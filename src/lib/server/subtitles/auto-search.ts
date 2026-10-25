/**
 * Auto-search orchestration (single + batch).
 *
 * One implementation shared by `/api/subtitles/auto-search` and
 * `/api/subtitles/auto-search/batch`: preflight the media item, resolve the
 * effective language profile, search once, then attempt each missing
 * requirement through the shared acquisition helper.
 *
 * Reporting is honest: genuinely empty provider results are `no_results`, while
 * results that existed but were rejected by the requirement tuple or the score
 * threshold are `below_threshold` (with `bestRejectedScore` /
 * `bestRejectedReason`). Item-level preflight skips are `no_file`,
 * `not_monitored`, `opted_out`, or `no_profile`.
 */

import { getSubtitleSearchService } from './services/SubtitleSearchService.js';
import { getSubtitleDownloadService } from './services/SubtitleDownloadService.js';
import { LanguageProfileService } from './services/LanguageProfileService.js';
import { selectBestCandidate, type CandidateRejectionReason } from './acquisition.js';
import {
	filterSearchEligible,
	recordSearchFailure,
	resetSearchFailure
} from './subtitle-search-state.js';
import { DEFAULT_MINIMUM_SCORE, requirementKey } from '#lib/shared/language-profile.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
import type { SubtitleDownloadResult, SubtitleSearchResult } from './types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SubtitleAutoSearch', logDomain: 'subtitles' });

export type AutoSearchReason =
	| 'no_file'
	| 'not_monitored'
	| 'opted_out'
	| 'no_profile'
	| 'no_results'
	| 'below_threshold'
	| 'downloaded'
	| 'error';

/** Item-level preflight reasons that stop the whole item. */
export type AutoSearchSkipReason = 'no_file' | 'not_monitored' | 'opted_out' | 'no_profile';

export interface RequirementOutcome {
	requirementKey: string;
	tag: string;
	variant: SubtitleRequirement['variant'];
	accessibility: SubtitleRequirement['accessibility'];
	reason: AutoSearchReason;
	bestRejectedScore?: number;
	bestRejectedReason?: CandidateRejectionReason;
	language?: string;
	matchScore?: number;
	providerId?: string;
	providerName?: string;
	providerSubtitleId?: string;
	error?: string;
}

export interface AutoSearchItemResult {
	ownerType: 'movie' | 'episode';
	ownerId: string;
	title: string;
	skipped?: AutoSearchSkipReason;
	searched: boolean;
	outcomes: RequirementOutcome[];
	downloaded: number;
	/** First successful download (backward-compatible single-file response). */
	subtitle?: SubtitleDownloadResult;
}

export interface AutoSearchOptions {
	/** Explicit language override; defaults to the profile's requirement tags. */
	languages?: string[];
	/**
	 * Target ONE requirement row ("Search now" from details pages). Manual
	 * intent: the backoff eligibility gate is bypassed for this requirement,
	 * but outcomes still record/reset state for scheduled paths.
	 */
	requirement?: SubtitleRequirement;
}

/** Structural media shapes (full drizzle rows satisfy these). */
export interface MovieLike {
	id: string;
	title: string;
	hasFile?: boolean | null;
	monitored?: boolean | null;
	wantsSubtitles?: boolean | null;
}

export interface EpisodeLike {
	id: string;
	seriesId: string;
	seasonNumber: number;
	episodeNumber: number;
	title?: string | null;
	hasFile?: boolean | null;
	monitored?: boolean | null;
	wantsSubtitlesOverride?: boolean | null;
}

export interface SeriesLike {
	id: string;
	monitored?: boolean | null;
	wantsSubtitles?: boolean | null;
}

/** Whether an item may be searched at all (movie preflight). */
export function moviePreflightReason(movie: {
	hasFile?: boolean | null;
	monitored?: boolean | null;
	wantsSubtitles?: boolean | null;
}): AutoSearchSkipReason | null {
	if (!movie.hasFile) return 'no_file';
	if (!movie.monitored) return 'not_monitored';
	if (movie.wantsSubtitles === false) return 'opted_out';
	return null;
}

/** Whether an episode may be searched at all (episode + series preflight). */
export function episodePreflightReason(
	episode: {
		hasFile?: boolean | null;
		monitored?: boolean | null;
		wantsSubtitlesOverride?: boolean | null;
	},
	series: { monitored?: boolean | null; wantsSubtitles?: boolean | null }
): AutoSearchSkipReason | null {
	if (!episode.hasFile) return 'no_file';
	if (!episode.monitored || !series.monitored) return 'not_monitored';
	// Tri-state: episode override wins when set (true forces subtitles on
	// against a series-level opt-out), otherwise inherit the series flag.
	const wantsSubtitles = episode.wantsSubtitlesOverride ?? series.wantsSubtitles;
	if (wantsSubtitles === false) return 'opted_out';
	return null;
}

function emptyResult(
	ownerType: AutoSearchItemResult['ownerType'],
	ownerId: string,
	title: string,
	skipped: AutoSearchSkipReason
): AutoSearchItemResult {
	return { ownerType, ownerId, title, skipped, searched: false, outcomes: [], downloaded: 0 };
}

/** Search for and download missing subtitles for a movie. */
export async function autoSearchMovie(
	movie: MovieLike,
	options: AutoSearchOptions = {}
): Promise<AutoSearchItemResult> {
	const skip = moviePreflightReason(movie);
	if (skip) return emptyResult('movie', movie.id, movie.title, skip);

	const profileService = LanguageProfileService.getInstance();
	// Effective requirements (per-item override → profile chain). Override-only
	// items (no profile in the chain) are still searchable: policy defaults
	// apply, requirements are explicit.
	const effective = await profileService.getEffectiveSubtitleRequirements({ movieId: movie.id });
	if (!effective || effective.requirements.length === 0) {
		return emptyResult('movie', movie.id, movie.title, 'no_profile');
	}

	const status = await profileService.getMovieSubtitleStatus(movie.id);
	if (status.satisfied || status.missing.length === 0) {
		return {
			ownerType: 'movie',
			ownerId: movie.id,
			title: movie.title,
			searched: false,
			outcomes: [],
			downloaded: 0
		};
	}

	// Manual per-requirement intent skips the backoff gate for that row.
	const missing = options.requirement
		? status.missing.filter((r) => requirementKey(r) === requirementKey(options.requirement!))
		: status.missing;

	const languages = requirementLanguages(effective.requirements, options.languages);
	if (languages.length === 0) return emptyResult('movie', movie.id, movie.title, 'no_profile');

	// Per-requirement backoff: attempt only requirements whose window is open.
	const activeMissing = options.requirement
		? missing
		: await filterSearchEligible('movie', movie.id, missing);
	if (activeMissing.length === 0) {
		return {
			ownerType: 'movie',
			ownerId: movie.id,
			title: movie.title,
			searched: false,
			outcomes: [],
			downloaded: 0
		};
	}

	const minScore = effective.profile?.minimumScore ?? DEFAULT_MINIMUM_SCORE;
	const searchResults = await getSubtitleSearchService().searchForMovie(movie.id, languages, {
		requireHearingImpaired: activeMissing.some((r) => r.accessibility === 'require-hi'),
		requirements: activeMissing,
		minimumScore: minScore
	});

	return acquireRequirements(
		'movie',
		movie.id,
		movie.title,
		activeMissing,
		searchResults.results,
		minScore
	);
}

/** Search for and download missing subtitles for an episode. */
export async function autoSearchEpisode(
	episode: EpisodeLike,
	series: SeriesLike,
	options: AutoSearchOptions = {}
): Promise<AutoSearchItemResult> {
	const title = episode.title || `S${episode.seasonNumber}E${episode.episodeNumber}`;
	const skip = episodePreflightReason(episode, series);
	if (skip) return emptyResult('episode', episode.id, title, skip);

	const profileService = LanguageProfileService.getInstance();
	// Episode chain: episode override → series resolution (series override →
	// library default → instance default).
	const effective = await profileService.getEffectiveSubtitleRequirements({
		episodeId: episode.id
	});
	if (!effective || effective.requirements.length === 0) {
		return emptyResult('episode', episode.id, title, 'no_profile');
	}

	const status = await profileService.getEpisodeSubtitleStatus(episode.id);
	if (status.satisfied || status.missing.length === 0) {
		return {
			ownerType: 'episode',
			ownerId: episode.id,
			title,
			searched: false,
			outcomes: [],
			downloaded: 0
		};
	}

	// Manual per-requirement intent skips the backoff gate for that row.
	const missing = options.requirement
		? status.missing.filter((r) => requirementKey(r) === requirementKey(options.requirement!))
		: status.missing;

	const languages = requirementLanguages(effective.requirements, options.languages);
	if (languages.length === 0) return emptyResult('episode', episode.id, title, 'no_profile');

	// Per-requirement backoff: attempt only requirements whose window is open.
	const activeMissing = options.requirement
		? missing
		: await filterSearchEligible('episode', episode.id, missing);
	if (activeMissing.length === 0) {
		return {
			ownerType: 'episode',
			ownerId: episode.id,
			title,
			searched: false,
			outcomes: [],
			downloaded: 0
		};
	}

	const minScore = effective.profile?.minimumScore ?? DEFAULT_MINIMUM_SCORE;
	const searchResults = await getSubtitleSearchService().searchForEpisode(episode.id, languages, {
		requireHearingImpaired: activeMissing.some((r) => r.accessibility === 'require-hi'),
		requirements: activeMissing,
		minimumScore: minScore
	});

	return acquireRequirements(
		'episode',
		episode.id,
		title,
		activeMissing,
		searchResults.results,
		minScore
	);
}

/**
 * Unique language tags to query providers with.
 *
 * Derived from the EFFECTIVE requirements (per-item override wins over the
 * profile chain) so an override-only language is actually searched for. An
 * explicit caller language list still wins (manual language selection).
 */
function requirementLanguages(
	requirements: SubtitleRequirement[],
	languages: string[] | undefined
): string[] {
	if (languages && languages.length > 0) return [...new Set(languages)];
	return [...new Set(requirements.map((requirement) => requirement.tag))];
}

async function acquireRequirements(
	ownerType: 'movie' | 'episode',
	ownerId: string,
	title: string,
	requirements: SubtitleRequirement[],
	results: SubtitleSearchResult[],
	minScore: number
): Promise<AutoSearchItemResult> {
	const downloadService = getSubtitleDownloadService();
	const outcomes: RequirementOutcome[] = [];
	let downloaded = 0;
	let firstDownload: SubtitleDownloadResult | undefined;
	const noResults = results.length === 0;

	for (const requirement of requirements) {
		const base = {
			requirementKey: requirementKey(requirement),
			tag: requirement.tag,
			variant: requirement.variant,
			accessibility: requirement.accessibility
		};

		// Reserve "no results" for genuinely zero provider results.
		if (noResults) {
			outcomes.push({ ...base, reason: 'no_results' });
			await recordSearchFailure(ownerType, ownerId, base.requirementKey);
			continue;
		}

		const selection = selectBestCandidate(results, requirement, minScore);
		if (!selection.best) {
			outcomes.push({
				...base,
				reason: 'below_threshold',
				bestRejectedScore: selection.bestRejected?.result.matchScore,
				bestRejectedReason: selection.bestRejected?.reason
			});
			await recordSearchFailure(ownerType, ownerId, base.requirementKey);
			continue;
		}

		const best = selection.best;
		try {
			const result =
				ownerType === 'movie'
					? await downloadService.downloadForMovie(ownerId, best)
					: await downloadService.downloadForEpisode(ownerId, best);

			downloaded++;
			if (!firstDownload) firstDownload = result;
			await resetSearchFailure(ownerType, ownerId, base.requirementKey);

			outcomes.push({
				...base,
				reason: 'downloaded',
				language: result?.language ?? best.language,
				matchScore: best.matchScore,
				providerId: best.providerId,
				providerName: best.providerName,
				providerSubtitleId: best.providerSubtitleId
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				{ ownerType, ownerId, language: requirement.tag, error: message },
				'[SubtitleAutoSearch] Download failed'
			);
			outcomes.push({ ...base, reason: 'error', error: message });
			await recordSearchFailure(ownerType, ownerId, base.requirementKey);
		}
	}

	return {
		ownerType,
		ownerId,
		title,
		searched: true,
		outcomes,
		downloaded,
		subtitle: firstDownload
	};
}

/**
 * Human/route-friendly summary reason for an item result.
 * `satisfied` is returned when nothing was missing.
 */
export function summarizeAutoSearchReason(
	result: AutoSearchItemResult
): AutoSearchReason | 'satisfied' {
	if (result.skipped) return result.skipped;
	if (result.downloaded > 0) return 'downloaded';
	if (result.outcomes.length === 0) return 'satisfied';
	return result.outcomes[0].reason;
}

/**
 * Radarr/Sonarr-compatible `release/push` (autobrr/RSS-tool push).
 *
 * Real autobrr pushes a raw, externally-discovered release title with no
 * known movie/series id attached (unlike the existing `/release` interactive
 * search flow in release.ts, where Cinephage's own search already resolved
 * identity) and expects the arr app to identify the matching library item
 * itself, decide whether to grab it, and respond with an approve/reject
 * verdict.
 *
 * Request/response field names confirmed against autobrr's actual Go client
 * (pkg/arr/{sonarr,radarr}/types.go `ReleasePushRequest`). The success
 * response is a single-element ARRAY, not a bare object - autobrr indexes
 * into `response[0]`.
 */

import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { movies, series, episodes } from '#lib/server/db/schema.js';
import { calculateMatchConfidence } from '#lib/server/library/title-matching.js';
import { parseRelease } from '#lib/server/indexers/parser/ReleaseParser.js';
import { scoreRelease } from '#lib/server/scoring/scorer.js';
import { QualityFilter } from '#lib/server/quality/QualityFilter.js';
import { BALANCED_PROFILE } from '#lib/server/scoring/profiles.js';
import type { ScoringProfile, ScoringResult } from '#lib/server/scoring/types.js';

type FetchFn = typeof fetch;
type Movie = typeof movies.$inferSelect;
type Series = typeof series.$inferSelect;
type Episode = typeof episodes.$inferSelect;

const qualityFilter = new QualityFilter();

// Matches MediaMatcherService's DEFAULT_MATCH_THRESHOLD - same confidence bar
// used for auto-matching a scanned file to a TMDB result, applied here to
// matching a pushed release's title to a library entry.
const MATCH_CONFIDENCE_THRESHOLD = 0.8;

interface PushVerdict {
	approved: boolean;
	rejected: boolean;
	temporarilyRejected: boolean;
	rejections: string[];
}

interface NormalizedRelease {
	title: string;
	downloadUrl?: string;
	magnetUrl?: string;
	size?: number;
	indexer: string;
	protocol: 'torrent' | 'usenet';
	publishDate: string;
}

function badRequest(propertyName: string, errorMessage: string): { status: number; body: unknown } {
	return {
		status: 400,
		body: [{ propertyName, errorMessage, errorCode: 'InvalidRequest' }]
	};
}

function approve(): { status: number; body: PushVerdict[] } {
	return {
		status: 200,
		body: [{ approved: true, rejected: false, temporarilyRejected: false, rejections: [] }]
	};
}

function reject(rejections: string[]): { status: number; body: PushVerdict[] } {
	return {
		status: 200,
		body: [{ approved: false, rejected: true, temporarilyRejected: false, rejections }]
	};
}

async function getProfileForMedia(
	scoringProfileId: string | null | undefined
): Promise<ScoringProfile> {
	if (scoringProfileId) {
		const profile = await qualityFilter.getProfile(scoringProfileId);
		if (profile) return profile;
	}
	return BALANCED_PROFILE;
}

function qualityRejectionReasons(result: ScoringResult): string[] {
	if (result.isBanned) return result.bannedReasons.map((name) => `Banned format: ${name}`);
	if (result.sizeRejected && result.sizeRejectionReason) return [result.sizeRejectionReason];
	if (result.protocolRejected && result.protocolRejectionReason)
		return [result.protocolRejectionReason];
	return [`Release score ${result.totalScore} does not meet profile minimum`];
}

/**
 * Find the library entry (movie or series) whose title best matches the
 * parsed release title. Confidence scoring reused from title-matching.ts;
 * the DB query itself doesn't exist anywhere yet, so it lives here.
 */
function bestTitleMatch<
	T extends { title: string; originalTitle: string | null; year: number | null }
>(
	candidates: T[],
	parsedTitle: string,
	parsedYear: number | undefined
): { candidate: T; confidence: number } | undefined {
	let best: { candidate: T; confidence: number } | undefined;
	for (const candidate of candidates) {
		const confidence = calculateMatchConfidence(
			parsedTitle,
			parsedYear,
			candidate.title,
			candidate.year ?? undefined,
			candidate.originalTitle ?? undefined
		);
		if (!best || confidence > best.confidence) {
			best = { candidate, confidence };
		}
	}
	return best;
}

/**
 * Grab the pushed release via the same internal `/api/download/grab` route
 * the existing interactive-search POST /release handler (grabRelease in
 * release.ts) forwards to - reusing the one real download-client submission
 * path rather than reimplementing it. Unlike that flow, no arr-id mapping is
 * needed here: the movie/series was resolved directly to its DB id above.
 */
async function grabPushedRelease(
	fetchFn: FetchFn,
	release: NormalizedRelease,
	target: { movieId?: string; seriesId?: string; episodeIds?: string[]; seasonNumber?: number }
): Promise<{ ok: boolean; status: number; body: unknown }> {
	const grabBody: Record<string, unknown> = {
		title: release.title,
		downloadUrl: release.downloadUrl,
		magnetUrl: release.magnetUrl,
		indexerName: release.indexer,
		protocol: release.protocol,
		size: release.size,
		publishDate: release.publishDate,
		mediaType: target.movieId ? 'movie' : 'tv',
		isAutomatic: true,
		source: 'arr_push',
		...target
	};

	const response = await fetchFn('/api/download/grab', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(grabBody)
	});
	const responseBody = await response.json().catch(() => ({}));
	return { ok: response.ok, status: response.status, body: responseBody };
}

function grabFailureReason(body: unknown): string {
	if (
		body &&
		typeof body === 'object' &&
		'error' in body &&
		typeof (body as { error: unknown }).error === 'string'
	) {
		return (body as { error: string }).error;
	}
	return 'Failed to grab release';
}

/**
 * Audio-language gate for pushed (autobrr/RSS) releases: rejects only on
 * affirmative contradiction under the item's require-mode audio preference
 * (same truth table as the grab pipeline's LanguageStage, applied pre-grab
 * so pushes get a clean rejection instead of a failed grab).
 */
async function rejectOnLanguageShortfall(
	title: string,
	mediaType: 'movie' | 'series',
	itemId: string
): Promise<string[] | null> {
	try {
		const { resolveAudioPreferenceForItem } =
			await import('#lib/server/languages/audio-preference-resolver.js');
		const { evaluatePushLanguageGate } = await import('#lib/server/arr/language-gate.js');
		return evaluatePushLanguageGate(title, await resolveAudioPreferenceForItem(mediaType, itemId));
	} catch {
		return null;
	}
}

async function pushMovieRelease(
	release: NormalizedRelease,
	fetchFn: FetchFn
): Promise<{ status: number; body: unknown }> {
	const parsed = parseRelease(release.title, { mode: 'movie' });

	const candidates = await db.select().from(movies).all();
	const match = bestTitleMatch<Movie>(candidates, parsed.cleanTitle, parsed.year);

	if (!match || match.confidence < MATCH_CONFIDENCE_THRESHOLD) {
		return reject(['No matching movie found in library']);
	}

	const movie = match.candidate;
	if (!movie.monitored) {
		return reject(['Movie is not monitored']);
	}

	const profile = await getProfileForMedia(movie.scoringProfileId);
	const scoringResult = scoreRelease(
		release.title,
		profile,
		undefined,
		release.size,
		{ mediaType: 'movie' },
		release.protocol
	);
	if (!scoringResult.meetsMinimum) {
		return reject(qualityRejectionReasons(scoringResult));
	}

	const languageRejection = await rejectOnLanguageShortfall(release.title, 'movie', movie.id);
	if (languageRejection) return reject(languageRejection);

	const grabResult = await grabPushedRelease(fetchFn, release, { movieId: movie.id });
	if (!grabResult.ok) {
		return reject([grabFailureReason(grabResult.body)]);
	}

	return approve();
}

async function pushSeriesRelease(
	release: NormalizedRelease,
	fetchFn: FetchFn
): Promise<{ status: number; body: unknown }> {
	const parsed = parseRelease(release.title, { mode: 'auto' });
	const episodeInfo = parsed.episode;

	const candidates = await db.select().from(series).all();
	const match = bestTitleMatch<Series>(candidates, parsed.cleanTitle, parsed.year);

	if (!match || match.confidence < MATCH_CONFIDENCE_THRESHOLD) {
		return reject(['No matching series found in library']);
	}

	const show = match.candidate;
	if (!show.monitored) {
		return reject(['Series is not monitored']);
	}

	const seasonNumber = episodeInfo?.season ?? episodeInfo?.seasons?.[0];
	if (!episodeInfo || seasonNumber === undefined) {
		return reject(['Could not determine season/episode from release title']);
	}

	const seriesEpisodes: Episode[] = await db
		.select()
		.from(episodes)
		.where(eq(episodes.seriesId, show.id))
		.all();
	const seasonEpisodes = seriesEpisodes.filter((episode) => episode.seasonNumber === seasonNumber);
	if (seasonEpisodes.length === 0) {
		return reject([`Season ${seasonNumber} not found for series`]);
	}

	const isSeasonPack =
		episodeInfo.isSeasonPack && (!episodeInfo.episodes || episodeInfo.episodes.length === 0);

	let targetEpisodes: Episode[];
	if (isSeasonPack) {
		targetEpisodes = seasonEpisodes;
	} else {
		const episodeNumbers = episodeInfo.episodes ?? [];
		if (episodeNumbers.length === 0) {
			return reject(['Could not determine episode number from release title']);
		}
		targetEpisodes = seasonEpisodes.filter((episode) =>
			episodeNumbers.includes(episode.episodeNumber)
		);
		if (targetEpisodes.length === 0) {
			return reject([`Episode not found: season ${seasonNumber}`]);
		}
	}

	const monitoredEpisodes = targetEpisodes.filter((episode) => episode.monitored);
	if (monitoredEpisodes.length === 0) {
		return reject(['Episode is not monitored']);
	}

	const profile = await getProfileForMedia(show.scoringProfileId);
	const scoringResult = scoreRelease(
		release.title,
		profile,
		undefined,
		release.size,
		{
			mediaType: 'tv',
			isSeasonPack,
			episodeCount: isSeasonPack ? seasonEpisodes.length : undefined
		},
		release.protocol
	);
	if (!scoringResult.meetsMinimum) {
		return reject(qualityRejectionReasons(scoringResult));
	}

	const seriesLanguageRejection = await rejectOnLanguageShortfall(release.title, 'series', show.id);
	if (seriesLanguageRejection) return reject(seriesLanguageRejection);

	const grabResult = await grabPushedRelease(fetchFn, release, {
		seriesId: show.id,
		episodeIds: isSeasonPack ? undefined : monitoredEpisodes.map((episode) => episode.id),
		seasonNumber: isSeasonPack ? seasonNumber : undefined
	});
	if (!grabResult.ok) {
		return reject([grabFailureReason(grabResult.body)]);
	}

	return approve();
}

/**
 * POST /release/push - parse a raw pushed release, match it against the
 * library, score it, and grab it if approved.
 */
export async function pushRelease(
	app: 'radarr' | 'sonarr',
	body: Record<string, unknown>,
	fetchFn: FetchFn
): Promise<{ status: number; body: unknown }> {
	const title = typeof body.title === 'string' ? body.title.trim() : '';
	if (!title) {
		return badRequest('title', 'title is required');
	}

	const downloadUrl = typeof body.downloadUrl === 'string' ? body.downloadUrl : undefined;
	const magnetUrl = typeof body.magnetUrl === 'string' ? body.magnetUrl : undefined;
	if (!downloadUrl && !magnetUrl) {
		return badRequest('downloadUrl', 'Either downloadUrl or magnetUrl is required');
	}

	const size = typeof body.size === 'number' ? body.size : undefined;
	const indexer = typeof body.indexer === 'string' ? body.indexer : 'unknown';
	const protocol: 'torrent' | 'usenet' =
		body.downloadProtocol === 'usenet' || body.protocol === 'usenet' ? 'usenet' : 'torrent';
	const publishDate =
		typeof body.publishDate === 'string' ? body.publishDate : new Date().toISOString();

	const release: NormalizedRelease = {
		title,
		downloadUrl,
		magnetUrl,
		size,
		indexer,
		protocol,
		publishDate
	};

	return app === 'radarr'
		? pushMovieRelease(release, fetchFn)
		: pushSeriesRelease(release, fetchFn);
}

import { basename, dirname, resolve } from 'node:path';
import { getMediaParseStem } from './media-utils.js';
import { parseRelease } from '#lib/server/indexers/parser/ReleaseParser.js';
import type { ParsedRelease } from '#lib/server/indexers/parser/types.js';

export type SeriesType = 'standard' | 'anime' | 'daily';

export type ResolvedTvEpisodeIdentifier =
	| {
			numbering: 'standard';
			seasonNumber: number;
			episodeNumbers: number[];
	  }
	| {
			numbering: 'daily';
			airDate: string;
	  }
	| {
			numbering: 'absolute';
			absoluteEpisode: number;
	  };

interface ResolveTvEpisodeIdentifierOptions {
	filePath: string;
	fileName?: string;
	parsed?: ParsedRelease;
	seasonHint?: number;
	seriesType?: SeriesType | null;
}

interface EpisodeRecordLike {
	seasonNumber: number;
	episodeNumber: number;
	absoluteEpisodeNumber?: number | null;
	airDate?: string | null;
}

export function extractSeasonFromPath(pathValue: string): number | undefined {
	const normalizedPath = resolve(pathValue).replace(/\\/g, '/');

	// "Specials" folder name is treated as season 0.
	if (/(?:^|\/)specials?(?:\/|$)/i.test(normalizedPath)) {
		return 0;
	}

	// First pass: match season as a complete path segment boundary
	// e.g. /Season 1/, /s01/, /Season.1/
	const segmentPatterns = [
		/(?:^|\/)season[\s._-]*(\d{1,3})(?:\/|$)/i,
		/(?:^|\/)s(\d{1,3})(?:\/|$)/i
	];

	for (const pattern of segmentPatterns) {
		const match = normalizedPath.match(pattern);
		const season = match?.[1] ? parseInt(match[1], 10) : NaN;
		if (!isNaN(season)) {
			return season;
		}
	}

	// Second pass: scan each path segment for a standalone S-number token
	// Handles folder names like "[Group] Title S1 BD-BOX" or "Show S2 Complete"
	// Requires word boundary on both sides and must not be followed by an episode number
	for (const segment of normalizedPath.split('/')) {
		const match = segment.match(/\bS(\d{1,2})\b(?![\s._-]?E\d)/i);
		if (!match) continue;
		const season = parseInt(match[1], 10);
		if (!isNaN(season) && season >= 1 && season <= 30) {
			return season;
		}
	}

	return undefined;
}

function extractCompactAirDate(fileStem: string): string | undefined {
	const match = fileStem.match(/\b(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
	if (!match) {
		return undefined;
	}

	return `${match[1]}-${match[2]}-${match[3]}`;
}

function extractTrailingEpisodeToken(fileStem: string): number | undefined {
	const patterns = [
		/(?:^|[\s._-])(?:ep?|episode)[\s._-]*0*([1-9]\d{0,2})(?:v\d+)?$/i,
		/(?:^|[\s._-])0*([1-9]\d{0,2})(?:v\d+)?$/i
	];

	for (const pattern of patterns) {
		const match = fileStem.match(pattern);
		if (!match?.[1]) {
			continue;
		}

		const episode = parseInt(match[1], 10);
		if (!isNaN(episode) && episode > 0) {
			return episode;
		}
	}

	return undefined;
}

export function resolveTvEpisodeIdentifier(
	options: ResolveTvEpisodeIdentifierOptions
): ResolvedTvEpisodeIdentifier | null {
	const fileReference = options.fileName ?? options.filePath;
	const fileStem = getMediaParseStem(fileReference);
	const parsed = options.parsed ?? parseRelease(fileStem);
	const seasonHint = options.seasonHint ?? extractSeasonFromPath(options.filePath);
	const seriesType = options.seriesType ?? null;
	const episodeInfo = parsed.episode;

	if (
		episodeInfo?.season !== undefined &&
		episodeInfo.episodes &&
		episodeInfo.episodes.length > 0
	) {
		return {
			numbering: 'standard',
			seasonNumber: episodeInfo.season,
			episodeNumbers: episodeInfo.episodes
		};
	}

	if (episodeInfo?.isDaily && episodeInfo.airDate) {
		return {
			numbering: 'daily',
			airDate: episodeInfo.airDate
		};
	}

	const compactAirDate = extractCompactAirDate(fileStem);
	if (seriesType === 'daily' && compactAirDate) {
		return {
			numbering: 'daily',
			airDate: compactAirDate
		};
	}

	if (episodeInfo?.isSeasonPack) {
		return null;
	}

	if (episodeInfo?.absoluteEpisode !== undefined) {
		if (seriesType !== 'anime' && seasonHint !== undefined) {
			return {
				numbering: 'standard',
				seasonNumber: seasonHint,
				episodeNumbers: [episodeInfo.absoluteEpisode]
			};
		}

		return {
			numbering: 'absolute',
			absoluteEpisode: episodeInfo.absoluteEpisode
		};
	}

	const trailingEpisode = extractTrailingEpisodeToken(fileStem);
	if (trailingEpisode === undefined) {
		return null;
	}

	if (seriesType === 'anime') {
		return {
			numbering: 'absolute',
			absoluteEpisode: trailingEpisode
		};
	}

	if (seasonHint !== undefined) {
		return {
			numbering: 'standard',
			seasonNumber: seasonHint,
			episodeNumbers: [trailingEpisode]
		};
	}

	return null;
}

export function matchEpisodesByIdentifier<T extends EpisodeRecordLike>(
	episodes: T[],
	identifier: ResolvedTvEpisodeIdentifier
): T[] {
	switch (identifier.numbering) {
		case 'standard':
			return episodes.filter(
				(episode) =>
					episode.seasonNumber === identifier.seasonNumber &&
					identifier.episodeNumbers.includes(episode.episodeNumber)
			);
		case 'daily':
			return episodes.filter((episode) => episode.airDate === identifier.airDate);
		case 'absolute': {
			const exact = episodes.filter(
				(episode) => episode.absoluteEpisodeNumber === identifier.absoluteEpisode
			);
			if (exact.length > 0) {
				return exact;
			}

			// absoluteEpisodeNumber is not populated by any metadata flow today,
			// so exact absolute lookups miss. For a series with a single REGULAR
			// season the absolute number unambiguously names that season's
			// episode ("Episode 13 - <title>" in a one-season documentary,
			// absolute numbering in a one-season anime). Season 0 specials must
			// not make the series look multi-season (Cosmos has 14 of them).
			const regularSeasons = new Set(
				episodes
					.filter((episode) => episode.seasonNumber > 0)
					.map((episode) => episode.seasonNumber)
			);
			if (regularSeasons.size === 1) {
				const [seasonNumber] = regularSeasons;
				return episodes.filter(
					(episode) =>
						episode.seasonNumber === seasonNumber &&
						episode.episodeNumber === identifier.absoluteEpisode
				);
			}

			return exact;
		}
	}
}

interface QueueEpisodeRecordLike extends EpisodeRecordLike {
	id: string;
}

interface QueueContextLike {
	/** Original release/torrent title, used as an identifier fallback source. */
	title?: string | null;
	/** Season number from the queue, used as a parse hint. */
	seasonNumber?: number | null;
	/** Ordered episode ids queued for this release. */
	episodeIds?: readonly string[] | null;
}

/**
 * Resolve a TV episode identifier by trying the file stem, then the queue
 * title, then the parent folder stem. This mirrors ImportService's fallback
 * chain so obfuscated provider basenames resolve exactly as conventional
 * import would resolve them.
 *
 * The caller owns any logging; this function is side-effect free and returns
 * the winning candidate source plus the stem that produced the identifier so
 * ImportService can preserve its existing fallback diagnostics.
 */
export function resolveEpisodeIdentifierWithFallback(
	videoFilePath: string,
	queueContext: QueueContextLike,
	seriesType: SeriesType
): {
	identifier: ResolvedTvEpisodeIdentifier;
	source: 'file' | 'queueTitle' | 'parentFolder';
	stem: string;
} | null {
	const seasonHint = queueContext.seasonNumber ?? undefined;
	const candidates: Array<{
		source: 'file' | 'queueTitle' | 'parentFolder';
		value?: string | null;
	}> = [
		{ source: 'file', value: videoFilePath },
		{ source: 'queueTitle', value: queueContext.title },
		{ source: 'parentFolder', value: basename(dirname(videoFilePath)) }
	];
	const seenStems = new Set<string>();

	for (const candidate of candidates) {
		if (!candidate.value) continue;
		const stem = getMediaParseStem(candidate.value);
		const normalizedStem = stem.trim().toLowerCase();
		if (!normalizedStem || seenStems.has(normalizedStem)) {
			continue;
		}
		seenStems.add(normalizedStem);

		const parsed: ParsedRelease = parseRelease(stem);
		const identifier = resolveTvEpisodeIdentifier({
			filePath: videoFilePath,
			fileName: stem,
			parsed,
			seasonHint,
			seriesType
		});

		if (!identifier) {
			continue;
		}

		return { identifier, source: candidate.source, stem };
	}

	return null;
}

/**
 * Queue-context fallback matching: when direct identifier matching misses,
 * interpret the parsed episode numbers as 1-based indices into the queued
 * episodes of the target season (sorted by episode number). This mirrors
 * ImportService's relative-index mapping for releases whose file numbering
 * does not line up with the library's episode numbers.
 *
 * Only standard numbering is eligible; absolute/daily identifiers return [].
 */
export function matchEpisodesFromQueueContext<T extends QueueEpisodeRecordLike>(
	seriesEpisodes: readonly T[],
	queueItem: QueueContextLike,
	identifier: ResolvedTvEpisodeIdentifier
): T[] {
	if (identifier.numbering !== 'standard') {
		return [];
	}

	const queuedEpisodeIds = queueItem.episodeIds ?? [];
	if (queuedEpisodeIds.length === 0) {
		return [];
	}

	const targetSeason = queueItem.seasonNumber ?? identifier.seasonNumber;
	if (targetSeason === undefined || targetSeason === null) {
		return [];
	}

	// Require season alignment before applying relative index mapping.
	if (identifier.seasonNumber !== targetSeason) {
		return [];
	}

	const queuedEpisodesInSeason = seriesEpisodes
		.filter(
			(episode) => queuedEpisodeIds.includes(episode.id) && episode.seasonNumber === targetSeason
		)
		.sort((a, b) => a.episodeNumber - b.episodeNumber);

	if (queuedEpisodesInSeason.length === 0) {
		return [];
	}

	const resolved = identifier.episodeNumbers
		.map((episodeNumber) => queuedEpisodesInSeason[episodeNumber - 1])
		.filter((episode): episode is T => Boolean(episode));

	if (resolved.length !== identifier.episodeNumbers.length) {
		return [];
	}

	// Deduplicate in case a release token repeats an episode number.
	const uniqueById = new Map(resolved.map((episode) => [episode.id, episode]));
	return [...uniqueById.values()];
}

/**
 * Release Result Types
 *
 * Defines the structure for search results returned by indexers.
 * Includes base release results and enhanced results with scoring.
 */

import type {
	IndexerProtocol,
	TorrentResultFields,
	UsenetResultFields,
	StreamingResultFields
} from './protocol';
import type { Category } from './category';
import type { ParsedRelease } from '../parser/types';

// Re-export ParsedRelease from the parser - this is the canonical type
export type { ParsedRelease } from '../parser/types';

// =============================================================================
// BASE RELEASE RESULT
// =============================================================================

/**
 * A release result from an indexer search.
 * This is the raw result before any enhancement/scoring.
 */
export interface ReleaseResult {
	/** Unique identifier (indexer-specific) */
	guid: string;
	/** Release title (as provided by indexer) */
	title: string;
	/** Download link (torrent file, NZB, magnet, or stream URL) */
	downloadUrl: string;
	/** Link to comments/details page */
	commentsUrl?: string;
	/** Publication date */
	publishDate: Date;
	/** Size in bytes */
	size: number;
	/** Indexer ID that provided this result */
	indexerId: string;
	/** Indexer display name */
	indexerName: string;
	/** Protocol (torrent/usenet/streaming) */
	protocol: IndexerProtocol;
	/** Categories */
	categories: Category[];

	// Protocol-specific fields
	/** Torrent-specific fields (if protocol === 'torrent') */
	torrent?: TorrentResultFields;
	/** Usenet-specific fields (if protocol === 'usenet') */
	usenet?: UsenetResultFields;
	/** Streaming-specific fields (if protocol === 'streaming') */
	streaming?: StreamingResultFields;

	// Legacy flat fields for backwards compatibility (deprecated)
	/** @deprecated Use torrent.seeders */
	seeders?: number;
	/** @deprecated Use torrent.leechers */
	leechers?: number;
	/** @deprecated Use torrent.grabs */
	grabs?: number;
	/** @deprecated Use torrent.infoHash */
	infoHash?: string;
	/** @deprecated Use torrent.magnetUrl */
	magnetUrl?: string;
	/** @deprecated Use usenet.poster */
	poster?: string;
	/** @deprecated Use usenet.group */
	group?: string;

	// Deduplication metadata
	/** All indexers that returned this release (tracked during deduplication) */
	sourceIndexers?: string[];

	/** Priority of the source indexer (lower = higher priority, from IndexerStatus) */
	indexerPriority?: number;

	// Metadata (if indexer provides it)
	/** IMDB ID if known */
	imdbId?: string;
	/** Audio languages reported by the indexer as structured data (torznab/newznab
	 * `language` attr). Title-parsed tokens live on `parsed.languages` instead -
	 * these are indexer-asserted, not filename-derived. */
	languages?: string[];
	/** Subtitle languages reported by the indexer (torznab/newznab `subs` attr) */
	subtitleLanguages?: string[];
	/** TMDB ID if known */
	tmdbId?: number;
	/** TVDB ID if known */
	tvdbId?: number;
	/** Season number if applicable */
	season?: number;
	/** Episode number if applicable */
	episode?: number;

	/** Source indexer language (ISO 639-1 code) - where the release came from */
	sourceLanguage?: string;

	/**
	 * Annotated during interactive searches when the release matches the
	 * blocklist (hash or exact title). Interactive searches keep the release
	 * in results and surface it through the existing rejected-releases
	 * machinery (rejected + rejections['Blocklisted']) so the showRejected
	 * toggle and rejection badges display it like any other rejection.
	 * Automatic searches remove blocklisted releases outright.
	 */
	blocklisted?: boolean;
}

/**
 * Quality scoring result
 */
export interface QualityScore {
	/** Total quality score */
	score: number;
	/** Resolution score component */
	resolutionScore: number;
	/** Source score component */
	sourceScore: number;
	/** Codec score component */
	codecScore: number;
	/** Audio score component */
	audioScore: number;
	/** HDR score component */
	hdrScore: number;
	/** Bonus/penalty adjustments */
	adjustments: number;
	/** Matched format names */
	matchedFormats: string[];
}

/**
 * Enhanced release result with parsed metadata and scoring
 */
export interface EnhancedReleaseResult extends ReleaseResult {
	/** Parsed metadata from release title */
	parsed: ParsedRelease;

	/** Quality score (optional - use quality.score for backward compat) */
	qualityScore?: QualityScore;

	/** Total score for ranking (quality + bonuses) */
	totalScore: number;

	/** Score components breakdown - use unknown since it comes from quality module */
	scoreComponents?: unknown;

	/** Whether this release was rejected by quality filter */
	rejected: boolean;

	/** Reason for rejection (primary reason - for backwards compatibility) */
	rejectionReason?: string;

	/** All rejection reasons (Radarr-style - for complete rejection tracking) */
	rejections?: string[];

	/** Count of rejections (for deduplication preference) */
	rejectionCount?: number;

	/** Position in ranked results (1 = best, Radarr-style releaseWeight) */
	releaseWeight?: number;

	/** Quality-only weight for debugging (resolution + source + codec score) */
	qualityWeight?: number;

	/** Rejection type for programmatic handling */
	rejectionType?: string;

	/** Quality filter result */
	quality?: unknown;

	/** Detailed scoring result from quality filter */
	scoringResult?: unknown;

	/** Matched format names */
	matchedFormats?: string[];

	// Episode matching for TV
	/** Episode match info */
	episodeMatch?: {
		season: number;
		seasons?: number[];
		episodes: number[];
		isSeasonPack: boolean;
		isCompleteSeries?: boolean;
	};

	// TMDB matching
	/** Whether release matches TMDB metadata */
	tmdbMatched?: boolean;
	/** TMDB match details */
	tmdbMatch?: {
		titleMatch?: boolean;
		yearMatch?: boolean;
		confidence?: number;
		id?: number;
		title?: string;
		year?: number;
	};

	// Upgrade evaluation
	/** Upgrade status compared to existing file */
	upgradeStatus?: 'upgrade' | 'sidegrade' | 'downgrade' | 'new' | 'blocked' | 'rejected';
	/** Whether this qualifies as an upgrade candidate */
	isUpgradeCandidate?: boolean;
	/** Score of existing file */
	existingScore?: number;
	/** Score improvement over existing */
	scoreImprovement?: number;
}

/**
 * Episode info extracted from an EnhancedReleaseResult.
 * Provides a canonical interface for episode data regardless of source.
 */
export interface EpisodeInfo {
	/** Primary season number */
	season?: number;
	/** All seasons (for multi-season packs) */
	seasons?: number[];
	/** Episode numbers in this release */
	episodes?: number[];
	/** Whether this is a season pack */
	isSeasonPack: boolean;
	/** Whether this is a complete series release */
	isCompleteSeries: boolean;
}

/**
 * Get canonical episode info from an EnhancedReleaseResult.
 *
 * This helper consolidates the fragile access patterns like:
 * `release.parsed.episode?.isSeasonPack ?? release.episodeMatch?.isSeasonPack`
 *
 * Priority:
 * 1. parsed.episode (primary, from release title parsing)
 * 2. episodeMatch (fallback, from enrichment)
 *
 * @param release - The enhanced release to extract episode info from
 * @returns Normalized episode info, or undefined if no episode info exists
 */
export function getEpisodeInfo(release: EnhancedReleaseResult): EpisodeInfo | undefined {
	const parsedEp = release.parsed?.episode;
	const matchedEp = release.episodeMatch;

	// If neither source has episode info, return undefined
	if (!parsedEp && !matchedEp) {
		return undefined;
	}

	return {
		season: parsedEp?.season ?? matchedEp?.season,
		seasons: parsedEp?.seasons ?? matchedEp?.seasons,
		episodes: parsedEp?.episodes ?? matchedEp?.episodes,
		isSeasonPack: parsedEp?.isSeasonPack ?? matchedEp?.isSeasonPack ?? false,
		isCompleteSeries: parsedEp?.isCompleteSeries ?? matchedEp?.isCompleteSeries ?? false
	};
}

/**
 * Check if a release is a season pack.
 * Convenience helper for the common pattern of checking isSeasonPack.
 */
export function isSeasonPack(release: EnhancedReleaseResult): boolean {
	return release.parsed?.episode?.isSeasonPack ?? release.episodeMatch?.isSeasonPack ?? false;
}

/**
 * Check if a release contains a specific season.
 * Works with both single-season and multi-season packs.
 */
export function releaseContainsSeason(
	release: EnhancedReleaseResult,
	targetSeason: number
): boolean {
	const info = getEpisodeInfo(release);
	if (!info) return false;

	// Complete series always contains any season
	if (info.isCompleteSeries) return true;

	// Check multi-season array first
	if (info.seasons?.length) {
		return info.seasons.includes(targetSeason);
	}

	// Single season match
	return info.season === targetSeason;
}

// =============================================================================
// SEARCH RESULT AGGREGATION
// =============================================================================

/**
 * Results from a single indexer
 */
export interface IndexerSearchResult {
	/** Indexer ID */
	indexerId: string;
	/** Indexer name */
	indexerName: string;
	/** Results from this indexer */
	results: ReleaseResult[];
	/** Search duration in milliseconds */
	searchTimeMs: number;
	/** Error message if search failed */
	error?: string;
	/** Search method used */
	searchMethod?: 'id' | 'text';
}

/**
 * Indexer that was rejected from search
 */
export interface RejectedIndexer {
	/** Indexer ID */
	indexerId: string;
	/** Indexer name */
	indexerName: string;
	/** Reason for rejection */
	reason: 'searchType' | 'searchSource' | 'disabled' | 'backoff' | 'indexerFilter' | 'protocol';
	/** Human-readable rejection message */
	message: string;
}

/**
 * Aggregated search result from multiple indexers
 */
export interface SearchResult {
	/** All releases (deduplicated and ranked) */
	releases: ReleaseResult[];
	/** Total results across all indexers */
	totalResults: number;
	/** Total search time in milliseconds */
	searchTimeMs: number;
	/** Whether results came from cache */
	fromCache?: boolean;
	/** Per-indexer results */
	indexerResults: IndexerSearchResult[];
	/** Indexers that were rejected from this search */
	rejectedIndexers?: RejectedIndexer[];
}

/**
 * Enhanced search result with scored releases
 */
export interface EnhancedSearchResult extends Omit<SearchResult, 'releases'> {
	/** Enhanced releases with scoring */
	releases: EnhancedReleaseResult[];
	/** Number of releases rejected by quality filter */
	rejectedCount: number;
	/** Enrichment time in milliseconds */
	enrichTimeMs: number;
	/** Scoring profile used */
	scoringProfileId?: string;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Minimal release info for deduplication/ranking
 */
export interface ReleaseInfo {
	guid: string;
	title: string;
	indexerId: string;
	size: number;
	seeders?: number;
	publishDate: Date;
	infoHash?: string;
}

/**
 * Extract minimal info from a release
 */
export function toReleaseInfo(release: ReleaseResult): ReleaseInfo {
	return {
		guid: release.guid,
		title: release.title,
		indexerId: release.indexerId,
		size: release.size,
		seeders: release.torrent?.seeders ?? release.seeders,
		publishDate: release.publishDate,
		infoHash: release.torrent?.infoHash ?? release.infoHash
	};
}

/**
 * Check if a release has usable download info
 */
export function hasDownloadInfo(release: ReleaseResult): boolean {
	return !!(
		release.downloadUrl ||
		release.torrent?.magnetUrl ||
		release.magnetUrl ||
		release.torrent?.infoHash ||
		release.infoHash
	);
}

/**
 * Get the best download URL for a release
 */
export function getBestDownloadUrl(release: ReleaseResult): string | undefined {
	// For torrents, prefer magnet (no tracking, works offline)
	if (release.protocol === 'torrent') {
		const magnetUrl = release.torrent?.magnetUrl ?? release.magnetUrl;
		if (magnetUrl) return magnetUrl;
	}

	// Fall back to download URL
	if (release.downloadUrl) return release.downloadUrl;

	return undefined;
}

/**
 * Format file size for display
 */
export function formatSize(bytes: number): string {
	if (bytes === 0) return '0 B';

	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const k = 1024;
	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Parse a size string into bytes
 */
export function parseSize(sizeStr: string): number {
	const match = sizeStr.match(/^([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/i);
	if (!match) return 0;

	const value = parseFloat(match[1]);
	const unit = (match[2] || 'B').toUpperCase();

	const multipliers: Record<string, number> = {
		B: 1,
		KB: 1024,
		KIB: 1024,
		MB: 1024 * 1024,
		MIB: 1024 * 1024,
		GB: 1024 * 1024 * 1024,
		GIB: 1024 * 1024 * 1024,
		TB: 1024 * 1024 * 1024 * 1024,
		TIB: 1024 * 1024 * 1024 * 1024
	};

	return Math.round(value * (multipliers[unit] || 1));
}

/**
 * Normalize a release result to use new structured fields
 */
export function normalizeReleaseResult(release: ReleaseResult): ReleaseResult {
	// If already normalized, return as-is
	if (release.torrent || release.usenet || release.streaming) {
		return release;
	}

	const normalized = { ...release };

	// Move legacy fields to protocol-specific objects
	if (release.protocol === 'torrent') {
		normalized.torrent = {
			seeders: release.seeders ?? 0,
			leechers: release.leechers ?? 0,
			grabs: release.grabs,
			infoHash: release.infoHash,
			magnetUrl: release.magnetUrl
		};
	} else if (release.protocol === 'usenet') {
		normalized.usenet = {
			poster: release.poster,
			group: release.group
		};
	}

	return normalized;
}

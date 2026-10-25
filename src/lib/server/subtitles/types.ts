/**
 * Subtitle Management System - Core Types
 */

import type { LanguageTag } from '#lib/shared/languages.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';

/**
 * Canonical language code.
 * @see #lib/shared/languages for the single language registry.
 */
export type LanguageCode = LanguageTag;

/** Subtitle file format */
export type SubtitleFormat = 'srt' | 'ass' | 'sub' | 'vtt' | 'ssa' | 'unknown';

/**
 * All supported provider implementations.
 * This is the single source of truth - add new providers here.
 */
export const PROVIDER_IMPLEMENTATIONS = [
	'opensubtitles',
	'opensubtitlesorg',
	'podnapisi',
	'addic7ed',
	'subdl',
	'yifysubtitles',
	'gestdown',
	'subf2m',
	'supersubtitles',
	// Regional providers
	'napiprojekt',
	'legendasdivx',
	'betaseries',
	'assrt'
] as const;

/** Provider implementation type (derived from the const array) */
export type ProviderImplementation = (typeof PROVIDER_IMPLEMENTATIONS)[number];

/** Sync options for alass */
export interface SyncOptionsType {
	referenceType?: 'video' | 'subtitle';
	referencePath?: string;
	splitPenalty?: number;
	noSplits?: boolean;
}

/** Subtitle history action types */
export type SubtitleAction =
	'downloaded' | 'deleted' | 'synced' | 'upgraded' | 'manual_upload' | 'discovered';

/** Blacklist reason types */
export type BlacklistReason = 'wrong_content' | 'out_of_sync' | 'poor_quality' | 'manual';

/**
 * Search criteria for subtitle lookup
 */
export interface SubtitleSearchCriteria {
	// Video file info (when available)
	filePath?: string;
	fileSize?: number;
	videoHash?: string; // OpenSubtitles hash
	fps?: number; // Video frame rate

	// Media identification
	imdbId?: string;
	tmdbId?: number;
	tvdbId?: number; // For TV show lookups
	title: string;
	originalTitle?: string;
	/** Canonical tag of the media's original language, when known. */
	originalLanguage?: LanguageCode;
	year?: number;

	// For TV episodes
	seriesTitle?: string;
	season?: number;
	episode?: number;
	episodeTitle?: string;

	// Language preferences
	languages: LanguageCode[];

	// Filters
	includeForced?: boolean;
	includeHearingImpaired?: boolean;
	excludeHearingImpaired?: boolean;
}

/**
 * Score breakdown for a subtitle match
 */
export interface SubtitleScoreBreakdown {
	hashMatch: number;
	titleMatch: number;
	yearMatch: number;
	releaseGroupMatch: number;
	sourceMatch: number;
	codecMatch: number;
	hiPenalty: number;
	forcedBonus: number;
}

/**
 * Result from a subtitle search
 */
export interface SubtitleSearchResult {
	// Provider info
	providerId: string;
	providerName: string;
	providerSubtitleId: string;

	// Basic info
	language: LanguageCode;
	title: string;
	releaseName?: string;
	fileName?: string;

	// Subtitle properties
	isForced: boolean;
	isHearingImpaired: boolean;
	format: SubtitleFormat;

	// Scoring
	isHashMatch: boolean;
	matchScore: number;
	scoreBreakdown?: SubtitleScoreBreakdown;

	// Download info
	downloadUrl?: string;
	downloadCount?: number;
	rating?: number;
	uploadDate?: string;
	uploader?: string;
	pageLink?: string; // Link to subtitle page on provider

	// File info
	fileSize?: number;

	// Originating movie file when this result came from a per-file search.
	// Wired into SubtitleDownloadService as a fallback target when no explicit
	// movieFileId option is supplied.
	movieFileId?: string;

	// Human-readable label of the originating movie file (basename of its
	// relative path). Lets the interactive search group/label results when a
	// movie has multiple files. Display-only; not used for download targeting.
	movieFileName?: string;
}

/**
 * Provider configuration from database
 */
export interface SubtitleProviderConfig {
	id: string;
	name: string;
	implementation: ProviderImplementation;
	enabled: boolean;
	priority: number;
	apiKey?: string;
	username?: string;
	password?: string;
	settings?: Record<string, unknown>;
	requestsPerMinute: number;
	// Health tracking
	lastError?: string;
	lastErrorAt?: string;
	consecutiveFailures: number;
	throttledUntil?: string;
}

/**
 * Provider search options
 */
export interface ProviderSearchOptions {
	maxResults?: number;
	timeout?: number;
}

/**
 * Media kind used for provider capability gating.
 * - `movie`: movies
 * - `tv`: standard/daily TV series
 * - `anime`: series whose type/library subtype is anime
 */
export type SubtitleMediaKind = 'movie' | 'tv' | 'anime';

/**
 * Aggregated search result across providers
 */
export interface AggregatedSearchResult {
	results: SubtitleSearchResult[];
	totalResults: number;
	searchTimeMs: number;
	providerResults: Array<{
		providerId: string;
		providerName: string;
		resultCount: number;
		error?: string;
		searchTimeMs: number;
		/** Set when the provider was intentionally not queried (with the reason). */
		skipped?: string;
	}>;
	/**
	 * Per-tier timing when priority tiers are used. Present only for searches
	 * that ran at least one tier. `stopped` marks the tier whose accepted
	 * candidates ended the cascade.
	 */
	tierTimings?: Array<{
		priority: number;
		providerIds: string[];
		searchTimeMs: number;
		accepted: boolean;
		stopped: boolean;
	}>;
}

/**
 * Result from downloading a subtitle
 */
export interface SubtitleDownloadResult {
	subtitleId: string;
	path: string;
	language: LanguageCode;
	format: SubtitleFormat;
	wasSynced: boolean;
	syncOffset: number | null;
	wasUpgrade: boolean;
	replacedSubtitleId?: string;
}

/**
 * Subtitle status for a media item.
 *
 * `missing` is the ordered list of v2 requirements that are not satisfied by a
 * file that currently exists on disk. `existing` describes every external
 * subtitle row found for the item, tagged with the requirement key it matches
 * (null when it matches none).
 */
export interface SubtitleStatus {
	satisfied: boolean;
	missing: SubtitleRequirement[];
	existing: Array<{
		language: LanguageCode;
		subtitleId: string;
		isForced: boolean;
		isHearingImpaired: boolean;
		matchScore?: number;
		requirementKey: string | null;
	}>;
}

/**
 * Sync result from alass
 */
export interface SubtitleSyncResult {
	success: boolean;
	offsetMs: number;
	error?: string;
}

/**
 * Media context for subtitle operations
 */
export interface MediaContext {
	type: 'movie' | 'episode';
	id: string;
	title: string;
	year?: number;
	imdbId?: string;
	tmdbId?: number;
	// For episodes
	seriesId?: string;
	seriesTitle?: string;
	season?: number;
	episode?: number;
	// File info
	filePath?: string;
	fileSize?: number;
	rootFolderPath?: string;
}

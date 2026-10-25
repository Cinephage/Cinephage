/**
 * Scoring Engine Types
 *
 * Core type definitions for the scoring system that evaluates releases
 * against custom formats and calculates quality scores.
 */

import type {
	Resolution,
	Source,
	Codec,
	HdrFormat,
	AudioCodec,
	AudioChannels
} from '../indexers/parser/types.js';

// Re-export Resolution for external use
export type { Resolution, Source, Codec, HdrFormat, AudioCodec, AudioChannels };

// =============================================================================
// Format Condition Types
// =============================================================================

/**
 * Types of conditions that can be used in custom format matching
 */
export type ConditionType =
	| 'resolution'
	| 'source'
	| 'release_title'
	| 'release_group'
	| 'codec'
	| 'audio_codec'
	| 'audio_channels'
	| 'audio_atmos'
	| 'hdr'
	| 'streaming_service'
	| 'flag'
	| 'indexer'
	| 'language';

/**
 * A single condition within a custom format definition
 */
export interface FormatCondition {
	/** Display name for this condition */
	name: string;

	/** Type of condition to evaluate */
	type: ConditionType;

	/**
	 * If true, this condition MUST match for the format to apply
	 * If false, this is an optional condition (OR logic with other optional conditions)
	 */
	required: boolean;

	/**
	 * If true, the condition is inverted (must NOT match)
	 */
	negate: boolean;

	// Type-specific fields (only one will be set based on type)

	/** For resolution conditions */
	resolution?: Resolution;

	/** For source conditions */
	source?: Source;

	/** Regex pattern for release_title or release_group conditions */
	pattern?: string;

	/** For codec conditions */
	codec?: Codec;

	/** For audio codec conditions */
	audioCodec?: AudioCodec;

	/** For audio channel conditions */
	audioChannels?: AudioChannels;

	/**
	 * For HDR conditions.
	 *
	 * `null` intentionally means "no HDR / SDR" — the format builder stores it
	 * that way. The parser's HdrFormat no longer carries null so that detected
	 * sets stay free of sentinel values.
	 */
	hdr?: HdrFormat | null;

	/** For streaming service conditions */
	streamingService?: string;

	/** For flag conditions (isRemux, isRepack, isProper, is3d) */
	flag?: 'isRemux' | 'isRepack' | 'isProper' | 'is3d';

	/** For indexer conditions (match by indexer name) */
	indexer?: string;

	/** For language conditions: a canonical language tag ('es', 'pt-BR') or
	 * the 'multi' / 'orig' pseudo-codes parsed from release names. Matches
	 * when any parsed language token matches (base-tag fallback). */
	language?: string;
}

// =============================================================================
// Custom Format Types
// =============================================================================

/**
 * Category of custom format for organization
 */
export type FormatCategory =
	| 'resolution' // Resolution + source combinations (e.g., "2160p Remux", "1080p WEB-DL")
	| 'release_group_tier' // Tiered release groups (Quality Tier 1-6, Efficient Tier 1-7, etc.)
	| 'audio' // Audio formats (TrueHD, DTS-HD MA, Atmos, etc.)
	| 'hdr' // HDR formats (Dolby Vision, HDR10+, HDR10, HLG)
	| 'streaming' // Streaming services (AMZN, NF, ATVP, etc.)
	| 'micro' // Micro encoder groups (YTS, YIFY, RARBG, PSA)
	| 'low_quality' // Low quality groups (not banned, just scored lower per profile)
	| 'banned' // Truly banned releases (deceptive: retagging, fake HDR, CAM, TS, etc.)
	| 'enhancement' // Special enhancements (IMAX, Repack, etc.)
	| 'codec' // Codec-specific formats (x265, AV1, etc.)
	| 'source' // Source-only formats (e.g., "WEB-DL (Any Resolution)")
	| 'other'; // Miscellaneous

/**
 * A custom format definition that can match against releases
 *
 * Note: Formats define WHAT to match (conditions), not HOW to score.
 * Scores are defined per-profile in ScoringProfile.formatScores.
 */
export interface CustomFormat {
	/** Unique identifier for this format */
	id: string;

	/** Display name */
	name: string;

	/** Description of what this format matches */
	description?: string;

	/** Category for organization */
	category: FormatCategory;

	/** Tags for filtering/searching */
	tags: string[];

	/** Conditions that determine if this format matches a release */
	conditions: FormatCondition[];
}

// =============================================================================
// Matching Result Types
// =============================================================================

/**
 * Result of matching a single condition
 */
export interface ConditionMatchResult {
	/** The condition that was evaluated */
	condition: FormatCondition;

	/** Whether the condition matched (before considering negate) */
	rawMatch: boolean;

	/** Final match result (after applying negate) */
	matches: boolean;
}

/**
 * A format that matched against a release
 */
export interface MatchedFormat {
	/** The format that matched */
	format: CustomFormat;

	/** Individual condition results */
	conditionResults: ConditionMatchResult[];
}

// =============================================================================
// Release Attributes (for scoring)
// =============================================================================

/**
 * All scorable attributes extracted from a release
 * Extends parsed release info with additional detection
 */
export interface ReleaseAttributes {
	/** Original release title */
	title: string;

	/** Cleaned title (media name) */
	cleanTitle: string;

	/** Release year */
	year?: number;

	// Core quality attributes
	resolution: Resolution;
	source: Source;
	codec: Codec;
	/**
	 * Every HDR format detected in the release, best-first.
	 *
	 * Requirement and ban matching reads this; scoring collapses it to one
	 * format so a DV+HDR10+ release is not counted twice.
	 */
	hdrFormats: HdrFormat[];
	/**
	 * Best detected HDR format (derived from `hdrFormats`), or null for SDR.
	 */
	hdr: HdrFormat | null;
	audioCodec: AudioCodec;
	audioChannels: AudioChannels;
	hasAtmos: boolean;

	// Release metadata
	releaseGroup?: string;
	streamingService?: string;
	edition?: string;
	languages: string[];

	// Source indexer info (for matching releases by indexer origin)
	indexerName?: string;

	// Flags
	isRemux: boolean;
	isRepack: boolean;
	isProper: boolean;
	is3d: boolean;

	// TV-specific
	isSeasonPack?: boolean;
	isCompleteSeries?: boolean;
	/** Number of seasons in a multi-season pack */
	seasonCount?: number;
}

// =============================================================================
// Pack Preference Types (for TV series pack prioritization)
// =============================================================================

/**
 * Configuration for prioritizing packs over individual episodes
 * Used when searching for multiple missing episodes
 */
export interface PackPreference {
	/** Whether pack preference is enabled */
	enabled: boolean;
	/** Bonus score for complete series packs */
	completeSeriesBonus: number;
	/** Bonus score for multi-season packs (2+ seasons) */
	multiSeasonBonus: number;
	/** Bonus score for single season packs */
	singleSeasonBonus: number;
	/** Minimum percentage of pack episodes that must be wanted (0-100) */
	minWantedEpisodesPercent: number;
}

// =============================================================================
// Scoring Profile Types
// =============================================================================

/**
 * Score assignment for a format within a profile
 */
export interface FormatScore {
	/** Format ID */
	formatId: string;

	/** Score to add when this format matches (can be negative) */
	score: number;
}

/**
 * Profile category for UI grouping and styling
 */
export type ProfileCategory = 'quality' | 'efficient' | 'micro' | 'streaming' | 'anime' | 'custom';

/**
 * A scoring profile that defines how formats are scored
 */
export interface ScoringProfile {
	/** Unique identifier */
	id: string;

	/** Display name */
	name: string;

	/** Description of this profile's philosophy */
	description: string;

	/** Tags describing this profile */
	tags: string[];

	/** Icon name for UI display (lucide icon) */
	icon?: string;

	/** Color class for UI display (e.g., 'text-yellow-500') */
	color?: string;

	/** Category for grouping in the UI */
	category?: ProfileCategory;

	/** Whether upgrades are allowed */
	upgradesAllowed: boolean;

	/** Whether to prevent resolution downgrades during upgrades */
	preventDowngrades: boolean;

	/** Whether this is a default profile */
	isDefault?: boolean;

	/** Minimum score for a release to be accepted */
	minScore: number;

	/** Score threshold to stop upgrading */
	upgradeUntilScore: number;

	/** Minimum score improvement to trigger upgrade */
	minScoreIncrement: number;

	/** Minimum file size for movies in GB */
	movieMinSizeGb?: number | null;

	/** Maximum file size for movies in GB */
	movieMaxSizeGb?: number | null;

	/** Minimum file size per TV episode in MB */
	episodeMinSizeMb?: number | null;

	/** Maximum file size per TV episode in MB */
	episodeMaxSizeMb?: number | null;

	/**
	 * Resolution fallback order (highest priority first)
	 * All profiles cascade through all resolutions
	 */
	resolutionOrder: Resolution[];

	/**
	 * Minimum resolution to accept (null = no minimum)
	 * Releases below this resolution will be rejected
	 */
	minResolution?: Resolution | null;

	/**
	 * Maximum resolution to accept (null = no maximum)
	 * Releases above this resolution will be rejected
	 */
	maxResolution?: Resolution | null;

	/**
	 * Allowed sources (null = allow all)
	 * Releases with sources not in this list will be rejected
	 */
	allowedSources?: Source[] | null;

	/**
	 * Excluded sources (e.g., ['cam', 'telesync'])
	 * Releases with sources in this list will be rejected
	 */
	excludedSources?: Source[] | null;

	/**
	 * Pack preference settings for TV series
	 * Controls bonus scores for season/series packs over individual episodes
	 */
	packPreference?: PackPreference;

	/**
	 * Score assignments for each format
	 * Format ID -> Score
	 */
	formatScores: Record<string, number>;

	/**
	 * Allowed protocols for this profile
	 * Determines which release types (torrent, usenet, streaming) are accepted
	 * Streaming releases (.strm) should only be allowed in the streaming profile
	 * @default ['torrent', 'usenet'] for non-streaming profiles
	 * @default ['torrent', 'usenet', 'streaming'] for streaming profile
	 */
	allowedProtocols?: ('torrent' | 'usenet' | 'streaming')[];

	/**
	 * Required format entries. AND entries must all match; OR entries need at least one match.
	 */
	requiredFormats?: { id: string; op: 'AND' | 'OR' }[];
}

/**
 * Context for media-specific file size validation
 */
export interface SizeValidationContext {
	/** Type of media being validated */
	mediaType: 'movie' | 'tv';
	/** Whether this is a season pack (only applies to TV) */
	isSeasonPack?: boolean;
	/** Number of episodes (required for season pack validation) */
	episodeCount?: number;
}

// =============================================================================
// Scoring Result Types
// =============================================================================

/**
 * Single category breakdown entry
 */
export interface CategoryBreakdown {
	/** Score contribution from this category */
	score: number;

	/** Names of formats that matched in this category */
	formats: string[];
}

/**
 * Breakdown of score by category
 */
export interface ScoreBreakdown {
	/** Score from resolution/source formats */
	resolution: CategoryBreakdown;

	/** Score from source formats */
	source: CategoryBreakdown;

	/** Score from codec formats */
	codec: CategoryBreakdown;

	/** Score from release group tier */
	releaseGroupTier: CategoryBreakdown;

	/** Score from audio format */
	audio: CategoryBreakdown;

	/** Score from HDR format */
	hdr: CategoryBreakdown;

	/** Score from streaming service */
	streaming: CategoryBreakdown;

	/** Score from enhancements (repack, etc.) */
	enhancement: CategoryBreakdown;

	/** Penalties from banned/problematic matches */
	banned: CategoryBreakdown;
}

/**
 * Complete scoring result for a release
 */
export interface ScoringResult {
	/** Original release name */
	releaseName: string;

	/** Profile name used for scoring */
	profile: string;

	/** Parsed resolution of the release */
	resolution: Resolution;

	/** Total calculated score */
	totalScore: number;

	/** Score breakdown by category */
	breakdown: ScoreBreakdown;

	/** All formats that matched this release with their scores */
	matchedFormats: ScoredFormat[];

	/** Whether this release meets minimum requirements */
	meetsMinimum: boolean;

	/** Whether this release is banned */
	isBanned: boolean;

	/** Reasons for ban if applicable */
	bannedReasons: string[];

	/** Whether this release was rejected due to file size */
	sizeRejected: boolean;

	/** Reason for size rejection if applicable */
	sizeRejectionReason?: string;

	/** Whether this release was rejected due to protocol mismatch */
	protocolRejected: boolean;

	/** Reason for protocol rejection if applicable */
	protocolRejectionReason?: string;
}

/**
 * A matched format with its calculated score
 */
export interface ScoredFormat {
	/** The format that matched */
	format: CustomFormat;

	/** Individual condition results */
	conditionResults: ConditionMatchResult[];

	/** Score assigned by the profile */
	score: number;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Score value used to effectively ban/reject a release
 */
export const BANNED_SCORE = -999999;

/**
 * Default resolution fallback order (all profiles use this)
 */
export const DEFAULT_RESOLUTION_ORDER: Resolution[] = ['2160p', '1080p', '720p', '480p', 'unknown'];

/**
 * Default pack preference settings
 * Gives significant bonus to packs to prioritize them over individual episodes
 */
export const DEFAULT_PACK_PREFERENCE: PackPreference = {
	enabled: true,
	completeSeriesBonus: 100, // Complete series packs get highest bonus
	multiSeasonBonus: 75, // Multi-season packs (S01-S03 etc)
	singleSeasonBonus: 50, // Single season packs
	minWantedEpisodesPercent: 50 // At least 50% of pack episodes should be wanted
};

/**
 * Calculate pack bonus for a release based on its pack type
 * @param isSeasonPack - Whether the release is a season pack
 * @param isCompleteSeries - Whether the release is a complete series
 * @param seasonCount - Number of seasons in the pack (for multi-season detection)
 * @param packPreference - Pack preference settings from the profile
 * @returns The pack bonus score to add
 */
export function calculatePackBonus(
	isSeasonPack: boolean | undefined,
	isCompleteSeries: boolean | undefined,
	seasonCount: number | undefined,
	packPreference?: PackPreference
): number {
	// Use default if not provided
	const prefs = packPreference ?? DEFAULT_PACK_PREFERENCE;

	// If disabled, no bonus
	if (!prefs.enabled) {
		return 0;
	}

	// Complete series gets highest bonus
	if (isCompleteSeries) {
		return prefs.completeSeriesBonus;
	}

	// Multi-season pack (2+ seasons)
	if (isSeasonPack && seasonCount && seasonCount >= 2) {
		return prefs.multiSeasonBonus;
	}

	// Single season pack
	if (isSeasonPack) {
		return prefs.singleSeasonBonus;
	}

	// Individual episode - no bonus
	return 0;
}

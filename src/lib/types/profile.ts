/**
 * Quality Profile Types
 *
 * Types for managing quality profiles
 */

import type { Resolution } from '#lib/server/scoring/types.js';

// =============================================================================
// Scoring Profile Types
// =============================================================================

/**
 * Profile category for UI grouping and styling
 */
type ProfileCategory = 'quality' | 'efficient' | 'micro' | 'streaming' | 'anime' | 'custom';

/**
 * A single entry in the required formats list.
 * AND entries must all match; OR entries need at least one match.
 */
export interface RequiredFormatEntry {
	id: string;
	op: 'AND' | 'OR';
}

/**
 * Base scoring profile structure
 *
 * Profiles are standalone - they define complete format->score mappings
 * without any runtime inheritance from base profiles.
 */
export interface ScoringProfile {
	id: string;
	name: string;
	description: string;
	tags: string[];
	/** Icon name for UI display (lucide icon) */
	icon?: string;
	/** Color class for UI display (e.g., 'text-yellow-500') */
	color?: string;
	/** Category for grouping in the UI */
	category?: ProfileCategory;
	upgradesAllowed: boolean;
	preventDowngrades: boolean;
	minScore: number;
	upgradeUntilScore: number;
	minScoreIncrement: number;
	resolutionOrder: Resolution[];
	/** Format score mappings (formatId -> score). All scores are defined here. */
	formatScores: Record<string, number>;
	/** Required format entries. AND entries all must match; OR entries need at least one match. */
	requiredFormats?: RequiredFormatEntry[];
	/**
	 * Indexer IDs this profile may search. `null` means all indexers; a non-empty
	 * array restricts searches and grabs to those indexers.
	 */
	allowedIndexerIds?: string[] | null;
	isDefault: boolean;
	isBuiltIn?: boolean;
	// Media-specific file size limits
	movieMinSizeGb?: number | null;
	movieMaxSizeGb?: number | null;
	episodeMinSizeMb?: number | null;
	episodeMaxSizeMb?: number | null;
	createdAt?: string;
	updatedAt?: string;
	/** Music profiles are rows in the same table, tagged by media kind. */
	mediaKind?: 'video' | 'music';
	/** Ordered ladder for a music profile; absent on video profiles. */
	musicTiers?: ProfileMusicTier[];
	/** Music's fallback switch; distinct from video's upgradesAllowed. */
	allowFallback?: boolean;
	musicMinSizeMb?: number | null;
	musicMaxSizeMb?: number | null;
}

/** One rung of a music quality ladder, as the shared profile UI edits it. */
export interface ProfileMusicTier {
	kind: 'lossless' | 'lossy' | 'streaming';
	label: string;
	formats?: string[];
	minBitrateKbps?: number;
	minBitDepth?: number;
}

/**
 * Form data for creating/updating scoring profiles
 */
export interface QualityProfileOption {
	id: string;
	name: string;
	description: string;
	isBuiltIn: boolean;
	isDefault: boolean;
}

export interface ScoringProfileFormData {
	id?: string;
	name?: string;
	description?: string;
	/** Copy format scores from this profile (built-in or custom ID) */
	copyFromId?: string;
	tags?: string[];
	upgradesAllowed?: boolean;
	preventDowngrades?: boolean;
	minScore?: number;
	upgradeUntilScore?: number;
	minScoreIncrement?: number;
	resolutionOrder?: Resolution[];
	formatScores?: Record<string, number>;
	requiredFormats?: RequiredFormatEntry[];
	/** Indexer IDs to restrict this profile to; `null`/absent means all indexers. */
	allowedIndexerIds?: string[] | null;
	isDefault?: boolean;
	movieMinSizeGb?: number | null;
	movieMaxSizeGb?: number | null;
	episodeMinSizeMb?: number | null;
	episodeMaxSizeMb?: number | null;
	/** Music rows carry their kind and ladder through the same form. */
	mediaKind?: 'video' | 'music';
	musicTiers?: ProfileMusicTier[];
	musicAllowFallback?: boolean;
	musicMinSizeMb?: number | null;
	musicMaxSizeMb?: number | null;
}

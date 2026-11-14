/**
 * Specification pattern types for monitoring decision-making
 * Based on Radarr/Sonarr architecture
 */

import type {
	movies,
	movieFiles,
	series,
	episodes,
	episodeFiles,
	scoringProfiles
} from '#lib/server/db/schema.js';

/**
 * Result of a specification evaluation
 */
export interface SpecificationResult {
	accepted: boolean;
	reason?: string;
}

/**
 * Context for movie-related monitoring decisions
 */
export interface MovieContext {
	movie: typeof movies.$inferSelect;
	existingFile?: typeof movieFiles.$inferSelect | null;
	profile?: typeof scoringProfiles.$inferSelect | null;
}

/**
 * Context for episode-related monitoring decisions
 */
export interface EpisodeContext {
	series: typeof series.$inferSelect;
	episode: typeof episodes.$inferSelect;
	existingFile?: typeof episodeFiles.$inferSelect | null;
	profile?: typeof scoringProfiles.$inferSelect | null;
}

/**
 * Release candidate being evaluated
 */
export interface ReleaseCandidate {
	title: string;
	score: number;
	size?: number;
	quality?: {
		resolution?: string;
		source?: string;
		codec?: string;
		hdr?: string;
	};
	indexerId?: string;
	infoHash?: string;
	downloadUrl?: string;
	magnetUrl?: string;
	protocol?: 'torrent' | 'usenet' | 'streaming';
}

/**
 * Base specification interface
 * All monitoring specifications implement this pattern
 */
export interface IMonitoringSpecification<TContext> {
	/**
	 * Check if the specification is satisfied for the given context
	 */
	isSatisfied(context: TContext, release?: ReleaseCandidate): Promise<SpecificationResult>;
}

/**
 * Rejection reasons for better tracking
 */
export enum RejectionReason {
	// Monitoring status
	NOT_MONITORED = 'not_monitored',
	SERIES_NOT_MONITORED = 'series_not_monitored',
	SEASON_NOT_MONITORED = 'season_not_monitored',
	SEASON_LINK_MISSING = 'season_link_missing',

	// Quality/Upgrade
	QUALITY_NOT_BETTER = 'quality_not_better',
	IMPROVEMENT_TOO_SMALL = 'improvement_too_small',
	ALREADY_AT_CUTOFF = 'already_at_cutoff',
	UPGRADES_NOT_ALLOWED = 'upgrades_not_allowed',
	RESOLUTION_DOWNGRADE = 'resolution_downgrade',

	// Availability
	ALREADY_HAS_FILE = 'already_has_file',
	NOT_YET_AIRED = 'not_yet_aired',

	// Storage
	READ_ONLY_FOLDER = 'read_only_folder',

	// Other
	NO_PROFILE = 'no_profile',
	UNKNOWN = 'unknown'
}

/**
 * Human-readable sentence for a RejectionReason enum value, for surfacing to
 * users (e.g. the Searches tab's reason column/timeline) instead of the raw
 * enum code. Falls back to the input unchanged for reasons already written
 * as a sentence (e.g. BlocklistSpecification) or not in this map.
 */
const REJECTION_REASON_LABELS: Partial<Record<RejectionReason, string>> = {
	[RejectionReason.QUALITY_NOT_BETTER]: 'No upgrades found - existing file quality is sufficient',
	[RejectionReason.IMPROVEMENT_TOO_SMALL]:
		'No upgrades found - best candidate did not meet the minimum improvement threshold',
	[RejectionReason.ALREADY_AT_CUTOFF]: 'Already at quality cutoff - no upgrade needed',
	[RejectionReason.UPGRADES_NOT_ALLOWED]: 'Upgrades are disabled for this quality profile',
	[RejectionReason.RESOLUTION_DOWNGRADE]: 'Best candidate would downgrade resolution',
	[RejectionReason.ALREADY_HAS_FILE]: 'Already has a file',
	[RejectionReason.NOT_YET_AIRED]: 'Not yet aired',
	[RejectionReason.READ_ONLY_FOLDER]: 'Target folder is read-only',
	[RejectionReason.NO_PROFILE]: 'No quality profile assigned',
	[RejectionReason.NOT_MONITORED]: 'Not monitored',
	[RejectionReason.SERIES_NOT_MONITORED]: 'Series is not monitored',
	[RejectionReason.SEASON_NOT_MONITORED]: 'Season is not monitored',
	[RejectionReason.SEASON_LINK_MISSING]: 'Season link is missing'
};

export function describeRejectionReason(reason: string | undefined): string | undefined {
	if (!reason) return reason;
	return REJECTION_REASON_LABELS[reason as RejectionReason] ?? reason;
}

/**
 * Helper to create rejection result
 */
export function reject(reason: RejectionReason | string): SpecificationResult {
	return {
		accepted: false,
		reason
	};
}

/**
 * Helper to create acceptance result
 */
export function accept(): SpecificationResult {
	return {
		accepted: true
	};
}

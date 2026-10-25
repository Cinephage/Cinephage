/**
 * Types for indexer management UI
 *
 * Re-exports canonical types from server for UI consumption.
 * Also defines UI-specific types that don't belong in the server.
 */

// =============================================================================
// RE-EXPORT CANONICAL TYPES FROM SERVER
// =============================================================================

// Core types
export type {
	IndexerProtocol,
	IndexerAccessType,
	TorrentProtocolSettings,
	UsenetProtocolSettings,
	StreamingProtocolSettings
} from '#lib/server/indexers/types/index.js';

// Definition types
export type {
	SettingField,
	IndexerCapabilities as ServerIndexerCapabilities,
	BaseIndexerDefinition
} from '#lib/server/indexers/types/index.js';

// Loader types (for UI components)
export type { UIDefinitionSetting as DefinitionSetting } from '#lib/server/indexers/loader/types.js';

// Config types
export type {
	IndexerConfig,
	IndexerStatus as ServerIndexerStatus
} from '#lib/server/indexers/types/index.js';

// =============================================================================
// UI-SPECIFIC TYPES
// =============================================================================

/**
 * UI-friendly capabilities (simplified from server version)
 */
export interface IndexerCapabilities {
	search?: {
		available: boolean;
		supportedParams: string[];
	};
	movieSearch?: {
		available: boolean;
		supportedParams: string[];
	};
	tvSearch?: {
		available: boolean;
		supportedParams: string[];
	};
	categories?: Record<string, string>;
	limits?: {
		default: number;
		max: number;
	};
	flags?: {
		supportsInfoHash?: boolean;
		supportsPagination?: boolean;
	};
}

/**
 * UI hints for dynamic form rendering.
 * Computed based on indexer type, protocol, and settings.
 */
export interface IndexerUIHints {
	/** Whether this indexer requires authentication (based on type and settings) */
	requiresAuth: boolean;
	/** Whether to show torrent-specific settings (seed ratio, min seeders, etc.) */
	showTorrentSettings: boolean;
	/** Whether to show usenet-specific settings */
	showUsenetSettings: boolean;
	/** Whether this is a streaming indexer */
	isStreaming: boolean;
}

import type { IndexerAccessType, IndexerProtocol } from '#lib/server/indexers/types/index.js';
import type { UIDefinitionSetting } from '#lib/server/indexers/loader/types.js';

/**
 * Simplified indexer definition from /api/indexers/definitions
 */
export interface IndexerDefinition {
	id: string;
	name: string;
	description?: string;
	type: IndexerAccessType;
	protocol: IndexerProtocol;
	siteUrl: string;
	/** Known alternate/mirror URLs from definition */
	alternateUrls: string[];
	/** Whether this definition comes from the custom definitions folder */
	isCustom?: boolean;
	capabilities: IndexerCapabilities;
	settings: UIDefinitionSetting[];
	/** Pre-computed UI hints for dynamic form rendering */
	uiHints?: IndexerUIHints;
}

/**
 * Compute UI hints for an indexer definition
 */
export function computeUIHints(
	definition: Pick<IndexerDefinition, 'type' | 'protocol' | 'settings'>
): IndexerUIHints {
	const hasAuthSettings =
		definition.settings?.some(
			(s) => s.type === 'password' || s.type === 'text' || s.name === 'cookie'
		) ?? false;

	return {
		requiresAuth:
			(definition.type === 'private' || definition.type === 'semi-private') && hasAuthSettings,
		showTorrentSettings: definition.protocol === 'torrent',
		showUsenetSettings: definition.protocol === 'usenet',
		isStreaming: definition.protocol === 'streaming'
	};
}

/**
 * Configured indexer from database
 */
export interface Indexer {
	id: string;
	name: string;
	definitionId: string;
	enabled: boolean;
	/** null = not Prowlarr-managed; false = disabled in Prowlarr (locked out in Cinephage) */
	upstreamEnabled?: boolean | null;
	/** True when sync detected this indexer no longer exists in the upstream service */
	orphaned?: boolean;
	/** True for system-owned indexers (e.g. cinephage-stream). Non-deletable, restricted editing. */
	isBuiltIn?: boolean;
	baseUrl: string;
	/** Alternative/fallback URLs (tried in order if primary fails) */
	alternateUrls: string[];
	priority: number;
	/** User override for max requests/minute sent to this indexer. Null = use definition/default. */
	rateLimitPerMinute?: number | null;
	protocol: IndexerProtocol;
	settings?: Record<string, string> | null;
	sensitiveSettings?: Record<string, boolean>;

	// Search capability toggles
	enableAutomaticSearch: boolean;
	enableInteractiveSearch: boolean;

	// Torrent seeding settings (only applicable when protocol === 'torrent')
	minimumSeeders?: number;
	seedRatio?: string | null; // Decimal stored as string (e.g., "1.0")
	seedTime?: number | null; // Minutes
	packSeedTime?: number | null; // Minutes for season packs
	rejectDeadTorrents?: boolean; // Reject torrents with 0 seeders

	// Usenet settings (only applicable when protocol === 'usenet')
	rejectPasswordProtected?: boolean;
	minimumCompletionPercentage?: number;

	// Newznab/Torznab category data
	/** Categories available on this indexer, populated after first caps fetch. */
	cachedCategories?: { id: string; name: string; subCategories?: { id: string; name: string }[] }[];
	/** Extra category IDs to include in all searches beyond content-type defaults. */
	additionalCategories?: number[];
}

/**
 * Indexer status from status tracker (runtime health info)
 */
export interface IndexerStatus {
	healthy: boolean;
	enabled: boolean;
	consecutiveFailures: number;
	lastFailure?: string;
	disabledUntil?: string;
	/** Why the indexer is currently auto-disabled, if it is */
	disabledReason?: 'consecutive_failures' | 'quota_exceeded' | 'manual';
	/** Message from the most recent failure, e.g. the indexer's own quota-exceeded text */
	lastFailureMessage?: string;
	averageResponseTime?: number;
}

/**
 * Combined indexer with status for UI display
 */
export interface IndexerWithStatus extends Indexer {
	status?: IndexerStatus;
	definitionName?: string;
}

/**
 * Form data for creating/updating indexer.
 *
 * Note: The `protocol` field is used client-side for UI purposes (showing protocol-specific
 * settings). The server ignores this field and derives protocol from the YAML definition.
 */
export interface IndexerFormData {
	name: string;
	definitionId: string;
	baseUrl: string;
	/** Alternative/fallback URLs */
	alternateUrls: string[];
	enabled: boolean;
	priority: number;
	/** User override for max requests/minute sent to this indexer. Null = use definition/default. */
	rateLimitPerMinute?: number | null;
	/**
	 * Protocol derived from definition - used client-side for UI hints.
	 * Server ignores this and gets protocol from the YAML definition.
	 */
	protocol: IndexerProtocol;
	settings: Record<string, string>;

	// Search capability toggles
	enableAutomaticSearch: boolean;
	enableInteractiveSearch: boolean;

	// Torrent seeding settings
	minimumSeeders: number;
	seedRatio?: string | null;
	seedTime?: number | null;
	packSeedTime?: number | null;
	rejectDeadTorrents: boolean;

	// Usenet settings
	rejectPasswordProtected?: boolean;
	minimumCompletionPercentage?: number;

	// Newznab/Torznab category overrides
	additionalCategories?: number[];
}

/**
 * Filter state for indexer table
 */
export interface IndexerFilters {
	protocol: IndexerProtocol | 'all';
	status: 'all' | 'enabled' | 'disabled';
	search: string;
}

/**
 * Sort state for indexer table
 */
export interface IndexerSort {
	column: 'name' | 'priority' | 'protocol' | 'enabled';
	direction: 'asc' | 'desc';
}

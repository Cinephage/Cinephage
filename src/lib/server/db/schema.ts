import {
	blob,
	integer,
	real,
	sqliteTable,
	text,
	primaryKey,
	index,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ProtocolSettings } from '#lib/server/indexers/types/index.js';
import type { NewznabCategory } from '#lib/server/indexers/newznab/types.js';
import type { DesiredQuality } from '#lib/types/library.js';
import type { AudioPreference, SubtitleRequirement } from '#lib/shared/language-profile.js';
import type { EpgLocalizedText } from '#lib/types/livetv.js';

// ============================================================================
// Better Auth Tables
// ============================================================================
// These tables are managed by us in schema-sync.ts for full control
// Column names use camelCase as Better Auth expects

export const user = sqliteTable(
	'user',
	{
		id: text('id').primaryKey(),
		name: text('name'),
		email: text('email').notNull(),
		emailVerified: integer('emailVerified').default(0),
		image: text('image'),
		username: text('username').unique(),
		displayUsername: text('displayUsername'),
		role: text('role').default('user').notNull(),
		language: text('language').default('en'),
		banned: integer('banned').default(0),
		banReason: text('banReason'),
		banExpires: text('banExpires'),
		createdAt: text('createdAt').notNull(),
		updatedAt: text('updatedAt').notNull(),
		// Mirrors the most recent session.lastActiveAt write (see touchLastActive
		// in session-helpers.ts), but on the user row so it survives a session
		// being revoked/deleted — the admin users list needs this to still mean
		// something for an account with zero current sessions.
		lastActiveAt: text('lastActiveAt')
	},
	(table) => [
		uniqueIndex('idx_user_email').on(table.email),
		uniqueIndex('idx_user_username').on(table.username)
	]
);

export type UserRecord = typeof user.$inferSelect;
export type NewUserRecord = typeof user.$inferInsert;

export const session = sqliteTable(
	'session',
	{
		id: text('id').primaryKey(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		token: text('token').notNull().unique(),
		expiresAt: text('expiresAt').notNull(),
		ipAddress: text('ipAddress'),
		userAgent: text('userAgent'),
		impersonatedBy: text('impersonatedBy'),
		createdAt: text('createdAt').notNull(),
		updatedAt: text('updatedAt').notNull(),
		// Updated on a throttle (see touchLastActive in session-helpers.ts), unlike
		// updatedAt which better-auth only refreshes once per session.updateAge.
		lastActiveAt: text('lastActiveAt')
	},
	(table) => [index('idx_session_user').on(table.userId)]
);

export const account = sqliteTable(
	'account',
	{
		id: text('id').primaryKey(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accountId: text('accountId').notNull(),
		providerId: text('providerId').notNull(),
		accessToken: text('accessToken'),
		refreshToken: text('refreshToken'),
		accessTokenExpiresAt: text('accessTokenExpiresAt'),
		refreshTokenExpiresAt: text('refreshTokenExpiresAt'),
		scope: text('scope'),
		idToken: text('idToken'),
		password: text('password'),
		createdAt: text('createdAt').notNull(),
		updatedAt: text('updatedAt').notNull()
	},
	(table) => [
		index('idx_account_user').on(table.userId),
		uniqueIndex('idx_account_provider').on(table.providerId, table.accountId)
	]
);

export const verification = sqliteTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: text('expiresAt').notNull(),
	createdAt: text('createdAt'),
	updatedAt: text('updatedAt')
});

export type SessionRecord = typeof session.$inferSelect;
export type NewSessionRecord = typeof session.$inferInsert;
export type AccountRecord = typeof account.$inferSelect;
export type NewAccountRecord = typeof account.$inferInsert;
export type VerificationRecord = typeof verification.$inferSelect;
export type NewVerificationRecord = typeof verification.$inferInsert;

export const authApiKeys = sqliteTable(
	'apikey',
	{
		id: text('id').primaryKey(),
		name: text('name'),
		start: text('start'),
		prefix: text('prefix'),
		key: text('key').notNull(),
		referenceId: text('referenceId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		configId: text('configId').default('default'),
		refillInterval: integer('refillInterval'),
		refillAmount: integer('refillAmount'),
		lastRefillAt: text('lastRefillAt'),
		enabled: integer('enabled').default(1),
		rateLimitEnabled: integer('rateLimitEnabled').default(1),
		rateLimitTimeWindow: integer('rateLimitTimeWindow'),
		rateLimitMax: integer('rateLimitMax'),
		requestCount: integer('requestCount').default(0),
		remaining: integer('remaining'),
		lastRequest: text('lastRequest'),
		expiresAt: text('expiresAt'),
		createdAt: text('createdAt').notNull(),
		updatedAt: text('updatedAt').notNull(),
		permissions: text('permissions'),
		metadata: text('metadata')
	},
	(table) => [
		index('idx_apikey_reference').on(table.referenceId),
		index('idx_apikey_key').on(table.key)
	]
);

export const authRateLimits = sqliteTable('rateLimit', {
	id: text('id').primaryKey(),
	key: text('key').notNull().unique(),
	count: integer('count').notNull(),
	lastRequest: integer('lastRequest').notNull()
});

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

// ============================================================================
// Indexers - User-configured indexer instances
// ============================================================================

/**
 * Indexers - User-configured indexer instances.
 * Each row represents a configured indexer that references a definition.
 */
export const indexers = sqliteTable(
	'indexers',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// User-given display name
		name: text('name').notNull(),
		// Reference to the YAML definition ID
		definitionId: text('definition_id').notNull(),
		// Enable/disable toggle (user preference)
		enabled: integer('enabled', { mode: 'boolean' }).default(true),
		// Upstream enabled state mirrored from Prowlarr on each sync.
		// null = not managed by an upstream source (Jackett, manual) - treated as true.
		// false = Prowlarr has this indexer disabled; Cinephage locks it out regardless of `enabled`.
		upstreamEnabled: integer('upstream_enabled', { mode: 'boolean' }),
		// True when sync detected the indexer is no longer present in the upstream service
		// (Prowlarr or Jackett). Soft-marks rather than hard-deletes so the user sees a
		// "Deleted" badge and can manually remove or re-enable after testing.
		orphaned: integer('orphaned', { mode: 'boolean' }).default(false),
		// True for indexers owned by a built-in subsystem (e.g. the CinephageAPI
		// library-streaming module owns the 'cinephage-stream' row). These rows
		// are non-deletable via the indexers page; their config is managed by
		// the owning subsystem. Matches the isBuiltIn convention on
		// scoringProfiles (schema.ts:401) and namingPresets (schema.ts:1195).
		isBuiltIn: integer('is_built_in', { mode: 'boolean' }).notNull().default(false),
		// Selected base URL (from definition's urls array)
		baseUrl: text('base_url').notNull(),
		// Alternate URLs for failover (JSON array)
		alternateUrls: text('alternate_urls', { mode: 'json' }).$type<string[]>(),
		// Priority for search ordering (lower = higher priority)
		priority: integer('priority').default(25),
		// Search toggles
		enableAutomaticSearch: integer('enable_automatic_search', { mode: 'boolean' }).default(true),
		enableInteractiveSearch: integer('enable_interactive_search', { mode: 'boolean' }).default(
			true
		),
		// User-provided settings values (apiKey, cookie, custom fields, etc.)
		settings: text('settings', { mode: 'json' }).$type<Record<string, string | boolean | number>>(),
		// Protocol-specific settings (JSON - one of the protocol settings types)
		protocolSettings: text('protocol_settings', { mode: 'json' }).$type<ProtocolSettings>(),
		// Categories reported by the indexer's live caps endpoint (Newznab/Torznab only).
		// Refreshed on every successful caps fetch; used to populate the category picker in settings UI.
		cachedCategories: text('cached_categories', { mode: 'json' }).$type<NewznabCategory[]>(),
		// Extra Newznab category IDs the user wants included in all searches for this indexer,
		// on top of the content-type defaults (e.g. [8000, 8010] to catch Other/Misc releases).
		additionalCategories: text('additional_categories', { mode: 'json' }).$type<number[]>(),
		// User override for max requests/minute sent to this indexer. Overrides the
		// definition's `requestdelay` (if any) and the generic default. Null = use
		// definition/default behavior. Protects real account API quotas (especially
		// Usenet indexers) from being exceeded by a large automatic/manual search.
		rateLimitPerMinute: integer('rate_limit_per_minute'),
		// Timestamps
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_indexers_definition').on(table.definitionId),
		index('idx_indexers_enabled').on(table.enabled)
	]
);

export type IndexerRecord = typeof indexers.$inferSelect;
export type NewIndexerRecord = typeof indexers.$inferInsert;

/**
 * Indexer Status - Persists health, failures, and backoff state across restarts.
 * Tracks indexer reliability and auto-disables failing indexers with exponential backoff.
 */
export const indexerStatus = sqliteTable(
	'indexer_status',
	{
		indexerId: text('indexer_id')
			.primaryKey()
			.references(() => indexers.id, { onDelete: 'cascade' }),

		// Health state
		health: text('health', { enum: ['healthy', 'warning', 'failing', 'disabled'] })
			.notNull()
			.default('healthy'),

		// Failure tracking
		consecutiveFailures: integer('consecutive_failures').notNull().default(0),
		totalRequests: integer('total_requests').notNull().default(0),
		totalFailures: integer('total_failures').notNull().default(0),

		// Auto-disable state
		isDisabled: integer('is_disabled', { mode: 'boolean' }).notNull().default(false),
		disabledAt: text('disabled_at'),
		disabledUntil: text('disabled_until'),
		// Why isDisabled is set: 'consecutive_failures' | 'quota_exceeded' | 'manual'.
		// Lets the UI distinguish "the indexer told us its quota is exhausted" (expected,
		// self-clearing) from "we can't reach it" (a real health problem).
		disabledReason: text('disabled_reason'),

		// Last activity
		lastSuccess: text('last_success'),
		lastFailure: text('last_failure'),
		// Last error message for quick diagnostics
		lastErrorMessage: text('last_error_message'),

		// Performance metrics
		avgResponseTime: integer('avg_response_time'),

		// Recent failures as JSON array (max 10)
		recentFailures: text('recent_failures', { mode: 'json' })
			.$type<Array<{ timestamp: string; message: string; requestUrl?: string }>>()
			.default([]),

		// Session cookies for persistent authentication (e.g., ncore 2FA sessions)
		cookies: text('cookies', { mode: 'json' }).$type<Record<string, string>>(),
		cookiesExpirationDate: text('cookies_expiration_date'),

		// Timestamps
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [index('idx_indexer_status_health').on(table.health, table.isDisabled)]
);

export type IndexerStatusRecord = typeof indexerStatus.$inferSelect;
export type NewIndexerStatusRecord = typeof indexerStatus.$inferInsert;

// ============================================================================
// Relations for indexer status
// ============================================================================
export const indexerStatusRelations = relations(indexerStatus, ({ one }) => ({
	indexer: one(indexers, {
		fields: [indexerStatus.indexerId],
		references: [indexers.id]
	})
}));

// Relations for indexers to status
export const indexersRelations = relations(indexers, ({ one }) => ({
	status: one(indexerStatus, {
		fields: [indexers.id],
		references: [indexerStatus.indexerId]
	})
}));

/**
 * Scoring Profiles - Custom profiles that configure how releases are scored
 *
 * Built on the scoring engine foundation. Each profile assigns scores to
 * formats (resolution, source, audio, HDR, release groups, etc.) that
 * determine release quality rankings.
 *
 * Built-in profiles (Quality, Balanced, Compact, Streamer) are defined in code
 * and serve as templates. Custom profiles are stored here and are standalone
 * (no runtime inheritance). Users can create custom profiles from scratch or
 * by copying from built-in or other custom profiles.
 */
export const scoringProfiles = sqliteTable('scoring_profiles', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	description: text('description'),
	// Tags for filtering/searching
	tags: text('tags', { mode: 'json' }).$type<string[]>(),
	// Whether upgrades are allowed with this profile
	upgradesAllowed: integer('upgrades_allowed', { mode: 'boolean' }).default(true),
	// Minimum score for a release to be accepted
	minScore: integer('min_score').default(0),
	// Score threshold to stop upgrading (-1 = never stop)
	upgradeUntilScore: integer('upgrade_until_score').default(-1),
	// Minimum score improvement to trigger upgrade
	minScoreIncrement: integer('min_score_increment').default(0),
	// Resolution fallback order as JSON array (highest priority first)
	// e.g., ['2160p', '1080p', '720p', '480p']
	resolutionOrder: text('resolution_order', { mode: 'json' }).$type<string[]>(),
	// Format score overrides (only stored if different from base profile)
	// Record<formatId, score>
	formatScores: text('format_scores', { mode: 'json' }).$type<Record<string, number>>(),
	// Allowed protocols for this profile (torrent, usenet, streaming)
	// Default: ['torrent', 'usenet'] - streaming only allowed in streaming profile
	allowedProtocols: text('allowed_protocols', { mode: 'json' }).$type<
		('torrent' | 'usenet' | 'streaming')[]
	>(),
	// Is this the default profile for new movies/shows
	isDefault: integer('is_default', { mode: 'boolean' }).default(false),
	// Media-specific file size limits (null = no limit)
	// Movie limits in GB
	movieMinSizeGb: real('movie_min_size_gb'),
	movieMaxSizeGb: real('movie_max_size_gb'),
	// Episode limits in MB (for per-episode validation, season packs use average)
	episodeMinSizeMb: real('episode_min_size_mb'),
	episodeMaxSizeMb: real('episode_max_size_mb'),
	isBuiltIn: integer('is_built_in', { mode: 'boolean' }).default(false),
	preventDowngrades: integer('prevent_downgrades', { mode: 'boolean' }).default(false),
	minResolution: text('min_resolution'),
	maxResolution: text('max_resolution'),
	allowedSources: text('allowed_sources', { mode: 'json' }).$type<string[] | null>(),
	excludedSources: text('excluded_sources', { mode: 'json' }).$type<string[] | null>(),
	requiredFormats: text('required_formats', { mode: 'json' }).$type<
		{ id: string; op: 'AND' | 'OR' }[]
	>(),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

/**
 * Profile Size Limits - User-configured overrides for built-in profiles
 *
 * Built-in profiles (Quality, Balanced, Compact, Streamer) are defined in code.
 * This table stores size limit overrides and default status for them.
 * Custom profiles store everything directly in the scoringProfiles table.
 */
export const profileSizeLimits = sqliteTable('profile_size_limits', {
	// Built-in profile ID (e.g., 'quality', 'balanced', 'compact', 'streamer')
	profileId: text('profile_id').primaryKey(),
	// Movie limits in GB
	movieMinSizeGb: real('movie_min_size_gb'),
	movieMaxSizeGb: real('movie_max_size_gb'),
	// Episode limits in MB
	episodeMinSizeMb: real('episode_min_size_mb'),
	episodeMaxSizeMb: real('episode_max_size_mb'),
	// Is this the default profile
	isDefault: integer('is_default', { mode: 'boolean' }).default(false),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

export type ProfileSizeLimitsRecord = typeof profileSizeLimits.$inferSelect;
export type NewProfileSizeLimitsRecord = typeof profileSizeLimits.$inferInsert;

/**
 * Built-in Profile Score Overrides - User-editable format score diffs for built-in profiles
 *
 * Built-in profiles (quality, balanced, compact, streamer) are defined in code.
 * This table stores only the diff: entries where the user changed the score from the shipped default.
 * Missing formatId = use the shipped default. Entry with default value = no override.
 */
export const builtInProfileScoreOverrides = sqliteTable('built_in_profile_score_overrides', {
	profileId: text('profile_id').primaryKey(),
	formatScores: text('format_scores', { mode: 'json' }).$type<Record<string, number>>(),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

export type BuiltInProfileScoreOverrideRecord = typeof builtInProfileScoreOverrides.$inferSelect;
export type NewBuiltInProfileScoreOverrideRecord = typeof builtInProfileScoreOverrides.$inferInsert;

/**
 * Custom Formats - User-defined format matching rules
 *
 * These extend the built-in formats with custom conditions.
 * Each format has conditions that determine when it matches a release.
 */
export const customFormats = sqliteTable('custom_formats', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	description: text('description'),
	// Category for UI grouping
	category: text('category', {
		enum: [
			'resolution',
			'release_group_tier',
			'audio',
			'hdr',
			'streaming',
			'micro',
			'low_quality',
			'banned',
			'enhancement',
			'codec',
			'other'
		]
	})
		.notNull()
		.default('other'),
	// Tags for filtering/searching
	tags: text('tags', { mode: 'json' }).$type<string[]>(),
	// Conditions as JSON array (FormatCondition[])
	conditions: text('conditions', { mode: 'json' }).$type<
		Array<{
			name: string;
			type: string;
			required: boolean;
			negate: boolean;
			resolution?: string;
			source?: string;
			pattern?: string;
			codec?: string;
			audioCodec?: string;
			audioChannels?: string;
			hdr?: string | null;
			streamingService?: string;
			flag?: string;
		}>
	>(),
	// Whether this format is active
	enabled: integer('enabled', { mode: 'boolean' }).default(true),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

export type CustomFormatRecord = typeof customFormats.$inferSelect;
export type NewCustomFormatRecord = typeof customFormats.$inferInsert;

/**
 * External ID Cache - Cache TMDB external IDs (IMDB, TVDB) to reduce API calls
 */
export const externalIdCache = sqliteTable(
	'external_id_cache',
	{
		tmdbId: integer('tmdb_id').notNull(),
		mediaType: text('media_type').notNull(), // 'movie' | 'tv'
		imdbId: text('imdb_id'),
		tvdbId: integer('tvdb_id'),
		cachedAt: text('cached_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [primaryKey({ columns: [table.tmdbId, table.mediaType] })]
);

/**
 * Download Clients - Configuration for torrent/usenet download clients
 * Currently supports qBittorrent, extensible for Transmission, Deluge, etc.
 */
export const downloadClients = sqliteTable('download_clients', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	// Client type: 'qbittorrent', future: 'transmission', 'deluge', etc.
	implementation: text('implementation').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).default(true),

	// Connection settings
	host: text('host').notNull(),
	port: integer('port').notNull(),
	useSsl: integer('use_ssl', { mode: 'boolean' }).default(false),
	username: text('username'),
	password: text('password'),
	urlBase: text('url_base'),
	mountMode: text('mount_mode'),

	// Debrid provider settings (realdebrid, torbox)
	// Encrypted API token (encrypted with debridTokenCrypto, distinct from apiKeyCrypto)
	apiToken: text('api_token'),
	// Whether to remove the torrent from the debrid provider after import
	removeAfterImport: integer('remove_after_import', { mode: 'boolean' }).default(false),
	// Content-type restriction for debrid clients: which media types this client
	// may be selected for (e.g. Real-Debrid for movies, TorBox for TV). Ignored
	// by non-debrid clients, which use movieCategory/tvCategory instead.
	allowMovies: integer('allow_movies', { mode: 'boolean' }).default(true),
	allowTv: integer('allow_tv', { mode: 'boolean' }).default(true),

	// Category settings (separate for movie/tv)
	movieCategory: text('movie_category').default('movies'),
	tvCategory: text('tv_category').default('tv'),

	// Priority settings
	recentPriority: text('recent_priority').default('normal'), // 'normal' | 'high' | 'force'
	olderPriority: text('older_priority').default('normal'),
	initialState: text('initial_state').default('start'), // 'start' | 'pause' | 'force'

	// Seeding limits
	seedRatioLimit: text('seed_ratio_limit'), // Decimal as string
	seedTimeLimit: integer('seed_time_limit'), // Minutes
	sequentialDownload: integer('sequential_download', { mode: 'boolean' }).notNull().default(false),

	// Path mapping - local path as seen by Cinephage server
	downloadPathLocal: text('download_path_local'),
	// Client's reported path (for completed downloads)
	downloadPathRemote: text('download_path_remote'),
	// SABnzbd temp folder paths (for incomplete downloads)
	tempPathLocal: text('temp_path_local'),
	tempPathRemote: text('temp_path_remote'),

	priority: integer('priority').default(1),
	// Health status (persisted across restarts, updated by manual/runtime checks)
	health: text('health').default('healthy'), // 'healthy' | 'warning' | 'failing'
	consecutiveFailures: integer('consecutive_failures').default(0),
	lastSuccess: text('last_success'),
	lastFailure: text('last_failure'),
	lastFailureMessage: text('last_failure_message'),
	lastCheckedAt: text('last_checked_at'),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

/**
 * Root Folders - Media library destination folders (where Jellyfin looks for content)
 */
export const rootFolders = sqliteTable('root_folders', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	path: text('path').notNull().unique(),
	// Media type this folder is for
	mediaType: text('media_type').notNull(), // 'movie' | 'tv'
	// Optional subtype for organization/routing (e.g. anime)
	mediaSubType: text('media_sub_type').notNull().default('standard'), // 'standard' | 'anime'
	// Whether this is the default for its media type
	isDefault: integer('is_default', { mode: 'boolean' }).default(false),
	// Read-only folder (for virtual mounts like NZBDav - catalog only, no imports)
	readOnly: integer('read_only', { mode: 'boolean' }).default(false),
	// Preserve symlinks during import (for NZBDav/rclone - recreate symlinks instead of copying content)
	preserveSymlinks: integer('preserve_symlinks', { mode: 'boolean' }).default(false),
	// When true, content added by scan or manual match is monitored; when false, unmonitored (Issue #81)
	defaultMonitored: integer('default_monitored', { mode: 'boolean' }).default(true),
	// Cached free space in bytes (updated periodically)
	freeSpaceBytes: integer('free_space_bytes'),
	// Cached total disk capacity in bytes (added v105; populated by RootFolderService.refreshFreeSpace)
	totalSpaceBytes: integer('total_space_bytes'),
	// Last time free space was checked
	lastCheckedAt: text('last_checked_at'),
	// JSON string[] — folder names to skip during disk scan (case-insensitive exact match)
	skipFolderPatterns: text('skip_folder_patterns'),
	// JSON string[] — video file extensions to exclude from scan (e.g. [".webm"])
	blockedVideoExtensions: text('blocked_video_extensions'),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
});

/**
 * Libraries - First-class media library entities (system + user custom libraries)
 */
export const libraries = sqliteTable(
	'libraries',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		slug: text('slug').notNull().unique(),
		mediaType: text('media_type').notNull(), // 'movie' | 'tv'
		mediaSubType: text('media_sub_type').notNull().default('custom'), // 'standard' | 'anime' | 'custom'
		isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
		systemKey: text('system_key').unique(),
		isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
		defaultRootFolderId: text('default_root_folder_id').references(() => rootFolders.id, {
			onDelete: 'set null'
		}),
		defaultMonitored: integer('default_monitored', { mode: 'boolean' }).notNull().default(true),
		defaultSearchOnAdd: integer('default_search_on_add', { mode: 'boolean' })
			.notNull()
			.default(true),
		defaultWantsSubtitles: integer('default_wants_subtitles', { mode: 'boolean' })
			.notNull()
			.default(true),
		// Language profile inherited by media added to this library (null = instance default)
		languageProfileId: text('language_profile_id'),
		sortOrder: integer('sort_order').notNull().default(0),
		qualityProfileId: text('quality_profile_id').references(() => scoringProfiles.id, {
			onDelete: 'set null'
		}),
		scanMode: text('scan_mode').notNull().default('scheduled'), // 'manual' | 'scheduled' | 'scheduled_daily' | 'watch' (Phase 4)
		scanConfig: text('scan_config', { mode: 'json' }).$type<{
			intervalMinutes?: number;
			scheduledTime?: string;
			debounceSeconds?: number;
		}>(),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_libraries_media_type').on(table.mediaType),
		index('idx_libraries_media_sub_type').on(table.mediaSubType),
		index('idx_libraries_sort_order').on(table.sortOrder)
	]
);

export const libraryRootFolders = sqliteTable(
	'library_root_folders',
	{
		libraryId: text('library_id')
			.notNull()
			.references(() => libraries.id, { onDelete: 'cascade' }),
		rootFolderId: text('root_folder_id')
			.notNull()
			.references(() => rootFolders.id, { onDelete: 'cascade' }),
		isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		primaryKey({ columns: [table.libraryId, table.rootFolderId] }),
		index('idx_library_root_folders_library').on(table.libraryId),
		index('idx_library_root_folders_root_folder').on(table.rootFolderId)
	]
);

// ============================================================================
// MEDIA LIBRARY TABLES
// ============================================================================

/**
 * Movies - Movies added to the library (linked to TMDB)
 */
export const movies = sqliteTable(
	'movies',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		tmdbId: integer('tmdb_id').notNull().unique(),
		imdbId: text('imdb_id'),
		title: text('title').notNull(),
		originalTitle: text('original_title'),
		year: integer('year'),
		overview: text('overview'),
		posterPath: text('poster_path'),
		backdropPath: text('backdrop_path'),
		runtime: integer('runtime'), // Minutes
		genres: text('genres', { mode: 'json' }).$type<string[]>(),
		providerRefs: text('provider_refs', { mode: 'json' }).$type<
			Partial<Record<'tmdb' | 'mal' | 'anilist', string>>
		>(),
		// Path to the movie folder (relative to root folder)
		path: text('path').notNull(),
		libraryId: text('library_id').references(() => libraries.id, { onDelete: 'set null' }),
		rootFolderId: text('root_folder_id').references(() => rootFolders.id, { onDelete: 'set null' }),
		// Quality profile for scoring and filtering releases
		scoringProfileId: text('scoring_profile_id').references(() => scoringProfiles.id, {
			onDelete: 'set null'
		}),
		// Desired qualities for multi-quality mode (e.g. ['2160p', '1080p']).
		// When >= 2 effective buckets, the movie maintains independent files per
		// resolution tier; upgrades only replace the same-resolution file.
		// null/empty/<2 = single-quality mode (current behavior).
		desiredQualities: text('desired_qualities', { mode: 'json' }).$type<DesiredQuality[]>(),
		// Language profile for subtitle preferences (deferred reference - languageProfiles defined later)
		languageProfileId: text('language_profile_id'),
		// Per-item subtitle requirement override (null = inherit from the
		// profile chain); replaces only the profile's requirement list.
		subtitleRequirementsOverride: text('subtitle_requirements_override', {
			mode: 'json'
		}).$type<SubtitleRequirement[]>(),
		// Audio-language shortfall: probed audio contradicts the effective
		// audio preference (import verifier, phase D of the 2026-09-15 design).
		// Marks the item eligible for a better-language upgrade re-grab.
		languageShortfall: integer('language_shortfall', { mode: 'boolean' }).default(false),
		// Whether to monitor for upgrades
		monitored: integer('monitored', { mode: 'boolean' }).default(true),
		// Minimum availability before searching (announced, inCinemas, released)
		minimumAvailability: text('minimum_availability').default('released'),
		added: text('added').$defaultFn(() => new Date().toISOString()),
		// Cached: does this movie have a file?
		hasFile: integer('has_file', { mode: 'boolean' }).default(false),
		// Whether to search for subtitles for this movie
		wantsSubtitles: integer('wants_subtitles', { mode: 'boolean' }).default(true),
		// Last time this movie was searched for releases (ISO timestamp).
		// Still actively read/written by the release-search cooldown
		// (CooldownStage / SearchCooldownSpecification) — intentionally NOT
		// dropped by migration 142, unlike the per-item adaptive subtitle
		// columns that used to sit beside it.
		lastSearchTime: text('last_search_time'),
		tmdbCollectionId: integer('tmdb_collection_id'),
		collectionName: text('collection_name'),
		releaseDate: text('release_date'),
		downloadReleaseDate: text('download_release_date'),
		downloadReleaseType: text('download_release_type'),
		digitalReleaseDate: text('digital_release_date'),
		physicalReleaseDate: text('physical_release_date'),
		availabilityDelay: integer('availability_delay').notNull().default(0),
		adult: integer('adult', { mode: 'boolean' }).default(false),
		adultSource: text('adult_source'),
		adultConfidence: text('adult_confidence'),
		// Delay profile for holding releases before grabbing
		delayProfileId: text('delay_profile_id'),
		// Metadata language override (null = inherit global, 'original' = use original_language)
		metadataLanguage: text('metadata_language'),
		// Canonical original language from metadata (e.g. 'en', 'ja') — basis for 'original' modes
		originalLanguage: text('original_language'),
		// Metadata language mode: 'inherit' (global setting) | 'original' | 'explicit'
		metadataLanguageMode: text('metadata_language_mode').notNull().default('inherit'),
		// Explicit TMDB locale used when metadataLanguageMode is 'explicit'
		metadataLanguageValue: text('metadata_language_value'),
		// Display flag: use originalTitle instead of title in all UI
		preferOriginalTitle: integer('prefer_original_title', { mode: 'boolean' }).default(false)
	},
	(table) => [
		index('idx_movies_monitored_hasfile').on(table.monitored, table.hasFile),
		index('idx_movies_release_date').on(table.releaseDate),
		index('idx_movies_download_release_date').on(table.downloadReleaseDate)
	]
);

/**
 * Movie Files - Actual movie files on disk
 */
export const movieFiles = sqliteTable(
	'movie_files',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		movieId: text('movie_id')
			.notNull()
			.references(() => movies.id, { onDelete: 'cascade' }),
		// Path relative to the movie folder
		relativePath: text('relative_path').notNull(),
		// File size in bytes
		size: integer('size'),
		// When the file was added to library
		dateAdded: text('date_added').$defaultFn(() => new Date().toISOString()),
		// Scene name if detected
		sceneName: text('scene_name'),
		// Release group if detected
		releaseGroup: text('release_group'),
		// Parsed quality info as JSON
		quality: text('quality', { mode: 'json' }).$type<{
			resolution?: string;
			source?: string;
			codec?: string;
			hdr?: string;
		}>(),
		// MediaInfo extracted data
		mediaInfo: text('media_info', { mode: 'json' }).$type<{
			containerFormat?: string;
			videoCodec?: string;
			videoProfile?: string;
			videoBitrate?: number;
			videoBitDepth?: number;
			videoHdrFormat?: string;
			width?: number;
			height?: number;
			fps?: number;
			runtime?: number; // seconds
			audioCodec?: string;
			audioChannels?: number;
			audioBitrate?: number;
			audioLanguages?: string[];
			subtitleLanguages?: string[];
		}>(),
		// Edition info (Director's Cut, Extended, etc.)
		edition: text('edition'),
		// Languages detected in file
		languages: text('languages', { mode: 'json' }).$type<string[]>(),
		// Info hash of the torrent used to download this file (for duplicate detection)
		infoHash: text('info_hash'),
		lastSeenScanId: text('last_seen_scan_id'),
		// Content categorization: 'main' | 'bonus' (Phase 1 pattern recognition)
		contentCategory: text('content_category').notNull().default('main'),
		filenameSignature: text('filename_signature'),
		contentHash: text('content_hash'),
		contentHashAlgorithm: text('content_hash_algorithm')
	},
	(table) => [
		// One row per movie+path: re-grabs and streaming re-imports update the
		// existing row (migration 150 deduped legacy duplicates first).
		uniqueIndex('idx_movie_files_movie_path_unique').on(table.movieId, table.relativePath)
	]
);

/**
 * Series - TV series added to the library (linked to TMDB)
 */
export const series = sqliteTable(
	'series',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		tmdbId: integer('tmdb_id').notNull().unique(),
		tvdbId: integer('tvdb_id'),
		imdbId: text('imdb_id'),
		title: text('title').notNull(),
		originalTitle: text('original_title'),
		year: integer('year'), // First air year
		overview: text('overview'),
		posterPath: text('poster_path'),
		backdropPath: text('backdrop_path'),
		status: text('status'), // 'Continuing', 'Ended', 'Upcoming'
		network: text('network'),
		genres: text('genres', { mode: 'json' }).$type<string[]>(),
		providerRefs: text('provider_refs', { mode: 'json' }).$type<
			Partial<Record<'tmdb' | 'mal' | 'anilist', string>>
		>(),
		// Path to the series folder (relative to root folder)
		path: text('path').notNull(),
		libraryId: text('library_id').references(() => libraries.id, { onDelete: 'set null' }),
		rootFolderId: text('root_folder_id').references(() => rootFolders.id, { onDelete: 'set null' }),
		// Quality profile for scoring and filtering releases
		scoringProfileId: text('scoring_profile_id').references(() => scoringProfiles.id, {
			onDelete: 'set null'
		}),
		// Language profile for subtitle preferences (deferred reference - languageProfiles defined later)
		languageProfileId: text('language_profile_id'),
		// Per-item subtitle requirement override (null = inherit from the
		// profile chain); replaces only the profile's requirement list.
		subtitleRequirementsOverride: text('subtitle_requirements_override', {
			mode: 'json'
		}).$type<SubtitleRequirement[]>(),
		// Audio-language shortfall: probed audio contradicts the effective
		// audio preference (import verifier, phase D of the 2026-09-15 design).
		// Marks the item eligible for a better-language upgrade re-grab.
		languageShortfall: integer('language_shortfall', { mode: 'boolean' }).default(false),
		// Whether to monitor for new episodes
		monitored: integer('monitored', { mode: 'boolean' }).default(true),
		// How to handle new seasons/episodes added after initial add: 'all' | 'none'
		monitorNewItems: text('monitor_new_items').default('all'),
		// Whether to monitor specials (Season 0)
		monitorSpecials: integer('monitor_specials', { mode: 'boolean' }).default(false),
		// Use season folders (e.g., /Season 01/)
		seasonFolder: integer('season_folder', { mode: 'boolean' }).default(true),
		// Series type for episode naming/searching: 'standard', 'anime', 'daily'
		seriesType: text('series_type').default('standard'),
		added: text('added').$defaultFn(() => new Date().toISOString()),
		// Cached stats
		episodeCount: integer('episode_count').default(0),
		episodeFileCount: integer('episode_file_count').default(0),
		// Whether to search for subtitles for this series (inherited by episodes by default)
		wantsSubtitles: integer('wants_subtitles', { mode: 'boolean' }).default(true),
		firstAirDate: text('first_air_date'),
		adult: integer('adult', { mode: 'boolean' }).default(false),
		adultSource: text('adult_source'),
		adultConfidence: text('adult_confidence'),
		episodeGroupId: text('episode_group_id'),
		// Delay profile for holding releases before grabbing
		delayProfileId: text('delay_profile_id'),
		// Metadata language override (null = inherit global, 'original' = use original_language)
		metadataLanguage: text('metadata_language'),
		// Canonical original language from metadata (e.g. 'en', 'ja') — basis for 'original' modes
		originalLanguage: text('original_language'),
		// Metadata language mode: 'inherit' (global setting) | 'original' | 'explicit'
		metadataLanguageMode: text('metadata_language_mode').notNull().default('inherit'),
		// Explicit TMDB locale used when metadataLanguageMode is 'explicit'
		metadataLanguageValue: text('metadata_language_value'),
		// Display flag: use originalTitle instead of title in all UI
		preferOriginalTitle: integer('prefer_original_title', { mode: 'boolean' }).default(false)
	},
	(table) => [
		index('idx_series_monitored').on(table.monitored),
		index('idx_series_first_air_date').on(table.firstAirDate)
	]
);

/**
 * Seasons - TV seasons (for tracking monitoring per season)
 */
export const seasons = sqliteTable(
	'seasons',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		seriesId: text('series_id')
			.notNull()
			.references(() => series.id, { onDelete: 'cascade' }),
		seasonNumber: integer('season_number').notNull(),
		// Whether to monitor this season
		monitored: integer('monitored', { mode: 'boolean' }).default(true),
		// TMDB metadata
		name: text('name'),
		overview: text('overview'),
		posterPath: text('poster_path'),
		airDate: text('air_date'),
		// Cached stats
		episodeCount: integer('episode_count').default(0),
		episodeFileCount: integer('episode_file_count').default(0)
	},
	(table) => [uniqueIndex('idx_seasons_unique_number').on(table.seriesId, table.seasonNumber)]
);

/**
 * Episodes - Individual TV episodes
 */
export const episodes = sqliteTable(
	'episodes',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		seriesId: text('series_id')
			.notNull()
			.references(() => series.id, { onDelete: 'cascade' }),
		seasonId: text('season_id').references(() => seasons.id, { onDelete: 'set null' }),
		tmdbId: integer('tmdb_id'),
		tvdbId: integer('tvdb_id'),
		seasonNumber: integer('season_number').notNull(),
		episodeNumber: integer('episode_number').notNull(),
		absoluteEpisodeNumber: integer('absolute_episode_number'),
		title: text('title'),
		overview: text('overview'),
		airDate: text('air_date'),
		runtime: integer('runtime'), // Minutes
		// Whether to monitor this episode
		monitored: integer('monitored', { mode: 'boolean' }).default(true),
		// Cached: does this episode have a file?
		hasFile: integer('has_file', { mode: 'boolean' }).default(false),
		// Override series-level subtitle preference (null = inherit from series)
		wantsSubtitlesOverride: integer('wants_subtitles_override', { mode: 'boolean' }),
		// Per-episode subtitle requirement override (null = inherit via series).
		// Episodes still have no language profile of their own — only the
		// requirement list can vary from the series-level resolution.
		subtitleRequirementsOverride: text('subtitle_requirements_override', {
			mode: 'json'
		}).$type<SubtitleRequirement[]>(),
		// Last time this episode was searched for releases (ISO timestamp).
		// Still actively read/written by the release-search cooldown
		// (CooldownStage / SearchCooldownSpecification) — intentionally NOT
		// dropped by migration 142, unlike the per-item adaptive subtitle
		// columns that used to sit beside it.
		lastSearchTime: text('last_search_time')
	},
	(table) => [
		index('idx_episodes_series_season').on(table.seriesId, table.seasonNumber),
		uniqueIndex('idx_episodes_unique_number').on(
			table.seriesId,
			table.seasonNumber,
			table.episodeNumber
		),
		index('idx_episodes_monitored_hasfile').on(table.monitored, table.hasFile),
		index('idx_episodes_airdate').on(table.airDate)
	]
);

/**
 * Episode Files - Actual episode files on disk
 */
export const episodeFiles = sqliteTable(
	'episode_files',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		seriesId: text('series_id')
			.notNull()
			.references(() => series.id, { onDelete: 'cascade' }),
		seasonNumber: integer('season_number').notNull(),
		// Can contain multiple episodes (e.g., double episodes)
		episodeIds: text('episode_ids', { mode: 'json' }).$type<string[]>(),
		// Path relative to the series folder
		relativePath: text('relative_path').notNull(),
		// File size in bytes
		size: integer('size'),
		// When the file was added to library
		dateAdded: text('date_added').$defaultFn(() => new Date().toISOString()),
		// Scene name if detected
		sceneName: text('scene_name'),
		// Release group if detected
		releaseGroup: text('release_group'),
		// Edition info (IMAX, Extended, etc.)
		edition: text('edition'),
		// Release type (singleEpisode, multiEpisode, seasonPack, etc.)
		releaseType: text('release_type'),
		// Parsed quality info as JSON
		quality: text('quality', { mode: 'json' }).$type<{
			resolution?: string;
			source?: string;
			codec?: string;
			hdr?: string;
		}>(),
		// MediaInfo extracted data (same structure as movieFiles)
		mediaInfo: text('media_info', { mode: 'json' }).$type<{
			containerFormat?: string;
			videoCodec?: string;
			videoProfile?: string;
			videoBitrate?: number;
			videoBitDepth?: number;
			videoHdrFormat?: string;
			width?: number;
			height?: number;
			fps?: number;
			runtime?: number;
			audioCodec?: string;
			audioChannels?: number;
			audioBitrate?: number;
			audioLanguages?: string[];
			subtitleLanguages?: string[];
		}>(),
		// Languages detected in file
		languages: text('languages', { mode: 'json' }).$type<string[]>(),
		// Info hash of the torrent used to download this file (for duplicate detection)
		infoHash: text('info_hash'),
		lastSeenScanId: text('last_seen_scan_id'),
		// Content categorization: 'main' | 'bonus' (Phase 1 pattern recognition)
		contentCategory: text('content_category').notNull().default('main'),
		filenameSignature: text('filename_signature'),
		contentHash: text('content_hash'),
		contentHashAlgorithm: text('content_hash_algorithm')
	},
	(table) => [uniqueIndex('idx_episode_files_unique_path').on(table.seriesId, table.relativePath)]
);

// ============================================================================
// Alternate Titles - For multi-title search support
// ============================================================================

/**
 * Alternate Titles - Stores alternate/translated titles for movies and series.
 * Used to search with multiple title variants for better results on regional trackers.
 * Titles can be auto-fetched from TMDB or manually added by users.
 */
export const alternateTitles = sqliteTable(
	'alternate_titles',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		// Media type: 'movie' or 'series'
		mediaType: text('media_type', { enum: ['movie', 'series'] }).notNull(),
		// Foreign key to movies.id or series.id (text UUID)
		mediaId: text('media_id').notNull(),
		// The alternate title
		title: text('title').notNull(),
		// Normalized title for matching (lowercase, no special chars)
		cleanTitle: text('clean_title').notNull(),
		// Source of this title: 'tmdb' (auto-fetched), 'user' (manually added), or
		// 'anilist'/'mal' (anime provider title variants — migration 142)
		source: text('source', { enum: ['tmdb', 'user', 'anilist', 'mal'] }).notNull(),
		// ISO 639-1 language code (e.g., 'en', 'cs', 'de')
		language: text('language'),
		// ISO 3166-1 country code (e.g., 'US', 'CZ', 'DE')
		country: text('country'),
		// When this title was added
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_alternate_titles_media').on(table.mediaType, table.mediaId),
		index('idx_alternate_titles_source').on(table.source)
	]
);

export type AlternateTitle = typeof alternateTitles.$inferSelect;
export type NewAlternateTitle = typeof alternateTitles.$inferInsert;

/**
 * Unmatched Files - Files found on disk that couldn't be auto-matched
 */
export const unmatchedFiles = sqliteTable('unmatched_files', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	// Full path to the file
	path: text('path').notNull().unique(),
	rootFolderId: text('root_folder_id').references(() => rootFolders.id, { onDelete: 'cascade' }),
	// Media type based on root folder
	mediaType: text('media_type').notNull(), // 'movie' | 'tv'
	// File size in bytes
	size: integer('size'),
	// Parsed info from filename
	parsedTitle: text('parsed_title'),
	parsedYear: integer('parsed_year'),
	parsedSeason: integer('parsed_season'),
	parsedEpisode: integer('parsed_episode'),
	// Best guess TMDB matches as JSON array
	suggestedMatches: text('suggested_matches', { mode: 'json' }).$type<
		Array<{
			tmdbId: number;
			title: string;
			year?: number;
			confidence: number;
			scoreBreakdown?: {
				titleMatch: number;
				yearMatch: number;
				typeMatch: number;
				popularity: number;
			};
		}>
	>(),
	// Why it wasn't matched
	reason: text('reason'), // 'no_match' | 'low_confidence' | 'multiple_matches' | 'ambiguous' | 'parse_failed'
	// When discovered
	discoveredAt: text('discovered_at').$defaultFn(() => new Date().toISOString()),
	lastSeenScanId: text('last_seen_scan_id'),
	// Content categorization: 'main' | 'bonus' (Phase 1 pattern recognition)
	contentCategory: text('content_category').notNull().default('main'),
	filenameSignature: text('filename_signature'),
	contentHash: text('content_hash'),
	contentHashAlgorithm: text('content_hash_algorithm'),
	// Diagnostic fields (added in migration 128)
	correlationId: text('correlation_id'),
	ambiguityMargin: real('ambiguity_margin')
});

/**
 * Library Scan History - Track scan operations
 */
export const libraryScanHistory = sqliteTable('library_scan_history', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	// Type of scan
	scanType: text('scan_type').notNull(), // 'full', 'incremental', 'folder'
	// Scope of scan
	rootFolderId: text('root_folder_id').references(() => rootFolders.id, { onDelete: 'set null' }),
	// Status
	status: text('status').notNull(), // 'running', 'completed', 'failed', 'cancelled'
	// Timestamps
	startedAt: text('started_at').$defaultFn(() => new Date().toISOString()),
	completedAt: text('completed_at'),
	// Stats
	filesScanned: integer('files_scanned').default(0),
	filesAdded: integer('files_added').default(0),
	filesUpdated: integer('files_updated').default(0),
	filesRemoved: integer('files_removed').default(0),
	unmatchedFiles: integer('unmatched_files').default(0),
	// Error info if failed
	errorMessage: text('error_message')
});

export const libraryJobs = sqliteTable(
	'library_jobs',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		type: text('type').notNull(),
		status: text('status').notNull().default('queued'),
		rootFolderId: text('root_folder_id').references(() => rootFolders.id, { onDelete: 'set null' }),
		parentJobId: text('parent_job_id'),
		dedupeKey: text('dedupe_key'),
		phase: text('phase').notNull().default('queued'),
		progressCurrent: integer('progress_current').notNull().default(0),
		progressTotal: integer('progress_total'),
		filesFound: integer('files_found').notNull().default(0),
		filesProcessed: integer('files_processed').notNull().default(0),
		filesAdded: integer('files_added').notNull().default(0),
		filesUpdated: integer('files_updated').notNull().default(0),
		filesRemoved: integer('files_removed').notNull().default(0),
		unmatchedCount: integer('unmatched_count').notNull().default(0),
		errorMessage: text('error_message'),
		cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
		metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
		startedAt: text('started_at'),
		completedAt: text('completed_at'),
		acknowledgedAt: text('acknowledged_at'),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_library_jobs_status_created').on(table.status, table.createdAt),
		index('idx_library_jobs_type_status').on(table.type, table.status),
		index('idx_library_jobs_root_status').on(table.rootFolderId, table.status),
		uniqueIndex('idx_library_jobs_active_dedupe')
			.on(table.dedupeKey)
			.where(sql`${table.dedupeKey} IS NOT NULL AND ${table.status} IN ('queued', 'running')`)
	]
);

export const libraryJobItems = sqliteTable(
	'library_job_items',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		jobId: text('job_id')
			.notNull()
			.references(() => libraryJobs.id, { onDelete: 'cascade' }),
		status: text('status').notNull().default('queued'),
		kind: text('kind').notNull(),
		path: text('path'),
		rootFolderId: text('root_folder_id').references(() => rootFolders.id, { onDelete: 'set null' }),
		mediaType: text('media_type'),
		attempts: integer('attempts').notNull().default(0),
		errorMessage: text('error_message'),
		metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_library_job_items_job_status').on(table.jobId, table.status),
		index('idx_library_job_items_path').on(table.path)
	]
);

/**
 * Library Settings - Configuration for library scanning
 */
export const librarySettings = sqliteTable('library_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

/**
 * Naming Settings - Configuration for file and folder naming conventions
 * Follows TRaSH Guides naming recommendations for media server compatibility
 *
 * Settings keys:
 * - 'movie_folder_format': string - Format for movie folder names
 * - 'movie_file_format': string - Format for movie file names
 * - 'series_folder_format': string - Format for series folder names
 * - 'season_folder_format': string - Format for season folder names
 * - 'episode_file_format': string - Format for episode file names
 * - 'daily_episode_format': string - Format for daily show episodes
 * - 'anime_episode_format': string - Format for anime episodes
 * - 'multi_episode_style': 'extend' | 'duplicate' | 'repeat' | 'scene' | 'range'
 * - 'colon_replacement': 'delete' | 'dash' | 'spaceDash' | 'spaceDashSpace' | 'smart'
 * - 'replace_spaces_with': string | null
 * - 'media_server_id_format': 'plex' | 'jellyfin' - Controls ID format in folder names
 * - 'include_quality': boolean
 * - 'include_media_info': boolean
 * - 'include_release_group': boolean
 */
/**
 * Library Pattern Config - Per-library pattern recognition settings (Phase 1)
 *
 * Each row holds the pattern configuration for a library or the global
 * fallback (scope='global'). Pattern families:
 *   - ignore_defaults_enabled + ignore_user_patterns (glob, case-sensitive)
 *   - bonus_patterns (glob, case-insensitive, content_category='bonus')
 *   - structure_mode + structure_config (folder_depth or regex)
 */
/**
 * Resolution Categories - User-editable resolution buckets (Phase 2)
 *
 * Replaces hardcoded "4k/1080p/720p/SD" with editable categories.
 * Used by quality scoring badges, statistics, and profile rules.
 * One fallback category with 0×0 thresholds is always required.
 * IDs are immutable once assigned (quality profiles reference them).
 */
export const resolutionCategories = sqliteTable('resolution_categories', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	label: text('label').notNull(),
	minWidth: integer('min_width').notNull().default(0),
	minHeight: integer('min_height').notNull().default(0),
	searchTerms: text('search_terms', { mode: 'json' }).$type<string[]>(),
	isFallback: integer('is_fallback', { mode: 'boolean' }).default(false),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
});

export const duplicateGroupSuppression = sqliteTable('duplicate_group_suppression', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	libraryId: text('library_id').references(() => libraries.id, { onDelete: 'cascade' }),
	signature: text('signature').notNull(),
	signatureType: text('signature_type').notNull(),
	dismissedAt: text('dismissed_at').$defaultFn(() => new Date().toISOString()),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
});

export const libraryPatternConfig = sqliteTable('library_pattern_config', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	libraryId: text('library_id').references(() => libraries.id, { onDelete: 'cascade' }),
	scope: text('scope').notNull(), // 'global' | 'library'
	ignoreDefaultsEnabled: integer('ignore_defaults_enabled', { mode: 'boolean' }).default(true),
	ignoreUserPatterns: text('ignore_user_patterns', { mode: 'json' }).$type<string[]>(),
	bonusPatterns: text('bonus_patterns', { mode: 'json' }).$type<string[]>(),
	structureMode: text('structure_mode'), // 'folder_depth' | 'regex' | null
	structureConfig: text('structure_config', { mode: 'json' }),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

export const namingSettings = sqliteTable('naming_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

/**
 * Naming Presets - User-saved naming format presets
 * Built-in presets are defined in code, custom presets are stored here
 */
export const namingPresets = sqliteTable('naming_presets', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	description: text('description'),
	config: text('config', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
	isBuiltIn: integer('is_built_in', { mode: 'boolean' }).default(false),
	createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date())
});

// Default library settings keys:
// - 'scan_interval_hours': How often to run periodic scans (default: 12)
// - 'watch_enabled': Whether filesystem watching is enabled (default: true)
// - 'auto_match_threshold': Minimum confidence for auto-matching (default: 0.8)
// - 'scan_on_startup': Whether to scan on app startup (default: true)

// ============================================================================
// DOWNLOAD QUEUE & HISTORY TABLES
// ============================================================================

/**
 * Download Queue - Active and pending downloads being tracked
 * Links to media items (movies/series/episodes) for automatic import
 */
export const downloadQueue = sqliteTable(
	'download_queue',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),

		// Download client info
		downloadClientId: text('download_client_id')
			.notNull()
			.references(() => downloadClients.id, { onDelete: 'cascade' }),
		// Hash/ID from the download client (torrent hash, NZB ID, etc.)
		downloadId: text('download_id').notNull(),
		// Info hash from the release/magnet (reliable identifier)
		infoHash: text('info_hash'),

		// Release info
		title: text('title').notNull(),
		indexerId: text('indexer_id'),
		indexerName: text('indexer_name'),
		// Original download/magnet URL
		downloadUrl: text('download_url'),
		magnetUrl: text('magnet_url'),
		// Queue lifecycle owner: 'torrent' | 'usenet' | 'streaming' | 'debrid'
		protocol: text('protocol').notNull().default('torrent'),

		// Linked media (at least one should be set)
		movieId: text('movie_id').references(() => movies.id, { onDelete: 'set null' }),
		seriesId: text('series_id').references(() => series.id, { onDelete: 'set null' }),
		// For episode-specific grabs (JSON array of episode IDs)
		episodeIds: text('episode_ids', { mode: 'json' }).$type<string[]>(),
		// Season number for season pack grabs
		seasonNumber: integer('season_number'),

		// Status tracking
		// 'queued' | 'downloading' | 'paused' | 'completed' | 'postprocessing' | 'importing' | 'imported' | 'failed' | 'seeding' | 'removed'
		status: text('status').notNull().default('queued'),
		// Download progress (0.0 - 1.0)
		progress: text('progress').default('0'), // Stored as text for decimal precision
		// Size in bytes
		size: integer('size'),
		// Download/upload speeds in bytes/sec (cached from last poll)
		downloadSpeed: integer('download_speed').default(0),
		uploadSpeed: integer('upload_speed').default(0),
		// ETA in seconds (cached from last poll)
		eta: integer('eta'),
		// Current seed ratio
		ratio: text('ratio').default('0'),

		// Paths
		// Client-reported download path (may differ from actual path)
		clientDownloadPath: text('client_download_path'),
		// Actual path on disk after path mapping applied
		outputPath: text('output_path'),
		// Path where files were imported to (in root folder)
		importedPath: text('imported_path'),
		// How the imported file reached its destination: 'hardlink' | 'copy' |
		// 'move' | 'symlink'. For multi-file imports (season packs) this is the
		// first successfully imported file's mode, same as quality/releaseGroup.
		transferMode: text('transfer_mode'),

		// Quality info (from parsed release name)
		quality: text('quality', { mode: 'json' }).$type<{
			resolution?: string;
			source?: string;
			codec?: string;
			hdr?: string;
			languages?: string[];
			fileLanguages?: string[];
		}>(),

		// Release group (extracted from release title at grab time)
		releaseGroup: text('release_group'),

		// Timestamps
		addedAt: text('added_at').$defaultFn(() => new Date().toISOString()),
		// When download started (first saw progress > 0)
		startedAt: text('started_at'),
		// When the download first entered the stalled state (drives stalled-timeout
		// cleanup). Persisted so the timer survives restarts and isn't reset by brief
		// metaDL ↔ downloading flaps. Cleared only when the download actually progresses.
		stalledSince: text('stalled_since'),
		// When download reached 100%
		completedAt: text('completed_at'),
		// When import finished
		importedAt: text('imported_at'),

		// Error tracking
		errorMessage: text('error_message'),
		// Number of import attempts
		importAttempts: integer('import_attempts').default(0),
		lastAttemptAt: text('last_attempt_at'),

		// Flags
		// Whether this was an automatic grab or manual
		isAutomatic: integer('is_automatic', { mode: 'boolean' }).default(false),
		// Whether this is an upgrade for existing file
		isUpgrade: integer('is_upgrade', { mode: 'boolean' }).default(false),
		// Set when markFailed() is called due to exhausted import attempts.
		// Prevents the polling loop from treating the download client's
		// persistent 'completed' status as a client-side recovery.
		importFailed: integer('import_failed', { mode: 'boolean' }).notNull().default(false),

		// Set only for rows created by the Unmatched-tab track/enroll flow
		// ('unmatched_track' | 'unmatched_enroll'). Left null for every other
		// insert path (normal grabs, arr_push, overrides) - this is the only
		// reliable signal that a row came from that flow; indexerId being
		// null is NOT unique to it (arr_push pushes never set indexerId
		// either). See AcquisitionService.releaseUnmatchedQueueItems.
		origin: text('origin')
	},
	(table) => [
		index('idx_download_queue_status').on(table.status),
		index('idx_download_queue_info_hash').on(table.infoHash),
		index('idx_download_queue_movie').on(table.movieId),
		index('idx_download_queue_series').on(table.seriesId)
	]
);

/**
 * Download Queue Tombstones - Suppress immediate queue re-add for locally removed items
 */
export const downloadQueueTombstones = sqliteTable(
	'download_queue_tombstones',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		downloadClientId: text('download_client_id')
			.notNull()
			.references(() => downloadClients.id, { onDelete: 'cascade' }),
		protocol: text('protocol').notNull().default('torrent'),
		remoteId: text('remote_id').notNull(),
		reason: text('reason'),
		suppressedUntil: text('suppressed_until').notNull(),
		lastSeenAt: text('last_seen_at'),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_download_queue_tombstones_client').on(table.downloadClientId),
		index('idx_download_queue_tombstones_suppressed_until').on(table.suppressedUntil),
		uniqueIndex('idx_download_queue_tombstones_unique').on(
			table.downloadClientId,
			table.protocol,
			table.remoteId
		)
	]
);

/**
 * Acquisition Intents — the durable authority for what is being acquired,
 * for which media slots, and why it was approved (migration 148).
 *
 * The download queue is a transport projection linked to an intent; media
 * ownership and exclusivity live here. Slot exclusivity ("one active
 * acquisition per movie/quality bucket or episode") is enforced by a partial
 * unique index on acquisition_reservations (target_key WHERE released_at IS
 * NULL), which survives restarts — unlike the pre-existing process-local
 * locks and status-list inference.
 *
 * Intents record the decision at APPROVAL time (including the
 * pipeline-computed upgrade status). They deliberately do NOT record a
 * replacement plan: import-time replacement is recomputed against current
 * library state by the import finalizer, never from grab-time intent.
 */
export const acquisitionIntents = sqliteTable(
	'acquisition_intents',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),

		// Target
		mediaType: text('media_type', { enum: ['movie', 'tv'] }).notNull(),
		movieId: text('movie_id').references(() => movies.id, { onDelete: 'set null' }),
		seriesId: text('series_id').references(() => series.id, { onDelete: 'set null' }),
		seasonNumber: integer('season_number'),
		/** Expanded concrete episode scope (JSON array of episode ids; never empty for tv). */
		episodeIds: text('episode_ids', { mode: 'json' }).$type<string[]>(),

		// Slot: 'single' for single-quality movies, the bucket resolution otherwise.
		qualitySlot: text('quality_slot').notNull(),

		// Release identity
		protocol: text('protocol').notNull(),
		/** Canonical release identity kind once resolved ('info_hash' | 'indexer_guid' | 'provider_hash'). */
		identityKind: text('identity_kind'),
		identityValue: text('identity_value'),
		releaseTitle: text('release_title').notNull(),
		indexerId: text('indexer_id'),
		indexerName: text('indexer_name'),

		// Decision audit (pipeline-computed at approval time)
		upgradeStatus: text('upgrade_status'),
		decision: text('decision', { mode: 'json' }).$type<Record<string, unknown>>(),

		// Origin
		source: text('source', { enum: ['manual', 'automatic', 'arr_push', 'override'] }).notNull(),

		// Lifecycle: active → completed | failed | canceled
		status: text('status', { enum: ['active', 'completed', 'failed', 'canceled'] })
			.notNull()
			.default('active'),
		/** download_queue.id once the transport row exists. */
		queueId: text('queue_id'),
		error: text('error'),

		createdAt: text('created_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		completedAt: text('completed_at')
	},
	(table) => [
		index('idx_acq_intents_status').on(table.status),
		index('idx_acq_intents_queue').on(table.queueId),
		index('idx_acq_intents_movie').on(table.movieId),
		index('idx_acq_intents_series').on(table.seriesId),
		// One ACTIVE acquisition per canonical release identity across ALL
		// targets: the same torrent grabbed for two movies is always wrong.
		uniqueIndex('idx_acq_intents_active_identity')
			.on(table.identityValue)
			.where(sql`${table.identityValue} IS NOT NULL AND ${table.status} = 'active'`)
	]
);

/**
 * Acquisition Reservations — durable per-slot locks (migration 148).
 * One ACTIVE (released_at IS NULL) row per target_key, DB-enforced:
 *   movie:<movieId>:<qualitySlot>   e.g. movie:abc:2160p / movie:abc:single
 *   episode:<episodeId>             one per episode in the intent's scope
 */
export const acquisitionReservations = sqliteTable(
	'acquisition_reservations',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		intentId: text('intent_id')
			.notNull()
			.references(() => acquisitionIntents.id, { onDelete: 'cascade' }),
		targetKey: text('target_key').notNull(),
		createdAt: text('created_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		/** null while the reservation is held; set when the intent reaches a terminal state. */
		releasedAt: text('released_at')
	},
	(table) => [
		index('idx_acq_reservations_intent').on(table.intentId),
		// THE exclusivity invariant.
		uniqueIndex('idx_acq_reservations_active_target')
			.on(table.targetKey)
			.where(sql`${table.releasedAt} IS NULL`)
	]
);

/**
 * Import Operations journal (migration 149) — durable record of each
 * multi-step import so startup recovery can resume or compensate
 * deterministically instead of guessing from queue statuses.
 *
 * States: staged → registered → completed | recovery_required.
 * `pendingOldFileIds` holds DB rows whose physical retirement failed (or
 * never ran); recovery and reports reconcile them. Media is never
 * auto-deleted from here — phase-5 reports surface it.
 */
export const importOperations = sqliteTable(
	'import_operations',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		intentId: text('intent_id').references(() => acquisitionIntents.id, {
			onDelete: 'set null'
		}),
		queueId: text('queue_id'),
		mediaType: text('media_type', { enum: ['movie', 'episode'] }).notNull(),
		movieId: text('movie_id'),
		seriesId: text('series_id'),
		episodeIds: text('episode_ids', { mode: 'json' }).$type<string[]>(),
		protocol: text('protocol'),
		/** Destination path of the incoming file (absolute). */
		destinationPath: text('destination_path').notNull(),
		newFileId: text('new_file_id'),
		/** DB rows targeted for retirement, with the file id the new row replaced. */
		pendingOldFileIds: text('pending_old_file_ids', { mode: 'json' }).$type<string[]>(),
		/** Rows whose physical deletion failed — row kept on purpose, flagged here. */
		failedOldFileIds: text('failed_old_file_ids', { mode: 'json' }).$type<string[]>(),
		status: text('status', {
			enum: ['staged', 'registered', 'completed', 'recovery_required']
		})
			.notNull()
			.default('staged'),
		error: text('error'),
		createdAt: text('created_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		completedAt: text('completed_at')
	},
	(table) => [
		index('idx_import_operations_status').on(table.status),
		index('idx_import_operations_queue').on(table.queueId)
	]
);

/**
 * Stalled Orphan Tracking - Records when a torrent in one of our categories that
 * is NOT actively tracked in the queue was first seen stalled, so the periodic
 * orphan sweep can apply the stalled timeout to it (and retry deletes that didn't
 * take, since the row survives until the torrent actually disappears).
 */
export const stalledOrphanTracking = sqliteTable(
	'stalled_orphan_tracking',
	{
		downloadClientId: text('download_client_id')
			.notNull()
			.references(() => downloadClients.id, { onDelete: 'cascade' }),
		infoHash: text('info_hash').notNull(),
		firstStalledAt: text('first_stalled_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString())
	},
	(table) => [primaryKey({ columns: [table.downloadClientId, table.infoHash] })]
);

/**
 * Download History - Permanent record of completed/failed downloads
 * Created when a download is imported or permanently fails
 */
export const downloadHistory = sqliteTable('download_history', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),

	// Snapshot of queue item data
	downloadClientId: text('download_client_id'),
	downloadClientName: text('download_client_name'),
	downloadId: text('download_id'),
	infoHash: text('info_hash'),
	title: text('title').notNull(),
	indexerId: text('indexer_id'),
	indexerName: text('indexer_name'),
	protocol: text('protocol'),

	// Linked media
	movieId: text('movie_id').references(() => movies.id, { onDelete: 'set null' }),
	seriesId: text('series_id').references(() => series.id, { onDelete: 'set null' }),
	episodeIds: text('episode_ids', { mode: 'json' }).$type<string[]>(),
	seasonNumber: integer('season_number'),

	// Final status: 'imported' | 'failed' | 'rejected' | 'removed'
	status: text('status').notNull(),
	// For failures/rejections
	statusReason: text('status_reason'),

	// Final stats
	size: integer('size'),
	// How long download took (seconds)
	downloadTimeSeconds: integer('download_time_seconds'),
	// Final ratio when removed from client
	finalRatio: text('final_ratio'),

	// Quality info
	quality: text('quality', { mode: 'json' }).$type<{
		resolution?: string;
		source?: string;
		codec?: string;
		hdr?: string;
	}>(),

	// Release group (extracted from release title at grab time)
	releaseGroup: text('release_group'),

	// Paths
	importedPath: text('imported_path'),
	// How the imported file reached its destination: 'hardlink' | 'copy' |
	// 'move' | 'symlink'.
	transferMode: text('transfer_mode'),

	// Created file IDs (for tracking what was imported)
	movieFileId: text('movie_file_id').references(() => movieFiles.id, { onDelete: 'set null' }),
	episodeFileIds: text('episode_file_ids', { mode: 'json' }).$type<string[]>(),

	// Timestamps
	grabbedAt: text('grabbed_at'),
	completedAt: text('completed_at'),
	importedAt: text('imported_at'),
	// When this history record was created
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
});

// ============================================================================
// MONITORING SYSTEM TABLES
// ============================================================================

/**
 * Monitoring Settings - Configuration for automated monitoring system
 * Controls intervals and behavior for missing content search, upgrade monitoring, etc.
 */
export const monitoringSettings = sqliteTable('monitoring_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

// Default monitoring settings keys:
// - 'missing_search_interval_hours': number - How often to search for missing content (default: 24)
// - 'upgrade_search_interval_hours': number - How often to search for upgrades (default: 168)
// - 'new_episode_check_interval_hours': number - How often to check for new episodes (default: 1)
// - 'cutoff_unmet_search_interval_hours': number - How often to search for cutoff unmet (default: 24)
// - 'auto_replace_enabled': boolean - Auto-replace with better quality (default: true)
// - 'search_on_monitor_enabled': boolean - Search when item first monitored (default: true)

// ============================================================================
// CAPTCHA SOLVER SETTINGS
// ============================================================================

/**
 * Captcha Solver Settings - Configuration for anti-bot/captcha bypass system
 * Controls browser automation settings for solving Cloudflare, Turnstile, etc.
 *
 * Settings keys:
 * - 'enabled': boolean - Master toggle for captcha solving (default: true)
 * - 'timeout_seconds': number - Max time to wait for challenge solve (default: 60)
 * - 'cache_ttl_seconds': number - How long to cache solved cookies (default: 3600)
 * - 'headless': boolean - Run browser in headless mode (default: true)
 * - 'proxy_url': string - Optional proxy URL for browser requests
 * - 'proxy_username': string - Proxy authentication username
 * - 'proxy_password': string - Proxy authentication password
 */
export const captchaSolverSettings = sqliteTable('captcha_solver_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

/**
 * Monitoring History - Audit trail of monitoring system activity
 * Tracks searches, grabs, and decisions made by the automated monitoring system
 */
/**
 * Blocklist - Tracks releases that should not be grabbed again
 * Prevents re-downloading failed or problematic releases
 */
export const blocklist = sqliteTable(
	'blocklist',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// What was blocked
		title: text('title').notNull(),
		infoHash: text('info_hash'),
		indexerId: text('indexer_id').references(() => indexers.id, { onDelete: 'set null' }),
		// Associated content (at least one must be set)
		movieId: text('movie_id').references(() => movies.id, { onDelete: 'cascade' }),
		seriesId: text('series_id').references(() => series.id, { onDelete: 'cascade' }),
		episodeIds: text('episode_ids', { mode: 'json' }).$type<string[]>(),
		// Why it was blocked
		reason: text('reason').notNull(), // 'download_failed', 'import_failed', 'quality_mismatch', 'manual'
		message: text('message'),
		// Source information for matching
		sourceTitle: text('source_title'),
		quality: text('quality', { mode: 'json' }).$type<{
			resolution?: string;
			source?: string;
			codec?: string;
			hdr?: string;
		}>(),
		size: integer('size'),
		protocol: text('protocol'), // 'torrent' | 'usenet' | 'streaming'
		// Timestamps
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		expiresAt: text('expires_at') // Optional expiration (null = permanent)
	},
	(table) => [
		index('idx_blocklist_movie').on(table.movieId),
		index('idx_blocklist_series').on(table.seriesId),
		index('idx_blocklist_infohash').on(table.infoHash)
	]
);

export const blockedMedia = sqliteTable(
	'blocked_media',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		tmdbId: integer('tmdb_id').notNull(),
		mediaType: text('media_type').notNull(),
		title: text('title').notNull(),
		posterPath: text('poster_path'),
		year: integer('year'),
		reason: text('reason'),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [uniqueIndex('idx_blocked_media_unique').on(table.tmdbId, table.mediaType)]
);

export const blockedKeywords = sqliteTable('blocked_keywords', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	keywordId: integer('keyword_id').notNull().unique(),
	name: text('name').notNull(),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

/**
 * Delay Profiles - Configures grab delays based on protocol and quality
 * Similar to Radarr/Sonarr's delay profiles for waiting for better releases
 */
export const delayProfiles = sqliteTable('delay_profiles', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	// Profile name
	name: text('name').notNull(),
	// Order for matching (lower = higher priority)
	sortOrder: integer('sort_order').notNull().default(0),
	qualityProfileId: text('quality_profile_id').references(() => scoringProfiles.id, {
		onDelete: 'set null'
	}),
	scanMode: text('scan_mode').notNull().default('scheduled'), // 'manual' | 'scheduled' | 'scheduled_daily' | 'watch' (Phase 4)
	scanConfig: text('scan_config', { mode: 'json' }).$type<{
		intervalMinutes?: number;
		scheduledTime?: string;
		debounceSeconds?: number;
	}>(),
	// Enable/disable
	enabled: integer('enabled', { mode: 'boolean' }).default(true),
	// Protocol delays (in minutes, 0 = immediate)
	usenetDelay: integer('usenet_delay').notNull().default(0),
	torrentDelay: integer('torrent_delay').notNull().default(0),
	// Quality-based delays (JSON map of resolution -> delay in minutes)
	qualityDelays: text('quality_delays', { mode: 'json' }).$type<Record<string, number>>(),
	// Preferred protocols
	preferredProtocol: text('preferred_protocol'), // 'usenet', 'torrent', or null
	// Tags for matching (JSON array)
	tags: text('tags', { mode: 'json' }).$type<string[]>(),
	// Bypass delay conditions
	bypassIfHighestQuality: integer('bypass_if_highest_quality', { mode: 'boolean' }).default(true),
	bypassIfAboveScore: integer('bypass_if_above_score'),
	// Timestamps
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

/**
 * Pending Releases - Tracks releases waiting for delay to expire
 * Releases are queued here when delay profile requires waiting
 */
export const pendingReleases = sqliteTable('pending_releases', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	// Release info
	title: text('title').notNull(),
	infoHash: text('info_hash'),
	indexerId: text('indexer_id').references(() => indexers.id, { onDelete: 'set null' }),
	// Download info
	downloadUrl: text('download_url'),
	magnetUrl: text('magnet_url'),
	// Associated content
	movieId: text('movie_id').references(() => movies.id, { onDelete: 'cascade' }),
	seriesId: text('series_id').references(() => series.id, { onDelete: 'cascade' }),
	episodeIds: text('episode_ids', { mode: 'json' }).$type<string[]>(),
	// Release details
	score: integer('score').notNull(),
	size: integer('size'),
	protocol: text('protocol').notNull(), // 'torrent' | 'usenet' | 'streaming'
	quality: text('quality', { mode: 'json' }).$type<{
		resolution?: string;
		source?: string;
		codec?: string;
		hdr?: string;
	}>(),
	// Delay tracking
	delayProfileId: text('delay_profile_id').references(() => delayProfiles.id, {
		onDelete: 'set null'
	}),
	// When the release was originally published on the indexer
	publishDate: text('publish_date'),
	addedAt: text('added_at').$defaultFn(() => new Date().toISOString()),
	processAt: text('process_at').notNull(), // When to process this release
	// Status
	status: text('status').notNull().default('pending'), // 'pending', 'superseded', 'grabbed', 'expired'
	supersededBy: text('superseded_by') // ID of release that superseded this one
});

export const monitoringHistory = sqliteTable(
	'monitoring_history',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Link to parent task execution (for unified task history)
		taskHistoryId: text('task_history_id').references(() => taskHistory.id, {
			onDelete: 'cascade'
		}),
		// Task type that triggered this action
		taskType: text('task_type').notNull(), // 'missing', 'upgrade', 'new_episode', 'cutoff_unmet'

		// Linked media (at least one should be set)
		movieId: text('movie_id').references(() => movies.id, { onDelete: 'cascade' }),
		seriesId: text('series_id').references(() => series.id, { onDelete: 'cascade' }),
		seasonNumber: integer('season_number'),
		episodeId: text('episode_id').references(() => episodes.id, { onDelete: 'cascade' }),

		// Status of this monitoring action
		// 'searching' | 'found' | 'grabbed' | 'no_results' | 'skipped' | 'error'
		status: text('status').notNull(),

		// Search results
		releasesFound: integer('releases_found').default(0),
		releaseGrabbed: text('release_grabbed'), // Title of release that was grabbed
		queueItemId: text('queue_item_id'), // Link to download queue if grabbed

		// Upgrade tracking
		isUpgrade: integer('is_upgrade', { mode: 'boolean' }).default(false),
		oldScore: integer('old_score'), // Previous file score (for upgrades)
		newScore: integer('new_score'), // New release score (for upgrades)

		// Timestamps
		executedAt: text('executed_at').$defaultFn(() => new Date().toISOString()),

		// Error info
		errorMessage: text('error_message')
	},
	(table) => [
		index('idx_monitoring_history_task_history').on(table.taskHistoryId),
		index('idx_monitoring_history_movie').on(table.movieId),
		index('idx_monitoring_history_series').on(table.seriesId),
		index('idx_monitoring_history_episode').on(table.episodeId)
	]
);

// ============================================================================
// SUBTITLE MANAGEMENT TABLES
// ============================================================================

/**
 * Language Profile (v2) - Persisted row shape for the combined
 * audio + subtitle preference model (see #lib/shared/language-profile).
 */
export interface LanguageProfileRow {
	id: string;
	name: string;
	audio: AudioPreference;
	subtitles: SubtitleRequirement[];
	/** Stop acquiring after the requirement at this rank is satisfied (null = disabled) */
	cutoffRank: number | null;
	/** Normalized 0-100 threshold shared by movies and episodes */
	minimumScore: number;
	upgradesAllowed: boolean;
	createdAt?: string;
	updatedAt?: string;
}

/**
 * Language Profiles (v2) - Audio preferences + ordered subtitle requirements.
 * Each movie/series/library can be assigned a profile; the default profile is
 * the single authority in language_settings.default_profile_id (no is_default).
 */
export const languageProfiles = sqliteTable('language_profiles', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	// Audio preference: prefer original track + ordered preferred languages
	audio: text('audio', { mode: 'json' }).$type<AudioPreference>().notNull(),
	// Ordered subtitle requirements (order = priority)
	subtitles: text('subtitles', { mode: 'json' }).$type<SubtitleRequirement[]>().notNull(),
	// Stop acquiring after the requirement at this rank is satisfied (null = disabled)
	cutoffRank: integer('cutoff_rank'),
	// Minimum score threshold for auto-download (normalized 0-100 scale)
	minimumScore: integer('minimum_score').notNull().default(70),
	// Whether to upgrade existing subtitles with better matches
	upgradesAllowed: integer('upgrades_allowed', { mode: 'boolean' }).default(true),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

/**
 * Language Settings - Singleton row (id = 'singleton') with the global
 * language configuration. default_profile_id is the only default-profile
 * authority; metadata_locale/region feed TMDB requests.
 */
export const languageSettings = sqliteTable('language_settings', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => 'singleton'),
	// Default profile applied when no library/media override exists (null = none)
	defaultProfileId: text('default_profile_id'),
	// TMDB metadata request locale (validated via Intl.getCanonicalLocales)
	metadataLocale: text('metadata_locale').notNull().default('en-US'),
	// ISO 3166-1 region for TMDB discover/release filtering
	region: text('region').notNull().default('US'),
	// Canonical TmdbLanguage origin filter for Discover; null = no filter
	discoverOriginalFilter: text('discover_original_filter'),
	// 'und' (never assume a language) | 'assume-language'
	unknownSubtitlePolicy: text('unknown_subtitle_policy').notNull().default('und'),
	// Language assumed for unknown subtitle tags when policy is 'assume-language'
	assumedLanguage: text('assumed_language'),
	// Whether subtitle search runs automatically for new/updated files
	autoSyncSubtitles: integer('auto_sync_subtitles', { mode: 'boolean' }).notNull().default(true),
	// Instance default for display: show originalTitle instead of the localized
	// title when a movie/series has no explicit per-item preference
	preferOriginalTitle: integer('prefer_original_title', { mode: 'boolean' })
		.notNull()
		.default(false),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

/**
 * Subtitle Providers - Configuration for subtitle sources (OpenSubtitles, Podnapisi, etc.)
 */
export const subtitleProviders = sqliteTable('subtitle_providers', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	// Provider type: 'opensubtitles', 'addic7ed', 'subdl', 'yifysubtitles', 'gestdown', 'subf2m'
	implementation: text('implementation').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).default(true),
	// Priority for search order (lower = higher priority)
	priority: integer('priority').default(25),

	// Authentication (provider-specific)
	apiKey: text('api_key'),
	username: text('username'),
	password: text('password'),

	// Provider-specific settings as JSON
	settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>(),

	// Rate limiting config
	requestsPerMinute: integer('requests_per_minute').default(60),

	// Throttling/health tracking
	lastError: text('last_error'),
	lastErrorAt: text('last_error_at'),
	consecutiveFailures: integer('consecutive_failures').default(0),
	throttledUntil: text('throttled_until'),

	createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

/**
 * Subtitles - Subtitle files on disk linked to movies/episodes
 */
export const subtitles = sqliteTable(
	'subtitles',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),

		// Link to media (one must be set)
		movieId: text('movie_id').references(() => movies.id, { onDelete: 'cascade' }),
		episodeId: text('episode_id').references(() => episodes.id, { onDelete: 'cascade' }),
		// Link to a specific movie file (multi-quality: one subtitle per resolution tier).
		// Nullable: null for legacy subtitles or episode subtitles.
		movieFileId: text('movie_file_id').references(() => movieFiles.id, {
			onDelete: 'set null'
		}),

		// File info
		relativePath: text('relative_path').notNull(),
		language: text('language').notNull(), // ISO 639-1 code

		// Subtitle properties
		isForced: integer('is_forced', { mode: 'boolean' }).default(false),
		isHearingImpaired: integer('is_hearing_impaired', { mode: 'boolean' }).default(false),
		format: text('format').notNull(), // 'srt', 'ass', 'sub', 'vtt'

		// Source info (null if manually added or discovered on disk)
		providerId: text('provider_id').references(() => subtitleProviders.id, {
			onDelete: 'set null'
		}),
		providerSubtitleId: text('provider_subtitle_id'), // External ID from provider

		// Scoring info (how well it matched)
		matchScore: integer('match_score'),
		isHashMatch: integer('is_hash_match', { mode: 'boolean' }).default(false),

		// File metadata
		size: integer('size'),

		// Sync correction applied (milliseconds offset)
		syncOffset: integer('sync_offset').default(0),
		wasSynced: integer('was_synced', { mode: 'boolean' }).default(false),

		// Upgrade rotation (migration 141): when the upgrade task last examined this
		// row. Upgrades order by this ascending (NULLs first) and stamp it on examine
		// so no subtitle is starved while others are re-checked every run.
		lastCheckedAt: text('last_checked_at'),

		dateAdded: text('date_added').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_subtitles_movie').on(table.movieId),
		index('idx_subtitles_episode').on(table.episodeId),
		// Identity for subtitle rows: owner + language + flags + stored path.
		// `ifnull` makes NULL owner columns participate in uniqueness (SQLite
		// treats NULLs as distinct otherwise).
		uniqueIndex('idx_subtitles_unique_identity').on(
			sql`ifnull(${table.movieId}, '')`,
			sql`ifnull(${table.episodeId}, '')`,
			table.language,
			table.isForced,
			table.isHearingImpaired,
			table.relativePath
		)
	]
);

/**
 * Subtitle Search State - per-requirement adaptive backoff (migration 141).
 *
 * Replaces the old per-media-item columns (movies/episodes.failed_subtitle_attempts,
 * first_subtitle_search_at), which were dropped by migration 142.
 * `requirement_key` is the stable `tag|variant|accessibility` tuple so one failing
 * requirement no longer gates the others for the same owner.
 */
export const subtitleSearchState = sqliteTable(
	'subtitle_search_state',
	{
		ownerType: text('owner_type', { enum: ['movie', 'episode'] }).notNull(),
		ownerId: text('owner_id').notNull(),
		requirementKey: text('requirement_key').notNull(),
		failedAttempts: integer('failed_attempts').notNull().default(0),
		firstSearchAt: text('first_search_at'),
		lastSearchAt: text('last_search_at')
	},
	(table) => [
		primaryKey({ columns: [table.ownerType, table.ownerId, table.requirementKey] }),
		index('idx_subtitle_search_state_owner').on(table.ownerType, table.ownerId)
	]
);

/**
 * Subtitle History - Audit trail of all subtitle actions
 */
export const subtitleHistory = sqliteTable('subtitle_history', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),

	// Link to media
	movieId: text('movie_id').references(() => movies.id, { onDelete: 'set null' }),
	episodeId: text('episode_id').references(() => episodes.id, { onDelete: 'set null' }),

	// Action info: 'downloaded', 'deleted', 'synced', 'upgraded', 'manual_upload', 'discovered'
	action: text('action').notNull(),

	// Subtitle details
	language: text('language').notNull(),
	providerId: text('provider_id'),
	providerName: text('provider_name'),
	providerSubtitleId: text('provider_subtitle_id'),

	// Score at time of download
	matchScore: integer('match_score'),
	wasHashMatch: integer('was_hash_match', { mode: 'boolean' }).default(false),

	// What was replaced (for upgrades)
	replacedSubtitleId: text('replaced_subtitle_id'),

	// Error message if failed
	errorMessage: text('error_message'),

	createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
});

/**
 * Subtitle Blacklist - Subtitles that should not be downloaded again
 */
export const subtitleBlacklist = sqliteTable('subtitle_blacklist', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),

	// Link to media
	movieId: text('movie_id').references(() => movies.id, { onDelete: 'cascade' }),
	episodeId: text('episode_id').references(() => episodes.id, { onDelete: 'cascade' }),

	// Provider info
	providerId: text('provider_id').references(() => subtitleProviders.id, { onDelete: 'cascade' }),
	providerSubtitleId: text('provider_subtitle_id').notNull(),

	// Why blacklisted: 'wrong_content', 'out_of_sync', 'poor_quality', 'manual'
	reason: text('reason'),

	language: text('language').notNull(),

	createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
});

// ============================================================================
// SYSTEM TASKS TABLE
// ============================================================================

/**
 * Task History - Tracks execution of manual system tasks
 * Used by the Tasks page to show task run history and prevent concurrent execution
 */
export const taskHistory = sqliteTable('task_history', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	// Task identifier (e.g., 'update-strm-urls')
	taskId: text('task_id').notNull(),
	// Execution status: 'running', 'completed', 'failed'
	status: text('status').notNull(),
	// Task-specific results as JSON
	results: text('results', { mode: 'json' }).$type<Record<string, unknown>>(),
	// Error messages if failed
	errors: text('errors', { mode: 'json' }).$type<string[]>(),
	// Timestamps
	startedAt: text('started_at').$defaultFn(() => new Date().toISOString()),
	completedAt: text('completed_at')
});

/**
 * Task Settings - Configuration for automated tasks
 * Stores per-task settings like enabled status, intervals, and schedule info
 * Replaces the key-value monitoring_settings table for task-specific config
 */
export const taskSettings = sqliteTable(
	'task_settings',
	{
		id: text('id').primaryKey(), // Task identifier (e.g., 'missing', 'upgrade', 'pendingRelease')
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		intervalHours: real('interval_hours'), // Null for manual tasks
		minIntervalHours: real('min_interval_hours').notNull().default(0.25),
		lastRunAt: text('last_run_at'), // ISO timestamp
		nextRunAt: text('next_run_at'), // ISO timestamp
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_task_settings_enabled').on(table.enabled),
		index('idx_task_settings_next_run').on(table.nextRunAt)
	]
);

export type TaskSettingsRecord = typeof taskSettings.$inferSelect;
export type NewTaskSettingsRecord = typeof taskSettings.$inferInsert;

// ============================================================================
// Cinephage API Subsystem
// ============================================================================
// First-class integration with api.cinephage.net. The subsystem owns the
// connection (HTTP client, version/commit identity, enable state) and houses
// feature modules (library-streaming, remote-streaming, etc.). Per-module
// config and enable state live here, not on the indexer row.
//
// See src/lib/server/cinephage/ for the runtime implementation.

/**
 * Cinephage API Config - Singleton row (id is always 1).
 * Holds subsystem-level config: master enable toggle, base URL override, and
 * version/commit overrides for cases where auto-detection from APP_VERSION /
 * APP_COMMIT fails (custom builds, dev checkouts without git, etc.).
 */
export const cinephageApiConfig = sqliteTable('cinephage_api_config', {
	id: integer('id').primaryKey(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	baseUrl: text('base_url').notNull().default('https://api.cinephage.net'),
	// Optional manual overrides. When null, the subsystem auto-detects from
	// APP_VERSION / APP_COMMIT env vars (baked into the Docker image at build).
	versionOverride: text('version_override'),
	commitOverride: text('commit_override'),
	// Auto-synced identity: the latest published release pair. The
	// api.cinephage.net gateway only accepts the newest release, so a
	// background sync keeps latest_version/latest_commit fresh. When
	// autoUpdate is enabled and no manual override is set, these take
	// precedence over APP_VERSION / APP_COMMIT.
	autoUpdate: integer('auto_update', { mode: 'boolean' }).notNull().default(true),
	latestVersion: text('latest_version'),
	latestCommit: text('latest_commit'),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

export type CinephageApiConfigRecord = typeof cinephageApiConfig.$inferSelect;
export type NewCinephageApiConfigRecord = typeof cinephageApiConfig.$inferInsert;

/**
 * Cinephage API Modules - Per-module state.
 * One row per registered feature module (e.g. 'library-streaming').
 * The module's settingsSchema (Zod) validates writes; settings is a JSON bag
 * whose shape is module-specific.
 */
export const cinephageApiModules = sqliteTable(
	'cinephage_api_modules',
	{
		moduleId: text('module_id').primaryKey(),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		settings: text('settings', { mode: 'json' })
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		// Populated when test() fails; cleared on success. Surfaced in the UI.
		lastError: text('last_error'),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [index('idx_cinephage_api_modules_enabled').on(table.enabled)]
);

export type CinephageApiModuleRecord = typeof cinephageApiModules.$inferSelect;
export type NewCinephageApiModuleRecord = typeof cinephageApiModules.$inferInsert;

// ============================================================================
// RELATIONS
// ============================================================================

/**
 * Movies Relations
 */
export const moviesRelations = relations(movies, ({ one, many }) => ({
	library: one(libraries, {
		fields: [movies.libraryId],
		references: [libraries.id]
	}),
	scoringProfile: one(scoringProfiles, {
		fields: [movies.scoringProfileId],
		references: [scoringProfiles.id]
	}),
	rootFolder: one(rootFolders, {
		fields: [movies.rootFolderId],
		references: [rootFolders.id]
	}),
	languageProfile: one(languageProfiles, {
		fields: [movies.languageProfileId],
		references: [languageProfiles.id]
	}),
	subtitles: many(subtitles)
}));

/**
 * Series Relations
 */
export const seriesRelations = relations(series, ({ one, many }) => ({
	library: one(libraries, {
		fields: [series.libraryId],
		references: [libraries.id]
	}),
	scoringProfile: one(scoringProfiles, {
		fields: [series.scoringProfileId],
		references: [scoringProfiles.id]
	}),
	rootFolder: one(rootFolders, {
		fields: [series.rootFolderId],
		references: [rootFolders.id]
	}),
	languageProfile: one(languageProfiles, {
		fields: [series.languageProfileId],
		references: [languageProfiles.id]
	}),
	seasons: many(seasons),
	episodes: many(episodes)
}));

/**
 * Libraries Relations
 */
export const librariesRelations = relations(libraries, ({ many }) => ({
	movies: many(movies),
	series: many(series),
	rootFolders: many(libraryRootFolders)
}));

/**
 * Library Root Folders Relations
 */
export const libraryRootFoldersRelations = relations(libraryRootFolders, ({ one }) => ({
	library: one(libraries, {
		fields: [libraryRootFolders.libraryId],
		references: [libraries.id]
	}),
	rootFolder: one(rootFolders, {
		fields: [libraryRootFolders.rootFolderId],
		references: [rootFolders.id]
	})
}));

/**
 * Seasons Relations
 */
export const seasonsRelations = relations(seasons, ({ one, many }) => ({
	series: one(series, {
		fields: [seasons.seriesId],
		references: [series.id]
	}),
	episodes: many(episodes)
}));

/**
 * Episodes Relations
 */
export const episodesRelations = relations(episodes, ({ one, many }) => ({
	series: one(series, {
		fields: [episodes.seriesId],
		references: [series.id]
	}),
	season: one(seasons, {
		fields: [episodes.seasonId],
		references: [seasons.id]
	}),
	subtitles: many(subtitles)
}));

/**
 * Movie Files Relations
 */
export const movieFilesRelations = relations(movieFiles, ({ one }) => ({
	movie: one(movies, {
		fields: [movieFiles.movieId],
		references: [movies.id]
	})
}));

/**
 * Episode Files Relations
 */
export const episodeFilesRelations = relations(episodeFiles, ({ one }) => ({
	series: one(series, {
		fields: [episodeFiles.seriesId],
		references: [series.id]
	})
}));

/**
 * Download Queue Relations
 */
export const downloadQueueRelations = relations(downloadQueue, ({ one }) => ({
	downloadClient: one(downloadClients, {
		fields: [downloadQueue.downloadClientId],
		references: [downloadClients.id]
	}),
	movie: one(movies, {
		fields: [downloadQueue.movieId],
		references: [movies.id]
	}),
	series: one(series, {
		fields: [downloadQueue.seriesId],
		references: [series.id]
	})
}));

/**
 * Download Queue Tombstones Relations
 */
export const downloadQueueTombstonesRelations = relations(downloadQueueTombstones, ({ one }) => ({
	downloadClient: one(downloadClients, {
		fields: [downloadQueueTombstones.downloadClientId],
		references: [downloadClients.id]
	})
}));

/**
 * Download History Relations
 */
export const downloadHistoryRelations = relations(downloadHistory, ({ one }) => ({
	movie: one(movies, {
		fields: [downloadHistory.movieId],
		references: [movies.id]
	}),
	series: one(series, {
		fields: [downloadHistory.seriesId],
		references: [series.id]
	}),
	movieFile: one(movieFiles, {
		fields: [downloadHistory.movieFileId],
		references: [movieFiles.id]
	})
}));

/**
 * Monitoring History Relations
 */
export const monitoringHistoryRelations = relations(monitoringHistory, ({ one }) => ({
	movie: one(movies, {
		fields: [monitoringHistory.movieId],
		references: [movies.id]
	}),
	series: one(series, {
		fields: [monitoringHistory.seriesId],
		references: [series.id]
	}),
	episode: one(episodes, {
		fields: [monitoringHistory.episodeId],
		references: [episodes.id]
	})
}));

/**
 * Unmatched Files Relations
 */
export const unmatchedFilesRelations = relations(unmatchedFiles, ({ one }) => ({
	rootFolder: one(rootFolders, {
		fields: [unmatchedFiles.rootFolderId],
		references: [rootFolders.id]
	})
}));

/**
 * Library Scan History Relations
 */
export const libraryScanHistoryRelations = relations(libraryScanHistory, ({ one }) => ({
	rootFolder: one(rootFolders, {
		fields: [libraryScanHistory.rootFolderId],
		references: [rootFolders.id]
	})
}));

// ============================================================================
// SUBTITLE RELATIONS
// ============================================================================

/**
 * Language Profiles Relations
 */
export const languageProfilesRelations = relations(languageProfiles, ({ many }) => ({
	movies: many(movies),
	series: many(series)
}));

/**
 * Subtitle Providers Relations
 */
export const subtitleProvidersRelations = relations(subtitleProviders, ({ many }) => ({
	subtitles: many(subtitles),
	blacklist: many(subtitleBlacklist)
}));

/**
 * Subtitles Relations
 */
export const subtitlesRelations = relations(subtitles, ({ one }) => ({
	movie: one(movies, {
		fields: [subtitles.movieId],
		references: [movies.id]
	}),
	episode: one(episodes, {
		fields: [subtitles.episodeId],
		references: [episodes.id]
	}),
	movieFile: one(movieFiles, {
		fields: [subtitles.movieFileId],
		references: [movieFiles.id]
	}),
	provider: one(subtitleProviders, {
		fields: [subtitles.providerId],
		references: [subtitleProviders.id]
	})
}));

/**
 * Subtitle History Relations
 */
export const subtitleHistoryRelations = relations(subtitleHistory, ({ one }) => ({
	movie: one(movies, {
		fields: [subtitleHistory.movieId],
		references: [movies.id]
	}),
	episode: one(episodes, {
		fields: [subtitleHistory.episodeId],
		references: [episodes.id]
	})
}));

/**
 * Subtitle Blacklist Relations
 */
export const subtitleBlacklistRelations = relations(subtitleBlacklist, ({ one }) => ({
	movie: one(movies, {
		fields: [subtitleBlacklist.movieId],
		references: [movies.id]
	}),
	episode: one(episodes, {
		fields: [subtitleBlacklist.episodeId],
		references: [episodes.id]
	}),
	provider: one(subtitleProviders, {
		fields: [subtitleBlacklist.providerId],
		references: [subtitleProviders.id]
	})
}));

// ============================================================================
// SMART LISTS FEATURE TABLES
// ============================================================================

/**
 * Smart List Filters - Type definition for JSON column
 * Maps to TMDB Discover API parameters
 */
export interface SmartListFilters {
	// Genres
	withGenres?: number[];
	withoutGenres?: number[];
	genreMode?: 'and' | 'or';

	// Year/Date
	yearMin?: number;
	yearMax?: number;
	releaseDateMin?: string;
	releaseDateMax?: string;

	// Rating
	voteAverageMin?: number;
	voteAverageMax?: number;
	voteCountMin?: number;

	// Popularity
	popularityMin?: number;
	popularityMax?: number;

	// People
	withCast?: number[];
	withCrew?: number[];

	// Keywords
	withKeywords?: number[];
	withoutKeywords?: number[];

	// Watch Providers
	withWatchProviders?: number[];
	watchRegion?: string;

	// Certification
	certification?: string;
	certificationCountry?: string;

	// Runtime
	runtimeMin?: number;
	runtimeMax?: number;

	// Language
	withOriginalLanguage?: string;

	// TV-specific
	withStatus?: string;

	// Movie-specific
	withReleaseType?: number[];
}

/**
 * Smart Lists - User-defined TMDB discover query lists
 *
 * Smart lists are dynamic lists that query TMDB's discover API using
 * user-defined filter criteria. Results are cached and periodically refreshed.
 */
export const smartLists = sqliteTable(
	'smart_lists',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),

		// === BASIC INFO ===
		name: text('name').notNull(),
		description: text('description'),

		// Media type: 'movie' or 'tv' (not mixed - TMDB discover is type-specific)
		mediaType: text('media_type', { enum: ['movie', 'tv'] }).notNull(),

		enabled: integer('enabled', { mode: 'boolean' }).default(true),

		// === TMDB DISCOVER FILTERS ===
		// Stored as JSON for flexibility
		filters: text('filters', { mode: 'json' }).$type<SmartListFilters>().notNull(),

		// Sort configuration
		sortBy: text('sort_by').default('popularity.desc'),

		// Item limit (how many items to fetch and cache)
		itemLimit: integer('item_limit').default(100).notNull(),

		// === LIBRARY-AWARE FILTERS ===
		// Whether to exclude items already in library
		excludeInLibrary: integer('exclude_in_library', { mode: 'boolean' }).default(true),
		// Whether to show only items that could be upgraded
		showUpgradeableOnly: integer('show_upgradeable_only', { mode: 'boolean' }).default(false),
		// Manually excluded TMDB IDs (JSON array)
		excludedTmdbIds: text('excluded_tmdb_ids', { mode: 'json' }).$type<number[]>().default([]),

		// === QUALITY/SCORING ===
		// Scoring profile for quality preferences
		scoringProfileId: text('scoring_profile_id').references(() => scoringProfiles.id, {
			onDelete: 'set null'
		}),

		// === AUTO-ADD CONFIGURATION ===
		// Auto-add behavior: 'disabled' | 'add_only' | 'add_and_search'
		autoAddBehavior: text('auto_add_behavior', {
			enum: ['disabled', 'add_only', 'add_and_search']
		}).default('disabled'),
		// Root folder for auto-added items
		rootFolderId: text('root_folder_id').references(() => rootFolders.id, {
			onDelete: 'set null'
		}),
		// Monitored state for auto-added items
		autoAddMonitored: integer('auto_add_monitored', { mode: 'boolean' }).default(true),
		// Minimum availability for auto-added movies
		minimumAvailability: text('minimum_availability').default('released'),
		// Whether to want subtitles for auto-added items
		wantsSubtitles: integer('wants_subtitles', { mode: 'boolean' }).default(true),
		// Language profile for auto-added items
		languageProfileId: text('language_profile_id'),

		// === LIST SOURCE TYPE ===
		// Source of list items: 'tmdb-discover', 'external-json', 'trakt-list', 'custom-manual'
		listSourceType: text('list_source_type', {
			enum: ['tmdb-discover', 'external-json', 'trakt-list', 'custom-manual']
		})
			.default('tmdb-discover')
			.notNull(),

		// === EXTERNAL SOURCE CONFIGURATION ===
		// Configuration for external list sources (URL, auth headers, list IDs, etc.)
		externalSourceConfig: text('external_source_config', { mode: 'json' })
			.$type<{
				url?: string;
				headers?: Record<string, string>;
				listId?: string;
				username?: string;
			}>()
			.default({}),

		// === PRESET CONFIGURATION ===
		// For external lists using curated presets (e.g., 'stevenlu:standard')
		presetId: text('preset_id'),
		presetProvider: text('preset_provider'),
		presetSettings: text('preset_settings', { mode: 'json' }).default({}),

		// === REFRESH CONFIGURATION ===
		// Refresh interval in hours (1-168)
		refreshIntervalHours: integer('refresh_interval_hours').default(24).notNull(),

		// === SYNC STATE ===
		lastRefreshTime: text('last_refresh_time'),
		lastRefreshStatus: text('last_refresh_status'), // 'success' | 'partial' | 'failed'
		lastRefreshError: text('last_refresh_error'),
		nextRefreshTime: text('next_refresh_time'),

		// === EXTERNAL SYNC STATE ===
		// Tracking for external list synchronization
		lastExternalSyncTime: text('last_external_sync_time'),
		externalSyncError: text('external_sync_error'),

		// === CACHED STATS ===
		cachedItemCount: integer('cached_item_count').default(0),
		itemsInLibrary: integer('items_in_library').default(0),
		itemsAutoAdded: integer('items_auto_added').default(0),

		// === TIMESTAMPS ===
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_smart_lists_enabled').on(table.enabled),
		index('idx_smart_lists_next_refresh').on(table.nextRefreshTime),
		index('idx_smart_lists_media_type').on(table.mediaType)
	]
);

export type SmartListRecord = typeof smartLists.$inferSelect;
export type NewSmartListRecord = typeof smartLists.$inferInsert;

/**
 * Smart List Items - Cached results from TMDB discover queries
 */
export const smartListItems = sqliteTable(
	'smart_list_items',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),

		// Parent smart list
		smartListId: text('smart_list_id')
			.notNull()
			.references(() => smartLists.id, { onDelete: 'cascade' }),

		// Media type (inherited from smart list)
		mediaType: text('media_type', { enum: ['movie', 'tv'] }).notNull(),

		// === TMDB DATA ===
		tmdbId: integer('tmdb_id').notNull(),

		// Cached metadata for display
		title: text('title').notNull(),
		originalTitle: text('original_title'),
		overview: text('overview'),
		posterPath: text('poster_path'),
		backdropPath: text('backdrop_path'),
		releaseDate: text('release_date'), // or first_air_date for TV
		year: integer('year'),
		voteAverage: text('vote_average'), // stored as text for precision
		voteCount: integer('vote_count'),
		popularity: text('popularity'),
		genreIds: text('genre_ids', { mode: 'json' }).$type<number[]>(),
		originalLanguage: text('original_language'),

		// === LIBRARY STATUS ===
		// Local library reference (if in library)
		movieId: text('movie_id').references(() => movies.id, { onDelete: 'set null' }),
		seriesId: text('series_id').references(() => series.id, { onDelete: 'set null' }),
		// Whether this item is in the library
		inLibrary: integer('in_library', { mode: 'boolean' }).default(false),
		// Whether this item was auto-added by this smart list
		wasAutoAdded: integer('was_auto_added', { mode: 'boolean' }).default(false),
		autoAddedAt: text('auto_added_at'),

		// === POSITION ===
		// Position in the list (based on sort order from TMDB)
		position: integer('position').notNull(),

		// === EXCLUSION ===
		// User manually excluded this item
		isExcluded: integer('is_excluded', { mode: 'boolean' }).default(false),
		excludedAt: text('excluded_at'),

		// === TIMESTAMPS ===
		firstSeenAt: text('first_seen_at').$defaultFn(() => new Date().toISOString()),
		lastSeenAt: text('last_seen_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_smart_list_items_list').on(table.smartListId),
		index('idx_smart_list_items_tmdb').on(table.tmdbId, table.mediaType),
		index('idx_smart_list_items_in_library').on(table.inLibrary),
		index('idx_smart_list_items_position').on(table.smartListId, table.position)
	]
);

export type SmartListItemRecord = typeof smartListItems.$inferSelect;
export type NewSmartListItemRecord = typeof smartListItems.$inferInsert;

/**
 * Smart List Refresh History - Tracks refresh operations
 */
export const smartListRefreshHistory = sqliteTable(
	'smart_list_refresh_history',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),

		smartListId: text('smart_list_id')
			.notNull()
			.references(() => smartLists.id, { onDelete: 'cascade' }),

		// Refresh type
		refreshType: text('refresh_type', { enum: ['automatic', 'manual'] }).notNull(),

		// Status
		status: text('status', { enum: ['running', 'success', 'partial', 'failed'] }).notNull(),

		// Results
		itemsFound: integer('items_found').default(0),
		itemsNew: integer('items_new').default(0),
		itemsRemoved: integer('items_removed').default(0),
		itemsAutoAdded: integer('items_auto_added').default(0),
		itemsFailed: integer('items_failed').default(0),

		// Failure details
		failureDetails: text('failure_details', { mode: 'json' }).$type<
			Array<{ tmdbId: number; title: string; error: string }>
		>(),

		// Timing
		startedAt: text('started_at').$defaultFn(() => new Date().toISOString()),
		completedAt: text('completed_at'),
		durationMs: integer('duration_ms'),

		// Error
		errorMessage: text('error_message')
	},
	(table) => [
		index('idx_smart_list_refresh_history_list').on(table.smartListId),
		index('idx_smart_list_refresh_history_status').on(table.status)
	]
);

export type SmartListRefreshHistoryRecord = typeof smartListRefreshHistory.$inferSelect;
export type NewSmartListRefreshHistoryRecord = typeof smartListRefreshHistory.$inferInsert;

// ============================================================================
// STREAMING CACHE TABLES
// ============================================================================

/**
 * Stream Extraction Cache - Persistent cache for successful stream extractions
 *
 * Survives server restarts by persisting popular cache entries to SQLite.
 * On startup, in-memory cache is warmed from the top entries by hit count.
 */
export const streamExtractionCache = sqliteTable(
	'stream_extraction_cache',
	{
		// Cache key (same format as in-memory cache: stream:tmdbId:type:s1:e2:provider)
		id: text('id').primaryKey(),

		// Media identification for queries
		tmdbId: integer('tmdb_id').notNull(),
		mediaType: text('media_type', { enum: ['movie', 'tv'] }).notNull(),
		seasonNumber: integer('season_number'),
		episodeNumber: integer('episode_number'),

		// The actual extraction result as JSON (ExtractionResult structure)
		extractionResult: text('extraction_result', { mode: 'json' }).$type<{
			success: boolean;
			sources: Array<{
				url: string;
				referer: string;
				provider: string;
				server?: string;
				quality?: string;
				language?: string;
				subtitles?: Array<{
					url: string;
					language: string;
					format?: string;
				}>;
			}>;
		}>(),

		// Which provider produced this result
		provider: text('provider'),

		// Timestamps
		cachedAt: text('cached_at').$defaultFn(() => new Date().toISOString()),
		expiresAt: text('expires_at').notNull(),

		// Access tracking for cache warming priority
		hitCount: integer('hit_count').default(0),
		lastAccessAt: text('last_access_at')
	},
	(table) => [
		index('idx_stream_cache_tmdb').on(table.tmdbId, table.mediaType),
		index('idx_stream_cache_expires').on(table.expiresAt),
		index('idx_stream_cache_hit_count').on(table.hitCount)
	]
);

export type StreamExtractionCacheRecord = typeof streamExtractionCache.$inferSelect;
export type NewStreamExtractionCacheRecord = typeof streamExtractionCache.$inferInsert;

// ============================================================================
// NZB STREAMING TABLES
// ============================================================================

/**
 * NNTP Servers - Configuration for Usenet news server connections
 * Used for direct NZB streaming without download clients
 */
export const nntpServers = sqliteTable(
	'nntp_servers',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		host: text('host').notNull(),
		port: integer('port').notNull().default(563),
		useSsl: integer('use_ssl', { mode: 'boolean' }).default(true),
		username: text('username'),
		password: text('password'),
		maxConnections: integer('max_connections').default(10),
		// Priority for server selection (lower = try first)
		priority: integer('priority').default(1),
		enabled: integer('enabled', { mode: 'boolean' }).default(true),
		// Optional link to download client for auto-fetch
		downloadClientId: text('download_client_id').references(() => downloadClients.id, {
			onDelete: 'set null'
		}),
		// Whether this was auto-fetched from SABnzbd/NZBGet
		autoFetched: integer('auto_fetched', { mode: 'boolean' }).default(false),
		// Connection testing
		lastTestedAt: text('last_tested_at'),
		testResult: text('test_result'), // 'success' | 'failed' | null
		testError: text('test_error'),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_nntp_servers_enabled').on(table.enabled),
		index('idx_nntp_servers_priority').on(table.priority),
		index('idx_nntp_servers_download_client').on(table.downloadClientId)
	]
);

export type NntpServerRecord = typeof nntpServers.$inferSelect;
export type NewNntpServerRecord = typeof nntpServers.$inferInsert;

/**
 * NZB Stream Mounts - Active NZB streaming sessions
 * Stores parsed NZB metadata for streaming without downloads
 */
export const nzbStreamMounts = sqliteTable(
	'nzb_stream_mounts',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Unique hash of NZB content for deduplication
		nzbHash: text('nzb_hash').notNull().unique(),
		title: text('title').notNull(),
		// Source info
		indexerId: text('indexer_id').references(() => indexers.id, { onDelete: 'set null' }),
		releaseGuid: text('release_guid'),
		downloadUrl: text('download_url'),
		// Media linkage (at least one should be set)
		movieId: text('movie_id').references(() => movies.id, { onDelete: 'cascade' }),
		seriesId: text('series_id').references(() => series.id, { onDelete: 'cascade' }),
		seasonNumber: integer('season_number'),
		episodeIds: text('episode_ids', { mode: 'json' }).$type<string[]>(),
		// NZB metadata (cached parsing results)
		fileCount: integer('file_count').notNull(),
		totalSize: integer('total_size').notNull(),
		// Parsed media files with segment info
		mediaFiles: text('media_files', { mode: 'json' })
			.$type<
				Array<{
					index: number;
					name: string;
					size: number;
					isRar: boolean;
					segments: Array<{
						messageId: string;
						bytes: number;
						number: number;
					}>;
					groups: string[];
				}>
			>()
			.notNull(),
		// RAR info if applicable
		rarInfo: text('rar_info', { mode: 'json' }).$type<{
			isMultiPart: boolean;
			isEncrypted: boolean;
			compressionMethod: number;
			format: 'rar4' | 'rar5';
			innerFiles: Array<{
				name: string;
				size: number;
				dataOffset: number;
			}>;
		}>(),
		// RAR password if needed (encrypted)
		password: text('password'),
		// Stream state
		status: text('status', {
			enum: [
				'pending',
				'parsing',
				'ready',
				'requires_extraction',
				'downloading',
				'extracting',
				'error',
				'expired'
			]
		})
			.notNull()
			.default('pending'),
		errorMessage: text('error_message'),
		// Streamability info (populated after checkStreamability is called)
		streamability: text('streamability', { mode: 'json' }).$type<{
			canStream: boolean;
			archiveType?: 'rar' | '7z' | 'zip' | 'none';
			compressionMethod?: number;
			requiresPassword?: boolean;
			error?: string;
		}>(),
		// Extraction state
		extractedFilePath: text('extracted_file_path'),
		extractionProgress: integer('extraction_progress'),
		// Usage tracking
		lastAccessedAt: text('last_accessed_at'),
		accessCount: integer('access_count').default(0),
		// Expiration for cleanup
		expiresAt: text('expires_at'),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_nzb_mounts_status').on(table.status),
		index('idx_nzb_mounts_movie').on(table.movieId),
		index('idx_nzb_mounts_series').on(table.seriesId),
		index('idx_nzb_mounts_expires').on(table.expiresAt),
		index('idx_nzb_mounts_hash').on(table.nzbHash)
	]
);

export type NzbStreamMountRecord = typeof nzbStreamMounts.$inferSelect;
export type NewNzbStreamMountRecord = typeof nzbStreamMounts.$inferInsert;

/**
 * NZB Segment Cache - Persistent storage for pre-fetched critical segments.
 *
 * Stores decoded segment data (first + last segments of video files) to enable
 * fast FFmpeg probing. Without this, FFmpeg must fetch segments on-demand to
 * read MKV headers and Cues, causing 1-2 minute playback delays.
 */
export const nzbSegmentCache = sqliteTable(
	'nzb_segment_cache',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Reference to parent mount
		mountId: text('mount_id')
			.notNull()
			.references(() => nzbStreamMounts.id, { onDelete: 'cascade' }),
		// Which file within the mount (0-indexed)
		fileIndex: integer('file_index').notNull(),
		// Which segment within the file (0-indexed)
		segmentIndex: integer('segment_index').notNull(),
		// Decoded segment data (binary)
		data: blob('data', { mode: 'buffer' }).notNull(),
		// Size in bytes (for stats)
		size: integer('size').notNull(),
		// Timestamps
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		// Fast lookup by mount + file + segment
		uniqueIndex('idx_segment_cache_lookup').on(table.mountId, table.fileIndex, table.segmentIndex),
		// For cleanup when mount is deleted (cascade handles this, but useful for queries)
		index('idx_segment_cache_mount').on(table.mountId)
	]
);

export type NzbSegmentCacheRecord = typeof nzbSegmentCache.$inferSelect;
export type NewNzbSegmentCacheRecord = typeof nzbSegmentCache.$inferInsert;

// ============================================================================
// NZB STREAMING RELATIONS
// ============================================================================

/**
 * NNTP Servers Relations
 */
export const nntpServersRelations = relations(nntpServers, ({ one }) => ({
	downloadClient: one(downloadClients, {
		fields: [nntpServers.downloadClientId],
		references: [downloadClients.id]
	})
}));

/**
 * NZB Stream Mounts Relations
 */
export const nzbStreamMountsRelations = relations(nzbStreamMounts, ({ one, many }) => ({
	indexer: one(indexers, {
		fields: [nzbStreamMounts.indexerId],
		references: [indexers.id]
	}),
	movie: one(movies, {
		fields: [nzbStreamMounts.movieId],
		references: [movies.id]
	}),
	series: one(series, {
		fields: [nzbStreamMounts.seriesId],
		references: [series.id]
	}),
	cachedSegments: many(nzbSegmentCache)
}));

/**
 * NZB Segment Cache Relations
 */
export const nzbSegmentCacheRelations = relations(nzbSegmentCache, ({ one }) => ({
	mount: one(nzbStreamMounts, {
		fields: [nzbSegmentCache.mountId],
		references: [nzbStreamMounts.id]
	})
}));

// ============================================================================
// SMART LISTS RELATIONS
// ============================================================================

/**
 * Smart Lists Relations
 */
export const smartListsRelations = relations(smartLists, ({ one, many }) => ({
	scoringProfile: one(scoringProfiles, {
		fields: [smartLists.scoringProfileId],
		references: [scoringProfiles.id]
	}),
	rootFolder: one(rootFolders, {
		fields: [smartLists.rootFolderId],
		references: [rootFolders.id]
	}),
	languageProfile: one(languageProfiles, {
		fields: [smartLists.languageProfileId],
		references: [languageProfiles.id]
	}),
	items: many(smartListItems),
	refreshHistory: many(smartListRefreshHistory)
}));

/**
 * Smart List Items Relations
 */
export const smartListItemsRelations = relations(smartListItems, ({ one }) => ({
	smartList: one(smartLists, {
		fields: [smartListItems.smartListId],
		references: [smartLists.id]
	}),
	movie: one(movies, {
		fields: [smartListItems.movieId],
		references: [movies.id]
	}),
	series: one(series, {
		fields: [smartListItems.seriesId],
		references: [series.id]
	})
}));

/**
 * Smart List Refresh History Relations
 */
export const smartListRefreshHistoryRelations = relations(smartListRefreshHistory, ({ one }) => ({
	smartList: one(smartLists, {
		fields: [smartListRefreshHistory.smartListId],
		references: [smartLists.id]
	})
}));

// ============================================================================
// MEDIA BROWSER (JELLYFIN/EMBY) INTEGRATION
// ============================================================================

/**
 * Path mapping for MediaBrowser servers.
 * Translates local paths (Cinephage) to remote paths (Jellyfin/Emby).
 */
export interface MediaBrowserPathMapping {
	/** Local path as seen by Cinephage */
	localPath: string;
	/** Remote path as seen by Jellyfin/Emby */
	remotePath: string;
}

/**
 * MediaBrowser Servers - Jellyfin, Emby, and Plex server configurations.
 * Used to notify media servers when content is added, updated, or deleted.
 */
export const mediaBrowserServers = sqliteTable('media_browser_servers', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	serverType: text('server_type', { enum: ['jellyfin', 'emby', 'plex'] }).notNull(),
	host: text('host').notNull(),
	apiKey: text('api_key').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).default(true),
	onImport: integer('on_import', { mode: 'boolean' }).default(true),
	onUpgrade: integer('on_upgrade', { mode: 'boolean' }).default(true),
	onRename: integer('on_rename', { mode: 'boolean' }).default(true),
	onDelete: integer('on_delete', { mode: 'boolean' }).default(true),
	pathMappings: text('path_mappings', { mode: 'json' }).$type<MediaBrowserPathMapping[]>(),
	serverName: text('server_name'),
	serverVersion: text('server_version'),
	serverId: text('server_id'),
	lastTestedAt: text('last_tested_at'),
	testResult: text('test_result'),
	testError: text('test_error'),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
});

export type MediaBrowserServerRecord = typeof mediaBrowserServers.$inferSelect;
export type NewMediaBrowserServerRecord = typeof mediaBrowserServers.$inferInsert;
/**
 * Per-account preference storage (JSON values keyed by a namespaced key,
 * e.g. 'calendar', 'theme'). Personal by definition — nothing here falls
 * back to a global row.
 */
export const userPreferences = sqliteTable(
	'user_preferences',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		value: text('value').notNull(),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [primaryKey({ columns: [table.userId, table.key] })]
);

/**
 * A Cinephage account linked to its media-server account (Jellyfin first).
 * Identity mapping only: serverUserId + a username snapshot. No per-user
 * tokens are ever stored — pairing proves identity and the server-side
 * admin key handles data access internally.
 */
export const userMediaServerLinks = sqliteTable(
	'user_media_server_links',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		serverId: text('server_id')
			.notNull()
			.references(() => mediaBrowserServers.id, { onDelete: 'cascade' }),
		serverUserId: text('server_user_id').notNull(),
		serverUsername: text('server_username').notNull(),
		linkedAt: text('linked_at').$defaultFn(() => new Date().toISOString()),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		// One media-server account maps to exactly one Cinephage account,
		// and each Cinephage account holds at most one link per server.
		uniqueIndex('idx_user_media_server_links_server_user').on(table.serverId, table.serverUserId),
		uniqueIndex('idx_user_media_server_links_user_server').on(table.userId, table.serverId)
	]
);

export const mediaServerSyncedItems = sqliteTable(
	'media_server_synced_items',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		serverId: text('server_id')
			.notNull()
			.references(() => mediaBrowserServers.id, { onDelete: 'cascade' }),
		serverItemId: text('server_item_id').notNull(),
		tmdbId: integer('tmdb_id'),
		tvdbId: integer('tvdb_id'),
		imdbId: text('imdb_id'),
		title: text('title').notNull(),
		year: integer('year'),
		itemType: text('item_type', { enum: ['movie', 'episode', 'series', 'season'] }).notNull(),
		seriesName: text('series_name'),
		seasonNumber: integer('season_number'),
		episodeNumber: integer('episode_number'),
		playCount: integer('play_count').default(0),
		lastPlayedDate: text('last_played_date'),
		playedPercentage: real('played_percentage'),
		isPlayed: integer('is_played').default(0),
		videoCodec: text('video_codec'),
		videoProfile: text('video_profile'),
		videoBitDepth: integer('video_bit_depth'),
		width: integer('width'),
		height: integer('height'),
		isHDR: integer('is_hdr').default(0),
		hdrFormat: text('hdr_format'),
		videoBitrate: integer('video_bitrate'),
		audioCodec: text('audio_codec'),
		audioChannels: integer('audio_channels'),
		audioChannelLayout: text('audio_channel_layout'),
		audioBitrate: integer('audio_bitrate'),
		audioLanguages: text('audio_languages', { mode: 'json' }).$type<string[]>().default([]),
		subtitleLanguages: text('subtitle_languages', { mode: 'json' }).$type<string[]>().default([]),
		// Untouched source language strings as reported by the media server;
		// audio/subtitle above hold the canonicalized tags (migration v140).
		audioLanguagesRaw: text('audio_languages_raw', { mode: 'json' }).$type<string[]>(),
		subtitleLanguagesRaw: text('subtitle_languages_raw', { mode: 'json' }).$type<string[]>(),
		containerFormat: text('container_format'),
		fileSize: integer('file_size'),
		bitrate: integer('bitrate'),
		duration: integer('duration'),
		lastSyncedAt: text('last_synced_at').notNull(),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [uniqueIndex('idx_synced_items_unique').on(table.serverId, table.serverItemId)]
);

export const mediaServerSyncedRuns = sqliteTable('media_server_synced_runs', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	serverId: text('server_id')
		.notNull()
		.references(() => mediaBrowserServers.id, { onDelete: 'cascade' }),
	status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
	itemsSynced: integer('items_synced').default(0),
	itemsAdded: integer('items_added').default(0),
	itemsUpdated: integer('items_updated').default(0),
	itemsRemoved: integer('items_removed').default(0),
	errorMessage: text('error_message'),
	startedAt: text('started_at').notNull(),
	completedAt: text('completed_at'),
	duration: integer('duration'),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
});

export type MediaServerSyncedItemRecord = typeof mediaServerSyncedItems.$inferSelect;
export type NewMediaServerSyncedItemRecord = typeof mediaServerSyncedItems.$inferInsert;
export type MediaServerSyncedRunRecord = typeof mediaServerSyncedRuns.$inferSelect;
export type NewMediaServerSyncedRunRecord = typeof mediaServerSyncedRuns.$inferInsert;

/**
 * Storage Items - Unified directory of media items across local library and media servers.
 * Reference-model: holds identity + FK references; size/quality/playback stay on source tables.
 * Populated by ReconciliationService (Phase 2).
 */
export const storageItems = sqliteTable('storage_items', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	itemType: text('item_type', { enum: ['movie', 'episode', 'series', 'season'] }).notNull(),
	tmdbId: integer('tmdb_id'),
	tvdbId: integer('tvdb_id'),
	imdbId: text('imdb_id'),
	title: text('title').notNull(),
	year: integer('year'),
	seriesName: text('series_name'),
	seasonNumber: integer('season_number'),
	episodeNumber: integer('episode_number'),
	// FK to local file row (nullable when item only exists on a media server)
	movieFileId: text('movie_file_id').references(() => movieFiles.id, { onDelete: 'set null' }),
	episodeFileId: text('episode_file_id').references(() => episodeFiles.id, {
		onDelete: 'set null'
	}),
	rootFolderId: text('root_folder_id').references(() => rootFolders.id, { onDelete: 'set null' }),
	libraryId: text('library_id').references(() => libraries.id, { onDelete: 'set null' }),
	sourceSystem: text('source_system', { enum: ['local', 'server', 'both'] }).notNull(),
	matchConfidence: text('match_confidence', { enum: ['exact', 'id', 'fuzzy', 'none'] }).notNull(),
	firstSeenAt: text('first_seen_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	lastReconciledAt: text('last_reconciled_at')
});

export type StorageItemRecord = typeof storageItems.$inferSelect;
export type NewStorageItemRecord = typeof storageItems.$inferInsert;

/**
 * Storage Item Server Links - Sidecar mapping items to media-server presence.
 * One item can be tracked by N servers; each (storageItemId, serverId) pair is unique.
 */
export const storageItemServerLinks = sqliteTable(
	'storage_item_server_links',
	{
		storageItemId: text('storage_item_id')
			.notNull()
			.references(() => storageItems.id, { onDelete: 'cascade' }),
		serverId: text('server_id')
			.notNull()
			.references(() => mediaBrowserServers.id, { onDelete: 'cascade' }),
		syncedItemId: text('synced_item_id')
			.notNull()
			.references(() => mediaServerSyncedItems.id, { onDelete: 'cascade' }),
		lastSeenAt: text('last_seen_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		primaryKey({ columns: [table.storageItemId, table.serverId] }),
		index('idx_storage_links_synced').on(table.syncedItemId)
	]
);

export type StorageItemServerLinkRecord = typeof storageItemServerLinks.$inferSelect;
export type NewStorageItemServerLinkRecord = typeof storageItemServerLinks.$inferInsert;

/**
 * Storage Insights - Cached, dismissible findings produced by the InsightsService (Phase 3).
 * One row per detected finding; dismissed findings remain for audit and can be re-detected on change.
 */
export const storageInsights = sqliteTable('storage_insights', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	insightType: text('insight_type').notNull(),
	severity: text('severity', { enum: ['info', 'warning', 'critical'] }).notNull(),
	scope: text('scope', { enum: ['global', 'library', 'root_folder', 'item'] }).notNull(),
	scopeId: text('scope_id'),
	title: text('title').notNull(),
	summary: text('summary'),
	detailsJson: text('details_json'),
	reclaimableBytes: integer('reclaimable_bytes'),
	itemCount: integer('item_count').notNull().default(0),
	firstDetectedAt: text('first_detected_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	lastDetectedAt: text('last_detected_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	dismissedAt: text('dismissed_at'),
	// Soft ref to auth DB user id - auth DB is separate, no FK possible (matches session/account convention)
	dismissedBy: text('dismissed_by')
});

export type StorageInsightRecord = typeof storageInsights.$inferSelect;
export type NewStorageInsightRecord = typeof storageInsights.$inferInsert;

// ============================================================================
// LIVE TV - STALKER PORTALS
// ============================================================================

/**
 * Stalker Portals - Saved portal URLs for scanning and account discovery.
 * Portals can be scanned to find valid MAC addresses.
 */
export const stalkerPortals = sqliteTable(
	'stalker_portals',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		url: text('url').notNull().unique(),
		endpoint: text('endpoint'), // 'portal.php' or 'stalker_portal/server/load.php'
		serverTimezone: text('server_timezone'),
		lastScannedAt: text('last_scanned_at'),
		lastScanResults: text('last_scan_results'), // JSON summary
		enabled: integer('enabled', { mode: 'boolean' }).default(true),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [index('idx_stalker_portals_enabled').on(table.enabled)]
);

export type StalkerPortalRecord = typeof stalkerPortals.$inferSelect;
export type NewStalkerPortalRecord = typeof stalkerPortals.$inferInsert;

// ============================================================================
// LIVE TV - PORTAL SCAN RESULTS
// ============================================================================

/**
 * Portal Scan Results - Discovered accounts pending user approval.
 * Stores MAC addresses found during portal scanning along with their profile data.
 */
export const portalScanResults = sqliteTable(
	'portal_scan_results',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		portalId: text('portal_id')
			.notNull()
			.references(() => stalkerPortals.id, { onDelete: 'cascade' }),
		macAddress: text('mac_address').notNull(),
		status: text('status')
			.$type<'pending' | 'approved' | 'ignored' | 'expired'>()
			.notNull()
			.default('pending'),

		// Account metadata discovered during scan
		channelCount: integer('channel_count'),
		categoryCount: integer('category_count'),
		expiresAt: text('expires_at'),
		accountStatus: text('account_status').$type<'active' | 'expired'>(),
		playbackLimit: integer('playback_limit'),
		serverTimezone: text('server_timezone'),
		rawProfile: text('raw_profile'), // JSON - full profile data for review

		// Timestamps
		discoveredAt: text('discovered_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		processedAt: text('processed_at') // When user took action
	},
	(table) => [
		uniqueIndex('idx_scan_results_portal_mac').on(table.portalId, table.macAddress),
		index('idx_scan_results_portal_status').on(table.portalId, table.status)
	]
);

export type PortalScanResultRecord = typeof portalScanResults.$inferSelect;
export type NewPortalScanResultRecord = typeof portalScanResults.$inferInsert;

// ============================================================================
// LIVE TV - PORTAL SCAN HISTORY
// ============================================================================

/**
 * Portal Scan History - Execution history for portal scans.
 * Tracks each scan operation with configuration and results.
 */
export const portalScanHistory = sqliteTable(
	'portal_scan_history',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		portalId: text('portal_id')
			.notNull()
			.references(() => stalkerPortals.id, { onDelete: 'cascade' }),
		workerId: text('worker_id'), // Reference to worker for active scans
		scanType: text('scan_type').$type<'random' | 'sequential' | 'import'>().notNull(),
		macPrefix: text('mac_prefix'), // For random/sequential scans
		macRangeStart: text('mac_range_start'), // For sequential
		macRangeEnd: text('mac_range_end'), // For sequential
		macsToTest: integer('macs_to_test'),
		macsTested: integer('macs_tested').default(0),
		macsFound: integer('macs_found').default(0),
		status: text('status')
			.$type<'running' | 'completed' | 'cancelled' | 'failed'>()
			.notNull()
			.default('running'),
		error: text('error'),
		startedAt: text('started_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		completedAt: text('completed_at')
	},
	(table) => [
		index('idx_scan_history_portal').on(table.portalId),
		index('idx_scan_history_status').on(table.status)
	]
);

export type PortalScanHistoryRecord = typeof portalScanHistory.$inferSelect;
export type NewPortalScanHistoryRecord = typeof portalScanHistory.$inferInsert;

// ============================================================================
// LIVE TV - USER CHANNEL CATEGORIES
// ============================================================================

/**
 * Channel Categories - User-defined categories for organizing their channel lineup.
 * Separate from portal categories - allows custom organization.
 */
export const channelCategories = sqliteTable(
	'channel_categories',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		position: integer('position').notNull(),
		color: text('color'), // Hex color for UI badge
		icon: text('icon'), // Lucide icon name
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [index('idx_channel_categories_position').on(table.position)]
);

export type ChannelCategoryRecord = typeof channelCategories.$inferSelect;
export type NewChannelCategoryRecord = typeof channelCategories.$inferInsert;

// ============================================================================
// LIVE TV - USER CHANNEL LINEUP
// ============================================================================

/**
 * Channel Lineup Items - User's custom channel lineup for Live TV.
 * Stores references to cached channels with custom ordering and overrides.
 */
export const channelLineupItems = sqliteTable(
	'channel_lineup_items',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Reference to the source account
		accountId: text('account_id')
			.notNull()
			.references(() => livetvAccounts.id, { onDelete: 'cascade' }),
		// Reference to the cached channel
		channelId: text('channel_id')
			.notNull()
			.references(() => livetvChannels.id, { onDelete: 'cascade' }),
		// Position in the lineup (1-based, for drag-to-reorder)
		position: integer('position').notNull(),
		// Custom channel number for EPG/remote control
		channelNumber: integer('channel_number'),
		// User customizations (override cached values when set)
		customName: text('custom_name'),
		customLogo: text('custom_logo'),
		epgId: text('epg_id'), // XMLTV EPG ID for Jellyfin/Plex matching
		// EPG source override - use EPG data from a different channel
		epgSourceChannelId: text('epg_source_channel_id').references(() => livetvChannels.id, {
			onDelete: 'set null'
		}),
		// User-created category (separate from portal category)
		categoryId: text('category_id').references(() => channelCategories.id, {
			onDelete: 'set null'
		}),
		addedAt: text('added_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		uniqueIndex('idx_lineup_account_channel').on(table.accountId, table.channelId),
		index('idx_lineup_position').on(table.position),
		index('idx_lineup_account').on(table.accountId),
		index('idx_lineup_category').on(table.categoryId)
	]
);

export type ChannelLineupItemRecord = typeof channelLineupItems.$inferSelect;
export type NewChannelLineupItemRecord = typeof channelLineupItems.$inferInsert;

// ============================================================================
// LIVE TV - CHANNEL LINEUP BACKUPS
// ============================================================================

/**
 * Channel Lineup Backups - Alternative channel sources for failover.
 * Each lineup item can have multiple backup links from any synced account.
 * When the primary source fails, the system can try backups in priority order.
 */
export const channelLineupBackups = sqliteTable(
	'channel_lineup_backups',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Reference to the lineup item this backup belongs to
		lineupItemId: text('lineup_item_id')
			.notNull()
			.references(() => channelLineupItems.id, { onDelete: 'cascade' }),
		// Reference to the backup source account (can be different from primary)
		accountId: text('account_id')
			.notNull()
			.references(() => livetvAccounts.id, { onDelete: 'cascade' }),
		// Reference to the backup channel
		channelId: text('channel_id')
			.notNull()
			.references(() => livetvChannels.id, { onDelete: 'cascade' }),
		// Priority order (1 = first backup, 2 = second, etc.)
		priority: integer('priority').notNull(),
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_lineup_backups_item').on(table.lineupItemId),
		index('idx_lineup_backups_priority').on(table.lineupItemId, table.priority),
		uniqueIndex('idx_lineup_backups_unique').on(table.lineupItemId, table.channelId)
	]
);

export type ChannelLineupBackupRecord = typeof channelLineupBackups.$inferSelect;
export type NewChannelLineupBackupRecord = typeof channelLineupBackups.$inferInsert;

// ============================================================================
// LIVE TV - EPG (Electronic Program Guide)
// ============================================================================

/**
 * EPG Programs - Stores program guide data fetched from provider accounts.
 * Linked to channels for now/next and guide queries.
 * Updated for multi-provider support (Stalker, XStream, M3U).
 */
export const epgPrograms = sqliteTable(
	'epg_programs',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Reference to the cached channel (unified)
		channelId: text('channel_id')
			.notNull()
			.references(() => livetvChannels.id, { onDelete: 'cascade' }),
		// External channel ID from provider (stalker_id, xstream_id, or tvg-id)
		externalChannelId: text('external_channel_id').notNull(),
		// Reference to the source account (unified)
		accountId: text('account_id')
			.notNull()
			.references(() => livetvAccounts.id, { onDelete: 'cascade' }),
		// Provider type for this EPG data
		providerType: text('provider_type').$type<LiveTvProviderType>().notNull(),
		// Program metadata
		title: text('title').notNull(),
		description: text('description'),
		category: text('category'),
		// Localized variants preserved from XMLTV @lang attributes (migration 140):
		// JSON arrays of { lang: string | null, text: string } with lang lower-cased.
		// Nullable — rows written before (or without) language data keep NULL, and
		// display-time selection falls back to the plain columns above.
		titleI18n: text('title_i18n', { mode: 'json' }).$type<EpgLocalizedText[]>(),
		descriptionI18n: text('description_i18n', { mode: 'json' }).$type<EpgLocalizedText[]>(),
		categoryI18n: text('category_i18n', { mode: 'json' }).$type<EpgLocalizedText[]>(),
		director: text('director'),
		actor: text('actor'),
		// Timing (ISO 8601 strings)
		startTime: text('start_time').notNull(),
		endTime: text('end_time').notNull(),
		// Duration in seconds
		duration: integer('duration').notNull(),
		// Archive availability
		hasArchive: integer('has_archive', { mode: 'boolean' }).default(false),
		// Timestamps
		cachedAt: text('cached_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_epg_programs_channel').on(table.channelId),
		index('idx_epg_programs_channel_time').on(table.channelId, table.startTime),
		index('idx_epg_programs_account').on(table.accountId),
		index('idx_epg_programs_end').on(table.endTime),
		// Unique constraint: one program per channel per start time per account
		uniqueIndex('idx_epg_programs_unique').on(
			table.accountId,
			table.externalChannelId,
			table.startTime
		)
	]
);

export type EpgProgramRecord = typeof epgPrograms.$inferSelect;
export type NewEpgProgramRecord = typeof epgPrograms.$inferInsert;

// ============================================================================
// LIVE TV - UNIFIED PROVIDER ACCOUNTS (Multi-provider support: Stalker, XStream, M3U, Cinephage)
// ============================================================================

export const livetvProviderTypeEnum = ['stalker', 'xstream', 'm3u', 'cinephage-iptv'] as const;
export type LiveTvProviderType = (typeof livetvProviderTypeEnum)[number];

/**
 * Live TV Accounts - Unified provider accounts supporting multiple IPTV protocols.
 * Replaces stalker_accounts with a generic structure that supports Stalker Portal,
 * XStream Codes, and M3U playlist sources.
 */
export const livetvAccounts = sqliteTable(
	'livetv_accounts',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		providerType: text('provider_type').$type<LiveTvProviderType>().notNull(),
		enabled: integer('enabled', { mode: 'boolean' }).default(true),

		// Stalker Portal specific config (stored as JSON)
		stalkerConfig: text('stalker_config', { mode: 'json' }).$type<{
			portalUrl: string;
			macAddress: string;
			serialNumber?: string;
			deviceId?: string;
			deviceId2?: string;
			model?: string;
			timezone?: string;
			language?: string; // Portal UI language (stb_lang), 2-letter code; 'en' when absent
			token?: string;
			username?: string;
			password?: string;
			portalId?: string; // Reference to stalkerPortals.id
			discoveredFromScan?: boolean;
			streamUrlType?: 'direct' | 'create_link' | 'unknown';
		}>(),

		// XStream Codes specific config (stored as JSON)
		xstreamConfig: text('xstream_config', { mode: 'json' }).$type<{
			baseUrl: string;
			username: string;
			password: string;
			epgUrl?: string;
			authToken?: string;
			tokenExpiry?: string;
		}>(),

		// M3U Playlist specific config (stored as JSON)
		m3uConfig: text('m3u_config', { mode: 'json' }).$type<{
			url?: string;
			fileContent?: string; // For uploaded M3U files
			epgUrl?: string; // Optional XMLTV EPG URL
			refreshIntervalHours?: number;
			lastRefreshAt?: string;
			autoRefresh?: boolean;
		}>(),

		// IPTV-Org API specific config (stored as JSON)
		iptvOrgConfig: text('iptv_org_config', { mode: 'json' }).$type<{
			countries?: string[]; // ISO 3166-1 alpha-2 codes
			categories?: string[];
			languages?: string[]; // ISO 639-3 codes
			lastSyncAt?: string;
			autoSyncIntervalHours?: number;
			preferredQuality?: string | null;
		}>(),

		// Common metadata fields
		playbackLimit: integer('playback_limit'),
		channelCount: integer('channel_count'),
		categoryCount: integer('category_count'),
		expiresAt: text('expires_at'),
		serverTimezone: text('server_timezone'),

		// Health tracking
		lastTestedAt: text('last_tested_at'),
		lastTestSuccess: integer('last_test_success', { mode: 'boolean' }),
		lastTestError: text('last_test_error'),

		// Sync tracking (channel sync)
		lastSyncAt: text('last_sync_at'),
		lastSyncError: text('last_sync_error'),
		syncStatus: text('sync_status', { enum: ['never', 'syncing', 'success', 'failed'] }).default(
			'never'
		),

		// EPG tracking (separate from channel sync)
		lastEpgSyncAt: text('last_epg_sync_at'),
		lastEpgSyncError: text('last_epg_sync_error'),
		epgProgramCount: integer('epg_program_count').default(0),
		hasEpg: integer('has_epg', { mode: 'boolean' }),

		// Timestamps
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_livetv_accounts_enabled').on(table.enabled),
		index('idx_livetv_accounts_type').on(table.providerType)
	]
);

export type LivetvAccountRecord = typeof livetvAccounts.$inferSelect;
export type NewLivetvAccountRecord = typeof livetvAccounts.$inferInsert;

// ============================================================================
// LIVE TV - UNIFIED CHANNELS (Multi-provider support)
// ============================================================================

/**
 * Live TV Channels - Unified channel cache supporting all provider types.
 * Replaces stalker_channels with a generic structure.
 */
export const livetvChannels = sqliteTable(
	'livetv_channels',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		accountId: text('account_id')
			.notNull()
			.references(() => livetvAccounts.id, { onDelete: 'cascade' }),
		providerType: text('provider_type').$type<LiveTvProviderType>().notNull(),

		// External provider ID (stalkerId for Stalker, streamId for XStream, tvg-id for M3U)
		externalId: text('external_id').notNull(),

		// Common channel fields
		name: text('name').notNull(),
		number: text('number'),
		logo: text('logo'),

		// Category reference (can be from provider-specific category table or generic)
		categoryId: text('category_id'), // Generic category ID
		providerCategoryId: text('provider_category_id'), // Provider's category ID

		// Provider-specific data stored as JSON
		stalkerData: text('stalker_data', { mode: 'json' }).$type<{
			stalkerGenreId?: string;
			cmd: string;
			tvArchive: boolean;
			archiveDuration: number;
		}>(),

		xstreamData: text('xstream_data', { mode: 'json' }).$type<{
			streamId: string;
			streamType: string;
			epgChannelId?: string;
			directStreamUrl?: string;
			containerExtension?: string;
		}>(),

		m3uData: text('m3u_data', { mode: 'json' }).$type<{
			tvgId?: string;
			tvgName?: string;
			groupTitle?: string;
			url: string;
			tvgLogo?: string;
			attributes?: Record<string, string>;
		}>(),

		// EPG mapping
		epgId: text('epg_id'), // XMLTV EPG ID override

		// Timestamps
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_livetv_channels_account').on(table.accountId),
		index('idx_livetv_channels_type').on(table.providerType),
		index('idx_livetv_channels_external').on(table.externalId),
		index('idx_livetv_channels_name').on(table.name),
		uniqueIndex('idx_livetv_channels_unique').on(table.accountId, table.externalId)
	]
);

export type LivetvChannelRecord = typeof livetvChannels.$inferSelect;
export type NewLivetvChannelRecord = typeof livetvChannels.$inferInsert;

// ============================================================================
// LIVE TV - UNIFIED PROVIDER CATEGORIES
// ============================================================================

/**
 * Live TV Provider Categories - Category cache for all provider types.
 * Replaces stalker_categories with a generic structure.
 */
export const livetvCategories = sqliteTable(
	'livetv_categories',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		accountId: text('account_id')
			.notNull()
			.references(() => livetvAccounts.id, { onDelete: 'cascade' }),
		providerType: text('provider_type').$type<LiveTvProviderType>().notNull(),

		// External provider ID
		externalId: text('external_id').notNull(),

		// Category info
		title: text('title').notNull(),
		alias: text('alias'),
		censored: integer('censored', { mode: 'boolean' }).default(false),
		channelCount: integer('channel_count').default(0),

		// Provider-specific data
		providerData: text('provider_data', { mode: 'json' }).$type<Record<string, unknown>>(),

		// Timestamps
		createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_livetv_categories_account').on(table.accountId),
		uniqueIndex('idx_livetv_categories_unique').on(table.accountId, table.externalId)
	]
);

export type LivetvCategoryRecord = typeof livetvCategories.$inferSelect;
export type NewLivetvCategoryRecord = typeof livetvCategories.$inferInsert;

// ============================================================================
// RELATIONS (Updated for new unified tables)
// ============================================================================

/**
 * Channel Categories Relations
 */
export const channelCategoriesRelations = relations(channelCategories, ({ many }) => ({
	lineupItems: many(channelLineupItems)
}));

/**
 * Channel Lineup Items Relations (Updated to use livetv_accounts and livetv_channels)
 */
export const channelLineupItemsRelations = relations(channelLineupItems, ({ one, many }) => ({
	account: one(livetvAccounts, {
		fields: [channelLineupItems.accountId],
		references: [livetvAccounts.id]
	}),
	channel: one(livetvChannels, {
		fields: [channelLineupItems.channelId],
		references: [livetvChannels.id]
	}),
	category: one(channelCategories, {
		fields: [channelLineupItems.categoryId],
		references: [channelCategories.id]
	}),
	backups: many(channelLineupBackups)
}));

/**
 * Channel Lineup Backups Relations (Updated to use livetv_accounts and livetv_channels)
 */
export const channelLineupBackupsRelations = relations(channelLineupBackups, ({ one }) => ({
	lineupItem: one(channelLineupItems, {
		fields: [channelLineupBackups.lineupItemId],
		references: [channelLineupItems.id]
	}),
	account: one(livetvAccounts, {
		fields: [channelLineupBackups.accountId],
		references: [livetvAccounts.id]
	}),
	channel: one(livetvChannels, {
		fields: [channelLineupBackups.channelId],
		references: [livetvChannels.id]
	})
}));

/**
 * EPG Programs Relations (Updated to use livetv_channels and livetv_accounts)
 */
export const epgProgramsRelations = relations(epgPrograms, ({ one }) => ({
	channel: one(livetvChannels, {
		fields: [epgPrograms.channelId],
		references: [livetvChannels.id]
	}),
	account: one(livetvAccounts, {
		fields: [epgPrograms.accountId],
		references: [livetvAccounts.id]
	})
}));

/**
 * Live TV Accounts Relations
 */
export const livetvAccountsRelations = relations(livetvAccounts, ({ many }) => ({
	channels: many(livetvChannels),
	categories: many(livetvCategories),
	lineupItems: many(channelLineupItems),
	backups: many(channelLineupBackups),
	epgPrograms: many(epgPrograms)
}));

/**
 * Live TV Channels Relations
 */
export const livetvChannelsRelations = relations(livetvChannels, ({ one, many }) => ({
	account: one(livetvAccounts, {
		fields: [livetvChannels.accountId],
		references: [livetvAccounts.id]
	}),
	category: one(livetvCategories, {
		fields: [livetvChannels.categoryId],
		references: [livetvCategories.id]
	}),
	lineupItems: many(channelLineupItems),
	epgPrograms: many(epgPrograms)
}));

/**
 * Live TV Categories Relations
 */
export const livetvCategoriesRelations = relations(livetvCategories, ({ one, many }) => ({
	account: one(livetvAccounts, {
		fields: [livetvCategories.accountId],
		references: [livetvAccounts.id]
	}),
	channels: many(livetvChannels)
}));

/**
 * Stalker Portals Relations
 */
export const stalkerPortalsRelations = relations(stalkerPortals, ({ many }) => ({
	scanResults: many(portalScanResults),
	scanHistory: many(portalScanHistory)
}));

/**
 * Portal Scan Results Relations
 */
export const portalScanResultsRelations = relations(portalScanResults, ({ one }) => ({
	portal: one(stalkerPortals, {
		fields: [portalScanResults.portalId],
		references: [stalkerPortals.id]
	})
}));

/**
 * Portal Scan History Relations
 */
export const portalScanHistoryRelations = relations(portalScanHistory, ({ one }) => ({
	portal: one(stalkerPortals, {
		fields: [portalScanHistory.portalId],
		references: [stalkerPortals.id]
	})
}));

// ============================================================================
// API Key Secrets Table
// ============================================================================
// Stores encrypted full API keys so users can view them anytime
// Encryption uses AES-256-GCM with key derived from BETTER_AUTH_SECRET

export const userApiKeySecrets = sqliteTable(
	'userApiKeySecrets',
	{
		id: text('id').primaryKey(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		encryptedKey: text('encryptedKey').notNull(),
		createdAt: text('createdAt').notNull()
	},
	(table) => [index('idx_userApiKeySecrets_userId').on(table.userId)]
);

export type UserApiKeySecretRecord = typeof userApiKeySecrets.$inferSelect;
export type NewUserApiKeySecretRecord = typeof userApiKeySecrets.$inferInsert;

export const userApiKeySecretsRelations = relations(userApiKeySecrets, ({ one }) => ({
	user: one(user, {
		fields: [userApiKeySecrets.userId],
		references: [user.id]
	})
}));

// ============================================================================
// Rename History Table
// ============================================================================
// Permanent audit trail for every file rename attempt.
// Survives log rotation; enables undo/recovery if things go wrong.

export const renameHistory = sqliteTable('rename_history', {
	id: text('id').primaryKey(),
	fileId: text('file_id').notNull(),
	mediaType: text('media_type').notNull(),
	oldPath: text('old_path').notNull(),
	newPath: text('new_path').notNull(),
	success: integer('success').notNull().default(0),
	error: text('error'),
	operation: text('operation').notNull().default('rename'),
	createdAt: text('created_at').notNull()
});

export type RenameHistoryRecord = typeof renameHistory.$inferSelect;

// ============================================================================
// Diagnostic Report Tables
// ============================================================================

export const rejectedReleases = sqliteTable(
	'rejected_releases',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		correlationId: text('correlation_id'),
		releaseTitle: text('release_title').notNull(),
		indexerName: text('indexer_name'),
		protocol: text('protocol'), // 'torrent' | 'usenet' | 'debrid'
		tmdbId: integer('tmdb_id'),
		mediaType: text('media_type'), // 'movie' | 'tv'
		mediaTitle: text('media_title'),
		rejectionReasons: text('rejection_reasons', { mode: 'json' }).$type<
			Array<{ type: string; rule: string; passed: boolean; detail?: string }>
		>(),
		primaryReason: text('primary_reason'), // 'required_format_mismatch' | 'quality_profile_mismatch' | 'delay_profile_pending' | 'other'
		ruleFired: text('rule_fired'), // short description of the triggering rule
		qualityProfileName: text('quality_profile_name'),
		releaseSize: integer('release_size'),
		releaseGroup: text('release_group'),
		// Grab fields — stored at rejection time to enable "Override and grab"
		downloadUrl: text('download_url'),
		magnetUrl: text('magnet_url'),
		infoHash: text('info_hash'),
		indexerGuid: text('indexer_guid'),
		indexerId: text('indexer_id'),
		rejectedAt: text('rejected_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		status: text('status').notNull().default('rejected') // 'rejected' | 'overridden' | 'resolved'
	},
	(table) => [
		index('idx_rejected_releases_rejected_at').on(table.rejectedAt),
		index('idx_rejected_releases_tmdb').on(table.tmdbId, table.mediaType),
		index('idx_rejected_releases_status').on(table.status)
	]
);

export type RejectedReleaseRecord = typeof rejectedReleases.$inferSelect;
export type NewRejectedReleaseRecord = typeof rejectedReleases.$inferInsert;

export const importFailures = sqliteTable(
	'import_failures',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		correlationId: text('correlation_id'),
		releaseTitle: text('release_title').notNull(),
		sourcePath: text('source_path'),
		destinationPath: text('destination_path'),
		// 'path_resolution' | 'dangerous_files' | 'disk_space' | 'root_folder' | 'library_entity' | 'transfer' | 'max_retries'
		failureStage: text('failure_stage').notNull(),
		// 'path_unavailable' | 'library_entity_missing' | 'root_folder_unavailable' | 'insufficient_disk_space' | 'dangerous_files_detected' | 'transfer_failed' | 'max_retries_exceeded'
		reason: text('reason').notNull(),
		reasonDetail: text('reason_detail'),
		dangerousFiles: text('dangerous_files', { mode: 'json' }).$type<
			Array<{ path: string; extension: string }>
		>(),
		attemptCount: integer('attempt_count').notNull().default(1),
		downloadClientId: text('download_client_id'),
		failedAt: text('failed_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		status: text('status').notNull().default('failed'), // 'failed' | 'retrying' | 'resolved'
		resolvedAt: text('resolved_at')
	},
	(table) => [
		index('idx_import_failures_failed_at').on(table.failedAt),
		index('idx_import_failures_status').on(table.status),
		index('idx_import_failures_stage').on(table.failureStage)
	]
);

export type ImportFailureRecord = typeof importFailures.$inferSelect;
export type NewImportFailureRecord = typeof importFailures.$inferInsert;

export const renamingFailures = sqliteTable(
	'renaming_failures',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		correlationId: text('correlation_id'),
		fileId: text('file_id').notNull(),
		fileType: text('file_type').notNull(), // 'movie' | 'episode'
		sourcePath: text('source_path').notNull(),
		intendedPath: text('intended_path').notNull(),
		namingTemplate: text('naming_template'),
		// 'collision' | 'invalid_chars' | 'path_too_long' | 'permission_denied' | 'source_not_found' | 'disk_full'
		reason: text('reason').notNull(),
		reasonDetail: text('reason_detail'),
		failedAt: text('failed_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		status: text('status').notNull().default('failed'), // 'failed' | 'resolved'
		resolvedAt: text('resolved_at')
	},
	(table) => [
		index('idx_renaming_failures_failed_at').on(table.failedAt),
		index('idx_renaming_failures_file').on(table.fileId, table.fileType),
		index('idx_renaming_failures_status').on(table.status)
	]
);

export type RenamingFailureRecord = typeof renamingFailures.$inferSelect;
export type NewRenamingFailureRecord = typeof renamingFailures.$inferInsert;

export type NewRenameHistoryRecord = typeof renameHistory.$inferInsert;

/**
 * Arr ID Mappings - surrogate integer IDs for the Radarr/Sonarr-compatible
 * API layer. Cinephage's own entities (root folders, scoring profiles,
 * movies, series, ...) use UUID text primary keys, but the Radarr/Sonarr v3
 * contract types every ID as an integer - client libraries (autobrr,
 * Overseerr, ArrAPI/Kometa) decode fields like `qualityProfileId` as ints.
 * This table assigns a stable integer per (entityType, entityId) pair the
 * first time it's exposed through the compat layer, so responses stay
 * consistent across requests and restarts without renumbering Cinephage's
 * own tables.
 */
export const arrIdMappings = sqliteTable(
	'arr_id_mappings',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		// e.g. 'rootFolder', 'qualityProfile', 'movie', 'series', 'tag'
		entityType: text('entity_type').notNull(),
		// The Cinephage UUID this surrogate ID stands in for
		entityId: text('entity_id').notNull(),
		createdAt: text('created_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString())
	},
	(table) => [uniqueIndex('idx_arr_id_mappings_entity').on(table.entityType, table.entityId)]
);

export type ArrIdMapping = typeof arrIdMappings.$inferSelect;
export type NewArrIdMapping = typeof arrIdMappings.$inferInsert;

/**
 * Radarr/Sonarr-compatible notification (webhook) connections registered by
 * arr-compat clients (Pulsarr, Notifiarr, etc.) via POST /notification.
 * `config` stores the full NotificationResource body as posted (name,
 * implementation, fields incl. url/method/username/password/headers, ...)
 * so GET/PUT can echo it back verbatim - the boolean columns below are
 * just a queryable mirror of the flags that matter for deciding whether
 * to fire, alongside which app (radarr/sonarr) this was registered on.
 */
export const arrNotificationConfigs = sqliteTable('arr_notification_configs', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	// 'radarr' or 'sonarr' - which arr-compat surface this was registered on
	app: text('app').notNull(),
	name: text('name').notNull(),
	onGrab: integer('on_grab', { mode: 'boolean' }).notNull().default(false),
	onDownload: integer('on_download', { mode: 'boolean' }).notNull().default(false),
	onUpgrade: integer('on_upgrade', { mode: 'boolean' }).notNull().default(false),
	onMovieAdded: integer('on_movie_added', { mode: 'boolean' }).notNull().default(false),
	onMovieDelete: integer('on_movie_delete', { mode: 'boolean' }).notNull().default(false),
	onSeriesAdd: integer('on_series_add', { mode: 'boolean' }).notNull().default(false),
	onSeriesDelete: integer('on_series_delete', { mode: 'boolean' }).notNull().default(false),
	config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

export type ArrNotificationConfig = typeof arrNotificationConfigs.$inferSelect;
export type NewArrNotificationConfig = typeof arrNotificationConfigs.$inferInsert;

/**
 * A user-submitted media request (Seerr-style). No movies/series row exists
 * until approval — the request carries the TMDB identity plus display
 * snapshots; approval creates/links the library row through the add path.
 * TV scope is stored as season numbers plus optional episode entries; the
 * episode-level truth lives on episodes.hasFile, never here.
 */
export const requests = sqliteTable(
	'requests',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		mediaType: text('media_type').notNull(),
		tmdbId: integer('tmdb_id').notNull(),
		title: text('title').notNull(),
		posterPath: text('poster_path'),
		year: integer('year'),
		// Linked once approval creates (or re-monitors) the library row.
		movieId: text('movie_id').references(() => movies.id, { onDelete: 'set null' }),
		seriesId: text('series_id').references(() => series.id, { onDelete: 'set null' }),
		status: text('status').notNull().default('pending'),
		// JSON: number[] of whole-season scope entries (series only).
		seasons: text('seasons', { mode: 'json' }).$type<number[]>(),
		// JSON: {seasonNumber, episodeNumber}[] episode-scope entries (series only).
		episodes: text('episodes', { mode: 'json' }).$type<
			{ seasonNumber: number; episodeNumber: number }[]
		>(),
		// Quota snapshot per season entry at approval time ({season, count}[]).
		episodeCountSnapshot: text('episode_count_snapshot', { mode: 'json' }).$type<
			{ season: number; count: number }[]
		>(),
		requestedBy: text('requested_by')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		// Set when an admin created this while impersonating the requester.
		actingUserId: text('acting_user_id').references(() => user.id, {
			onDelete: 'set null'
		}),
		decidedBy: text('decided_by').references(() => user.id, { onDelete: 'set null' }),
		autoApproved: integer('auto_approved', { mode: 'boolean' }).notNull().default(false),
		declineReason: text('decline_reason'),
		failureReason: text('failure_reason'),
		ignoreQuota: integer('ignore_quota', { mode: 'boolean' }).notNull().default(false),
		expiresAt: text('expires_at'),
		decidedAt: text('decided_at'),
		fulfilledAt: text('fulfilled_at'),
		createdAt: text('created_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text('updated_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString())
	},
	(table) => [
		index('idx_requests_media_status').on(table.mediaType, table.tmdbId, table.status),
		index('idx_requests_requester_created').on(table.requestedBy, table.createdAt),
		index('idx_requests_pending').on(table.status)
	]
);

/**
 * Admin-managed per-user request settings. Deliberately NOT in
 * user_preferences — that table is self-writable by the account owner, and
 * these values (disable, auto-approve grant, quota overrides) must only
 * change through admin endpoints. Null quota/auto-approve values inherit
 * the global request_settings defaults.
 */
export const userRequestSettings = sqliteTable('user_request_settings', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	requestsDisabled: integer('requests_disabled', { mode: 'boolean' }).notNull().default(false),
	autoApprove: integer('auto_approve', { mode: 'boolean' }),
	movieQuotaLimit: integer('movie_quota_limit'),
	movieQuotaDays: integer('movie_quota_days'),
	tvQuotaLimit: integer('tv_quota_limit'),
	tvQuotaDays: integer('tv_quota_days'),
	updatedAt: text('updated_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

/**
 * In-app request notifications (one row per user per event). Feed rows only
 * — live delivery rides the requests SSE stream; this table is the durable
 * inbox behind the bell.
 */
export const requestNotifications = sqliteTable(
	'request_notifications',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		requestId: text('request_id').references(() => requests.id, { onDelete: 'cascade' }),
		event: text('event').notNull(),
		payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
		readAt: text('read_at'),
		createdAt: text('created_at')
			.notNull()
			.$defaultFn(() => new Date().toISOString())
	},
	(table) => [index('idx_request_notifications_user_read').on(table.userId, table.readAt)]
);

export type RequestRecord = typeof requests.$inferSelect;
export type NewRequestRecord = typeof requests.$inferInsert;
export type UserRequestSettingsRecord = typeof userRequestSettings.$inferSelect;
export type NewUserRequestSettingsRecord = typeof userRequestSettings.$inferInsert;
export type RequestNotificationRecord = typeof requestNotifications.$inferSelect;
export type NewRequestNotificationRecord = typeof requestNotifications.$inferInsert;

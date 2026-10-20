import { z } from 'zod';
import { TMDB } from '#lib/config/constants.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validation schemas for API inputs and database rows.
 * Use these with z.safeParse() for runtime validation.
 */

// ============================================================
// Indexer Schemas
// ============================================================

/**
 * Valid indexer protocols.
 */
export const indexerProtocolSchema = z.enum(['torrent', 'usenet', 'streaming']);

/**
 * Schema for creating a new indexer.
 * YAML-only architecture: all indexers are defined by YAML definitions.
 */
export const indexerCreateSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
	/** YAML definition ID (e.g., 'knaben', 'anidex', 'torrentday') */
	definitionId: z.string().regex(/^[a-z0-9-]+$/, 'Must be a valid definition ID'),
	baseUrl: z.string().url('Must be a valid URL'),
	/** Alternative/fallback URLs */
	alternateUrls: z.array(z.string().url('Must be a valid URL')).default([]),
	enabled: z.boolean().default(true),
	/** True when upstream sync detected this indexer no longer exists; cleared on re-appearance */
	orphaned: z.boolean().optional(),
	priority: z.number().int().min(1).max(100).default(25),
	/**
	 * User override for max requests/minute sent to this indexer. Null/undefined
	 * = use the definition's `requestdelay` (if any) or the generic default.
	 */
	rateLimitPerMinute: z.number().int().min(1).max(600).optional().nullable(),
	/** User-provided settings for YAML indexers (apiKey, cookie, passkey, etc.) */
	settings: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional()
		.nullable(),

	// Search capability toggles
	enableAutomaticSearch: z.boolean().default(true),
	enableInteractiveSearch: z.boolean().default(true),

	// Torrent seeding settings (stored in protocolSettings JSON)
	minimumSeeders: z.number().int().min(0).default(1),
	seedRatio: z
		.string()
		.regex(/^\d+(\.\d+)?$/, 'Must be a valid decimal number (e.g., "1.0", "2.5")')
		.optional()
		.nullable(), // Decimal as string (e.g., "1.0")
	seedTime: z.number().int().min(0).optional().nullable(), // Minutes
	packSeedTime: z.number().int().min(0).optional().nullable(), // Minutes
	rejectDeadTorrents: z.boolean().default(true), // Reject torrents with 0 seeders

	// Usenet settings (stored in protocolSettings JSON)
	rejectPasswordProtected: z.boolean().default(true),
	minimumCompletionPercentage: z.number().int().min(0).max(100).default(95),

	// Newznab/Torznab per-indexer category overrides
	additionalCategories: z.array(z.number().int()).optional()
});

/**
 * Schema for updating an existing indexer.
 * `.required()` first strips `.default()` wrappers so Zod 4 does not backfill
 * missing keys with defaults during a partial update. See zod issue #5235.
 */
export const indexerUpdateSchema = indexerCreateSchema.required().partial();

/**
 * Schema for testing an indexer connection.
 */
export const indexerTestSchema = z.object({
	indexerId: z.string().uuid().optional(),
	name: z.string().min(1),
	definitionId: z.string().regex(/^[a-z0-9-]+$/),
	baseUrl: z.string().url(),
	alternateUrls: z.array(z.string().url()).default([]),
	settings: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional()
		.nullable()
});

// ============================================================
// Search Schemas
// ============================================================

/**
 * Valid search types.
 */
export const searchTypeSchema = z.enum(['basic', 'movie', 'tv', 'music', 'book']);

/**
 * Base search criteria fields.
 */
const baseSearchCriteriaSchema = z.object({
	query: z.string().optional(),
	categories: z.array(z.number().int()).optional(),
	indexerIds: z.array(z.string()).optional(),
	limit: z.number().int().min(1).optional(),
	offset: z.number().int().min(0).default(0)
});

/**
 * Schema for basic text search.
 */
export const basicSearchCriteriaSchema = baseSearchCriteriaSchema.extend({
	searchType: z.literal('basic'),
	query: z.string().min(1, 'Query is required for basic search')
});

/**
 * Schema for movie search with optional IDs.
 */
export const movieSearchCriteriaSchema = baseSearchCriteriaSchema.extend({
	searchType: z.literal('movie'),
	imdbId: z
		.string()
		.regex(/^tt\d{7,8}$/, 'Invalid IMDB ID format')
		.optional(),
	tmdbId: z.number().int().positive().optional(),
	year: z.number().int().min(1888).max(2100).optional()
});

/**
 * Schema for TV search with optional IDs.
 */
export const tvSearchCriteriaSchema = baseSearchCriteriaSchema.extend({
	searchType: z.literal('tv'),
	imdbId: z
		.string()
		.regex(/^tt\d{7,8}$/, 'Invalid IMDB ID format')
		.optional(),
	tmdbId: z.number().int().positive().optional(),
	tvdbId: z.number().int().positive().optional(),
	season: z.number().int().min(0).optional(),
	episode: z.number().int().min(0).optional()
});

/**
 * Schema for music search.
 */
export const musicSearchCriteriaSchema = baseSearchCriteriaSchema.extend({
	searchType: z.literal('music'),
	artist: z.string().optional(),
	album: z.string().optional(),
	label: z.string().optional(),
	year: z.number().int().min(1900).max(2100).optional()
});

/**
 * Schema for book search.
 */
export const bookSearchCriteriaSchema = baseSearchCriteriaSchema.extend({
	searchType: z.literal('book'),
	author: z.string().optional(),
	title: z.string().optional()
});

/**
 * Union schema for all search criteria types.
 */
export const searchCriteriaSchema = z.discriminatedUnion('searchType', [
	basicSearchCriteriaSchema,
	movieSearchCriteriaSchema,
	tvSearchCriteriaSchema,
	musicSearchCriteriaSchema,
	bookSearchCriteriaSchema
]);

/**
 * Schema for search options (legacy - maps to SearchCriteria).
 */
export const searchOptionsSchema = z.object({
	query: z.string().min(1, 'Query is required'),
	categories: z.array(z.number().int()).optional(),
	indexerIds: z.array(z.string()).optional(),
	minSeeders: z.number().int().min(0).optional(),
	maxResults: z.number().int().min(1).max(500).default(100),
	contentType: z.enum(['movie', 'tv', 'all']).default('all'),
	useCache: z.boolean().default(true)
});

/**
 * Schema for enrichment options (quality filtering and TMDB matching).
 */
export const enrichmentOptionsSchema = z.object({
	/** Scoring profile ID for quality scoring */
	scoringProfileId: z.string().optional(),
	/** Whether to match releases to TMDB entries */
	matchToTmdb: z.boolean().default(false),
	/** Whether to filter out rejected releases */
	filterRejected: z.boolean().default(false),
	/** Minimum score to include (0-1000) */
	minScore: z.number().int().min(0).max(1000).optional()
});

/**
 * Schema for configuration export (Backup & Restore).
 */
export const backupExportSchema = z.object({
	passphrase: z.string().min(16, 'Passphrase must be at least 16 characters'),
	includeIndexerCookies: z.boolean().default(false)
});

export const encryptedBackupPayloadSchema = z.object({
	algorithm: z.literal('aes-256-gcm'),
	salt: z.string().min(1),
	iv: z.string().min(1),
	authTag: z.string().min(1),
	ciphertext: z.string().min(1)
});

const backupSectionNameSchema = z.enum([
	'system',
	'profiles',
	'downloads',
	'indexers',
	'subtitles',
	'integrations',
	'liveTv'
]);

export const configurationBackupManifestSchema = z.object({
	sectionOrder: z.array(backupSectionNameSchema),
	sections: z.array(
		z.object({
			id: backupSectionNameSchema,
			label: z.string().min(1),
			tableNames: z.array(z.string().min(1)),
			totalRows: z.number().int().min(0)
		})
	),
	totalTables: z.number().int().min(0),
	totalRows: z.number().int().min(0),
	supportsRestoreModes: z.array(z.literal('apply'))
});

export const configurationBackupFileSchema = z.object({
	format: z.literal('cinephage-config-backup'),
	version: z.literal(1),
	createdAt: z.string().min(1),
	manifest: configurationBackupManifestSchema.optional(),
	options: z
		.object({
			includeIndexerCookies: z.boolean().optional()
		})
		.optional(),
	data: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
	secrets: encryptedBackupPayloadSchema
});

export const backupImportSchema = z.object({
	passphrase: z.string().trim().min(1, 'Backup passphrase is required'),
	sections: z.array(backupSectionNameSchema).optional(),
	mode: z.enum(['apply', 'replace']).default('apply'),
	backup: configurationBackupFileSchema
});

/**
 * Schema for search query parameters (GET request).
 */
export const searchQuerySchema = z.object({
	q: z.string().optional(),
	searchType: searchTypeSchema.default('basic'),
	searchMode: z.enum(['all', 'multiSeasonPack']).optional(),
	categories: z
		.string()
		.optional()
		.transform((v) => v?.split(',').map(Number)),
	indexers: z
		.string()
		.optional()
		.transform((v) => v?.split(',')),
	minSeeders: z.coerce.number().int().min(0).optional(),
	limit: z.coerce.number().int().min(1).optional(),
	// Movie/TV specific
	imdbId: z.string().optional(),
	tmdbId: z.coerce.number().int().positive().optional(),
	tvdbId: z.coerce.number().int().positive().optional(),
	year: z.coerce.number().int().min(1888).max(2100).optional(),
	season: z.coerce.number().int().min(0).optional(),
	episode: z.coerce.number().int().min(0).optional(),
	// Language preference (ISO 639-1 code)
	language: z.string().optional(),
	// Enrichment options
	enrich: z
		.string()
		.optional()
		.transform((v) => v === 'true' || v === '1'),
	scoringProfileId: z.string().optional(),
	matchToTmdb: z
		.string()
		.optional()
		.transform((v) => v === 'true' || v === '1'),
	filterRejected: z
		.string()
		.optional()
		.transform((v) => v === 'true' || v === '1'),
	minScore: z.coerce.number().int().min(0).max(1000).optional()
});

// ============================================================
// TMDB Schemas
// ============================================================

/**
 * Schema for TMDB API key validation.
 * TMDB API keys are 32-character hexadecimal strings.
 */
export const tmdbApiKeySchema = z
	.string()
	.min(32, 'TMDB API key must be at least 32 characters')
	.max(64, 'TMDB API key must be at most 64 characters')
	.regex(/^[a-f0-9]+$/i, 'TMDB API key must be hexadecimal');

/**
 * Schema for global TMDB filters.
 */
export const globalTmdbFiltersSchema = z.object({
	include_adult: z.boolean().default(false),
	min_vote_average: z.number().min(0).max(10).default(0),
	min_vote_count: z.number().int().min(0).default(0),
	language: z.string().default('en-US'),
	region: z.string().default(TMDB.DEFAULT_REGION),
	excluded_genre_ids: z.array(z.number().int()).default([])
});

/**
 * Schema for the global blocked video extensions list.
 * Applies to disk scans when a root folder has no per-folder override set.
 * Empty by default — no video formats blocked unless the user explicitly adds them.
 */
export const globalBlockedVideoExtensionsSchema = z.object({
	extensions: z.array(z.string().min(2).max(10)).default([])
});

export type GlobalBlockedVideoExtensions = z.infer<typeof globalBlockedVideoExtensionsSchema>;

// ============================================================
// Discover API Schemas
// ============================================================

/**
 * Schema for discover query parameters.
 */
export const discoverQuerySchema = z.object({
	type: z.enum(['movie', 'tv', 'all']).default('all'),
	page: z.coerce.number().int().min(1).default(1),
	with_genres: z.string().optional(),
	with_watch_providers: z.string().optional(),
	sort_by: z.string().optional(),
	'primary_release_date.gte': z.string().regex(DATE_REGEX, 'Expected YYYY-MM-DD').optional(),
	'primary_release_date.lte': z.string().regex(DATE_REGEX, 'Expected YYYY-MM-DD').optional(),
	'first_air_date.gte': z.string().regex(DATE_REGEX, 'Expected YYYY-MM-DD').optional(),
	'first_air_date.lte': z.string().regex(DATE_REGEX, 'Expected YYYY-MM-DD').optional(),
	'vote_average.gte': z.coerce.number().min(0).max(10).optional(),
	'vote_average.lte': z.coerce.number().min(0).max(10).optional()
});

// ============================================================
// Database Row Schemas (for parsing DB results)
// ============================================================

/**
 * Schema for parsing indexer rows from database.
 */
export const indexerRowSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	implementation: z.string(),
	enabled: z
		.boolean()
		.nullable()
		.transform((v) => v ?? true),
	url: z.string(),
	apiKey: z.string().nullable(),
	priority: z
		.number()
		.nullable()
		.transform((v) => v ?? 25),
	protocol: z.string().transform((v) => {
		if (v === 'torrent' || v === 'usenet') return v;
		return 'torrent' as const;
	}),
	config: z.unknown().transform((v) => (v as Record<string, unknown>) ?? null),
	settings: z.unknown().transform((v) => (v as Record<string, string>) ?? null)
});

// ============================================================
// Type Exports
// ============================================================

export type IndexerCreate = z.input<typeof indexerCreateSchema>;
export type IndexerUpdate = z.input<typeof indexerUpdateSchema>;
export type IndexerTest = z.infer<typeof indexerTestSchema>;
export type SearchOptions = z.infer<typeof searchOptionsSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type EnrichmentOptions = z.infer<typeof enrichmentOptionsSchema>;
export type DiscoverQuery = z.infer<typeof discoverQuerySchema>;
export type GlobalTmdbFilters = z.infer<typeof globalTmdbFiltersSchema>;

// New typed search criteria
export type SearchType = z.infer<typeof searchTypeSchema>;
export type BasicSearchCriteria = z.infer<typeof basicSearchCriteriaSchema>;
export type MovieSearchCriteria = z.infer<typeof movieSearchCriteriaSchema>;
export type TvSearchCriteria = z.infer<typeof tvSearchCriteriaSchema>;
export type MusicSearchCriteria = z.infer<typeof musicSearchCriteriaSchema>;
export type BookSearchCriteria = z.infer<typeof bookSearchCriteriaSchema>;
export type SearchCriteria = z.infer<typeof searchCriteriaSchema>;

// ============================================================
// Download Client Schemas
// ============================================================

/**
 * Valid download client implementations.
 */
export const downloadClientImplementationSchema = z.enum([
	'qbittorrent',
	'transmission',
	'deluge',
	'rtorrent',
	'aria2',
	'nzbget',
	'sabnzbd',
	'realdebrid',
	'torbox'
]);

/**
 * Priority levels for downloads.
 */
export const downloadPrioritySchema = z.enum(['normal', 'high', 'force']);

/**
 * Initial state options for added downloads.
 */
export const downloadInitialStateSchema = z.enum(['start', 'pause', 'force']);

const DEBRID_IMPLEMENTATIONS = ['realdebrid', 'torbox'] as const;
const NON_DEBRID_IMPLEMENTATIONS = [
	'qbittorrent',
	'transmission',
	'deluge',
	'rtorrent',
	'aria2',
	'sabnzbd',
	'nzbget'
] as const;
function isDebridImplementation(implementation: string): boolean {
	return DEBRID_IMPLEMENTATIONS.includes(implementation as (typeof DEBRID_IMPLEMENTATIONS)[number]);
}

const downloadClientBaseFields = {
	name: z.string().min(1, 'Name is required').max(20, 'Name must be 20 characters or less'),
	enabled: z.boolean().default(true),
	priority: z.number().int().min(1).max(100).default(1)
};

const nonDebridDownloadClientFields = {
	host: z.string().min(1, 'Host is required'),
	port: z.number().int().min(1, 'Port must be at least 1').max(65535, 'Port must be at most 65535'),
	useSsl: z.boolean().default(false),
	urlBase: z.string().max(200).optional().nullable(),
	mountMode: z.enum(['nzbdav', 'altmount']).optional().nullable(),
	username: z.string().optional().nullable(),
	password: z.string().optional().nullable(),
	movieCategory: z.string().min(1).default('movies'),
	tvCategory: z.string().min(1).default('tv'),
	recentPriority: downloadPrioritySchema.default('normal'),
	olderPriority: downloadPrioritySchema.default('normal'),
	initialState: downloadInitialStateSchema.default('start'),
	seedRatioLimit: z
		.string()
		.regex(/^\d+(\.\d+)?$/, 'Must be a valid decimal number (e.g., "1.0", "2.5")')
		.optional()
		.nullable(),
	seedTimeLimit: z.number().int().min(0).optional().nullable(),
	sequentialDownload: z.boolean().optional(),
	downloadPathLocal: z.string().optional().nullable(),
	downloadPathRemote: z.string().optional().nullable(),
	tempPathLocal: z.string().optional().nullable(),
	tempPathRemote: z.string().optional().nullable()
};

const debridDownloadClientCreateSchema = z
	.object({
		...downloadClientBaseFields,
		implementation: z.enum(DEBRID_IMPLEMENTATIONS),
		apiToken: z.string().optional().nullable(),
		removeAfterImport: z.boolean().default(false),
		allowMovies: z.boolean().default(true),
		allowTv: z.boolean().default(true)
	})
	.strict()
	.superRefine((data, context) => {
		if (!data.allowMovies && !data.allowTv) {
			context.addIssue({
				code: 'custom',
				path: ['allowMovies'],
				message: 'At least one content type (Movies or TV Shows) must be enabled'
			});
		}
	});

const nonDebridDownloadClientCreateSchema = z
	.object({
		...downloadClientBaseFields,
		implementation: z.enum(NON_DEBRID_IMPLEMENTATIONS),
		...nonDebridDownloadClientFields,
		apiToken: z.never().optional(),
		// Torrent/usenet clients: removes completed downloads once seed goals
		// are met (debrid clients use the same flag for provider-side removal).
		removeAfterImport: z.boolean().optional(),
		allowMovies: z.never().optional(),
		allowTv: z.never().optional()
	})
	.strict()
	.superRefine((data, context) => {
		if (data.implementation !== 'qbittorrent' && data.sequentialDownload !== undefined) {
			context.addIssue({
				code: 'custom',
				path: ['sequentialDownload'],
				message: 'Sequential download is only supported by qBittorrent'
			});
		}
	});

export const downloadClientCreateSchema = z.union([
	debridDownloadClientCreateSchema,
	nonDebridDownloadClientCreateSchema
]);

export type DownloadClientCreateDiscriminated =
	| z.infer<typeof debridDownloadClientCreateSchema>
	| z.infer<typeof nonDebridDownloadClientCreateSchema>;
// Update schemas defined explicitly without .default() so that absent fields
// are omitted from the parsed output rather than filled with default values.
// In Zod v4, .partial() on a schema with .default() still applies defaults for
// absent fields, which causes superRefine forbidden-field checks to fire on
// fields the caller never sent (e.g. toggle sends {enabled:false} but Zod fills
// in removeAfterImport:false from the debrid branch, then superRefine rejects it
// for non-debrid clients).
const debridDownloadClientUpdateSchema = z
	.object({
		name: z
			.string()
			.min(1, 'Name is required')
			.max(20, 'Name must be 20 characters or less')
			.optional(),
		enabled: z.boolean().optional(),
		priority: z.number().int().min(1).max(100).optional(),
		implementation: z.enum(DEBRID_IMPLEMENTATIONS).optional(),
		apiToken: z.string().optional().nullable(),
		removeAfterImport: z.boolean().optional(),
		allowMovies: z.boolean().optional(),
		allowTv: z.boolean().optional()
	})
	.strict()
	.superRefine((data, context) => {
		if (data.allowMovies === false && data.allowTv === false) {
			context.addIssue({
				code: 'custom',
				path: ['allowMovies'],
				message: 'At least one content type (Movies or TV Shows) must be enabled'
			});
		}
	});
const nonDebridDownloadClientUpdateSchema = z
	.object({
		name: z
			.string()
			.min(1, 'Name is required')
			.max(20, 'Name must be 20 characters or less')
			.optional(),
		enabled: z.boolean().optional(),
		priority: z.number().int().min(1).max(100).optional(),
		implementation: z.enum(NON_DEBRID_IMPLEMENTATIONS).optional(),
		host: z.string().min(1, 'Host is required').optional(),
		port: z
			.number()
			.int()
			.min(1, 'Port must be at least 1')
			.max(65535, 'Port must be at most 65535')
			.optional(),
		useSsl: z.boolean().optional(),
		urlBase: z.string().max(200).optional().nullable(),
		mountMode: z.enum(['nzbdav', 'altmount']).optional().nullable(),
		username: z.string().optional().nullable(),
		password: z.string().optional().nullable(),
		movieCategory: z.string().min(1).optional(),
		tvCategory: z.string().min(1).optional(),
		recentPriority: downloadPrioritySchema.optional(),
		olderPriority: downloadPrioritySchema.optional(),
		initialState: downloadInitialStateSchema.optional(),
		seedRatioLimit: z
			.string()
			.regex(/^\d+(\.\d+)?$/, 'Must be a valid decimal number (e.g., "1.0", "2.5")')
			.optional()
			.nullable(),
		seedTimeLimit: z.number().int().min(0).optional().nullable(),
		sequentialDownload: z.boolean().optional(),
		downloadPathLocal: z.string().optional().nullable(),
		downloadPathRemote: z.string().optional().nullable(),
		tempPathLocal: z.string().optional().nullable(),
		tempPathRemote: z.string().optional().nullable(),
		apiToken: z.never().optional(),
		removeAfterImport: z.boolean().optional(),
		allowMovies: z.never().optional(),
		allowTv: z.never().optional()
	})
	.strict();
export const downloadClientUpdateSchema = z.union([
	debridDownloadClientUpdateSchema,
	nonDebridDownloadClientUpdateSchema
]);

const DEBRID_ONLY_UPDATE_FIELDS = ['apiToken', 'allowMovies', 'allowTv'] as const;
const NON_DEBRID_ONLY_UPDATE_FIELDS = [
	'host',
	'port',
	'useSsl',
	'urlBase',
	'mountMode',
	'username',
	'password',
	'movieCategory',
	'tvCategory',
	'recentPriority',
	'olderPriority',
	'initialState',
	'seedRatioLimit',
	'seedTimeLimit',
	'sequentialDownload',
	'downloadPathLocal',
	'downloadPathRemote',
	'tempPathLocal',
	'tempPathRemote'
] as const;

export function downloadClientUpdateSchemaForImplementation(storedImplementation: string) {
	const storedIsDebrid = isDebridImplementation(storedImplementation);
	const forbiddenFields = storedIsDebrid
		? NON_DEBRID_ONLY_UPDATE_FIELDS
		: DEBRID_ONLY_UPDATE_FIELDS;

	return downloadClientUpdateSchema.superRefine((data, context) => {
		if (data.implementation !== undefined && data.implementation !== storedImplementation) {
			context.addIssue({
				code: 'custom',
				message: 'Download client implementation cannot be changed'
			});
		}
		for (const field of forbiddenFields) {
			if (field in data) {
				context.addIssue({
					code: 'custom',
					path: [field],
					message: `Field is not valid for ${storedImplementation}`
				});
			}
		}
		if (!storedIsDebrid && storedImplementation !== 'qbittorrent' && 'sequentialDownload' in data) {
			context.addIssue({
				code: 'custom',
				path: ['sequentialDownload'],
				message: 'Sequential download is only supported by qBittorrent'
			});
		}
	});
}

export type DownloadClientUpdateDiscriminated =
	| z.infer<typeof debridDownloadClientUpdateSchema>
	| z.infer<typeof nonDebridDownloadClientUpdateSchema>;

const debridDownloadClientTestSchema = z.object({
	implementation: z.enum(DEBRID_IMPLEMENTATIONS),
	apiToken: z.string().optional().nullable()
});

const nonDebridDownloadClientTestSchema = z.object({
	implementation: z.enum(NON_DEBRID_IMPLEMENTATIONS),
	host: z.string().min(1, 'Host is required'),
	port: z.number().int().min(1).max(65535),
	useSsl: z.boolean().default(false),
	urlBase: z.string().max(200).optional().nullable(),
	mountMode: z.enum(['nzbdav', 'altmount']).optional().nullable(),
	username: z.string().optional().nullable(),
	password: z.string().optional().nullable()
});

export const downloadClientTestSchema = z.union([
	debridDownloadClientTestSchema,
	nonDebridDownloadClientTestSchema
]);

export type DownloadClientTestDiscriminated =
	| z.infer<typeof debridDownloadClientTestSchema>
	| z.infer<typeof nonDebridDownloadClientTestSchema>;

// ============================================================
// Root Folder Schemas
// ============================================================

/**
 * Media type for root folders.
 */
export const rootFolderMediaTypeSchema = z.enum(['movie', 'tv']);
export const rootFolderMediaSubTypeSchema = z.enum(['standard', 'anime']);

/**
 * Schema for creating a root folder.
 */
export const rootFolderCreateSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
	path: z.string().min(1, 'Path is required'),
	mediaType: rootFolderMediaTypeSchema,
	mediaSubType: rootFolderMediaSubTypeSchema.default('standard'),
	isDefault: z.boolean().default(false),
	readOnly: z.boolean().default(false),
	preserveSymlinks: z.boolean().default(false),
	defaultMonitored: z.boolean().default(true),
	skipFolderPatterns: z.array(z.string().min(1).max(200)).default([]),
	blockedVideoExtensions: z
		.array(
			z
				.string()
				.min(1)
				.max(20)
				.transform((v) => (v.startsWith('.') ? v.toLowerCase() : `.${v.toLowerCase()}`))
		)
		.default([])
});

/**
 * Schema for updating a root folder.
 */
export const rootFolderUpdateSchema = rootFolderCreateSchema.required().partial();

// Download Client Type Exports
export type DownloadClientImplementation = z.infer<typeof downloadClientImplementationSchema>;
export type DownloadPriority = z.infer<typeof downloadPrioritySchema>;
export type DownloadInitialState = z.infer<typeof downloadInitialStateSchema>;
export type DownloadClientCreate = z.infer<typeof downloadClientCreateSchema>;
export type DownloadClientUpdate = z.infer<typeof downloadClientUpdateSchema>;
export type DownloadClientTest = z.infer<typeof downloadClientTestSchema>;

// Root Folder Type Exports
export type RootFolderMediaType = z.infer<typeof rootFolderMediaTypeSchema>;
export type RootFolderMediaSubType = z.infer<typeof rootFolderMediaSubTypeSchema>;
export type RootFolderCreate = z.infer<typeof rootFolderCreateSchema>;
export type RootFolderUpdate = z.infer<typeof rootFolderUpdateSchema>;

// ============================================================
// Library Entity Schemas
// ============================================================

/**
 * Media type and subtype for first-class libraries.
 */
export const libraryMediaTypeSchema = z.enum(['movie', 'tv']);
export const libraryMediaSubTypeSchema = z.enum(['standard', 'anime']);
export const metadataProviderSelectionSchema = z.enum(['auto', 'tmdb', 'anilist', 'mal']);

/**
 * Schema for creating a library entity.
 */
export const libraryCreateSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
	mediaType: libraryMediaTypeSchema,
	mediaSubType: libraryMediaSubTypeSchema.default('standard'),
	rootFolderIds: z.array(z.string().uuid()).optional().default([]),
	defaultRootFolderId: z.string().uuid().optional().nullable(),
	isDefault: z.boolean().default(false),
	defaultSearchOnAdd: z.boolean().default(true),
	defaultWantsSubtitles: z.boolean().default(true),
	qualityProfileId: z.string().nullable().optional(),
	/** Library-wide default language profile; null/omitted = inherit the instance default */
	languageProfileId: z.string().nullable().optional(),
	sortOrder: z.number().int().min(0).default(100),
	scanMode: z.enum(['manual', 'scheduled', 'scheduled_daily', 'watch']).default('scheduled'),
	scanConfig: z
		.object({
			intervalMinutes: z.number().int().min(5).optional(),
			scheduledTime: z.string().optional(),
			debounceSeconds: z.number().int().min(3).optional()
		})
		.nullable()
		.optional()
});

/**
 * Schema for updating a library entity.
 */
export const libraryUpdateSchema = libraryCreateSchema.required().partial();

/**
 * Schema for updating library classification settings.
 */
export const libraryClassificationUpdateSchema = z.object({
	enforceAnimeSubtype: z.boolean()
});

/**
 * Schema for deleting a library with optional target library for reassignment.
 */
export const libraryDeleteSchema = z.object({
	targetLibraryId: z.string().uuid().optional().nullable()
});

// Library Entity Type Exports
export type LibraryMediaType = z.infer<typeof libraryMediaTypeSchema>;
export type LibraryMediaSubType = z.infer<typeof libraryMediaSubTypeSchema>;
export type LibraryCreate = z.infer<typeof libraryCreateSchema>;
export type LibraryUpdate = z.infer<typeof libraryUpdateSchema>;

// ============================================================
// Language Profile Schemas
// ============================================================

import {
	canonicalizeLanguageTag,
	isValidLanguageCode,
	type LanguageTag
} from '#lib/shared/languages.js';
import { CAPTURED_LOG_LEVELS, CAPTURED_LOG_DOMAINS } from '#lib/logging/log-capture.js';

/**
 * Schema for validating a language code
 */
export const languageCodeSchema = z
	.string()
	.min(2)
	.max(10)
	.refine((code) => isValidLanguageCode(code), {
		message: 'Invalid language code'
	});

/**
 * Canonical language tag input. Canonicalizes aliases before validation so
 * 'ENG', 'ger', 'pob', 'zh-tw' are stored canonically; unknown codes fail.
 */
export const languageTagSchema = z
	.string()
	.min(2)
	.max(35)
	.transform((value) => canonicalizeLanguageTag(value) || value.trim().toLowerCase())
	.refine((value): value is LanguageTag => isValidLanguageCode(value), {
		message: 'Invalid language code'
	});

/**
 * One subtitle requirement: language + variant + accessibility policy.
 * This replaces the boolean (forced, hearingImpaired, excludeHi, isCutoff)
 * combination once the pipeline migrates (Phase 3).
 */
export const subtitleRequirementSchema = z.object({
	tag: languageTagSchema,
	variant: z.enum(['regular', 'forced', 'both']).default('regular'),
	accessibility: z.enum(['any', 'prefer-hi', 'require-hi', 'exclude-hi']).default('any')
});

/** Combined profile audio preferences. */
export const audioPreferenceSchema = z.object({
	preferOriginal: z.boolean().default(true),
	languages: z.array(languageTagSchema).default([]),
	mode: z.enum(['prefer', 'require']).default('prefer')
});

const languageProfileV2BaseSchema = z.object({
	name: z.string().min(1, 'Name is required').max(60, 'Name must be 60 characters or less'),
	audio: audioPreferenceSchema.default({ preferOriginal: true, languages: [], mode: 'prefer' }),
	subtitles: z
		.array(subtitleRequirementSchema)
		.min(1, 'At least one subtitle language is required'),
	cutoffRank: z.number().int().min(0).nullable().default(null),
	minimumScore: z.number().int().min(0).max(100).default(70),
	upgradesAllowed: z.boolean().default(true)
});

/** Create payload for the combined profile (Phase 2 persistence). */
export const languageProfileV2CreateSchema = languageProfileV2BaseSchema
	.refine(
		(profile) => profile.cutoffRank === null || profile.cutoffRank < profile.subtitles.length,
		{
			message: 'Cutoff rank must reference a subtitle requirement',
			path: ['cutoffRank']
		}
	)
	.refine(
		(profile) => {
			const keys = profile.subtitles.map(
				(requirement) => `${requirement.tag}|${requirement.variant}|${requirement.accessibility}`
			);
			return new Set(keys).size === keys.length;
		},
		{ message: 'Duplicate subtitle requirements are not allowed', path: ['subtitles'] }
	);

/**
 * Partial update payload for the combined profile.
 *
 * `.required().partial()` (not plain `.partial()`) is required: in Zod v4,
 * `.partial()` on a schema whose fields carry `.default()` still materializes
 * those defaults for absent fields, so a rename-only PUT would silently reset
 * audio, cutoffRank, minimumScore, and upgradesAllowed.
 */
export const languageProfileV2UpdateSchema = languageProfileV2BaseSchema.required().partial();

export type LanguageProfileV2Create = z.infer<typeof languageProfileV2CreateSchema>;
export type LanguageProfileV2Update = z.infer<typeof languageProfileV2UpdateSchema>;

/**
 * Per-item subtitle requirement override (movies, series, episodes).
 *
 * Replaces ONLY the requirement list of the effective profile — audio,
 * scoring, and upgrade policy still come from the profile chain. An explicit
 * list means "acquire exactly these": empty arrays are rejected (turn the
 * wants-subtitles gate off instead) and duplicates are rejected (identity is
 * the tag|variant|accessibility tuple).
 */
export const subtitleRequirementsOverrideSchema = z
	.array(subtitleRequirementSchema)
	.min(1, 'At least one subtitle language is required')
	.max(10, 'At most 10 subtitle languages are allowed')
	.refine(
		(requirements) => {
			const keys = requirements.map(
				(requirement) => `${requirement.tag}|${requirement.variant}|${requirement.accessibility}`
			);
			return new Set(keys).size === keys.length;
		},
		{ message: 'Duplicate subtitle requirements are not allowed', path: ['subtitles'] }
	);

export type SubtitleRequirementsOverride = z.infer<typeof subtitleRequirementsOverrideSchema>;

// ============================================================
// Subtitle Search Schemas
// ============================================================

/**
 * Schema for subtitle search request.
 */
export const subtitleSearchSchema = z.object({
	// Media identification
	movieId: z.string().uuid().optional(),
	episodeId: z.string().uuid().optional(),
	// Manual search parameters
	title: z.string().optional(),
	year: z.number().int().min(1888).max(2100).optional(),
	imdbId: z
		.string()
		.regex(/^tt\d{7,8}$/, 'Invalid IMDB ID format')
		.optional(),
	tmdbId: z.number().int().positive().optional(),
	// For episodes
	seriesTitle: z.string().optional(),
	season: z.number().int().min(0).optional(),
	episode: z.number().int().min(0).optional(),
	// Language preferences - validate against supported languages
	languages: z.array(languageCodeSchema).optional(),
	// Filters
	includeForced: z.boolean().default(true),
	includeHearingImpaired: z.boolean().default(true),
	excludeHearingImpaired: z.boolean().default(false),
	// Provider selection
	providerIds: z.array(z.string().uuid()).optional()
});

/**
 * Schema for subtitle download request.
 *
 * The interactive search modal submits the full selected search result (not
 * just the provider ids) so the download service can forward provider-specific
 * fields such as `downloadUrl`/`pageLink`/`releaseName` to the provider. The
 * fields mirror `SubtitleSearchResult`; unknown keys are stripped by Zod.
 */
export const subtitleDownloadSchema = z.object({
	providerId: z.string().uuid(),
	providerName: z.string().min(1),
	providerSubtitleId: z.string().min(1),
	movieId: z.string().uuid().optional(),
	episodeId: z.string().uuid().optional(),
	// Target movie file for multi-file movies (prevents cross-tier clobber).
	movieFileId: z.string().uuid().optional(),
	language: languageCodeSchema,
	title: z.string().min(1),
	releaseName: z.string().optional(),
	fileName: z.string().optional(),
	isForced: z.boolean().default(false),
	isHearingImpaired: z.boolean().default(false),
	format: z.enum(['srt', 'ass', 'sub', 'vtt', 'ssa', 'unknown']).default('srt'),
	isHashMatch: z.boolean().default(false),
	// Normalized 0-100 scoring scale shared by movies and episodes.
	matchScore: z.number().min(0).max(100).default(0),
	// Provider URLs are opaque; only require non-empty when present (some
	// providers expose non-http download tokens in these fields).
	downloadUrl: z.string().min(1).optional(),
	pageLink: z.string().min(1).optional(),
	fileSize: z.number().int().nonnegative().optional(),
	uploadDate: z.string().optional(),
	downloadCount: z.number().int().nonnegative().optional()
});

/**
 * Schema for subtitle sync request (alass).
 */
export const subtitleSyncSchema = z.object({
	subtitleId: z.string().uuid(),
	referenceType: z.enum(['video', 'subtitle']).default('video'),
	referencePath: z
		.string()
		.refine((s) => !s.includes('\0'), { message: 'Path must not contain null bytes' })
		.optional(),
	splitPenalty: z.number().int().min(0).max(1000).default(7),
	noSplits: z.boolean().default(false)
});

/**
 * Schema for bulk subtitle sync request.
 * Syncs multiple subtitles with shared settings.
 */
export const subtitleBulkSyncSchema = z.object({
	subtitleIds: z.array(z.string().uuid()).min(1).max(500),
	splitPenalty: z.number().int().min(0).max(1000).default(7),
	noSplits: z.boolean().default(false)
});

/**
 * Schema for deleting a subtitle file.
 */
export const subtitleDeleteSchema = z.object({
	addToBlacklist: z.boolean().default(false),
	reason: z.enum(['wrong_content', 'out_of_sync', 'poor_quality', 'manual']).optional()
});

/**
 * Schema for blacklisting a subtitle.
 */
export const subtitleBlacklistSchema = z.object({
	subtitleId: z.string().uuid().optional(),
	providerId: z.string().uuid(),
	providerSubtitleId: z.string().min(1),
	movieId: z.string().uuid().optional(),
	episodeId: z.string().uuid().optional(),
	reason: z.enum(['wrong_content', 'out_of_sync', 'poor_quality', 'manual']).default('manual')
});

// ============================================================
// Subtitle Settings Schemas
// ============================================================

// Subtitle Type Exports
// The provider schemas live in the server-only module; these re-exports are
// type-only and erased at compile time, so no server code ships to clients.
export type {
	SubtitleProviderImplementation,
	SubtitleProviderCreate,
	SubtitleProviderUpdate,
	SubtitleProviderTest,
	LanguageSettingsValues,
	LanguageSettingsUpdateInput,
	LiveTvAccountCreate
} from '#lib/server/validation/schemas.js';
export type SubtitleSearchRequest = z.infer<typeof subtitleSearchSchema>;
export type SubtitleDownloadRequest = z.infer<typeof subtitleDownloadSchema>;
export type SubtitleSyncRequest = z.infer<typeof subtitleSyncSchema>;
export type SubtitleBlacklistRequest = z.infer<typeof subtitleBlacklistSchema>;
/**
 * Schema for batch subtitle auto-search request.
 */
export const subtitleBatchAutoSearchSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('season'),
		seriesId: z.string().uuid(),
		seasonNumber: z.number().int().min(0),
		requirement: subtitleRequirementSchema.optional()
	}),
	z.object({
		type: z.literal('series'),
		seriesId: z.string().uuid(),
		requirement: subtitleRequirementSchema.optional()
	}),
	z.object({
		type: z.literal('collection'),
		collectionId: z.number().int().positive(),
		requirement: subtitleRequirementSchema.optional()
	}),
	z.object({
		type: z.literal('episodes'),
		episodeIds: z.array(z.string().uuid()).min(1).max(500),
		requirement: subtitleRequirementSchema.optional()
	})
]);
export type SubtitleBatchAutoSearchRequest = z.infer<typeof subtitleBatchAutoSearchSchema>;

// ============================================================
// Naming Settings Schemas
// ============================================================

/**
 * Multi-episode style options for naming.
 */
export const multiEpisodeStyleSchema = z.enum(['extend', 'duplicate', 'repeat', 'scene', 'range']);

/**
 * Colon replacement options for naming.
 */
export const colonReplacementSchema = z.enum([
	'delete',
	'dash',
	'spaceDash',
	'spaceDashSpace',
	'smart'
]);

/**
 * Media server ID format options.
 * - plex: {tmdb-12345} or {tvdb-12345}
 * - jellyfin: [tmdbid-12345] or [tvdbid-12345]
 */
export const mediaServerIdFormatSchema = z.enum(['plex', 'jellyfin']);

/**
 * Schema for updating naming settings.
 * All fields are optional - only provided fields will be updated.
 */
export const namingConfigUpdateSchema = z.object({
	// Movie formats
	movieFolderFormat: z.string().min(1).max(500).optional(),
	movieFileFormat: z.string().min(1).max(500).optional(),

	// TV formats
	seriesFolderFormat: z.string().min(1).max(500).optional(),
	seasonFolderFormat: z.string().min(1).max(200).optional(),
	episodeFileFormat: z.string().min(1).max(500).optional(),
	dailyEpisodeFormat: z.string().min(1).max(500).optional(),
	animeEpisodeFormat: z.string().min(1).max(500).optional(),
	multiEpisodeStyle: multiEpisodeStyleSchema.optional(),

	// Options
	replaceSpacesWith: z.string().max(10).optional(),
	colonReplacement: colonReplacementSchema.optional(),
	mediaServerIdFormat: mediaServerIdFormatSchema.optional(),
	includeQuality: z.boolean().optional(),
	includeMediaInfo: z.boolean().optional(),
	includeReleaseGroup: z.boolean().optional(),
	useSpecialsFolder: z.boolean().optional()
});

export const namingPresetSelectionSchema = z.object({
	selectedServerPresetId: z.string().min(1),
	selectedStylePresetId: z.string().min(1),
	selectedDetailPresetId: z.string().min(1),
	selectedCustomPresetId: z.string().min(1).optional()
});

export const namingSettingsUpdateSchema = z.object({
	config: namingConfigUpdateSchema,
	presetSelection: namingPresetSelectionSchema
});

// Naming Type Exports
export type MultiEpisodeStyle = z.infer<typeof multiEpisodeStyleSchema>;
export type ColonReplacement = z.infer<typeof colonReplacementSchema>;
export type MediaServerIdFormat = z.infer<typeof mediaServerIdFormatSchema>;
export type NamingConfigUpdate = z.infer<typeof namingConfigUpdateSchema>;
export type NamingPresetSelection = z.infer<typeof namingPresetSelectionSchema>;
export type NamingSettingsUpdate = z.infer<typeof namingSettingsUpdateSchema>;

// ============================================================
// NNTP Server Schemas (for NZB streaming)
// ============================================================

/**
 * Schema for creating an NNTP server.
 */
export const nntpServerCreateSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
	host: z.string().min(1, 'Host is required'),
	port: z.number().int().min(1).max(65535).default(563),
	useSsl: z.boolean().default(true),
	username: z.string().optional().nullable(),
	password: z.string().optional().nullable(),
	maxConnections: z.number().int().min(1).max(50).default(10),
	priority: z.number().int().min(0).max(99).default(1),
	enabled: z.boolean().default(true),
	downloadClientId: z.string().uuid().optional().nullable()
});

/**
 * Schema for updating an NNTP server.
 */
export const nntpServerUpdateSchema = nntpServerCreateSchema.required().partial();

/**
 * Schema for testing NNTP connection.
 */
export const nntpServerTestSchema = z.object({
	host: z.string().min(1, 'Host is required'),
	port: z.number().int().min(1).max(65535),
	useSsl: z.boolean().default(true),
	username: z.string().optional().nullable(),
	password: z.string().optional().nullable()
});

// NNTP Server Type Exports
export type NntpServerCreate = z.infer<typeof nntpServerCreateSchema>;
export type NntpServerUpdate = z.infer<typeof nntpServerUpdateSchema>;
export type NntpServerTest = z.infer<typeof nntpServerTestSchema>;

// ============================================================
// CinephageAPI subsystem schemas
// ============================================================

/**
 * Subsystem-level config update. All fields optional — the API accepts
 * partial updates and the settings panel sends only what changed.
 */
export const cinephageSubsystemUpdateSchema = z.object({
	enabled: z.boolean().optional(),
	baseUrl: z.string().trim().min(1).optional(),
	versionOverride: z.string().trim().nullable().optional(),
	commitOverride: z.string().trim().nullable().optional(),
	autoUpdate: z.boolean().optional()
});

export type CinephageSubsystemUpdate = z.infer<typeof cinephageSubsystemUpdateSchema>;

/**
 * Per-module config update. Settings is a free-form JSON bag whose shape
 * is validated by the module's settingsSchema at the server (currently
 * only library-streaming declares one).
 */
export const cinephageModuleUpdateSchema = z.object({
	moduleId: z.string().min(1),
	enabled: z.boolean().optional(),
	settings: z.record(z.string(), z.unknown()).optional()
});

export type CinephageModuleUpdate = z.infer<typeof cinephageModuleUpdateSchema>;

// ============================================================
// Media server notification schemas
// ============================================================

/**
 * Server type for MediaBrowser servers.
 */
export const mediaBrowserServerTypeSchema = z.enum(['jellyfin', 'emby', 'plex']);

/**
 * Path mapping for MediaBrowser servers.
 */
export const mediaBrowserPathMappingSchema = z.object({
	localPath: z.string().min(1, 'Local path is required'),
	remotePath: z.string().min(1, 'Remote path is required')
});

/**
 * Schema for creating a MediaBrowser server.
 */
export const mediaBrowserServerCreateSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
	serverType: mediaBrowserServerTypeSchema,
	host: z.string().url('Must be a valid URL'),
	apiKey: z.string().min(1, 'API key is required'),
	enabled: z.boolean().default(true),
	onImport: z.boolean().default(true),
	onUpgrade: z.boolean().default(true),
	onRename: z.boolean().default(true),
	onDelete: z.boolean().default(true),
	pathMappings: z.array(mediaBrowserPathMappingSchema).default([])
});

/**
 * Schema for updating a MediaBrowser server.
 */
export const mediaBrowserServerUpdateSchema = mediaBrowserServerCreateSchema.required().partial();

/**
 * Schema for testing a MediaBrowser server connection.
 */
export const mediaBrowserServerTestSchema = z.object({
	host: z.string().url('Must be a valid URL'),
	apiKey: z.string().min(1, 'API key is required'),
	serverType: mediaBrowserServerTypeSchema.optional()
});

// MediaBrowser Type Exports
export type MediaBrowserServerType = z.infer<typeof mediaBrowserServerTypeSchema>;
export type MediaBrowserPathMapping = z.infer<typeof mediaBrowserPathMappingSchema>;
export type MediaBrowserServerCreate = z.infer<typeof mediaBrowserServerCreateSchema>;
export type MediaBrowserServerUpdate = z.infer<typeof mediaBrowserServerUpdateSchema>;
export type MediaBrowserServerTest = z.infer<typeof mediaBrowserServerTestSchema>;

// ============================================================
// Stalker Portal Account Schemas (Live TV)
// ============================================================

/**
 * MAC address validation regex.
 * Format: XX:XX:XX:XX:XX:XX (uppercase or lowercase hex)
 */
const MAC_ADDRESS_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

/**
 * Timezone format regex (e.g., Europe/London, America/New_York)
 */
const TIMEZONE_REGEX = /^[a-zA-Z_]+\/[a-zA-Z_]+$/;

/**
 * Schema for creating a Stalker Portal account.
 */
export const stalkerAccountCreateSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
	portalUrl: z
		.string()
		.url('Must be a valid URL')
		.refine(
			(url) => {
				// Allow any valid URL - portal path varies by provider
				try {
					new URL(url);
					return true;
				} catch {
					return false;
				}
			},
			{ message: 'Must be a valid portal URL' }
		),
	macAddress: z.string().regex(MAC_ADDRESS_REGEX, {
		message: 'Invalid MAC address format (expected XX:XX:XX:XX:XX:XX)'
	}),
	enabled: z.boolean().default(true),
	// Device parameters (optional - will be auto-generated if not provided)
	serialNumber: z.string().max(50).optional(),
	deviceId: z.string().max(50).optional(),
	deviceId2: z.string().max(50).optional(),
	model: z.string().max(50).default('MAG254'),
	timezone: z
		.string()
		.regex(TIMEZONE_REGEX, { message: 'Invalid timezone format (expected Region/City)' })
		.default('Europe/London'),
	// Optional credentials
	username: z.string().max(100).optional(),
	password: z.string().max(100).optional()
});

/**
 * Schema for updating a Stalker Portal account.
 */
export const stalkerAccountUpdateSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	portalUrl: z.string().url().optional(),
	macAddress: z
		.string()
		.regex(MAC_ADDRESS_REGEX, {
			message: 'Invalid MAC address format (expected XX:XX:XX:XX:XX:XX)'
		})
		.optional(),
	enabled: z.boolean().optional(),
	// Device parameters
	serialNumber: z.string().max(50).optional(),
	deviceId: z.string().max(50).optional(),
	deviceId2: z.string().max(50).optional(),
	model: z.string().max(50).optional(),
	timezone: z
		.string()
		.regex(TIMEZONE_REGEX, { message: 'Invalid timezone format (expected Region/City)' })
		.optional(),
	// Credentials
	username: z.string().max(100).optional(),
	password: z.string().max(100).optional()
});

/**
 * Schema for testing a Stalker Portal account connection.
 */
export const stalkerAccountTestSchema = z.object({
	portalUrl: z.string().url('Must be a valid URL'),
	macAddress: z.string().regex(MAC_ADDRESS_REGEX, {
		message: 'Invalid MAC address format (expected XX:XX:XX:XX:XX:XX)'
	}),
	// Device parameters (optional - will be auto-generated if not provided)
	serialNumber: z.string().max(50).optional(),
	deviceId: z.string().max(50).optional(),
	deviceId2: z.string().max(50).optional(),
	model: z.string().max(50).optional(),
	timezone: z.string().optional(),
	// Optional credentials
	username: z.string().max(100).optional(),
	password: z.string().max(100).optional()
});

// Stalker Account Type Exports
export type StalkerAccountCreate = z.infer<typeof stalkerAccountCreateSchema>;
export type StalkerAccountUpdate = z.infer<typeof stalkerAccountUpdateSchema>;
export type StalkerAccountTest = z.infer<typeof stalkerAccountTestSchema>;

// ============================================================================
// LiveTV Lineup Schemas
// ============================================================================

/**
 * Schema for channel category form (create/update)
 */
export const channelCategoryFormSchema = z.object({
	name: z.string().min(1, 'Name is required'),
	color: z.string().optional(),
	icon: z.string().optional()
});

/**
 * Schema for reordering categories
 */
export const categoryReorderSchema = z.object({
	categoryIds: z.array(z.string()).min(0)
});

/**
 * Schema for adding to lineup
 */
export const addToLineupSchema = z.object({
	channels: z.array(
		z.object({
			accountId: z.string().min(1),
			channelId: z.string().min(1),
			categoryId: z.string().nullable().optional()
		})
	)
});

/**
 * Schema for updating a channel in lineup
 */
export const updateChannelSchema = z.object({
	channelNumber: z.number().nullable().optional(),
	customName: z.string().nullable().optional(),
	customLogo: z.string().nullable().optional(),
	epgId: z.string().nullable().optional(),
	epgSourceChannelId: z.string().nullable().optional(),
	categoryId: z.string().nullable().optional()
});

/**
 * Schema for removing from lineup
 */
export const removeFromLineupSchema = z.object({
	itemIds: z.array(z.string())
});

/**
 * Schema for reordering lineup
 */
export const reorderLineupSchema = z.object({
	itemIds: z.array(z.string())
});

/**
 * Schema for bulk setting category
 */
export const bulkSetCategorySchema = z.object({
	itemIds: z.array(z.string()),
	categoryId: z.string().nullable().optional()
});

/**
 * Schema for bulk clean names
 */
export const bulkCleanNamesSchema = z.object({
	itemIds: z.array(z.string())
});

/**
 * Schema for adding backup link
 */
export const addBackupLinkSchema = z.object({
	accountId: z.string().min(1),
	channelId: z.string().min(1)
});

/**
 * Schema for reordering backups
 */
export const reorderBackupsSchema = z.object({
	backupIds: z.array(z.string())
});

// LiveTV Lineup Type Exports
export type ChannelCategoryForm = z.infer<typeof channelCategoryFormSchema>;
export type CategoryReorder = z.infer<typeof categoryReorderSchema>;
export type AddToLineup = z.infer<typeof addToLineupSchema>;
export type UpdateChannel = z.infer<typeof updateChannelSchema>;
export type RemoveFromLineup = z.infer<typeof removeFromLineupSchema>;
export type ReorderLineup = z.infer<typeof reorderLineupSchema>;
export type BulkSetCategory = z.infer<typeof bulkSetCategorySchema>;
export type BulkCleanNames = z.infer<typeof bulkCleanNamesSchema>;
export type AddBackupLink = z.infer<typeof addBackupLinkSchema>;
export type ReorderBackups = z.infer<typeof reorderBackupsSchema>;

// ============================================================================
// Stalker Portal Schemas (for scanner feature)
// ============================================================================

/**
 * Schema for creating a Stalker Portal.
 */
export const stalkerPortalCreateSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
	url: z
		.string()
		.min(1, 'URL is required')
		.refine(
			(url) => {
				try {
					// Accept URLs with or without protocol
					const testUrl = url.startsWith('http') ? url : `http://${url}`;
					new URL(testUrl);
					return true;
				} catch {
					return false;
				}
			},
			{ message: 'Must be a valid portal URL' }
		),
	enabled: z.boolean().default(true)
});

/**
 * Schema for updating a Stalker Portal.
 */
export const stalkerPortalUpdateSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	url: z.string().min(1).optional(),
	enabled: z.boolean().optional()
});

/**
 * Schema for detecting portal type.
 */
export const stalkerPortalDetectSchema = z.object({
	url: z.string().url('Must be a valid URL').min(1, 'URL is required')
});

// Stalker Portal Type Exports
export type StalkerPortalCreate = z.infer<typeof stalkerPortalCreateSchema>;
export type StalkerPortalUpdate = z.infer<typeof stalkerPortalUpdateSchema>;
export type StalkerPortalDetect = z.infer<typeof stalkerPortalDetectSchema>;

// ============================================================
// Log Filter Schemas
// ============================================================

/**
 * Shared schema for common log filter query parameters.
 */
export const baseLogFilterQuerySchema = z.object({
	level: z.enum(CAPTURED_LOG_LEVELS).optional(),
	levels: z
		.string()
		.optional()
		.transform((v) =>
			v
				? (v
						.split(',')
						.filter((l) =>
							(CAPTURED_LOG_LEVELS as readonly string[]).includes(l)
						) as (typeof CAPTURED_LOG_LEVELS)[number][])
				: undefined
		),
	logDomain: z.enum(CAPTURED_LOG_DOMAINS).optional(),
	search: z.string().max(200).optional(),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional(),
	supportId: z.string().max(100).optional(),
	requestId: z.string().max(100).optional(),
	correlationId: z.string().max(100).optional()
});

/**
 * Schema for log filter query parameters used by the SSE stream.
 */
export const logFilterQuerySchema = baseLogFilterQuerySchema.extend({
	limit: z.coerce.number().int().min(1).max(1000).optional()
});

/**
 * Schema for log history search query parameters.
 */
export const logHistoryQuerySchema = baseLogFilterQuerySchema.extend({
	page: z.coerce.number().int().min(1).optional(),
	pageSize: z.coerce.number().int().min(1).max(500).optional()
});

/**
 * Schema for log download query parameters.
 */
export const logDownloadQuerySchema = baseLogFilterQuerySchema.extend({
	limit: z.coerce.number().int().min(1).max(5000).optional(),
	format: z.enum(['json', 'jsonl']).optional()
});

export type LogFilterQuery = z.infer<typeof logFilterQuerySchema>;

// ============================================================================
// Library Schemas
// ============================================================================

/**
 * Schema for library status request
 */
export const libraryStatusSchema = z.object({
	tmdbIds: z.array(z.number().int()),
	mediaType: z.enum(['movie', 'tv', 'all']).default('all')
});

/**
 * Schema for updating an episode
 */
export const episodeUpdateSchema = z
	.object({
		monitored: z.boolean().optional(),
		wantsSubtitlesOverride: z.union([z.boolean(), z.null()]).optional(),
		subtitleRequirementsOverride: subtitleRequirementsOverrideSchema.nullable().optional()
	})
	.refine(
		(data) =>
			data.monitored !== undefined ||
			data.wantsSubtitlesOverride !== undefined ||
			data.subtitleRequirementsOverride !== undefined,
		{
			message: 'No valid fields to update'
		}
	);

/**
 * Per-item TMDB metadata language override mode:
 * - inherit: use the global language_settings.metadataLocale
 * - original: use the item's TMDB original_language
 * - explicit: use metadataLanguageValue (a canonical TMDB locale)
 */
export const metadataLanguageModeSchema = z.enum(['inherit', 'original', 'explicit']);
export type MetadataLanguageMode = z.infer<typeof metadataLanguageModeSchema>;

/** Canonicalize a TMDB locale via Intl, returning null when invalid. */
function canonicalMetadataLocale(value: string): string | null {
	try {
		return Intl.getCanonicalLocales(value.trim())[0] ?? null;
	} catch {
		return null;
	}
}

/**
 * Map a legacy single-string `metadataLanguage` override onto the v2 pair.
 * Valid locales become 'explicit' (canonicalized); 'original' maps to the
 * original mode; null/empty/invalid degrades to 'inherit' so old payloads
 * never hard-fail.
 */
export function normalizeLegacyMetadataLanguage(value: string | null | undefined): {
	mode: MetadataLanguageMode;
	value: string | null;
} {
	if (value == null || value.trim() === '') return { mode: 'inherit', value: null };
	if (value.trim().toLowerCase() === 'original') return { mode: 'original', value: null };
	const canonical = canonicalMetadataLocale(value);
	return canonical ? { mode: 'explicit', value: canonical } : { mode: 'inherit', value: null };
}

/**
 * The three metadata-language fields shared by the movie/series update schemas.
 * `metadataLanguage` is the deprecated single-string form kept for one release.
 */
const metadataLanguageFields = {
	metadataLanguageMode: metadataLanguageModeSchema.optional(),
	metadataLanguageValue: z.string().nullable().optional(),
	/** @deprecated Use metadataLanguageMode + metadataLanguageValue. */
	metadataLanguage: z.string().nullable().optional()
};

interface MetadataLanguageOverride {
	metadataLanguageMode?: MetadataLanguageMode;
	metadataLanguageValue?: string | null;
	metadataLanguage?: string | null;
}

/**
 * Validate the metadata-language pair: 'explicit' requires a valid canonical
 * locale; legacy and explicit cannot be combined. Validation only — forcing
 * value null for inherit/original and canonicalizing happen in the normalizer.
 */
function validateMetadataLanguageOverride(
	data: MetadataLanguageOverride,
	ctx: z.RefinementCtx
): void {
	const hasLegacy = data.metadataLanguage !== undefined;
	const hasMode = data.metadataLanguageMode !== undefined;
	const hasValue = data.metadataLanguageValue !== undefined;
	if (!hasLegacy && !hasMode && !hasValue) return;

	if (hasLegacy && (hasMode || hasValue)) {
		ctx.addIssue({
			code: 'custom',
			path: ['metadataLanguage'],
			message:
				'Provide either metadataLanguage (deprecated) or metadataLanguageMode/metadataLanguageValue, not both'
		});
		return;
	}

	if (!hasLegacy && data.metadataLanguageMode === 'explicit') {
		const candidate = data.metadataLanguageValue;
		if (candidate == null || canonicalMetadataLocale(candidate) === null) {
			ctx.addIssue({
				code: 'custom',
				path: ['metadataLanguageValue'],
				message: "metadataLanguageValue must be a valid TMDB locale when mode is 'explicit'"
			});
		}
	}
}

/**
 * Normalize the metadata-language override in place: map legacy strings onto
 * the pair, canonicalize explicit locales, and force the value null for
 * inherit/original (and when only a value was supplied without a mode).
 */
function normalizeMetadataLanguageOverride<T extends MetadataLanguageOverride>(data: T): T {
	const hasLegacy = data.metadataLanguage !== undefined;
	const hasMode = data.metadataLanguageMode !== undefined;
	const hasValue = data.metadataLanguageValue !== undefined;
	if (!hasLegacy && !hasMode && !hasValue) return data;

	if (hasLegacy) {
		const mapped = normalizeLegacyMetadataLanguage(data.metadataLanguage);
		data.metadataLanguageMode = mapped.mode;
		data.metadataLanguageValue = mapped.value;
		return data;
	}

	if (data.metadataLanguageMode === 'explicit') {
		data.metadataLanguageValue = canonicalMetadataLocale(data.metadataLanguageValue ?? '');
	} else {
		// inherit / original (or no mode supplied) never carry a value.
		data.metadataLanguageValue = null;
		if (data.metadataLanguageMode === undefined) data.metadataLanguageMode = 'inherit';
	}
	return data;
}

/**
 * Schema for updating a movie
 */
export const movieUpdateSchema = z
	.object({
		monitored: z.boolean().optional(),
		scoringProfileId: z.string().nullable().optional(),
		/** Desired qualities for multi-quality mode (null/empty = single-quality). */
		desiredQualities: z
			.array(z.enum(['2160p', '1080p', '720p', '480p']))
			.nullable()
			.optional(),
		minimumAvailability: z.string().min(1).optional(),
		availabilityDelay: z.number().int().min(0).max(365).optional(),
		providerRefs: z.partialRecord(z.enum(['tmdb', 'anilist', 'mal']), z.string().min(1)).optional(),
		rootFolderId: z.string().optional(),
		moveFilesOnRootChange: z.boolean().optional(),
		wantsSubtitles: z.boolean().optional(),
		languageProfileId: z.string().nullable().optional(),
		/** Per-item subtitle requirement override; null clears (inherit). */
		subtitleRequirementsOverride: subtitleRequirementsOverrideSchema.nullable().optional(),
		delayProfileId: z.string().nullable().optional(),
		/** Edit-only: opt-in removal of files for resolutions no longer in
		 *  desiredQualities. Server recomputes the redundant set authoritatively. */
		removeUnwantedFiles: z.boolean().optional(),
		/** Relative folder name within the root folder (e.g. "Brokenwood Mysteries"). Used to
		 *  correct a drifted DB path without touching files on disk. */
		folderPath: z
			.string()
			.min(1)
			.refine((v) => !v.includes('..') && !v.startsWith('/'), {
				message: 'Folder path must be a relative name with no path traversal'
			})
			.optional(),
		/** Override the TMDB collection assignment for this movie. */
		tmdbCollectionId: z.number().int().positive().nullable().optional(),
		collectionName: z.string().min(1).nullable().optional(),
		...metadataLanguageFields,
		/** Display originalTitle instead of localized title in the UI */
		// Tri-state: true/false = explicit per-item preference, null = inherit
		// the instance default (language_settings.prefer_original_title).
		preferOriginalTitle: z.union([z.boolean(), z.null()]).optional()
	})
	.superRefine((data, ctx) => validateMetadataLanguageOverride(data, ctx))
	.transform((data) => normalizeMetadataLanguageOverride(data));

/**
 * Schema for updating a series
 */
export const seriesUpdateSchema = z
	.object({
		monitored: z.boolean().optional(),
		scoringProfileId: z.string().nullable().optional(),
		seasonFolder: z.boolean().optional(),
		seriesType: z.enum(['standard', 'anime', 'daily']).optional(),
		providerRefs: z.partialRecord(z.enum(['tmdb', 'anilist', 'mal']), z.string().min(1)).optional(),
		rootFolderId: z.string().optional(),
		wantsSubtitles: z.boolean().optional(),
		languageProfileId: z.string().nullable().optional(),
		/** Per-item subtitle requirement override; null clears (inherit). */
		subtitleRequirementsOverride: subtitleRequirementsOverrideSchema.nullable().optional(),
		delayProfileId: z.string().nullable().optional(),
		/** Relative folder name within the root folder. Used to correct a drifted DB path. */
		folderPath: z
			.string()
			.min(1)
			.refine((v) => !v.includes('..') && !v.startsWith('/'), {
				message: 'Folder path must be a relative name with no path traversal'
			})
			.optional(),
		/** TMDB episode group ID for alternate season ordering (null = default TMDB ordering) */
		episodeGroupId: z.string().nullable().optional(),
		...metadataLanguageFields,
		/** Display originalTitle instead of localized title in the UI */
		// Tri-state: true/false = explicit per-item preference, null = inherit
		// the instance default (language_settings.prefer_original_title).
		preferOriginalTitle: z.union([z.boolean(), z.null()]).optional()
	})
	.superRefine((data, ctx) => validateMetadataLanguageOverride(data, ctx))
	.transform((data) => normalizeMetadataLanguageOverride(data));

/**
 * Schema for auto-search request
 */
export const autoSearchSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('episode'),
		episodeId: z.string().min(1)
	}),
	z.object({
		type: z.literal('season'),
		seasonNumber: z.number().int().min(0)
	}),
	z.object({
		type: z.literal('missing')
	}),
	z.object({
		type: z.literal('bulk'),
		episodeIds: z.array(z.string()).min(1)
	})
]);

/**
 * Schema for updating a season
 */
export const seasonUpdateSchema = z.object({
	monitored: z.boolean().optional(),
	updateEpisodes: z.boolean().optional()
});

/**
 * Schema for library scan
 */
export const libraryScanSchema = z
	.object({
		rootFolderId: z.string().optional(),
		fullScan: z.boolean().optional()
	})
	.optional()
	.default({});

/**
 * Schema for manual import execution.
 */
export const importMethodSchema = z.enum(['move', 'copy', 'symlink']);
export type ImportMethod = z.infer<typeof importMethodSchema>;

export const fileManagementSchema = z.object({
	importMode: importMethodSchema.default('move'),
	preferHardlink: z.boolean().default(true),
	minimumFreeSpaceGb: z.number().min(0).default(1),
	deleteEmptyFolders: z.boolean().default(false),
	recycleEnabled: z.boolean().default(false),
	extraFileExtensions: z.array(z.string()).default([]),
	preservePermissions: z.boolean().default(false),
	chmodFile: z.union([z.string().regex(/^[0-7]{3,4}$/), z.literal('')]).default(''),
	autoEnabledPreserveSymlinkFolderIds: z.array(z.string()).default([]),
	defaultImportFolder: z.string().optional()
});
export type FileManagementSettings = z.infer<typeof fileManagementSchema>;

export const manualImportSchema = z
	.object({
		sourcePath: z.string().min(1).optional(),
		selectedFilePath: z.string().min(1).optional(),
		mediaType: z.enum(['movie', 'tv']),
		tmdbId: z.number().int().positive(),
		importTarget: z.enum(['new', 'existing']),
		rootFolderId: z.string().optional(),
		libraryId: z.string().optional(),
		seasonNumber: z.number().int().min(0).optional(),
		episodeNumber: z.number().int().min(1).optional(),
		importMode: importMethodSchema.optional(),
		// Per-import hardlink override; omitted means the global File Management
		// setting applies (resolved at execution time). Must live in this schema:
		// routes persist the parsed payload and the durable bulk/worker path
		// replays the stored request without re-validation, so an unknown key
		// is stripped before the job is even enqueued.
		preferHardlink: z.boolean().optional(),
		// Queue the import as a background library job and return immediately (#530).
		// Omitted means run synchronously, as before.
		background: z.boolean().optional()
	})
	.superRefine((value, ctx) => {
		if (!value.sourcePath && !value.selectedFilePath) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'sourcePath or selectedFilePath is required',
				path: ['sourcePath']
			});
		}
	});

/**
 * Schema for adding a movie to the library.
 */
export const addMovieSchema = z.object({
	tmdbId: z.number().int().positive(),
	rootFolderId: z.string().min(1),
	scoringProfileId: z.string().optional(),
	/** Desired qualities for multi-quality mode (null/empty = single-quality). */
	desiredQualities: z
		.array(z.enum(['2160p', '1080p', '720p', '480p']))
		.nullable()
		.optional(),
	monitored: z.boolean().default(true),
	minimumAvailability: z.enum(['announced', 'inCinemas', 'released']).default('released'),
	availabilityDelay: z.number().int().min(0).max(365).default(0),
	searchOnAdd: z.boolean().default(true),
	wantsSubtitles: z.boolean().default(true),
	/** Optional per-item language profile + subtitle requirement override at add time. */
	languageProfileId: z.string().uuid().nullable().optional(),
	subtitleRequirementsOverride: subtitleRequirementsOverrideSchema.nullable().optional()
});

/**
 * Schema for adding a series to the library.
 */
export const addSeriesSchema = z.object({
	tmdbId: z.number().int().positive(),
	rootFolderId: z.string().min(1),
	scoringProfileId: z.string().optional(),
	monitored: z.boolean().default(true),
	seasonFolder: z.boolean().default(true),
	seriesType: z.enum(['standard', 'anime', 'daily']).default('standard'),
	monitorType: z
		.enum([
			'all',
			'future',
			'missing',
			'existing',
			'firstSeason',
			'lastSeason',
			'recent',
			'pilot',
			'none'
		])
		.default('all'),
	monitorNewItems: z.enum(['all', 'none']).default('all'),
	monitorSpecials: z.boolean().default(false),
	monitoredSeasons: z.array(z.number().int()).optional(),
	searchOnAdd: z.boolean().default(true),
	wantsSubtitles: z.boolean().default(true),
	/** Optional per-item language profile + subtitle requirement override at add time. */
	languageProfileId: z.string().uuid().nullable().optional(),
	subtitleRequirementsOverride: subtitleRequirementsOverrideSchema.nullable().optional(),
	/**
	 * Explicit episode selection: when present, exactly these episodes are
	 * monitored (seasons containing them become monitored). Takes precedence
	 * over monitorType/monitoredSeasons for episode-level control — used by
	 * the request system's episode-granular approvals.
	 */
	monitoredEpisodes: z
		.array(
			z.object({ seasonNumber: z.number().int().min(0), episodeNumber: z.number().int().min(1) })
		)
		.optional()
});

/**
 * Schema for bulk adding movies to the library.
 */
export const bulkAddMoviesSchema = z.object({
	tmdbIds: z.array(z.number().int().positive()).min(1).max(50),
	rootFolderId: z.string().min(1),
	scoringProfileId: z.string().optional(),
	monitored: z.boolean().default(true),
	minimumAvailability: z.enum(['announced', 'inCinemas', 'released']).default('released'),
	availabilityDelay: z.number().int().min(0).max(365).default(0),
	searchOnAdd: z.boolean().default(true),
	wantsSubtitles: z.boolean().default(true)
});

/**
 * Schema for bulk adding TV series to the library. The series scope fields
 * (monitorType/monitorSpecials/…) are shared across the whole selection,
 * mirroring how the single add form's defaults would apply to each item.
 */
export const bulkAddSeriesSchema = z.object({
	tmdbIds: z.array(z.number().int().positive()).min(1).max(50),
	rootFolderId: z.string().min(1),
	scoringProfileId: z.string().optional(),
	monitored: z.boolean().default(true),
	seriesType: z.enum(['standard', 'anime', 'daily']).default('standard'),
	monitorType: z
		.enum([
			'all',
			'future',
			'missing',
			'existing',
			'firstSeason',
			'lastSeason',
			'recent',
			'pilot',
			'none'
		])
		.default('all'),
	monitorNewItems: z.enum(['all', 'none']).default('all'),
	monitorSpecials: z.boolean().default(false),
	seasonFolder: z.boolean().default(true),
	searchOnAdd: z.boolean().default(true),
	wantsSubtitles: z.boolean().default(true)
});

/**
 * Schema for batch episode update
 */
export const episodeBatchUpdateSchema = z.object({
	monitored: z.boolean(),
	episodeIds: z.array(z.string()).min(1).optional(),
	seriesId: z.string().optional(),
	seasonNumber: z.number().int().optional()
});

/**
 * Schema for batch movie update
 */
export const movieBatchUpdateSchema = z.object({
	movieIds: z.array(z.string()).min(1),
	updates: z.object({
		monitored: z.boolean().optional(),
		scoringProfileId: z.string().nullable().optional()
	})
});

/**
 * Schema for batch movie delete
 */
export const movieBatchDeleteSchema = z.object({
	movieIds: z.array(z.string()).min(1),
	deleteFiles: z.boolean().default(false),
	removeFromLibrary: z.boolean().default(false)
});

/**
 * Schema for batch series update
 */
export const seriesBatchUpdateSchema = z.object({
	seriesIds: z.array(z.string()).min(1),
	updates: z.object({
		monitored: z.boolean().optional(),
		scoringProfileId: z.string().nullable().optional()
	})
});

/**
 * Schema for batch series delete
 */
export const seriesBatchDeleteSchema = z.object({
	seriesIds: z.array(z.string()).min(1),
	deleteFiles: z.boolean().default(false),
	removeFromLibrary: z.boolean().default(false)
});

// ============================================================================
// Download & Queue Schemas
// ============================================================================

/**
 * Schema for grab request
 */
export const grabRequestSchema = z
	.object({
		guid: z.string().optional(),
		downloadUrl: z.string().optional(),
		magnetUrl: z.string().optional(),
		infoHash: z.string().optional(),
		title: z.string().min(1, 'title is required'),
		indexerId: z.string().optional(),
		indexerName: z.string().optional(),
		protocol: z.enum(['torrent', 'usenet', 'streaming']).optional(),
		categories: z.array(z.number()).optional(),
		size: z.number().optional(),
		publishDate: z.string().datetime().optional(),
		commentsUrl: z.string().optional(),
		/** External IDs asserted by the search result, when available. */
		tmdbId: z.number().int().optional(),
		imdbId: z.string().optional(),
		tvdbId: z.number().int().optional(),
		movieId: z.string().optional(),
		seriesId: z.string().optional(),
		episodeIds: z.array(z.string()).optional(),
		seasonNumber: z.number().int().optional(),
		mediaType: z.enum(['movie', 'tv']),
		isAutomatic: z.boolean().optional(),
		isUpgrade: z.boolean().optional(),
		force: z.boolean().optional(),
		/** Acquisition origin recorded on the acquisition intent. */
		source: z.enum(['manual', 'automatic', 'arr_push', 'override']).optional(),
		streamUsenet: z.boolean().optional(),
		acquisitionProtocol: z.enum(['default', 'torrent', 'debrid']).optional()
	})
	.refine((data) => data.downloadUrl || data.magnetUrl, {
		message: 'Either downloadUrl or magnetUrl is required',
		path: ['downloadUrl']
	})
	.refine((data) => data.movieId || data.seriesId, {
		message: 'Either movieId or seriesId is required',
		path: ['movieId']
	});

/**
 * Schema for queue action
 */
export const queueActionSchema = z.object({
	action: z.enum(['pause', 'resume'])
});

// ============================================================================
// Workers Schemas
// ============================================================================

// ============================================================================
// Naming Schemas
// ============================================================================

/**
 * Schema for naming preset create
 */
export const namingPresetCreateSchema = z.object({
	name: z.string().min(1, 'Name is required'),
	description: z.string().optional(),
	config: z.record(z.string(), z.unknown())
});

/**
 * Schema for naming preset update
 */
export const namingPresetUpdateSchema = z.object({
	name: z.string().min(1, 'Name cannot be empty').optional(),
	description: z.string().optional(),
	config: z.record(z.string(), z.unknown()).optional()
});

/**
 * Schema for naming preview
 */
export const namingPreviewSchema = z.object({
	config: z.record(z.string(), z.unknown()).optional()
});

/**
 * Schema for naming validate
 */
export const namingValidateSchema = z.object({
	formats: z.record(z.string(), z.string())
});

// ============================================================================
// User Schemas
// ============================================================================

/**
 * Schema for user language preference
 */
export const userLanguageSchema = z.object({
	language: z.string().min(1, 'Language is required')
});

// ============================================================================
// Subtitle Scan Schema
// ============================================================================

/**
 * Schema for subtitle scan
 */
export const subtitleScanSchema = z
	.object({
		movieId: z.string().optional(),
		seriesId: z.string().optional(),
		scanAll: z.boolean().optional()
	})
	.optional()
	.default({})
	.refine((data) => data?.movieId || data?.seriesId || data?.scanAll, {
		message: 'Specify movieId, seriesId, or scanAll: true'
	});

// ============================================================================
// Unmatched Schemas
// ============================================================================

/**
 * Schema for unmatched match
 */
export const unmatchedMatchSchema = z.object({
	fileIds: z.array(z.string()).min(1),
	tmdbId: z.number().int(),
	mediaType: z.enum(['movie', 'tv']),
	season: z.number().int().optional(),
	episode: z.number().int().optional(),
	episodeMapping: z
		.record(
			z.string(),
			z.object({
				season: z.number().int(),
				episode: z.number().int()
			})
		)
		.optional()
});

/**
 * Schema for unmatched delete
 */
export const unmatchedDeleteSchema = z.object({
	fileIds: z.array(z.string()).min(1),
	deleteFromDisk: z.boolean().default(false)
});

/**
 * Schema for unmatched single match
 */
export const unmatchedSingleMatchSchema = z.object({
	tmdbId: z.number().int(),
	mediaType: z.enum(['movie', 'tv']),
	season: z.number().int().optional(),
	episode: z.number().int().optional()
});

// ============================================================================
// Custom Format Schemas
// ============================================================================

export const conditionSchema = z.object({
	name: z.string().min(1).max(100),
	type: z.enum([
		'resolution',
		'source',
		'release_title',
		'release_group',
		'codec',
		'audio_codec',
		'audio_channels',
		'audio_atmos',
		'hdr',
		'streaming_service',
		'flag',
		'indexer',
		'language'
	]),
	required: z.boolean(),
	negate: z.boolean(),
	resolution: z.string().optional(),
	source: z.string().optional(),
	pattern: z.string().optional(),
	codec: z.string().optional(),
	audioCodec: z.string().optional(),
	audioChannels: z.string().optional(),
	hdr: z.string().nullable().optional(),
	streamingService: z.string().optional(),
	flag: z.enum(['isRemux', 'isRepack', 'isProper', 'is3d']).optional(),
	indexer: z.string().optional(),
	language: z.string().optional()
});

export type Condition = z.infer<typeof conditionSchema>;

export const customFormatTestSchema = z.object({
	releaseName: z.string().min(1),
	conditions: z.array(conditionSchema).min(1)
});

export const customFormatSchema = z.object({
	id: z.string().min(1).max(50).optional(),
	name: z.string().min(1).max(100),
	description: z.string().max(500).optional(),
	category: z.enum([
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
	]),
	tags: z.array(z.string()).optional().default([]),
	conditions: z.array(conditionSchema).min(1),
	enabled: z.boolean().optional().default(true)
});

export const customFormatUpdateSchema = customFormatSchema.extend({
	id: z.string().min(1)
});

export const customFormatDeleteSchema = z.object({
	id: z.string().min(1)
});

export type CustomFormatCreate = z.infer<typeof customFormatSchema>;
export type CustomFormatUpdateBody = z.infer<typeof customFormatUpdateSchema>;
export type CustomFormatDelete = z.infer<typeof customFormatDeleteSchema>;

// ============================================================================
// Scoring Profile Schemas
// ============================================================================

export const scoringProfileCreateSchema = z.object({
	id: z.string().min(1).max(50).optional(),
	name: z.string().min(1).max(100),
	description: z.string().max(500).optional(),
	copyFromId: z.string().optional(),
	upgradesAllowed: z.boolean().optional(),
	preventDowngrades: z.boolean().optional(),
	minScore: z.number().int().optional(),
	upgradeUntilScore: z.number().int().optional(),
	minScoreIncrement: z.number().int().optional(),
	formatScores: z.record(z.string(), z.number().int()).optional(),
	requiredFormats: z.array(z.object({ id: z.string(), op: z.enum(['AND', 'OR']) })).optional(),
	movieMinSizeGb: z.number().nullable().optional(),
	movieMaxSizeGb: z.number().nullable().optional(),
	episodeMinSizeMb: z.number().nullable().optional(),
	episodeMaxSizeMb: z.number().nullable().optional(),
	isDefault: z.boolean().optional()
});

export const scoringProfileUpdateSchema = scoringProfileCreateSchema.required().partial();

export const scoringProfileUpdateBodySchema = scoringProfileUpdateSchema
	.extend({
		id: z.string().min(1, 'Profile ID is required')
	})
	.passthrough();

export const scoringProfileDeleteSchema = z.object({
	id: z.string().min(1, 'Profile ID is required')
});

export type ScoringProfileCreate = z.infer<typeof scoringProfileCreateSchema>;
export type ScoringProfileUpdate = z.infer<typeof scoringProfileUpdateSchema>;
export type ScoringProfileUpdateBody = z.infer<typeof scoringProfileUpdateBodySchema>;

// ============================================================================
// Smart List Schemas
// ============================================================================

/** Helper: coerce empty strings to undefined for optional number fields */
const optionalSmartNumber = z.preprocess(
	(v: unknown) => (v === '' || v === null ? undefined : v),
	z.number().optional()
);

/** Helper: coerce empty strings to undefined for optional number fields with range */
const optionalSmartNumberRange = (min: number, max: number) =>
	z.preprocess(
		(v: unknown) => (v === '' || v === null ? undefined : v),
		z.number().min(min).max(max).optional()
	);

const smartListFiltersSchema = z.object({
	withGenres: z.array(z.number()).optional(),
	withoutGenres: z.array(z.number()).optional(),
	genreMode: z.enum(['and', 'or']).optional(),
	yearMin: optionalSmartNumber,
	yearMax: optionalSmartNumber,
	releaseDateMin: z.string().optional(),
	releaseDateMax: z.string().optional(),
	voteAverageMin: optionalSmartNumberRange(0, 10),
	voteAverageMax: optionalSmartNumberRange(0, 10),
	voteCountMin: optionalSmartNumber,
	popularityMin: optionalSmartNumber,
	popularityMax: optionalSmartNumber,
	withCast: z.array(z.number()).optional(),
	withCrew: z.array(z.number()).optional(),
	withKeywords: z.array(z.number()).optional(),
	withoutKeywords: z.array(z.number()).optional(),
	withWatchProviders: z.array(z.number()).optional(),
	watchRegion: z.string().optional(),
	certification: z.string().optional(),
	certificationCountry: z.string().optional(),
	runtimeMin: optionalSmartNumber,
	runtimeMax: optionalSmartNumber,
	withOriginalLanguage: z.string().optional(),
	withStatus: z.string().optional(),
	withReleaseType: z.array(z.number()).optional()
});

const smartListSortBySchema = z
	.enum([
		'popularity.desc',
		'popularity.asc',
		'vote_average.desc',
		'vote_average.asc',
		'primary_release_date.desc',
		'primary_release_date.asc',
		'first_air_date.desc',
		'first_air_date.asc',
		'revenue.desc',
		'revenue.asc',
		'title.asc',
		'title.desc'
	])
	.optional();

export const smartListCreateSchema = z.object({
	name: z.string().min(1).max(100),
	description: z.string().max(101).optional(),
	mediaType: z.enum(['movie', 'tv']),
	filters: smartListFiltersSchema,
	sortBy: smartListSortBySchema,
	itemLimit: z.number().min(1).max(1000).optional(),
	excludeInLibrary: z.boolean().optional(),
	showUpgradeableOnly: z.boolean().optional(),
	excludedTmdbIds: z.array(z.number()).optional(),
	scoringProfileId: z.string().optional(),
	autoAddBehavior: z.enum(['disabled', 'add_only', 'add_and_search']).optional(),
	rootFolderId: z.string().optional(),
	autoAddMonitored: z.boolean().optional(),
	minimumAvailability: z.string().optional(),
	wantsSubtitles: z.boolean().optional(),
	languageProfileId: z.string().optional(),
	refreshIntervalHours: z.number().min(1).max(168).optional(),
	enabled: z.boolean().optional(),
	listSourceType: z
		.enum(['tmdb-discover', 'external-json', 'trakt-list', 'custom-manual'])
		.optional(),
	externalSourceConfig: z
		.object({
			url: z.string().optional(),
			headers: z.record(z.string(), z.unknown()).optional(),
			listId: z.string().optional(),
			username: z.string().optional()
		})
		.optional(),
	presetId: z.string().optional(),
	presetProvider: z.string().optional(),
	presetSettings: z.record(z.string(), z.unknown()).optional()
});

export const smartListPreviewSchema = z.object({
	mediaType: z.enum(['movie', 'tv']),
	filters: smartListFiltersSchema,
	sortBy: smartListSortBySchema.optional().default('popularity.desc'),
	itemLimit: z.preprocess(
		(v: unknown) => (v === '' || v === null ? undefined : v),
		z.number().min(1).max(1000).optional().default(100)
	),
	page: z.preprocess(
		(v: unknown) => (v === '' || v === null ? undefined : v),
		z.number().optional().default(1)
	)
});

export const smartListExternalPreviewSchema = z.object({
	url: z.string().url().optional(),
	headers: z.record(z.string(), z.unknown()).optional(),
	mediaType: z.enum(['movie', 'tv']).optional(),
	presetId: z.string().optional(),
	providerType: z.string().optional(),
	config: z.record(z.string(), z.unknown()).optional(),
	page: z.number().int().min(1).default(1),
	itemLimit: z.number().int().min(1).max(1000).default(100)
});

export const smartListItemsActionSchema = z.object({
	action: z.enum(['exclude', 'include', 'addToLibrary']),
	itemIds: z.array(z.string()).optional(),
	tmdbIds: z.array(z.number()).optional()
});

// ============================================================================
// Monitoring Settings Schema
// ============================================================================

export const monitoringSettingsUpdateSchema = z.object({
	missingSearchIntervalHours: z.number().min(0.25).optional(),
	upgradeSearchIntervalHours: z.number().min(0.25).optional(),
	newEpisodeCheckIntervalHours: z.number().min(0.25).optional(),
	cutoffUnmetSearchIntervalHours: z.number().min(0.25).optional(),
	autoReplaceEnabled: z.boolean().optional(),
	searchOnMonitorEnabled: z.boolean().optional(),
	stalledDownloadTimeoutMinutes: z.number().min(0).optional(),
	stalledDownloadProgressThreshold: z.number().min(0).max(100).optional(),
	stalledDownloadBlocklistHours: z.number().min(0).optional()
});

// ============================================================================
// Captcha Solver Schemas
// ============================================================================

export const captchaSolverSettingsUpdateSchema = z.object({
	enabled: z.boolean().optional(),
	timeoutSeconds: z.number().min(10).max(300).optional(),
	cacheTtlSeconds: z.number().min(60).max(86400).optional(),
	headless: z.boolean().optional(),
	proxyUrl: z.string().optional(),
	proxyUsername: z.string().optional(),
	proxyPassword: z.string().optional()
});

export const captchaSolverTestSchema = z.object({
	url: z.string().url()
});

// ============================================================================
// Streaming Schemas
// ============================================================================

/**
 * Schema for streaming status action
 */
export const streamingStatusActionSchema = z.object({
	action: z.enum(['reset-all'])
});

/**
 * Schema for STRM update
 */
export const strmUpdateSchema = z
	.object({
		baseUrl: z.string().optional(),
		apiKey: z.string().optional()
	})
	.optional();

// ============================================================================
// Blocked Media Schemas
// ============================================================================

/**
 * Schema for blocking media (movies/series) from appearing in discover/search.
 */
export const blockMediaSchema = z.object({
	tmdbId: z.number().int().positive(),
	mediaType: z.enum(['movie', 'tv']),
	title: z.string().min(1),
	posterPath: z.string().nullable().optional(),
	year: z.number().nullable().optional(),
	reason: z.string().optional()
});

/**
 * Schema for unblocking media by ID.
 */
export const unblockMediaSchema = z.object({
	ids: z.array(z.string()).min(1)
});

export const addBlockedKeywordSchema = z.object({
	keywordId: z.number().int().positive()
});

export const removeBlockedKeywordSchema = z.object({
	id: z.number().int().positive()
});

// ============================================================================
// Blocklist Schemas (Release-Level)
// ============================================================================

/**
 * Schema for adding a release to the blocklist.
 */
export const addToBlocklistSchema = z.object({
	title: z.string().min(1),
	infoHash: z.string().optional(),
	indexerId: z.string().optional(),
	movieId: z.string().nullable().optional(),
	seriesId: z.string().nullable().optional(),
	size: z.number().nonnegative().optional(),
	protocol: z.enum(['torrent', 'usenet', 'streaming']).optional(),
	reason: z.enum(['manual']).default('manual'),
	message: z.string().optional(),
	expiresInHours: z.number().positive().nullable().optional()
});

export type AddToBlocklistRequest = z.infer<typeof addToBlocklistSchema>;

/**
 * Schema for updating a blocklist entry's expiry.
 */
export const updateBlocklistExpirySchema = z.object({
	id: z.string().min(1),
	expiresInHours: z.number().positive().nullable()
});

export type UpdateBlocklistExpiryRequest = z.infer<typeof updateBlocklistExpirySchema>;

// ============================================================================
// Type Exports for New Schemas
// ============================================================================

// Library Type Exports
export type LibraryStatusRequest = z.infer<typeof libraryStatusSchema>;
export type EpisodeUpdate = z.infer<typeof episodeUpdateSchema>;
export type MovieUpdate = z.infer<typeof movieUpdateSchema>;
export type SeriesUpdate = z.infer<typeof seriesUpdateSchema>;
export type AutoSearchRequest = z.infer<typeof autoSearchSchema>;
export type SeasonUpdate = z.infer<typeof seasonUpdateSchema>;
export type LibraryScanRequest = z.infer<typeof libraryScanSchema>;
export type EpisodeBatchUpdate = z.infer<typeof episodeBatchUpdateSchema>;
export type MovieBatchUpdate = z.infer<typeof movieBatchUpdateSchema>;
export type MovieBatchDelete = z.infer<typeof movieBatchDeleteSchema>;
export type SeriesBatchUpdate = z.infer<typeof seriesBatchUpdateSchema>;
export type SeriesBatchDelete = z.infer<typeof seriesBatchDeleteSchema>;

// Download & Queue Type Exports
export type GrabRequest = z.infer<typeof grabRequestSchema>;
export type QueueAction = z.infer<typeof queueActionSchema>;

// Naming Type Exports
export type NamingPresetCreate = z.infer<typeof namingPresetCreateSchema>;
export type NamingPresetUpdate = z.infer<typeof namingPresetUpdateSchema>;
export type NamingPreview = z.infer<typeof namingPreviewSchema>;
export type NamingValidate = z.infer<typeof namingValidateSchema>;

// User Type Exports
export type UserLanguage = z.infer<typeof userLanguageSchema>;

// Unmatched Type Exports
export type UnmatchedMatch = z.infer<typeof unmatchedMatchSchema>;
export type UnmatchedDelete = z.infer<typeof unmatchedDeleteSchema>;
export type UnmatchedSingleMatch = z.infer<typeof unmatchedSingleMatchSchema>;

// Streaming Type Exports
export type StreamingStatusAction = z.infer<typeof streamingStatusActionSchema>;
export type StrmUpdate = z.infer<typeof strmUpdateSchema>;

// Backup Type Exports
export type BackupExport = z.infer<typeof backupExportSchema>;
export type BackupImport = z.infer<typeof backupImportSchema>;

// Manual Import Type Exports
export type ManualImportRequest = z.infer<typeof manualImportSchema>;
export type AddMovieRequest = z.infer<typeof addMovieSchema>;
export type AddSeriesRequest = z.infer<typeof addSeriesSchema>;
export type BulkAddMoviesRequest = z.infer<typeof bulkAddMoviesSchema>;
export type BulkAddSeriesRequest = z.infer<typeof bulkAddSeriesSchema>;

// Library Classification & Delete Type Exports
export type LibraryClassificationUpdate = z.infer<typeof libraryClassificationUpdateSchema>;
export type LibraryDeleteRequest = z.infer<typeof libraryDeleteSchema>;

// Smart List Type Exports
export type SmartListCreateRequest = z.infer<typeof smartListCreateSchema>;
export type SmartListPreviewRequest = z.infer<typeof smartListPreviewSchema>;
export type SmartListExternalPreviewRequest = z.infer<typeof smartListExternalPreviewSchema>;
export type SmartListItemsAction = z.infer<typeof smartListItemsActionSchema>;

// Monitoring & Captcha Type Exports
export type MonitoringSettingsUpdate = z.infer<typeof monitoringSettingsUpdateSchema>;
export type CaptchaSolverSettingsUpdate = z.infer<typeof captchaSolverSettingsUpdateSchema>;
export type CaptchaSolverTestRequest = z.infer<typeof captchaSolverTestSchema>;

// Custom Format Test Type Export
export type CustomFormatTestRequest = z.infer<typeof customFormatTestSchema>;

// ============================================================
// Calendar Preferences Schema
// ============================================================

export const calendarPreferencesSchema = z.object({
	contentType: z.enum(['all', 'movies', 'episodes']).default('all'),
	libraryOnly: z.boolean().default(false),
	upcomingShowNonLibrary: z.boolean().default(true),
	viewMode: z.enum(['grid', 'list']).default('grid'),
	minRating: z.number().min(0).max(10).default(0),
	genreIds: z.array(z.number()).default([]),
	excludeAdult: z.boolean().default(false),
	certifications: z.array(z.string()).default([])
});
export type CalendarPreferences = z.infer<typeof calendarPreferencesSchema>;

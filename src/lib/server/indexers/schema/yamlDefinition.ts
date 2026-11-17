/**
 * YAML Indexer Definition Schema
 *
 * Schema for YAML-based indexer definitions. Compatible with Prowlarr/Jackett
 * definition format for community portability.
 *
 * Extended to support all protocols:
 * - Torrent: Standard HTTP-based torrent indexers
 * - Usenet: Newznab/Spotweb indexers for NZB files
 * - Streaming: Internal library streaming (database queries)
 */

import { z } from 'zod';

// ============================================================================
// Filter Block
// ============================================================================

export const filterBlockSchema = z.object({
	name: z.string(),
	args: z
		.union([
			z.string(),
			z.number(),
			z.array(z.union([z.string(), z.number()])) // Array can contain strings or numbers
		])
		.optional()
});

export type FilterBlock = z.infer<typeof filterBlockSchema>;

// ============================================================================
// Selector Block
// ============================================================================

export const selectorBlockSchema = z.object({
	selector: z.string().optional(),
	optional: z.boolean().optional(),
	default: z.union([z.string(), z.number()]).optional(), // Can be string or number (e.g., default: 0)
	text: z.union([z.string(), z.number()]).optional(), // Can be string or number (e.g., text: 0)
	attribute: z.string().optional(),
	remove: z.string().optional(),
	filters: z.array(filterBlockSchema).optional(),
	case: z.record(z.string(), z.string()).optional()
});

export type SelectorBlock = z.infer<typeof selectorBlockSchema>;

// ============================================================================
// Indexer Features
// ============================================================================

/**
 * Behaviour a definition opts into, so the runtime never has to recognise a
 * tracker by its name or base URL. Name/host matching breaks behind Prowlarr or
 * Jackett (the base URL is the proxy's) and for any renamed mirror or instance.
 */
export const indexerFeaturesSchema = z.object({
	/**
	 * Season packs are living topics: the author re-creates the torrent as
	 * episodes air, so a pack holding "1..K of N" is complete for an ongoing
	 * season, and a pack grab should select every wanted episode inside it.
	 */
	livingSeasonPacks: z.boolean().optional(),
	/**
	 * Download links are forum endpoints (`/viewtopic.php`, `/dl.php?t=<id>`):
	 * normalise those paths and fetch the details page first, because the bare
	 * download link is transient.
	 */
	forumDownloadLinks: z.boolean().optional()
});

export type IndexerFeatures = z.infer<typeof indexerFeaturesSchema>;

// ============================================================================
// Settings Field
// ============================================================================

export const settingsFieldSchema = z.object({
	name: z.string(),
	type: z.enum([
		'text',
		'password',
		'checkbox',
		'select',
		'info',
		'info_cookie',
		'info_cloudflare',
		'info_flaresolverr', // Prowlarr's name for Cloudflare/FlareSolverr warning
		'info_useragent',
		'info_category_8000',
		'cardigannCaptcha'
	]),
	label: z.string().optional(), // Optional for info_* types which often lack labels
	default: z.union([z.string(), z.boolean(), z.number()]).optional(),
	required: z.boolean().optional(),
	defaults: z.array(z.string()).optional(),
	options: z.record(z.string(), z.string()).optional()
});

export type SettingsField = z.infer<typeof settingsFieldSchema>;

// ============================================================================
// Category Mapping
// ============================================================================

export const categoryMappingSchema = z.object({
	id: z.union([z.string(), z.number()]).transform((v) => String(v)), // Prowlarr uses numeric IDs, coerce to string
	cat: z.string().optional(),
	desc: z.string().optional(),
	default: z.boolean().optional()
});

export type CategoryMapping = z.infer<typeof categoryMappingSchema>;

// ============================================================================
// Protocol Configuration Blocks
// ============================================================================

/**
 * Torrent protocol-specific configuration
 */
export const torrentProtocolConfigSchema = z.object({
	supportsMagnet: z.boolean().optional().default(true),
	supportsInfoHash: z.boolean().optional().default(true),
	// Freeleech detection patterns
	freeleechPatterns: z.array(z.string()).optional(),
	// Internal release detection patterns
	internalPatterns: z.array(z.string()).optional()
});

export type TorrentProtocolConfig = z.infer<typeof torrentProtocolConfigSchema>;

/**
 * Usenet protocol-specific configuration
 */
export const usenetProtocolConfigSchema = z.object({
	apiType: z.enum(['newznab', 'spotweb', 'custom']).optional().default('newznab'),
	supportsCategories: z.boolean().optional().default(true),
	defaultApiPath: z.string().optional().default('/api'),
	// Extended Newznab attributes to extract
	extendedAttributes: z
		.array(
			z.object({
				name: z.string(),
				attribute: z.string()
			})
		)
		.optional()
});

export type UsenetProtocolConfig = z.infer<typeof usenetProtocolConfigSchema>;

/**
 * Streaming protocol-specific configuration
 */
export const streamingProtocolConfigSchema = z.object({
	// 'internal' queries local library database, 'external' uses HTTP
	type: z.enum(['internal', 'external']).optional().default('external'),
	// Data source: 'database' for internal library, 'http' for external APIs
	dataSource: z.enum(['database', 'http']).optional().default('http'),
	// Available quality tiers
	qualityTiers: z.array(z.string()).optional().default(['4k', '1080p', '720p', '480p']),
	// Streaming provider definitions
	providers: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				enabled: z.boolean().optional().default(true),
				supportsMovies: z.boolean().optional().default(true),
				supportsTv: z.boolean().optional().default(true)
			})
		)
		.optional()
});

export type StreamingProtocolConfig = z.infer<typeof streamingProtocolConfigSchema>;

/**
 * Combined protocol configuration - only one should be present based on protocol type
 */
export const protocolConfigSchema = z.object({
	torrent: torrentProtocolConfigSchema.optional(),
	usenet: usenetProtocolConfigSchema.optional(),
	streaming: streamingProtocolConfigSchema.optional()
});

export type ProtocolConfig = z.infer<typeof protocolConfigSchema>;

// ============================================================================
// Capabilities Block
// ============================================================================

/**
 * Episode format types for search.
 * - standard: S01E05 (most common)
 * - european: 1x05 (used by some European trackers)
 * - compact: 105 (season + episode as single number)
 * - daily: 2024.01.15 (for daily shows)
 * - absolute: 125 (absolute episode number, for anime)
 */
export const episodeFormatTypeSchema = z.enum([
	'standard',
	'european',
	'compact',
	'daily',
	'absolute'
]);

/**
 * Movie format types for search.
 */
export const movieFormatTypeSchema = z.enum(['standard', 'yearOnly', 'noYear']);

/**
 * Search format configuration for an indexer.
 */
export const searchFormatsSchema = z
	.object({
		/** Episode format preferences, in order of preference */
		episode: z.array(episodeFormatTypeSchema).optional(),
		/** Movie format preferences */
		movie: z.array(movieFormatTypeSchema).optional()
	})
	.optional();

export const capabilitiesBlockSchema = z.object({
	categories: z.record(z.string(), z.string()).optional(),
	categorymappings: z.array(categoryMappingSchema).optional(),
	modes: z.record(z.string(), z.array(z.string())).optional(),
	allowrawsearch: z.boolean().optional(),
	/**
	 * Search format preferences for this indexer.
	 * Specifies which episode/movie formats the indexer expects.
	 */
	searchFormats: searchFormatsSchema
});

export type CapabilitiesBlock = z.infer<typeof capabilitiesBlockSchema>;

// ============================================================================
// Captcha Block
// ============================================================================

export const captchaBlockSchema = z.object({
	type: z.string().optional(),
	selector: z.string().optional(),
	input: z.string().optional()
});

export type CaptchaBlock = z.infer<typeof captchaBlockSchema>;

// ============================================================================
// Error Block
// ============================================================================

export const errorBlockSchema = z.object({
	path: z.string().optional(),
	selector: z.string().optional(),
	message: selectorBlockSchema.optional()
});

export type ErrorBlock = z.infer<typeof errorBlockSchema>;

// ============================================================================
// Page Test Block
// ============================================================================

export const pageTestBlockSchema = z.object({
	path: z.string().optional(),
	selector: z.string().optional()
});

export type PageTestBlock = z.infer<typeof pageTestBlockSchema>;

// ============================================================================
// Login Block
// ============================================================================

/**
 * API Key authentication configuration
 */
export const apiKeyAuthSchema = z.object({
	// Where to send the API key: header, query parameter, or both
	location: z.enum(['header', 'query', 'both']).optional().default('query'),
	// Header name if using header location (default: X-Api-Key)
	headerName: z.string().optional().default('X-Api-Key'),
	// Query parameter name if using query location (default: apikey)
	queryParam: z.string().optional().default('apikey'),
	// Prefix for the header value (e.g., 'Bearer ')
	prefix: z.string().optional(),
	// Source template for the API key value (e.g., '{{ .Config.apikey }}')
	source: z.string().optional()
});

export type ApiKeyAuth = z.infer<typeof apiKeyAuthSchema>;

/**
 * Passkey authentication configuration (URL-embedded keys)
 */
export const passkeyAuthSchema = z.object({
	// URL template containing the passkey (e.g., '/torrents/rss/{{ .Config.passkey }}')
	urlTemplate: z.string().optional()
});

export type PasskeyAuth = z.infer<typeof passkeyAuthSchema>;

/**
 * Basic HTTP authentication configuration
 */
export const basicAuthSchema = z.object({
	// Username source template
	username: z.string().optional(),
	// Password source template
	password: z.string().optional()
});

export type BasicAuth = z.infer<typeof basicAuthSchema>;

export const loginBlockSchema = z.object({
	path: z.string().optional(),
	submitpath: z.string().optional(),
	cookies: z.array(z.string()).optional(),
	// Extended method options including apikey, basic, passkey, none
	method: z
		.enum(['post', 'form', 'cookie', 'get', 'oneurl', 'apikey', 'basic', 'passkey', 'none'])
		.optional(),
	form: z.string().optional(),
	selectors: z.boolean().optional(),
	inputs: z.record(z.string(), z.string()).optional(),
	selectorinputs: z.record(z.string(), selectorBlockSchema).optional(),
	getselectorinputs: z.record(z.string(), selectorBlockSchema).optional(),
	error: z.array(errorBlockSchema).optional(),
	test: pageTestBlockSchema.optional(),
	captcha: captchaBlockSchema.optional(),
	headers: z.record(z.string(), z.array(z.string())).optional(),
	// Extended auth method configurations
	apikey: apiKeyAuthSchema.optional(),
	passkey: passkeyAuthSchema.optional(),
	basic: basicAuthSchema.optional()
});

export type LoginBlock = z.infer<typeof loginBlockSchema>;

// ============================================================================
// Ratio Block
// ============================================================================

export const ratioBlockSchema = selectorBlockSchema.extend({
	path: z.string().optional()
});

export type RatioBlock = z.infer<typeof ratioBlockSchema>;

// ============================================================================
// Request Block
// ============================================================================

// Input values can be strings, numbers, or booleans in YAML - coerce all to strings
const inputValueSchema = z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v));

export const requestBlockSchema = z.object({
	path: z.string().optional(),
	method: z.string().optional(),
	inputs: z.record(z.string(), inputValueSchema).optional(),
	queryseparator: z.string().optional()
});

export type RequestBlock = z.infer<typeof requestBlockSchema>;

// ============================================================================
// Response Block
// ============================================================================

export const responseBlockSchema = z.object({
	type: z.enum(['json', 'html', 'xml']).optional(),
	noResultsMessage: z.string().optional()
});

export type ResponseBlock = z.infer<typeof responseBlockSchema>;

// ============================================================================
// Search Path Block
// ============================================================================

export const searchPathBlockSchema = requestBlockSchema.extend({
	categories: z.array(z.string()).optional(),
	inheritinputs: z.boolean().optional(),
	followredirect: z.boolean().optional(),
	response: responseBlockSchema.optional()
});

export type SearchPathBlock = z.infer<typeof searchPathBlockSchema>;

// ============================================================================
// Rows Block
// ============================================================================

export const rowsBlockSchema = selectorBlockSchema.extend({
	after: z.number().optional(),
	dateheaders: selectorBlockSchema.optional(),
	count: selectorBlockSchema.optional(),
	// Can be boolean or string - string specifies nested field to iterate over
	multiple: z.union([z.boolean(), z.string()]).optional(),
	missingAttributeEqualsNoResults: z.boolean().optional()
});

export type RowsBlock = z.infer<typeof rowsBlockSchema>;

// ============================================================================
// Field Definition
// Used in search.fields - can be either a SelectorBlock or a simple string
// ============================================================================

export const fieldDefinitionSchema = z.union([selectorBlockSchema, z.string()]);

export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;

// ============================================================================
// Database Query Block (for internal streaming indexer)
// ============================================================================

/**
 * Database query condition for WHERE clauses
 */
export const queryConditionSchema = z.object({
	// Field name in the database table
	field: z.string(),
	// Comparison operator
	operator: z
		.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'notnull'])
		.optional()
		.default('eq'),
	// Value (can use template variables like '{{ .Query.TMDBID }}')
	value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
	// If true, condition is only applied when value is non-empty
	optional: z.boolean().optional().default(false)
});

export type QueryCondition = z.infer<typeof queryConditionSchema>;

/**
 * Database join configuration
 */
export const queryJoinSchema = z.object({
	// Table to join
	table: z.string(),
	// Join condition (e.g., 'movies.id = streams.movieId')
	on: z.string(),
	// Join type
	type: z.enum(['inner', 'left', 'right']).optional().default('inner')
});

export type QueryJoin = z.infer<typeof queryJoinSchema>;

/**
 * Output field mapping for database results
 */
export const outputMappingSchema = z.object({
	// Maps to ReleaseResult.guid
	guid: z.string(),
	// Maps to ReleaseResult.title
	title: z.string(),
	// Maps to ReleaseResult.downloadUrl (for streaming: 'stream://movie/{tmdbId}')
	downloadUrl: z.string(),
	// Maps to ReleaseResult.size (can be fixed or template)
	size: z.union([z.string(), z.number()]).optional(),
	// Maps to ReleaseResult.publishDate
	publishDate: z.string().optional(),
	// Maps to ReleaseResult.commentsUrl
	commentsUrl: z.string().optional(),
	// Streaming-specific: quality tier
	quality: z.string().optional(),
	// Streaming-specific: provider ID
	provider: z.string().optional()
});

export type OutputMapping = z.infer<typeof outputMappingSchema>;

/**
 * Database query definition for internal indexers (streaming)
 */
export const databaseQuerySchema = z.object({
	// Primary table to query
	table: z.string(),
	// Optional joins
	join: z.union([queryJoinSchema, z.array(queryJoinSchema)]).optional(),
	// WHERE conditions
	conditions: z.array(queryConditionSchema).optional(),
	// Output mapping - how to transform DB rows to ReleaseResult
	outputMapping: outputMappingSchema,
	// Content type this query handles
	contentType: z.enum(['movie', 'tv', 'episode']).optional()
});

export type DatabaseQuery = z.infer<typeof databaseQuerySchema>;

// ============================================================================
// Search Block
// ============================================================================

export const searchBlockSchema = z.object({
	// Search type: 'http' for external requests, 'database' for internal queries
	type: z.enum(['http', 'database']).optional().default('http'),

	// HTTP search configuration (original fields)
	path: z.string().optional(),
	paths: z.array(searchPathBlockSchema).optional(),
	headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
	keywordsfilters: z.array(filterBlockSchema).optional(),
	allowEmptyInputs: z.boolean().optional(),
	inputs: z.record(z.string(), inputValueSchema).optional(),
	error: z.array(errorBlockSchema).optional(),
	preprocessingfilters: z.array(filterBlockSchema).optional(),
	rows: rowsBlockSchema.optional(),
	fields: z.record(z.string(), fieldDefinitionSchema).optional(),
	response: responseBlockSchema.optional(),

	// Database query configuration (for streaming protocol with dataSource: 'database')
	movieQuery: databaseQuerySchema.optional(),
	tvQuery: databaseQuerySchema.optional(),
	episodeQuery: databaseQuerySchema.optional()
});

export type SearchBlock = z.infer<typeof searchBlockSchema>;

// ============================================================================
// Selector Field (for download)
// ============================================================================

export const selectorFieldSchema = z.object({
	selector: z.string().optional(),
	attribute: z.string().optional(),
	usebeforeresponse: z.boolean().optional(),
	filters: z.array(filterBlockSchema).optional()
});

export type SelectorField = z.infer<typeof selectorFieldSchema>;

// ============================================================================
// Before Block
// ============================================================================

export const beforeBlockSchema = requestBlockSchema.extend({
	pathselector: selectorFieldSchema.optional()
});

export type BeforeBlock = z.infer<typeof beforeBlockSchema>;

// ============================================================================
// Infohash Block
// ============================================================================

export const infohashBlockSchema = z.object({
	hash: selectorFieldSchema.optional(),
	title: selectorFieldSchema.optional(),
	usebeforeresponse: z.boolean().optional()
});

export type InfohashBlock = z.infer<typeof infohashBlockSchema>;

// ============================================================================
// Download Variable (for extracting dynamic values from details page)
// ============================================================================

export const downloadVariableSchema = selectorFieldSchema.extend({
	name: z.string()
});

export type DownloadVariable = z.infer<typeof downloadVariableSchema>;

// ============================================================================
// Download Block
// ============================================================================

export const downloadBlockSchema = z.object({
	selectors: z.array(selectorFieldSchema).optional(),
	method: z.string().optional(),
	before: beforeBlockSchema.optional(),
	infohash: infohashBlockSchema.optional(),
	headers: z.record(z.string(), z.array(z.string())).optional(),
	downloadVariables: z.array(downloadVariableSchema).optional(),
	downloadVariablesFrom: z.enum(['details', 'search']).optional()
});

export type DownloadBlock = z.infer<typeof downloadBlockSchema>;

// ============================================================================
// YAML Definition (Root Schema)
// ============================================================================

export const yamlDefinitionSchema = z.object({
	// Metadata
	id: z.string(),
	// Indexer IDs this definition replaces (for migration purposes)
	replaces: z.array(z.string()).optional(),
	name: z.string(),
	description: z.string().optional(),
	type: z.enum(['public', 'semi-private', 'private']).default('public'),
	language: z.string().optional(),
	encoding: z.string().default('UTF-8'),
	// Protocol type: torrent, usenet, or streaming
	protocol: z.enum(['torrent', 'usenet', 'streaming']).default('torrent'),
	requestdelay: z.number().optional(),
	/** Per-request HTTP timeout in ms. Overrides the default 30-second timeout. */
	requesttimeout: z.number().optional(),

	// Auto-managed / not user-addable. When true, the definition is hidden
	// from the indexers-page picker and is seeded by a subsystem module
	// (e.g. CinephageAPI library-streaming owns cinephage-stream). The
	// resulting indexer row is marked isBuiltIn and protected from delete/edit.
	internal: z.boolean().optional().default(false),

	// URLs
	links: z.array(z.string()),
	legacylinks: z.array(z.string()).optional(),

	// Behavior
	followredirect: z.boolean().optional(),
	testlinktorrent: z.boolean().optional(),
	certificates: z.array(z.string()).optional(),

	// Protocol-specific configuration
	protocolConfig: protocolConfigSchema.optional(),

	// User settings
	settings: z.array(settingsFieldSchema).optional(),

	// Capabilities
	features: indexerFeaturesSchema.optional(),
	caps: capabilitiesBlockSchema,

	// Authentication
	login: loginBlockSchema.optional(),

	// Ratio tracking
	ratio: ratioBlockSchema.optional(),

	// Search configuration
	search: searchBlockSchema,

	// Download configuration
	download: downloadBlockSchema.optional()
});

export type YamlDefinition = z.infer<typeof yamlDefinitionSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

export type SafeParseResult =
	{ success: true; data: YamlDefinition } | { success: false; error: z.ZodError };

export function validateYamlDefinition(data: unknown): YamlDefinition {
	return yamlDefinitionSchema.parse(data);
}

export function safeValidateYamlDefinition(data: unknown): SafeParseResult {
	return yamlDefinitionSchema.safeParse(data);
}

export function formatValidationError(error: z.ZodError): string {
	return error.issues
		.map((e) => {
			const path = e.path.join('.');
			return path ? `${path}: ${e.message}` : e.message;
		})
		.join('; ');
}

// ============================================================================
// Standard Newznab Categories
// ============================================================================

export const NEWZNAB_CATEGORIES: Record<string, { id: number; name: string }> = {
	// Console
	Console: { id: 1000, name: 'Console' },
	'Console/NDS': { id: 1010, name: 'Console/NDS' },
	'Console/PSP': { id: 1020, name: 'Console/PSP' },
	'Console/Wii': { id: 1030, name: 'Console/Wii' },
	'Console/Xbox': { id: 1040, name: 'Console/Xbox' },
	'Console/Xbox 360': { id: 1050, name: 'Console/Xbox 360' },
	'Console/Wiiware': { id: 1060, name: 'Console/Wiiware' },
	'Console/Xbox 360 DLC': { id: 1070, name: 'Console/Xbox 360 DLC' },
	'Console/PS3': { id: 1080, name: 'Console/PS3' },
	'Console/Other': { id: 1090, name: 'Console/Other' },
	'Console/3DS': { id: 1110, name: 'Console/3DS' },
	'Console/PS Vita': { id: 1120, name: 'Console/PS Vita' },
	'Console/WiiU': { id: 1130, name: 'Console/WiiU' },
	'Console/Xbox One': { id: 1140, name: 'Console/Xbox One' },
	'Console/PS4': { id: 1180, name: 'Console/PS4' },

	// Movies
	Movies: { id: 2000, name: 'Movies' },
	'Movies/Foreign': { id: 2010, name: 'Movies/Foreign' },
	'Movies/Other': { id: 2020, name: 'Movies/Other' },
	'Movies/SD': { id: 2030, name: 'Movies/SD' },
	'Movies/HD': { id: 2040, name: 'Movies/HD' },
	'Movies/UHD': { id: 2045, name: 'Movies/UHD' },
	'Movies/BluRay': { id: 2050, name: 'Movies/BluRay' },
	'Movies/3D': { id: 2060, name: 'Movies/3D' },
	'Movies/DVD': { id: 2070, name: 'Movies/DVD' },
	'Movies/WEB-DL': { id: 2080, name: 'Movies/WEB-DL' },

	// Audio
	Audio: { id: 3000, name: 'Audio' },
	'Audio/MP3': { id: 3010, name: 'Audio/MP3' },
	'Audio/Video': { id: 3020, name: 'Audio/Video' },
	'Audio/Audiobook': { id: 3030, name: 'Audio/Audiobook' },
	'Audio/Lossless': { id: 3040, name: 'Audio/Lossless' },
	'Audio/Other': { id: 3050, name: 'Audio/Other' },
	'Audio/Foreign': { id: 3060, name: 'Audio/Foreign' },

	// PC
	PC: { id: 4000, name: 'PC' },
	'PC/0day': { id: 4010, name: 'PC/0day' },
	'PC/ISO': { id: 4020, name: 'PC/ISO' },
	'PC/Mac': { id: 4030, name: 'PC/Mac' },
	'PC/Mobile-Other': { id: 4040, name: 'PC/Mobile-Other' },
	'PC/Games': { id: 4050, name: 'PC/Games' },
	'PC/Mobile-iOS': { id: 4060, name: 'PC/Mobile-iOS' },
	'PC/Mobile-Android': { id: 4070, name: 'PC/Mobile-Android' },

	// TV
	TV: { id: 5000, name: 'TV' },
	'TV/WEB-DL': { id: 5010, name: 'TV/WEB-DL' },
	'TV/Foreign': { id: 5020, name: 'TV/Foreign' },
	'TV/SD': { id: 5030, name: 'TV/SD' },
	'TV/HD': { id: 5040, name: 'TV/HD' },
	'TV/UHD': { id: 5045, name: 'TV/UHD' },
	'TV/Other': { id: 5050, name: 'TV/Other' },
	'TV/Sport': { id: 5060, name: 'TV/Sport' },
	'TV/Anime': { id: 5070, name: 'TV/Anime' },
	'TV/Documentary': { id: 5080, name: 'TV/Documentary' },

	// XXX
	XXX: { id: 6000, name: 'XXX' },
	'XXX/DVD': { id: 6010, name: 'XXX/DVD' },
	'XXX/WMV': { id: 6020, name: 'XXX/WMV' },
	'XXX/XviD': { id: 6030, name: 'XXX/XviD' },
	'XXX/x264': { id: 6040, name: 'XXX/x264' },
	'XXX/UHD': { id: 6045, name: 'XXX/UHD' },
	'XXX/Pack': { id: 6050, name: 'XXX/Pack' },
	'XXX/ImageSet': { id: 6060, name: 'XXX/ImageSet' },
	'XXX/Other': { id: 6070, name: 'XXX/Other' },
	'XXX/SD': { id: 6080, name: 'XXX/SD' },
	'XXX/WEB-DL': { id: 6090, name: 'XXX/WEB-DL' },

	// Books
	Books: { id: 7000, name: 'Books' },
	'Books/Mags': { id: 7010, name: 'Books/Mags' },
	'Books/EBook': { id: 7020, name: 'Books/EBook' },
	'Books/Comics': { id: 7030, name: 'Books/Comics' },
	'Books/Technical': { id: 7040, name: 'Books/Technical' },
	'Books/Other': { id: 7050, name: 'Books/Other' },
	'Books/Foreign': { id: 7060, name: 'Books/Foreign' },

	// Other
	Other: { id: 8000, name: 'Other' },
	'Other/Misc': { id: 8010, name: 'Other/Misc' },
	'Other/Hashed': { id: 8020, name: 'Other/Hashed' }
};

export function getCategoryByName(name: string): { id: number; name: string } | null {
	return NEWZNAB_CATEGORIES[name] ?? null;
}

export function getCategoryById(id: number): { id: number; name: string } | null {
	for (const cat of Object.values(NEWZNAB_CATEGORIES)) {
		if (cat.id === id) return cat;
	}
	return null;
}

/**
 * Resolve a category value (numeric ID string or name like "Movies/Foreign")
 * to a Newznab numeric ID.
 *
 * This function handles both:
 * - Numeric strings: "2010" -> 2010
 * - Category names: "Movies/Foreign" -> 2010
 *
 * @param cat - The category value from YAML (can be numeric string or category name)
 * @returns The Newznab numeric category ID, or 8000 (Other) if not found
 */
export function resolveCategoryId(cat: string | undefined): number {
	if (!cat) return 8000; // Default to "Other"

	// If already numeric, parse directly
	if (/^\d+$/.test(cat)) {
		return parseInt(cat, 10);
	}

	// Look up by name in NEWZNAB_CATEGORIES
	const info = NEWZNAB_CATEGORIES[cat];
	return info?.id ?? 8000;
}

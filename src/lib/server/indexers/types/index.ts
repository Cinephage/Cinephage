/**
 * Unified Indexer Types
 *
 * This module provides the canonical type definitions for the indexer system.
 * All indexer-related code should import types from this module.
 *
 * Structure:
 * - protocol.ts: Protocol types (torrent, usenet, streaming) and settings
 * - auth.ts: Authentication methods and configurations
 * - accessType.ts: Access/privacy levels (public, semi-private, private)
 * - category.ts: Newznab-compatible categories
 * - definition.ts: Indexer definition structure (blueprints)
 * - config.ts: Indexer configuration (user instances)
 * - release.ts: Search result types
 * - search.ts: Search criteria types
 * - interfaces.ts: Core interfaces for indexer implementations
 */

// =============================================================================
// PROTOCOL TYPES
// =============================================================================
export {
	// Types
	type IndexerProtocol,
	type TorrentProtocolSettings,
	type UsenetProtocolSettings,
	type StreamingProtocolSettings,
	type ProtocolSettings,
	type TorrentResultFields,
	type UsenetResultFields,
	type StreamingResultFields,
	// Constants
	IndexerProtocols,
	ALL_PROTOCOLS,
	// Functions
	createDefaultTorrentSettings,
	createDefaultUsenetSettings,
	createDefaultStreamingSettings,
	getDefaultProtocolSettings,
	isTorrentSettings,
	isUsenetSettings,
	isStreamingSettings,
	isValidProtocol
} from './protocol';

// =============================================================================
// AUTHENTICATION TYPES
// =============================================================================
export {
	// Types
	type AuthMethod,
	type BaseAuthConfig,
	type NoAuthConfig,
	type CookieAuthConfig,
	type ApiKeyAuthConfig,
	type FormAuthConfig,
	type PasskeyAuthConfig,
	type BasicAuthConfig,
	type AuthConfig,
	type AuthState,
	type StoredAuthSession,
	type AuthResult,
	type AuthTestResult,
	// Definition-level auth configs
	type DefinitionAuthConfigBase,
	type DefinitionCookieAuthConfig,
	type DefinitionApiKeyAuthConfig,
	type DefinitionPasskeyAuthConfig,
	type DefinitionFormAuthConfig,
	type DefinitionAuthConfig,
	// Constants
	AuthMethods,
	ALL_AUTH_METHODS,
	// Functions
	isCookieAuth,
	isApiKeyAuth,
	isFormAuth,
	isPasskeyAuth,
	isBasicAuth,
	isNoAuth,
	requiresCredentials,
	isValidAuthMethod,
	createNoAuthConfig,
	createCookieAuthConfig,
	createApiKeyAuthConfig,
	createFormAuthConfig,
	createPasskeyAuthConfig,
	createBasicAuthConfig,
	settingsToAuthConfig,
	parseCookieString,
	serializeCookies
} from './auth';

// =============================================================================
// ACCESS TYPE
// =============================================================================
export {
	// Types
	type IndexerAccessType,
	// Constants
	IndexerAccessTypes,
	ALL_ACCESS_TYPES,
	// Functions
	requiresAuthentication,
	isRestricted,
	isValidAccessType,
	getAccessTypeLabel,
	getAccessTypeDescription
} from './accessType';

// =============================================================================
// CATEGORY TYPES
// =============================================================================
export {
	// Types
	Category,
	type ContentType,
	type CategoryMapping,
	type SearchTypeCategory,
	// Constants
	MOVIE_CATEGORIES,
	TV_CATEGORIES,
	AUDIO_CATEGORIES,
	BOOK_CATEGORIES,
	PC_CATEGORIES,
	CONSOLE_CATEGORIES,
	XXX_CATEGORIES,
	// Functions
	isMovieCategory,
	isTvCategory,
	isAudioCategory,
	isBookCategory,
	isPcCategory,
	isConsoleCategory,
	isXxxCategory,
	getCategoryContentType,
	getCategoriesForContentType,
	expandCategoriesForClassification,
	getCategoryName,
	buildCategoryMap,
	hasCategoriesForContentType,
	// Legacy compatibility functions
	getCategoriesForSearchType,
	categoryMatchesSearchType,
	indexerHasCategoriesForSearchType,
	restrictionAllowsSearchType
} from './category';

// =============================================================================
// DEFINITION TYPES
// =============================================================================
export {
	// Types
	type SettingFieldType,
	type SettingField,
	type SearchParam,
	type SearchMode,
	type IndexerCapabilities,
	type EpisodeFormatType,
	type MovieFormatType,
	type SearchFormats,
	type DefinitionSource,
	type BaseIndexerDefinition,
	type NativeIndexerDefinition,
	type YamlIndexerDefinition,
	type IndexerDefinition,
	type YamlLoginConfig,
	type YamlSearchConfig,
	type YamlSearchPath,
	type YamlFieldSelector,
	type DefinitionUIHints,
	// Functions
	isNativeDefinition,
	isYamlDefinition,
	computeDefinitionUIHints,
	createDefaultCapabilities,
	// Capability utilities
	getSearchMode,
	supportsParam,
	supportsMovieIdSearch,
	supportsTvIdSearch,
	canHandleSearchType
} from './definition';

// =============================================================================
// CONFIG TYPES
// =============================================================================
export {
	// Types
	type IndexerConfig,
	type CreateIndexerData,
	type UpdateIndexerData,
	type HealthStatus,
	type IndexerStatus,
	type IndexerStatusSnapshot,
	type IndexerWithStatus,
	type IndexerFilters,
	type IndexerSort,
	// Functions
	convertLegacyConfig,
	convertToFlatConfig
} from './config';

// =============================================================================
// RELEASE TYPES
// =============================================================================
export {
	// Types
	type ReleaseResult,
	type ParsedRelease,
	type QualityScore,
	type EnhancedReleaseResult,
	type EpisodeInfo,
	type IndexerSearchResult,
	type RejectedIndexer,
	type SearchResult,
	type EnhancedSearchResult,
	type ReleaseInfo,
	// Functions
	toReleaseInfo,
	hasDownloadInfo,
	getBestDownloadUrl,
	formatSize,
	parseSize,
	normalizeReleaseResult,
	// Episode info helpers
	getEpisodeInfo,
	isSeasonPack,
	releaseContainsSeason
} from './release';

// =============================================================================
// SEARCH TYPES
// =============================================================================
export {
	// Types
	type SearchType,
	type BaseSearchCriteria,
	type MovieSearchCriteria,
	type TvSearchCriteria,
	type MusicSearchCriteria,
	type BookSearchCriteria,
	type BasicSearchCriteria,
	type SearchCriteria,
	// Functions
	isMovieSearch,
	isTvSearch,
	isMusicSearch,
	isBookSearch,
	isBasicSearch,
	hasSearchableIds,
	createTextOnlyCriteria,
	createIdOnlyCriteria,
	criteriaToString,
	createMovieSearchCriteria,
	createTvSearchCriteria,
	createBasicSearchCriteria,
	// Episode token helpers (legacy - prefer SearchFormatProvider for new code)
	generateEpisodeTokenFormats,
	/**
	 * @deprecated Use SearchFormatProvider and preferredEpisodeFormat instead.
	 * Episode token composition is now handled by TemplateEngine.
	 */
	queryContainsEpisodeToken,
	/**
	 * @deprecated Use SearchFormatProvider and preferredEpisodeFormat instead.
	 * Episode token composition is now handled by TemplateEngine.
	 */
	keywordsContainEpisodeToken
} from './search';

// =============================================================================
// INTERFACE TYPES
// =============================================================================
export {
	// Types
	type IIndexer,
	type DownloadTorrentOptions,
	type IndexerDownloadResult,
	type IndexerRequest,
	type IIndexerRequestGenerator,
	type IIndexerResponseParser,
	type IHttpIndexer,
	type ITorrentIndexer,
	type IUsenetIndexer,
	type IStreamingIndexer,
	type IIndexerFactory
} from './interfaces';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Definition ID for the internal Cinephage Stream indexer */
export const CINEPHAGE_STREAM_DEFINITION_ID = 'cinephage-stream';

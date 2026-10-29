/**
 * Live TV Types
 *
 * Type definitions for Live TV functionality supporting multiple provider types:
 * - Stalker Portal
 * - XStream Codes
 * - M3U Playlists
 */

export type LiveTvProviderType =
	'stalker' | 'xstream' | 'm3u' | 'cinephage-iptv' | 'cinephage-live';

// ============================================================================
// PROVIDER INTERFACE TYPES (for provider implementations)
// ============================================================================

/**
 * Authentication result from provider
 */
export interface AuthResult {
	success: boolean;
	token?: string;
	tokenExpiry?: Date;
	error?: string;
}

/**
 * Stream URL resolution result
 */
export interface StreamResolutionResult {
	success: boolean;
	url?: string;
	type: 'hls' | 'direct' | 'unknown';
	error?: string;
	/** Optional headers required for fetching the stream (e.g., cookies for Stalker portals) */
	headers?: Record<string, string>;
}

/**
 * Provider capabilities
 */
export interface ProviderCapabilities {
	supportsEpg: boolean;
	supportsArchive: boolean;
	supportsCategories: boolean;
	requiresAuthentication: boolean;
	streamUrlExpires: boolean;
}

/**
 * Live TV Provider Interface
 * All provider implementations must implement this interface.
 */
export interface LiveTvProvider {
	/** Provider type identifier */
	readonly type: LiveTvProviderType;

	/** Provider capabilities */
	readonly capabilities: ProviderCapabilities;

	/** Get provider name for display */
	getDisplayName(): string;

	/** Authenticate with the provider */
	authenticate(account: LiveTvAccount): Promise<AuthResult>;

	/** Test account connection without fully authenticating */
	testConnection(account: LiveTvAccount): Promise<LiveTvAccountTestResult>;

	/** Check if current authentication token is valid */
	isAuthenticated(account: LiveTvAccount): boolean;

	/** Sync channels and categories from provider */
	syncChannels(accountId: string): Promise<ChannelSyncResult>;

	/** Get categories from provider (for on-demand fetching) */
	fetchCategories(account: LiveTvAccount): Promise<LiveTvCategory[]>;

	/** Get channels from provider (for on-demand fetching) */
	fetchChannels(account: LiveTvAccount): Promise<LiveTvChannel[]>;

	/** Resolve stream URL for a channel */
	resolveStreamUrl(account: LiveTvAccount, channel: LiveTvChannel): Promise<StreamResolutionResult>;

	/** Get direct stream URL (for providers that have static URLs) */
	getDirectStreamUrl?(channel: LiveTvChannel): string | null;

	/** Check if provider has EPG support */
	hasEpgSupport(): boolean;

	/** Fetch EPG data from provider */
	fetchEpg?(account: LiveTvAccount, startTime: Date, endTime: Date): Promise<EpgProgram[]>;

	/** Check if provider supports archive/catch-up TV */
	supportsArchive(): boolean;

	/** Get archive stream URL for a time-shifted stream */
	getArchiveStreamUrl?(
		account: LiveTvAccount,
		channel: LiveTvChannel,
		startTime: Date,
		duration: number
	): Promise<StreamResolutionResult>;
}

// ============================================================================
// PROVIDER CONFIGURATION TYPES
// ============================================================================

/**
 * Stalker Portal configuration
 */
export interface StalkerConfig {
	portalUrl: string;
	macAddress: string;
	serialNumber?: string;
	deviceId?: string;
	deviceId2?: string;
	model?: string;
	timezone?: string;
	/** Portal UI language (stb_lang / Accept-Language), 2-letter code. Defaults to 'en'. */
	language?: string;
	token?: string;
	username?: string;
	password?: string;
	portalId?: string;
	discoveredFromScan?: boolean;
	streamUrlType?: 'direct' | 'create_link' | 'unknown';
	endpoint?: string;
}

/**
 * XStream Codes configuration
 */
export interface XstreamConfig {
	baseUrl: string;
	username: string;
	password: string;
	/** Optional XMLTV override (e.g. /xmltv.php?username=...&password=...) */
	epgUrl?: string;
	authToken?: string;
	tokenExpiry?: string;
	/** Output format for stream URLs: 'ts' (MPEG-TS), 'm3u8' (HLS), or 'mp4'. Defaults to 'ts'. */
	outputFormat?: 'ts' | 'm3u8' | 'mp4';
}

/**
 * M3U Playlist configuration
 */
export interface M3uConfig {
	url?: string;
	fileContent?: string;
	epgUrl?: string;
	refreshIntervalHours?: number;
	lastRefreshAt?: string;
	autoRefresh?: boolean;
	/** Custom headers to send when fetching the playlist and streams (e.g., auth tokens) */
	headers?: Record<string, string>;
	/** Custom User-Agent for playlist and stream requests */
	userAgent?: string;
}

// ============================================================================
// UNIFIED ACCOUNT TYPES
// ============================================================================

/**
 * Live TV Account - Unified provider account
 */
export interface LiveTvAccount {
	id: string;
	name: string;
	providerType: LiveTvProviderType;
	enabled: boolean;

	// Provider-specific configs (only one will be populated based on providerType)
	stalkerConfig?: StalkerConfig;
	xstreamConfig?: XstreamConfig;
	m3uConfig?: M3uConfig;
	cinephageIptvConfig?: CinephageIptvConfig;

	// Common metadata
	playbackLimit: number | null;
	channelCount: number | null;
	categoryCount: number | null;
	expiresAt: string | null;
	serverTimezone: string | null;

	// Health tracking
	lastTestedAt: string | null;
	lastTestSuccess: boolean | null;
	lastTestError: string | null;

	// Sync tracking
	lastSyncAt: string | null;
	lastSyncError: string | null;
	syncStatus: 'never' | 'syncing' | 'success' | 'failed';

	// EPG tracking
	lastEpgSyncAt: string | null;
	lastEpgSyncError: string | null;
	epgProgramCount: number;
	hasEpg: boolean | null;

	createdAt: string;
	updatedAt: string;
}

/**
 * Live TV Account Input - For creating/updating accounts
 */
export interface LiveTvAccountInput {
	name: string;
	providerType: LiveTvProviderType;
	enabled?: boolean;

	// Provider configs
	stalkerConfig?: StalkerConfig;
	xstreamConfig?: XstreamConfig;
	m3uConfig?: M3uConfig;
	cinephageIptvConfig?: CinephageIptvConfig;
}

/**
 * Live TV Account Update - Partial update
 */
export interface LiveTvAccountUpdate {
	name?: string;
	enabled?: boolean;

	// Provider configs (can update individual fields)
	stalkerConfig?: Partial<StalkerConfig>;
	xstreamConfig?: Partial<XstreamConfig>;
	m3uConfig?: Partial<M3uConfig>;
	cinephageIptvConfig?: Partial<CinephageIptvConfig>;
}

/**
 * Result of testing account connection
 */
export interface LiveTvAccountTestResult {
	success: boolean;
	error?: string;
	profile?: {
		playbackLimit: number;
		channelCount: number;
		categoryCount: number;
		expiresAt: string | null;
		serverTimezone: string;
		streamVerified: boolean;
		epg?: {
			status: 'not_configured' | 'reachable' | 'unreachable';
			source?: 'configured' | 'playlist-header';
			error?: string;
		};
	};
}

// ============================================================================
// PROVIDER DATA TYPES
// ============================================================================

/**
 * Stalker-specific channel data
 */
export interface StalkerChannelData {
	stalkerGenreId?: string;
	cmd: string;
	tvArchive: boolean;
	archiveDuration: number;
}

/**
 * XStream-specific channel data
 */
export interface XstreamChannelData {
	streamId: string;
	streamType: string;
	epgChannelId?: string;
	directStreamUrl?: string;
	containerExtension?: string;
}

/** Cinephage IPTV configuration */
export interface CinephageIptvConfig {
	countries?: string[];
	categories?: string[];
	languages?: string[];
	lastSyncAt?: string;
	autoSyncIntervalHours?: number;
	preferredQuality?: string | null;
}

/**
 * M3U-specific channel data
 */
export interface M3uChannelData {
	tvgId?: string;
	tvgName?: string;
	groupTitle?: string;
	url: string;
	tvgLogo?: string;
	attributes?: Record<string, string>;
	/** Backup stream URLs for automatic failover */
	backupUrls?: string[];
}

/**
 * Cinephage Live channel metadata from the Cinephage-owned taxonomy:
 * the clean category bucket ("Soccer", "Sports", …) and the ISO 3166-1
 * alpha-2 country code derived server-side by the Cinephage API.
 */
export interface CinephageLiveChannelData {
	category?: string;
	countryCode?: string;
}

// ============================================================================
// UNIFIED CHANNEL TYPES
// ============================================================================

/**
 * Live TV Category - Unified category structure
 */
export interface LiveTvCategory {
	id: string;
	accountId: string;
	providerType: LiveTvProviderType;
	externalId: string;
	title: string;
	alias: string | null;
	censored: boolean;
	channelCount: number;
	providerData?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

/**
 * Live TV Channel - Unified channel structure
 */
export interface LiveTvChannel {
	id: string;
	accountId: string;
	providerType: LiveTvProviderType;
	externalId: string;
	name: string;
	number: string | null;
	logo: string | null;
	categoryId: string | null;
	providerCategoryId: string | null;

	// Provider-specific data (only one populated) - using same names as CachedChannel
	stalker?: StalkerChannelData;
	xstream?: XstreamChannelData;
	m3u?: M3uChannelData;
	cinephageLive?: CinephageLiveChannelData;

	epgId: string | null;
	createdAt: string;
	updatedAt: string;

	// Joined fields
	accountName?: string;
	categoryTitle: string | null;
}

/**
 * Cached channel with provider type and data
 */
export interface CachedChannel {
	id: string;
	accountId: string;
	providerType: LiveTvProviderType;
	externalId: string;
	name: string;
	number: string | null;
	logo: string | null;
	categoryId: string | null;
	categoryTitle: string | null;
	providerCategoryId: string | null;

	// Provider-specific data as nested objects
	stalker?: StalkerChannelData;
	xstream?: XstreamChannelData;
	m3u?: M3uChannelData;
	cinephageLive?: CinephageLiveChannelData;

	// Optional EPG ID (used when channel is from the database)
	epgId?: string | null;

	createdAt: string;
	updatedAt: string;

	// Joined fields
	accountName?: string;
}

// ============================================================================
// CHANNEL QUERY TYPES
// ============================================================================

/**
 * Query options for channel listing
 */
export interface ChannelQueryOptions {
	accountIds?: string[];
	categoryIds?: string[];
	providerTypes?: LiveTvProviderType[];
	/** ISO 3166-1 alpha-2 codes from Cinephage Live channel metadata. */
	countryCodes?: string[];
	search?: string;
	hasArchive?: boolean;
	page?: number;
	pageSize?: number;
	sortBy?: 'name' | 'number' | 'category';
	sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated response for channel listing
 */
export interface PaginatedChannelResponse {
	items: CachedChannel[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

/**
 * Result of syncing channels from provider
 */
export interface ChannelSyncResult {
	success: boolean;
	categoriesAdded: number;
	categoriesUpdated: number;
	channelsAdded: number;
	channelsUpdated: number;
	channelsRemoved: number;
	duration: number;
	error?: string;
}

/**
 * Sync status for account display
 */
export interface AccountSyncStatus {
	id: string;
	name: string;
	providerType: LiveTvProviderType;
	syncStatus: 'never' | 'syncing' | 'success' | 'failed';
	lastSyncAt: string | null;
	lastSyncError: string | null;
	channelCount: number | null;
	categoryCount: number | null;
}

// ============================================================================
// USER CATEGORIES
// ============================================================================

/**
 * User-defined category for organizing their channel lineup
 */
export interface ChannelCategory {
	id: string;
	name: string;
	position: number;
	color: string | null;
	icon: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Form data for creating/editing a category
 */
export interface ChannelCategoryFormData {
	name: string;
	color?: string;
	icon?: string;
}

// ============================================================================
// CHANNEL LINEUP TYPES
// ============================================================================

/**
 * Channel lineup item as stored in the database
 */
export interface ChannelLineupItem {
	id: string;
	accountId: string;
	channelId: string;
	position: number;
	channelNumber: number | null;
	customName: string | null;
	customLogo: string | null;
	epgId: string | null;
	epgSourceChannelId: string | null;
	categoryId: string | null;
	addedAt: string;
	updatedAt: string;
}

/**
 * Enriched lineup item with channel data, account name, and computed display values
 */
export interface ChannelLineupItemWithDetails extends ChannelLineupItem {
	// Provider type for this lineup item
	providerType: LiveTvProviderType;

	// From livetvChannels join
	channel: CachedChannel;

	// From livetvAccounts join
	accountName: string;

	// From channelCategories join
	category: ChannelCategory | null;

	// Computed display values
	displayName: string;
	displayLogo: string | null;

	// EPG source override (when using another channel's EPG)
	epgSourceChannel: CachedChannel | null;
	epgSourceAccountName: string | null;
}

// ============================================================================
// CHANNEL LINEUP BACKUPS
// ============================================================================

/**
 * Backup link for a lineup item - alternative channel source for failover
 */
export interface ChannelBackupLink {
	id: string;
	lineupItemId: string;
	accountId: string;
	channelId: string;
	priority: number;
	createdAt: string;
	updatedAt: string;

	// Provider type for this backup
	providerType: LiveTvProviderType;

	// Joined data
	channel: CachedChannel;
	accountName: string;
}

/**
 * Lineup item extended with backup links
 */
export interface ChannelLineupItemWithBackups extends ChannelLineupItemWithDetails {
	backups: ChannelBackupLink[];
}

/**
 * Request to add a backup link to a lineup item
 */
export interface AddBackupLinkRequest {
	accountId: string;
	channelId: string;
}

/**
 * Request to reorder backup links for a lineup item
 */
export interface ReorderBackupsRequest {
	backupIds: string[];
}

// ============================================================================
// CHANNEL LINEUP REQUESTS
// ============================================================================

/**
 * Request to update a channel's customization
 */
export interface UpdateChannelRequest {
	channelNumber?: number | null;
	customName?: string | null;
	customLogo?: string | null;
	epgId?: string | null;
	epgSourceChannelId?: string | null;
	categoryId?: string | null;
}

/**
 * Request to add channels to the lineup
 */
export interface AddToLineupRequest {
	channels: Array<{
		accountId: string;
		channelId: string;
		categoryId?: string | null;
	}>;
}

/**
 * Request to reorder lineup items
 */
export interface ReorderLineupRequest {
	itemIds: string[];
}

/**
 * Request to remove items from lineup
 */
export interface RemoveFromLineupRequest {
	itemIds: string[];
}

/**
 * Request to apply cleaned names to lineup items
 */
export interface BulkApplyCleanNamesRequest {
	itemIds: string[];
}

/**
 * Preview entry for applying cleaned names in bulk
 */
export interface ChannelCleanNamePreview {
	itemId: string;
	channelNumber: number;
	accountName: string;
	providerType: LiveTvProviderType;
	currentName: string;
	cleanedName: string;
}

/**
 * Result of applying cleaned names in bulk
 */
export interface BulkApplyCleanNamesResult {
	updated: number;
	skippedExistingCustom: number;
	skippedUnchanged: number;
}

// ============================================================================
// EPG (Electronic Program Guide) TYPES
// ============================================================================

/**
 * Raw EPG program data from provider API
 */
export interface EpgProgramRaw {
	id: string;
	ch_id: string;
	time: string;
	time_to: string;
	duration: number;
	name: string;
	descr: string;
	category: string;
	director: string;
	actor: string;
	start_timestamp: number;
	stop_timestamp: number;
	mark_archive: number;
}

/**
 * A single localized text variant preserved from an XMLTV `@lang` attribute
 * (migration 140). `lang` is the lower-cased `@_lang` value, or null when the
 * source element carried no language.
 */
export interface EpgLocalizedText {
	lang: string | null;
	text: string;
}

/**
 * EPG program stored in database
 */
export interface EpgProgram {
	id: string;
	channelId: string;
	externalChannelId: string;
	accountId: string;
	providerType: LiveTvProviderType;
	title: string;
	description: string | null;
	category: string | null;
	director: string | null;
	actor: string | null;
	/**
	 * All localized variants seen for the title/description/category XMLTV
	 * elements. Optional; providers without language information leave these
	 * unset and display falls back to the plain columns.
	 */
	titleI18n?: EpgLocalizedText[] | null;
	descriptionI18n?: EpgLocalizedText[] | null;
	categoryI18n?: EpgLocalizedText[] | null;
	startTime: string;
	endTime: string;
	duration: number;
	hasArchive: boolean;
	cachedAt: string;
	updatedAt: string;
}

/**
 * EPG program with computed progress for display
 */
export interface EpgProgramWithProgress extends EpgProgram {
	progress: number; // 0-1 representing how far through the program
	isLive: boolean; // true if currently airing
	remainingMinutes: number;
}

/**
 * Current and next program for a channel
 */
export interface ChannelNowNext {
	channelId: string;
	now: EpgProgramWithProgress | null;
	next: EpgProgram | null;
}

/**
 * Result of syncing EPG from a provider account
 */
export interface EpgSyncResult {
	success: boolean;
	accountId: string;
	accountName: string;
	providerType: LiveTvProviderType;
	programsAdded: number;
	programsUpdated: number;
	programsRemoved: number;
	duration: number;
	error?: string;
}

/**
 * EPG sync status for display
 */
export interface EpgStatus {
	isEnabled: boolean;
	isSyncing: boolean;
	syncingAccountIds?: string[];
	cancelRequestedAll?: boolean;
	cancelRequestedAccountIds?: string[];
	syncIntervalHours: number;
	retentionHours: number;
	lastSyncAt: string | null;
	nextSyncAt: string | null;
	totalPrograms: number;
	accounts: Array<{
		id: string;
		name: string;
		providerType: LiveTvProviderType;
		lastEpgSyncAt: string | null;
		programCount: number;
		hasEpg: boolean | null;
		error?: string;
	}>;
}

// ============================================================================
// STREAMING TYPES
// ============================================================================

/**
 * Result of fetching a stream
 */
export interface FetchStreamResult {
	response: Response;
	url: string;
	type: 'hls' | 'direct' | 'unknown';
	accountId: string;
	channelId: string;
	lineupItemId: string;
	providerType: LiveTvProviderType;
	/** Provider-specific headers needed for subsequent segment/playlist requests (e.g., cookies for Stalker portals) */
	providerHeaders?: Record<string, string>;
}

/**
 * Stream error with additional context
 */
export interface StreamError extends Error {
	code:
		| 'LINEUP_ITEM_NOT_FOUND'
		| 'ACCOUNT_NOT_FOUND'
		| 'CHANNEL_NOT_FOUND'
		| 'ALL_SOURCES_FAILED'
		| 'STREAM_FETCH_FAILED'
		| 'AUTH_FAILED'
		| 'UNSUPPORTED_PROVIDER';
	accountId?: string;
	channelId?: string;
	attempts?: number;
	providerType?: LiveTvProviderType;
}

// ============================================================================
// M3U IMPORT TYPES
// ============================================================================

/**
 * M3U channel parsed from playlist
 */
export interface M3uChannelParsed {
	tvgId?: string;
	tvgName?: string;
	tvgLogo?: string;
	groupTitle?: string;
	name: string;
	url: string;
	attributes: Record<string, string>;
}

/**
 * M3U import result
 */
export interface M3uImportResult {
	success: boolean;
	channelsImported: number;
	categoriesCreated: number;
	errors: string[];
}

// ============================================================================
// BACKWARD COMPATIBILITY (Deprecated types for old Stalker-specific code)
// ============================================================================

/** @deprecated Use LiveTvAccountTestResult instead */
export type StalkerAccountTestResult = LiveTvAccountTestResult;

/** @deprecated Use LiveTvCategory instead */
export interface StalkerCategory {
	id: string;
	title: string;
	alias: string;
	censored: boolean;
}

/** @deprecated Use LiveTvChannel instead */
export interface StalkerChannel {
	id: string;
	name: string;
	number: string;
	logo: string;
	genreId: string;
	cmd: string;
	tvArchive: boolean;
	archiveDuration: number;
}

// ============================================================================
// STALKER RAW PROFILE (for internal portal API responses)
// ============================================================================

/**
 * Raw profile response from Stalker Portal API
 * Contains many fields, we only use a subset
 */
export interface StalkerRawProfile {
	id: number;
	mac: string;
	status: number;
	blocked: string;
	phone: string;
	fname: string;
	expire_billing_date: string;
	tariff_expired_date: string | null;
	playback_limit: number;
	default_timezone: string;
	[key: string]: unknown;
}

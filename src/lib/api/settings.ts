import type {
	RootFolderCreate,
	RootFolderUpdate,
	LibraryCreate,
	LibraryUpdate,
	LibraryDeleteRequest,
	NamingConfigUpdate,
	NamingPresetSelection,
	ScoringProfileCreate,
	ScoringProfileUpdate,
	GlobalTmdbFilters,
	DownloadClientCreate,
	DownloadClientUpdate,
	DownloadClientTest,
	MediaBrowserServerCreate,
	MediaBrowserServerUpdate,
	MediaBrowserServerTest,
	MediaBrowserServerType,
	NamingPresetCreate,
	NamingPresetUpdate,
	NamingPreview,
	LibraryClassificationUpdate,
	BackupImport,
	FileManagementSettings
} from '#lib/validation/schemas.js';

import type {
	RootFolder,
	PathValidationResult,
	DownloadClient,
	ConnectionTestResult
} from '#lib/types/downloadClient.js';
import type {
	NamingConfigShape,
	NamingPreset,
	NamingServerPreset,
	NamingStylePreset,
	NamingDetailPreset
} from '#lib/naming/setup-presets.js';
import type {
	RenamePreviewResult,
	RenameExecuteResult,
	ReorganizeBatchResult
} from '#lib/library/naming/types.js';
import type { CapturedLogEntry, CapturedLogLevel } from '#lib/logging/log-capture.js';

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

// ---------------------------------------------------------------------------
// Response payload types (client mirrors of the JSON the server emits).
// Sources: the matching +server.ts handlers under src/routes/api and the
// services they spread. Dates arrive as strings. Keep in sync with the server.
// ---------------------------------------------------------------------------

// --- Root folders -----------------------------------------------------------

export type RootFolderCreateResponse = {
	folder: RootFolder;
	scanJobId: string;
};

export type RootFolderUpdateResponse = {
	folder: RootFolder;
	autoDisabledAnimeEnforcement: boolean;
};

export type RootFolderDeleteResponse = {
	autoDisabledAnimeEnforcement: boolean;
};

// --- Libraries --------------------------------------------------------------

/** Root folder summary embedded in a library payload (LibraryEntityService.LibraryRootFolder). */
export type LibraryRootFolderRef = {
	id: string;
	name: string;
	path: string;
	mediaType: 'movie' | 'tv';
	mediaSubType: 'standard' | 'anime';
};

/** Library row as serialized by /api/libraries (LibraryEntityService.LibraryEntity). */
export type LibraryResponse = {
	id: string;
	name: string;
	slug: string;
	mediaType: 'movie' | 'tv';
	mediaSubType: 'standard' | 'anime';
	isSystem: boolean;
	systemKey: string | null;
	isDefault: boolean;
	rootFolders: LibraryRootFolderRef[];
	defaultRootFolderId: string | null;
	defaultRootFolderPath: string | null;
	defaultSearchOnAdd: boolean;
	defaultWantsSubtitles: boolean;
	qualityProfileId: string | null;
	/** Library-wide default language profile; null = inherit the instance default */
	languageProfileId: string | null;
	sortOrder: number;
	scanMode?: string | null;
	createdAt: string;
	updatedAt: string;
};

export type LibrariesListResponse = {
	libraries: LibraryResponse[];
};

export type LibraryMutationResponse = {
	library: LibraryResponse;
};

// --- Naming -----------------------------------------------------------------

export type NamingSettingsResponse = {
	config: NamingConfigShape;
	presetSelection: NamingPresetSelection;
	defaults: NamingConfigShape;
};

export type NamingSettingsUpdateResponse = {
	config: NamingConfigShape;
	presetSelection: NamingPresetSelection;
};

export type NamingSettingsResetResponse = NamingSettingsUpdateResponse & {
	message: string;
};

export type NamingPresetsSetup = {
	servers: NamingServerPreset[];
	styles: NamingStylePreset[];
	details: NamingDetailPreset[];
};

export type NamingPresetsResponse = {
	presets: NamingPreset[];
	builtInIds: string[];
	setupPresets: NamingPresetsSetup;
};

export type NamingPresetResponse = {
	preset: NamingPreset;
};

/** Client mirror of NamingService.MediaNamingInfo (sample data used by previews). */
export type NamingSampleMediaInfo = {
	title: string;
	originalTitle?: string;
	year?: number;
	tmdbId?: number;
	tvdbId?: number;
	imdbId?: string;
	collectionName?: string;
	localizedTitles?: Record<string, string>;
	edition?: string;
	resolution?: string;
	source?: string;
	codec?: string;
	hdr?: string;
	bitDepth?: string;
	is3D?: boolean;
	audioCodec?: string;
	audioChannels?: string;
	audioLanguages?: string[];
	releaseGroup?: string;
	proper?: boolean;
	repack?: boolean;
	seasonNumber?: number;
	episodeNumbers?: number[];
	absoluteNumber?: number;
	episodeTitle?: string;
	airDate?: string;
	isDaily?: boolean;
	isAnime?: boolean;
	originalExtension?: string;
};

export type NamingPreviewResponse = {
	previews: {
		movie: { folder: string; file: string };
		movieWithEdition: { folder: string; file: string };
		series: { folder: string; season: string };
		episode: { file: string };
		multiEpisode: { file: string };
		anime: { file: string };
		daily: { file: string };
	};
	config: NamingConfigShape;
	sampleData: {
		movie: NamingSampleMediaInfo;
		episode: NamingSampleMediaInfo;
	};
};

export type NamingFormatValidation = {
	valid: boolean;
	errors: Array<{ position: number; message: string; token?: string }>;
	warnings: Array<{ position: number; message: string; suggestion?: string }>;
	tokens: string[];
};

export type NamingValidateResponse = {
	results: Record<string, NamingFormatValidation>;
};

export type NamingTokenInfo = {
	token: string;
	description: string;
};

export type NamingTokensResponse = {
	tokens: Record<string, NamingTokenInfo[]>;
	categories: Array<{ id: string; name: string; description: string }>;
};

// --- Rename -----------------------------------------------------------------

/** Payload of POST /api/rename/reorganize beyond the success envelope. */
export type ReorganizeResponse = {
	oldPath?: string;
	newPath?: string;
};

// --- Scoring profiles -------------------------------------------------------

export type ScoringProfileCategory =
	'quality' | 'efficient' | 'micro' | 'streaming' | 'anime' | 'custom';

/** Profile row as mapped by GET /api/scoring-profiles. */
export type ScoringProfileSummary = {
	id: string;
	name: string;
	description: string;
	tags: string[];
	icon: string;
	color: string;
	category: ScoringProfileCategory;
	upgradesAllowed: boolean;
	preventDowngrades: boolean;
	minScore: number;
	upgradeUntilScore: number;
	minScoreIncrement: number;
	formatScores: Record<string, number>;
	requiredFormats: Array<{ id: string; op: 'AND' | 'OR' }>;
	movieMinSizeGb: number | null;
	movieMaxSizeGb: number | null;
	episodeMinSizeMb: number | null;
	episodeMaxSizeMb: number | null;
	isDefault: boolean;
	isBuiltIn: boolean;
};

export type ScoringProfilesResponse = {
	profiles: ScoringProfileSummary[];
	count: number;
	defaultProfileId: string;
};

/** Raw scoring_profiles DB row (bare payload of POST /api/scoring-profiles). */
export type ScoringProfileRecordResponse = {
	id: string;
	name: string;
	description: string | null;
	tags: string[] | null;
	upgradesAllowed: boolean | null;
	minScore: number | null;
	upgradeUntilScore: number | null;
	minScoreIncrement: number | null;
	resolutionOrder?: string[] | null;
	formatScores: Record<string, number> | null;
	allowedProtocols?: Array<'torrent' | 'usenet' | 'streaming'> | null;
	isDefault: boolean | null;
	movieMinSizeGb: number | null;
	movieMaxSizeGb: number | null;
	episodeMinSizeMb: number | null;
	episodeMaxSizeMb: number | null;
	isBuiltIn: boolean | null;
	preventDowngrades: boolean | null;
	minResolution?: string | null;
	maxResolution?: string | null;
	allowedSources?: string[] | null;
	excludedSources?: string[] | null;
	requiredFormats: Array<{ id: string; op: 'AND' | 'OR' }> | null;
	createdAt?: string;
	updatedAt?: string;
};

/** Built-in profile PUT response: code-defined profile overlaid with stored settings. */
export type ScoringProfileBuiltInUpdateResponse = {
	id: string;
	name: string;
	description: string;
	tags: string[];
	icon?: string;
	color?: string;
	category?: ScoringProfileCategory;
	upgradesAllowed: boolean;
	preventDowngrades: boolean;
	isDefault: boolean;
	minScore: number;
	upgradeUntilScore: number;
	minScoreIncrement: number;
	movieMinSizeGb: number | null;
	movieMaxSizeGb: number | null;
	episodeMinSizeMb: number | null;
	episodeMaxSizeMb: number | null;
	formatScores: Record<string, number>;
	isBuiltIn: boolean;
};

export type ScoringProfileDeleteResponse = {
	deleted: ScoringProfileRecordResponse;
};

// --- TMDB / metadata providers / filters ------------------------------------

export type TmdbSettingsResponse = {
	hasApiKey: boolean;
};

export type TmdbSettingsUpdateResponse = {
	unchanged?: boolean;
};

export interface MetadataProviderSettingsPayload {
	animeEnrichmentEnabled?: boolean;
}

export type MetadataProviderSettingsResponse = {
	animeEnrichmentEnabled: boolean;
};

export type TmdbFiltersResponse = {
	filters: GlobalTmdbFilters;
};

// --- Blocklist --------------------------------------------------------------

export type BlocklistQualityInfo = {
	resolution?: string;
	source?: string;
	codec?: string;
	hdr?: string;
};

/** blocklist DB row as returned (bare) by GET /api/settings/blocklist. */
export type BlocklistEntry = {
	id: string;
	title: string;
	infoHash: string | null;
	indexerId: string | null;
	movieId: string | null;
	seriesId: string | null;
	episodeIds: string[] | null;
	reason: string;
	message: string | null;
	sourceTitle: string | null;
	quality: BlocklistQualityInfo | null;
	size: number | null;
	protocol: string | null;
	createdAt: string;
	expiresAt: string | null;
};

export type BlocklistResponse = {
	entries: BlocklistEntry[];
	total: number;
};

export type BlocklistDeleteResponse = {
	removed?: number;
	message?: string;
};

export type BlocklistAddResponse = {
	id: string;
};

// --- Backup -----------------------------------------------------------------

export type BackupExportResponse = {
	fileName: string;
	backup: BackupImport['backup'];
};

export type BackupImportResponse = {
	message: string;
	result: {
		restoredSections: Array<
			'system' | 'profiles' | 'downloads' | 'indexers' | 'subtitles' | 'integrations' | 'liveTv'
		>;
		restoredTables: string[];
		secretsRestored: boolean;
		warnings: string[];
	};
};

// --- Logs -------------------------------------------------------------------

export type LogSettingsResponse = {
	retentionDays: number;
	defaultRetentionDays: number;
	maxRetentionDays: number;
	minLevel: CapturedLogLevel;
	defaultMinLevel: CapturedLogLevel;
};

export type LogSettingsUpdateResponse = {
	retentionDays: number;
	minLevel: CapturedLogLevel;
};

/** Only the format=json branch returns JSON; the default jsonl branch streams text. */
export type LogDownloadResponse = {
	entries: CapturedLogEntry[];
	total: number;
};

export type LogHistoryResponse = {
	entries: CapturedLogEntry[];
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
};

// --- API keys ---------------------------------------------------------------

export type ManagedApiKeyResponse = {
	id: string;
	name?: string | null;
	key: string;
	createdAt?: string | null;
	metadata?: Record<string, unknown> | null;
};

export type ApiKeysResponse = {
	data: ManagedApiKeyResponse[];
};

export type ApiKeysCreateResponse = {
	data: {
		mainKey: { id: string; key: string } | null;
		streamingKey: { id: string; key: string } | null;
	};
};

export type ApiKeyRegenerateResponse = {
	data: {
		id: string;
		key: string;
		name?: string | null;
		metadata?: Record<string, unknown> | null;
	};
};

// --- Streaming cache / external URL / arr compat / sidecar ------------------

export type StreamingCacheCleanupResponse = {
	cleaned: number;
	freedMB: number;
};

export type ExternalUrlResponse = {
	url: string | null;
};

export type ExternalUrlUpdateResponse = {
	url: string | null;
};

export type ArrCompatResponse = {
	enabled: boolean;
};

export interface SidecarSettingsPayload {
	enabled: boolean;
	overwriteExisting: boolean;
	includeArtwork: boolean;
	tvSeriesLevel: boolean;
	tvSeasonLevel: boolean;
	tvEpisodeLevel: boolean;
}

// --- System / classification ------------------------------------------------

export type SystemServiceStatus = {
	name: string;
	status: 'pending' | 'starting' | 'ready' | 'error';
	error?: string;
};

export type SystemStatusResponse = {
	ready: boolean;
	version: string;
	services: SystemServiceStatus[];
};

export type GithubReleaseResponse = {
	version: string;
	commit: string;
	fetchedAt: number;
};

export type LibraryClassificationResponse = {
	enforceAnimeSubtype: boolean;
};

// --- Workers ----------------------------------------------------------------

export type WorkerTypeValue =
	'stream' | 'import' | 'scan' | 'monitoring' | 'search' | 'portal-scan' | 'channel-sync';

export type WorkerStatusValue = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type WorkerLogEntryResponse = {
	timestamp: string;
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	data?: Record<string, unknown>;
};

export type WorkerStateResponse = {
	id: string;
	type: WorkerTypeValue;
	status: WorkerStatusValue;
	progress: number;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	error?: string;
	metadata: Record<string, unknown>;
};

export type WorkerDetailResponse = WorkerStateResponse & {
	logs: WorkerLogEntryResponse[];
};

export type WorkersListResponse = {
	workers: WorkerStateResponse[];
	stats: {
		total: number;
		byType: Record<WorkerTypeValue, { active: number; completed: number; failed: number }>;
	};
	config: {
		maxConcurrent: Record<WorkerTypeValue, number>;
		cleanupAfterMs: number;
		maxLogsPerWorker: number;
	};
};

export type WorkerDeleteResponse = {
	action: 'cancelled' | 'removed';
	message: string;
};

export type WorkersClearResponse = {
	cleared: number;
};

// --- Media server stats -----------------------------------------------------

export type MediaServerBreakdownEntry = {
	serverId: string;
	serverName: string;
	serverType: MediaBrowserServerType;
	playCount: number;
	lastPlayedDate: string | null;
	videoCodec: string | null;
	width: number | null;
	height: number | null;
	isHDR: boolean;
	containerFormat: string | null;
};

export type AggregatedMediaItemResponse = {
	tmdbId: number | null;
	tvdbId: number | null;
	imdbId: string | null;
	title: string;
	year: number | null;
	itemType: string;
	totalPlayCount: number;
	lastPlayedDate: string | null;
	serverBreakdown: MediaServerBreakdownEntry[];
};

export type MediaServerSyncStatusResponse = {
	serverId: string;
	serverName: string;
	serverType: MediaBrowserServerType;
	itemCount: number;
	lastSyncAt: string | null;
	lastSyncStatus: string | null;
	enabled: boolean;
};

export type MediaServerStatsResponse = {
	totalPlays: number;
	uniqueItems: number;
	serversSynced: number;
	totalFileSize: number;
	resolutionBreakdown: Array<{ label: string; count: number }>;
	codecBreakdown: Array<{ label: string; count: number }>;
	hdrBreakdown: Array<{ label: string; count: number }>;
	audioCodecBreakdown: Array<{ label: string; count: number }>;
	containerBreakdown: Array<{ label: string; count: number }>;
	topPlayedItems: AggregatedMediaItemResponse[];
	largestItems: AggregatedMediaItemResponse[];
	serverStatuses: MediaServerSyncStatusResponse[];
};

export type MediaServerStatsSyncResponse = {
	message: string;
};

// --- Download clients -------------------------------------------------------

export type DownloadClientMutationResponse = {
	client: DownloadClient;
};

// --- Media browser servers (notifications) ----------------------------------

export type MediaBrowserPathMappingRef = {
	localPath: string;
	remotePath: string;
};

/** Client mirror of MediaBrowserServerPublic (API key excluded server-side). */
export type MediaBrowserServerResponse = {
	id: string;
	name: string;
	serverType: MediaBrowserServerType;
	host: string;
	enabled: boolean | null;
	onImport: boolean | null;
	onUpgrade: boolean | null;
	onRename: boolean | null;
	onDelete: boolean | null;
	pathMappings: MediaBrowserPathMappingRef[] | null;
	serverName: string | null;
	serverVersion: string | null;
	serverId: string | null;
	lastTestedAt: string | null;
	testResult: string | null;
	testError: string | null;
	createdAt: string | null;
	updatedAt: string | null;
};

export type MediaBrowserMutationResponse = {
	server: MediaBrowserServerResponse;
};

export type MediaBrowserTestResponse = {
	success: boolean;
	error?: string;
	serverInfo?: {
		serverName: string;
		version: string;
		id: string;
		detectedType?: MediaBrowserServerType;
		productName?: string;
	};
};

// --- Logos ------------------------------------------------------------------

export type LogoStatusData = {
	downloaded: boolean;
	count: number;
	countries: number;
};

export type LogoStatusResponse = {
	data: LogoStatusData;
};

export type LogoCountryInfo = {
	code: string;
	name: string;
	logoCount: number;
};

export type LogoCountriesResponse = {
	data: LogoCountryInfo[];
};

export type LogoDownloadResponse = {
	message: string;
	data?: LogoStatusData;
};

// --- User language ----------------------------------------------------------

export type UserLanguageResponse = {
	language: string;
};

// --- Blocked extensions / media / keywords ----------------------------------

export type BlockedExtensionsResponse = {
	extensions: string[];
};

export type BlockedMediaEntryResponse = {
	id: string;
	tmdbId: number;
	mediaType: string;
	title: string;
	posterPath: string | null;
	year: number | null;
	reason: string | null;
	createdAt: string | null;
};

export type BlockedMediaResponse = {
	entries: BlockedMediaEntryResponse[];
	total: number;
};

export type BlockedMediaMutationResponse = {
	entry: BlockedMediaEntryResponse;
};

export type BlockedMediaRemoveResponse = {
	removed: number;
};

export type BlockedKeywordEntry = {
	id: number;
	keywordId: number;
	name: string;
	createdAt: string;
};

export type BlockedKeywordMutationResponse = {
	entry: BlockedKeywordEntry;
};

// --- File management --------------------------------------------------------

export type FileManagementSettingsUpdateResponse = FileManagementSettings & {
	autoEnabledCount: number;
	autoRevertedCount: number;
};

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

export async function getRootFolders(): Promise<RootFolder[]> {
	const response = await apiGet('/api/root-folders');
	return response as unknown as RootFolder[];
}

export async function createRootFolder(payload: RootFolderCreate) {
	return apiPost<RootFolderCreateResponse>('/api/root-folders', payload);
}

export async function updateRootFolder(id: string, payload: RootFolderUpdate) {
	return apiPut<RootFolderUpdateResponse>(`/api/root-folders/${id}`, payload);
}

export async function deleteRootFolder(id: string) {
	return apiDelete<RootFolderDeleteResponse>(`/api/root-folders/${id}`);
}

export async function validateRootFolder(
	path: string,
	readOnly?: boolean,
	folderId?: string
): Promise<PathValidationResult> {
	const response = await apiPost('/api/root-folders/validate', { path, readOnly, folderId });
	return response as unknown as PathValidationResult;
}

export async function getLibraries(params?: { mediaType?: string; includeSystem?: boolean }) {
	const query: Record<string, string> = {};
	if (params?.mediaType) query.mediaType = params.mediaType;
	if (params?.includeSystem !== undefined) query.includeSystem = String(params.includeSystem);
	return apiGet<LibrariesListResponse>('/api/libraries', query);
}

export async function createLibrary(payload: LibraryCreate) {
	return apiPost<LibraryMutationResponse>('/api/libraries', payload);
}

export async function updateLibrary(id: string, payload: LibraryUpdate) {
	return apiPut<LibraryMutationResponse>(`/api/libraries/${id}`, payload);
}

export async function deleteLibrary(id: string, body?: LibraryDeleteRequest) {
	return apiDelete(`/api/libraries/${id}`, body);
}

export async function getNamingConfig(): Promise<NamingSettingsResponse> {
	const response = await apiGet('/api/naming');
	return response as unknown as NamingSettingsResponse;
}

export async function updateNamingConfig(
	config: NamingConfigUpdate,
	presetSelection?: NamingPresetSelection
) {
	return apiPut<NamingSettingsUpdateResponse>('/api/naming', { config, presetSelection });
}

export async function resetNamingConfig() {
	return apiDelete<NamingSettingsResetResponse>('/api/naming');
}

export async function getNamingPresets(): Promise<NamingPresetsResponse> {
	const response = await apiGet('/api/naming/presets');
	return response as unknown as NamingPresetsResponse;
}

export async function getNamingPreset(id: string): Promise<NamingPresetResponse> {
	const response = await apiGet(`/api/naming/presets/${id}`);
	return response as unknown as NamingPresetResponse;
}

export async function createNamingPreset(
	payload: NamingPresetCreate
): Promise<NamingPresetResponse> {
	const response = await apiPost('/api/naming/presets', payload);
	return response as unknown as NamingPresetResponse;
}

export async function updateNamingPreset(
	id: string,
	payload: NamingPresetUpdate
): Promise<NamingPresetResponse> {
	const response = await apiPut(`/api/naming/presets/${id}`, payload);
	return response as unknown as NamingPresetResponse;
}

export async function deleteNamingPreset(id: string) {
	return apiDelete(`/api/naming/presets/${id}`);
}

export async function previewNaming(payload: NamingPreview): Promise<NamingPreviewResponse> {
	const response = await apiPost('/api/naming/preview', payload);
	return response as unknown as NamingPreviewResponse;
}

// The server only reads a `formats` object from this endpoint; this wrapper
// sends `{ pattern }`, so it cannot reach the success path (see
// validateNamingFormats). Left untyped because no success payload applies.
export async function validateNaming(pattern: string) {
	return apiPost('/api/naming/validate', { pattern });
}

export async function validateNamingFormats(
	formats: Record<string, string>
): Promise<NamingValidateResponse> {
	const response = await apiPost('/api/naming/validate', { formats });
	return response as unknown as NamingValidateResponse;
}

export async function getNamingTokens(): Promise<NamingTokensResponse> {
	const response = await apiGet('/api/naming/tokens');
	return response as unknown as NamingTokensResponse;
}

export type RenamePreviewCategory = 'willChange' | 'alreadyCorrect' | 'collisions' | 'errors';

// The endpoint answers with an NDJSON stream (application/x-ndjson), not a
// JSON envelope, so there is no ApiResponse payload to describe here.
export async function getRenamePreview(
	mediaType?: string,
	options?: { category?: RenamePreviewCategory; limit?: number; offset?: number }
) {
	const params: Record<string, string> = {};
	if (mediaType) params.mediaType = mediaType;
	if (options?.category) params.category = options.category;
	if (options?.limit !== undefined) params.limit = String(options.limit);
	if (options?.offset !== undefined && options.offset > 0) params.offset = String(options.offset);
	return apiGet('/api/rename/preview', params);
}

export async function getMovieRenamePreview(movieId: string) {
	return apiGet<RenamePreviewResult>(`/api/rename/preview/movie/${movieId}`);
}

export async function getSeriesRenamePreview(seriesId: string) {
	return apiGet<RenamePreviewResult>(`/api/rename/preview/series/${seriesId}`);
}

export async function executeRename(fileIds: string[], mediaType?: string) {
	return apiPost<RenameExecuteResult>('/api/rename/execute', { fileIds, mediaType });
}

export async function reorganizeFolder(mediaId: string, mediaType: 'movie' | 'series') {
	return apiPost<ReorganizeResponse>('/api/rename/reorganize', { mediaId, mediaType });
}

export async function reorganizeFolderBatch(
	items: Array<{ mediaId: string; mediaType: 'movie' | 'series' }>
) {
	return apiPost<ReorganizeBatchResult>('/api/rename/reorganize-batch', { items });
}

export async function getScoringProfiles(): Promise<ScoringProfilesResponse> {
	const response = await apiGet('/api/scoring-profiles');
	return response as unknown as ScoringProfilesResponse;
}

export async function createScoringProfile(
	payload: ScoringProfileCreate
): Promise<ScoringProfileRecordResponse> {
	const response = await apiPost('/api/scoring-profiles', payload);
	return response as unknown as ScoringProfileRecordResponse;
}

export async function updateScoringProfile(
	payload: { id: string } & ScoringProfileUpdate
): Promise<ScoringProfileRecordResponse | ScoringProfileBuiltInUpdateResponse> {
	const response = await apiPut('/api/scoring-profiles', payload);
	return response as unknown as ScoringProfileRecordResponse | ScoringProfileBuiltInUpdateResponse;
}

export async function deleteScoringProfile(id: string) {
	return apiDelete<ScoringProfileDeleteResponse>('/api/scoring-profiles', { id });
}

export async function getTmdbSettings() {
	return apiGet<TmdbSettingsResponse>('/api/settings/tmdb');
}

export async function updateTmdbSettings(apiKey: string) {
	return apiPut<TmdbSettingsUpdateResponse>('/api/settings/tmdb', { apiKey });
}

export async function getMetadataProviderSettings() {
	return apiGet<MetadataProviderSettingsResponse>('/api/settings/metadata-providers');
}

export async function updateMetadataProviderSettings(payload: MetadataProviderSettingsPayload) {
	return apiPut<MetadataProviderSettingsResponse>('/api/settings/metadata-providers', payload);
}

export async function getTmdbFilters() {
	return apiGet<TmdbFiltersResponse>('/api/settings/filters');
}

export async function updateTmdbFilters(filters: GlobalTmdbFilters) {
	return apiPut<TmdbFiltersResponse>('/api/settings/filters', filters);
}

export async function getBlocklist(params?: {
	limit?: number;
	offset?: number;
	reason?: string;
	protocol?: string;
	activeOnly?: boolean;
}): Promise<BlocklistResponse> {
	const query: Record<string, string> = {};
	if (params?.limit) query.limit = String(params.limit);
	if (params?.offset) query.offset = String(params.offset);
	if (params?.reason) query.reason = params.reason;
	if (params?.protocol) query.protocol = params.protocol;
	if (params?.activeOnly) query.activeOnly = 'true';
	const response = await apiGet('/api/settings/blocklist', query);
	return response as unknown as BlocklistResponse;
}

export async function deleteBlocklistEntries(ids?: string[]) {
	return apiDelete<BlocklistDeleteResponse>('/api/settings/blocklist', ids ? { ids } : undefined);
}

export async function purgeBlocklistExpired() {
	return apiDelete<BlocklistDeleteResponse>('/api/settings/blocklist', { action: 'purgeExpired' });
}

export async function addToBlocklist(payload: {
	title: string;
	infoHash?: string;
	indexerId?: string;
	movieId?: string | null;
	seriesId?: string | null;
	size?: number;
	protocol?: 'torrent' | 'usenet' | 'streaming';
	reason?: 'manual';
	message?: string;
	expiresInHours?: number | null;
}) {
	return apiPost<BlocklistAddResponse>('/api/settings/blocklist', payload);
}

export async function updateBlocklistExpiry(payload: {
	id: string;
	expiresInHours: number | null;
}) {
	return apiPut('/api/settings/blocklist', payload);
}

export async function exportConfig(passphrase: string, includeIndexerCookies?: boolean) {
	return apiPost<BackupExportResponse>('/api/settings/system/backup', {
		passphrase,
		includeIndexerCookies
	});
}

export async function importConfig(
	passphrase: string,
	backup: BackupImport['backup'],
	opts?: { sections?: BackupImport['sections']; mode?: BackupImport['mode'] }
) {
	return apiPut<BackupImportResponse>('/api/settings/system/backup', {
		passphrase,
		backup,
		...opts
	});
}

export async function getLogSettings() {
	return apiGet<LogSettingsResponse>('/api/settings/logs/settings');
}

export async function updateLogSettings(update: { retentionDays?: number; minLevel?: string }) {
	return apiPut<LogSettingsUpdateResponse>('/api/settings/logs/settings', update);
}

export async function downloadLogs(params?: Record<string, string>) {
	return apiGet<LogDownloadResponse>('/api/settings/logs/download', params);
}

export async function getLogHistory(params?: Record<string, string>) {
	return apiGet<LogHistoryResponse>('/api/settings/logs/history', params);
}

export async function reportClientLog(entries: unknown[]) {
	return apiPost('/api/settings/logs/client-report', { entries });
}

export async function getApiKeys() {
	return apiGet<ApiKeysResponse>('/api/settings/system/api-keys');
}

export async function createApiKeys() {
	return apiPost<ApiKeysCreateResponse>('/api/settings/system/api-keys');
}

export async function regenerateApiKey(keyId: string) {
	return apiPost<ApiKeyRegenerateResponse>(`/api/settings/system/api-keys/${keyId}/regenerate`);
}

export async function cleanupStreamingCache() {
	return apiPost<StreamingCacheCleanupResponse>('/api/settings/streaming/cache/cleanup');
}

export async function getExternalUrl(): Promise<ExternalUrlResponse> {
	const response = await apiGet('/api/settings/external-url');
	return response as unknown as ExternalUrlResponse;
}

export async function updateExternalUrl(url: string) {
	return apiPut<ExternalUrlUpdateResponse>('/api/settings/external-url', { url });
}

export async function getArrCompatEnabled(): Promise<ArrCompatResponse> {
	const response = await apiGet('/api/settings/arr-compat');
	return response as unknown as ArrCompatResponse;
}

export async function updateArrCompatEnabled(enabled: boolean): Promise<ArrCompatResponse> {
	const response = await apiPut('/api/settings/arr-compat', { enabled });
	return response as unknown as ArrCompatResponse;
}

export async function getSidecarSettings(): Promise<SidecarSettingsPayload> {
	const response = await apiGet('/api/settings/sidecar');
	return response as unknown as SidecarSettingsPayload;
}

export async function updateSidecarSettings(
	update: Partial<SidecarSettingsPayload>
): Promise<SidecarSettingsPayload> {
	const response = await apiPut('/api/settings/sidecar', update);
	return response as unknown as SidecarSettingsPayload;
}

export async function getSystemStatus() {
	return apiGet<SystemStatusResponse>('/api/system/status');
}

export async function getGithubRelease() {
	return apiGet<GithubReleaseResponse>('/api/system/github-release');
}

export async function getLibraryClassificationSettings(): Promise<LibraryClassificationResponse> {
	const response = await apiGet('/api/settings/library/classification');
	return response as unknown as LibraryClassificationResponse;
}

export async function updateLibraryClassificationSettings(payload: LibraryClassificationUpdate) {
	return apiPost<LibraryClassificationResponse>('/api/settings/library/classification', payload);
}

export async function getWorker(id: string): Promise<WorkerDetailResponse> {
	const response = await apiGet(`/api/workers/${id}`);
	return response as unknown as WorkerDetailResponse;
}

export async function deleteWorker(id: string) {
	return apiDelete<WorkerDeleteResponse>(`/api/workers/${id}`);
}

export async function getWorkers(
	type?: string,
	activeOnly?: boolean
): Promise<WorkersListResponse> {
	const params: Record<string, string> = {};
	if (type) params.type = type;
	if (activeOnly) params.active = 'true';
	const response = await apiGet('/api/workers', params);
	return response as unknown as WorkersListResponse;
}

export async function clearCompletedWorkers() {
	return apiDelete<WorkersClearResponse>('/api/workers');
}

export async function getMediaServerStats(): Promise<MediaServerStatsResponse> {
	const response = await apiGet('/api/media-server-stats');
	return response as unknown as MediaServerStatsResponse;
}

export async function syncMediaServerStats() {
	return apiPost<MediaServerStatsSyncResponse>('/api/media-server-stats/sync');
}

export async function getDownloadClients(): Promise<DownloadClient[]> {
	const response = await apiGet('/api/download-clients');
	return response as unknown as DownloadClient[];
}

export async function createDownloadClient(payload: DownloadClientCreate) {
	return apiPost<DownloadClientMutationResponse>('/api/download-clients', payload);
}

export async function updateDownloadClient(id: string, payload: DownloadClientUpdate) {
	return apiPut<DownloadClientMutationResponse>(`/api/download-clients/${id}`, payload);
}

export async function deleteDownloadClient(id: string) {
	return apiDelete(`/api/download-clients/${id}`);
}

export async function testDownloadClient(id: string) {
	return apiPost<ConnectionTestResult>(`/api/download-clients/${id}/test`);
}

export async function testNewDownloadClient(payload: DownloadClientTest) {
	return apiPost<ConnectionTestResult>('/api/download-clients/test', payload);
}

export async function getMediaBrowserNotifications(): Promise<MediaBrowserServerResponse[]> {
	const response = await apiGet('/api/notifications/mediabrowser');
	return response as unknown as MediaBrowserServerResponse[];
}

export async function getMediaBrowserNotification(id: string): Promise<MediaBrowserServerResponse> {
	const response = await apiGet(`/api/notifications/mediabrowser/${id}`);
	return response as unknown as MediaBrowserServerResponse;
}

export async function createMediaBrowserNotification(payload: MediaBrowserServerCreate) {
	return apiPost<MediaBrowserMutationResponse>('/api/notifications/mediabrowser', payload);
}

export async function updateMediaBrowserNotification(
	id: string,
	payload: MediaBrowserServerUpdate
) {
	return apiPut<MediaBrowserMutationResponse>(`/api/notifications/mediabrowser/${id}`, payload);
}

export async function deleteMediaBrowserNotification(id: string) {
	return apiDelete(`/api/notifications/mediabrowser/${id}`);
}

export async function testMediaBrowserNotification(
	id: string,
	payload?: Record<string, unknown>
): Promise<MediaBrowserTestResponse> {
	const response = await apiPost(`/api/notifications/mediabrowser/${id}/test`, payload);
	return response as unknown as MediaBrowserTestResponse;
}

export async function testNewMediaBrowserNotification(
	payload: MediaBrowserServerTest
): Promise<MediaBrowserTestResponse> {
	const response = await apiPost('/api/notifications/mediabrowser/test', payload);
	return response as unknown as MediaBrowserTestResponse;
}

// The /api/logos route only implements GET; this PUT has no server handler,
// so there is no success payload to type.
export async function updateLogoSettings(payload: Record<string, unknown>) {
	return apiPut('/api/logos', payload);
}

export async function getLogoStatus() {
	return apiGet<LogoStatusResponse>('/api/logos/status');
}

export async function getLogoCountries() {
	return apiGet<LogoCountriesResponse>('/api/logos/countries');
}

export async function downloadLogos(payload: Record<string, unknown>) {
	return apiPost<LogoDownloadResponse>('/api/logos/download', payload);
}

export async function updateUserLanguage(language: string) {
	return apiPost<UserLanguageResponse>('/api/user/language', { language });
}

export async function getBlockedExtensions() {
	return apiGet<BlockedExtensionsResponse>('/api/settings/blocked-extensions');
}

export async function updateBlockedExtensions(payload: { extensions: string[] }) {
	return apiPut<BlockedExtensionsResponse>('/api/settings/blocked-extensions', payload);
}

export async function getBlockedMedia(params?: {
	search?: string;
	mediaType?: string;
	limit?: number;
	offset?: number;
}): Promise<BlockedMediaResponse> {
	const query: Record<string, string> = {};
	if (params?.search) query.search = params.search;
	if (params?.mediaType) query.mediaType = params.mediaType;
	if (params?.limit) query.limit = String(params.limit);
	if (params?.offset) query.offset = String(params.offset);
	const response = await apiGet('/api/settings/blocked-media', query);
	return response as unknown as BlockedMediaResponse;
}

export async function blockMedia(payload: {
	tmdbId: number;
	mediaType: 'movie' | 'tv';
	title: string;
	posterPath?: string | null;
	year?: number | null;
	reason?: string;
}) {
	return apiPost<BlockedMediaMutationResponse>('/api/settings/blocked-media', payload);
}

export async function unblockMedia(ids: string[]) {
	return apiDelete<BlockedMediaRemoveResponse>('/api/settings/blocked-media', { ids });
}

export async function getBlockedKeywords(): Promise<BlockedKeywordEntry[]> {
	const res = await apiGet('/api/settings/blocked-keywords');
	return res as unknown as BlockedKeywordEntry[];
}

export async function addBlockedKeyword(keywordId: number) {
	return apiPost<BlockedKeywordMutationResponse>('/api/settings/blocked-keywords', { keywordId });
}

export async function removeBlockedKeyword(id: number) {
	return apiDelete('/api/settings/blocked-keywords', { id });
}

export async function seedBlockedKeywords(): Promise<{ success: boolean; added: number }> {
	return apiPost('/api/settings/blocked-keywords', { seed: true }) as Promise<{
		success: boolean;
		added: number;
	}>;
}

export async function getFileManagementSettings() {
	return apiGet<FileManagementSettings>('/api/settings/file-management');
}

export async function updateFileManagementSettings(payload: FileManagementSettings) {
	return apiPut<FileManagementSettingsUpdateResponse>('/api/settings/file-management', payload);
}

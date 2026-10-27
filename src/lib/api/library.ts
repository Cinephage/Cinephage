import type {
	LibraryScanRequest,
	MovieUpdate,
	UnmatchedMatch,
	AddMovieRequest,
	AddSeriesRequest,
	BulkAddMoviesRequest,
	BulkAddSeriesRequest,
	UnmatchedSingleMatch,
	ManualImportRequest,
	SeriesUpdate
} from '#lib/validation/schemas.js';

import { apiGet, apiPost, apiPatch, apiPut, apiDelete, type ApiResponse } from './client.js';
import { MAX_BULK_IMPORT_JOBS } from '#lib/shared/bulk-import.js';
import type { DesiredQuality } from '#lib/types/library.js';
import type { FileScoreResponse } from '#lib/types/score.js';
import type {
	EffectiveLanguageProfile,
	EffectiveSubtitleRequirements,
	SubtitleRequirement
} from '#lib/shared/language-profile.js';
import type {
	BatchMatchResult,
	LibraryIssue,
	PaginationState,
	RootFolderOption,
	UnmatchedFile,
	UnmatchedFolder
} from '#lib/types/unmatched.js';

// ---------------------------------------------------------------------------
// Shared response payload types (client mirrors of the JSON the server emits)
// ---------------------------------------------------------------------------

/** Parsed/stored quality descriptor attached to library files. */
export interface FileQuality {
	resolution?: string;
	source?: string;
	codec?: string;
	hdr?: string;
}

/** ffprobe-derived media info stored as JSON on movie/episode file rows. */
export interface FileMediaInfo {
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
}

/** A library_job row as serialized by the library jobs endpoints. */
export interface LibraryJob {
	id: string;
	type: string;
	status: string;
	rootFolderId: string | null;
	parentJobId: string | null;
	dedupeKey: string | null;
	phase: string;
	progressCurrent: number;
	progressTotal: number | null;
	filesFound: number;
	filesProcessed: number;
	filesAdded: number;
	filesUpdated: number;
	filesRemoved: number;
	unmatchedCount: number;
	errorMessage: string | null;
	cancelRequested: boolean;
	metadata: Record<string, unknown> | null;
	startedAt: string | null;
	completedAt: string | null;
	acknowledgedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Library membership status for one TMDB entry (/api/library/status). */
export interface LibraryStatus {
	inLibrary: boolean;
	hasFile: boolean;
	monitored?: boolean;
	mediaType: 'movie' | 'tv' | null;
	libraryId?: string;
	releaseDate?: string | null;
	digitalReleaseDate?: string | null;
	physicalReleaseDate?: string | null;
}

export interface LibraryStatusResponse {
	status: LibraryStatus;
}

export interface LibraryStatusMapResponse {
	status: Record<number, LibraryStatus>;
}

/** TMDB match suggestion returned by manual import detection. */
export interface ManualImportMatch {
	tmdbId: number;
	title: string;
	year?: number;
	confidence: number;
	mediaType: 'movie' | 'tv';
	isAnime?: boolean;
	inLibrary: boolean;
	libraryId?: string;
	rootFolderId?: string | null;
	rootFolderPath?: string | null;
}

interface ManualImportDetectionData {
	sourcePath: string;
	selectedFilePath: string;
	fileName: string;
	detectedFileCount: number;
	detectedSeasons?: number[];
	suggestedSeason?: number;
	parsedTitle: string;
	parsedYear?: number;
	parsedSeason?: number;
	parsedEpisode?: number;
	parsedEpisodes?: number[];
	inferredMediaType: 'movie' | 'tv';
	matches: ManualImportMatch[];
}

export interface ManualImportDetectionGroup extends ManualImportDetectionData {
	id: string;
	displayName: string;
	sourceType: 'file' | 'folder';
}

export interface ManualImportDetectionResult extends ManualImportDetectionData {
	grouped: boolean;
	totalGroups: number;
	selectedGroupId: string;
	groups: ManualImportDetectionGroup[];
}

export interface ImportDetectResponse {
	data: ManualImportDetectionResult;
}

export interface ImportExecuteResult {
	success: boolean;
	mediaType: 'movie' | 'tv';
	tmdbId: number;
	libraryId: string;
	importedPath: string;
	importedPaths: string[];
	importedCount: number;
	transferMode: string;
}

export interface ImportExecuteResponse {
	data: ImportExecuteResult | { jobId: string; background: boolean };
}

export interface BulkImportResponse {
	data: {
		parentJobId: string;
		totalGroups: number;
		jobIds: string[];
	};
}

export interface BatchUpdateResponse {
	updatedCount: number;
}

export interface BatchDeleteResponse {
	deletedCount: number;
	removedCount: number;
	skippedCount: number;
	failedCount: number;
	errors?: Array<{ id: string; error: string }>;
}

export interface ScanQueuedResponse {
	message: string;
	jobId: string;
	status: string;
}

export interface ScanStatusResponse {
	initialized: boolean;
	scanning: boolean;
	currentScanId: string | null;
	lastScanTime: string | null;
	nextScanTime: string | null;
	scanIntervalHours: number;
	watcherStatus: { enabled: boolean; watchedFolders: string[] };
	activeJobs: LibraryJob[];
}

export interface UnmatchedListMeta {
	timestamp: string;
	filters: { mediaType?: 'movie' | 'tv'; search?: string };
	grouping?: string;
}

export interface UnmatchedFilesPayload {
	files: UnmatchedFile[];
	pagination: PaginationState;
}

export interface UnmatchedFoldersPayload {
	folders: UnmatchedFolder[];
	totalFolders: number;
	totalFiles: number;
}

export type UnmatchedListPayload = UnmatchedFilesPayload | UnmatchedFoldersPayload;

export interface UnmatchedListResponse {
	data: UnmatchedListPayload;
	meta: UnmatchedListMeta;
}

export interface UnmatchedMatchResponse {
	data: BatchMatchResult;
	meta: {
		timestamp: string;
		request?: { fileCount: number; tmdbId: number; mediaType: 'movie' | 'tv' };
	};
}

export interface ReprocessUnmatchedResponse {
	data: {
		queued: boolean;
		jobCount: number;
		jobs: LibraryJob[];
	};
	meta: { timestamp: string };
}

export interface ForceMatchAllResponse {
	data: { matched: number; failed: number; eligible: number };
	meta: { timestamp: string };
}

export interface UnmatchedIssuesResponse {
	data: {
		libraryItems: LibraryIssue[];
		rootFolders: RootFolderOption[];
		total: number;
	};
	meta: { timestamp: string };
}

/** Movie file summary nested in the movie detail payload. */
export interface MovieFileSummary {
	id: string;
	relativePath: string;
	size: number | null;
	sizeFormatted?: string;
	dateAdded: string;
	quality: FileQuality | null;
	mediaInfo: FileMediaInfo | null;
	releaseGroup: string | null;
	edition: string | null;
}

/** Subtitle row summary nested in the movie detail payload. */
export interface MovieSubtitleSummary {
	id: string;
	language: string;
	relativePath: string;
	isForced: boolean | null;
	isHearingImpaired: boolean | null;
	format: string;
	matchScore: number | null;
	providerId: string | null;
	dateAdded: string;
	wasSynced: boolean | null;
	syncOffset: number | null;
}

export interface MovieSubtitleStatus {
	satisfied: boolean;
	missing: SubtitleRequirement[];
	existing: Array<{
		language: string;
		subtitleId: string;
		isForced: boolean;
		isHearingImpaired: boolean;
		matchScore?: number;
		requirementKey: string | null;
	}>;
}

/** Full movie detail as returned by GET /api/library/movies/[id]. */
export interface MovieDetail {
	id: string;
	tmdbId: number;
	imdbId: string | null;
	providerRefs: Partial<Record<'tmdb' | 'anilist' | 'mal', string>>;
	title: string;
	originalTitle: string | null;
	year: number | null;
	overview: string | null;
	posterPath: string | null;
	backdropPath: string | null;
	runtime: number | null;
	genres: string[] | null;
	path: string;
	rootFolderId: string | null;
	rootFolderPath: string | null;
	scoringProfileId: string | null;
	desiredQualities: DesiredQuality[] | null;
	languageProfileId: string | null;
	monitored: boolean | null;
	minimumAvailability: string | null;
	added: string;
	hasFile: boolean | null;
	wantsSubtitles: boolean | null;
	/** TMDB release info overrides the stored column when available. */
	releaseDate: string | null;
	digitalReleaseDate: string | null;
	physicalReleaseDate: string | null;
	availabilityDelay: number;
	metadataLanguageMode: string;
	metadataLanguageValue: string | null;
	preferOriginalTitle: boolean | null;
	/** Legacy view derived from the v2 language pair. */
	metadataLanguage: string | null;
	tmdbStatus: string | null;
	files: MovieFileSummary[];
	subtitles: MovieSubtitleSummary[];
	subtitleStatus: MovieSubtitleStatus;
	effectiveLanguageProfile: EffectiveLanguageProfile | null;
	effectiveSubtitleRequirements: EffectiveSubtitleRequirements | null;
}

export interface MovieDetailResponse {
	movie: MovieDetail;
}

export interface MovieUpdateResponse {
	moveQueued: boolean;
	moveTaskId: string | undefined;
	moveTaskHistoryId: string | undefined;
	removedCount: number;
	failedCount?: number;
	warning?: string;
}

export interface MovieDeletedResponse {
	removed?: boolean;
}

export interface MovieScoreResponse {
	score: FileScoreResponse;
}

export interface MovieRefreshResponse {
	movie: {
		id: string;
		tmdbId: number;
		imdbId: string | null;
		title: string;
		year: number | null;
		overview: string | null;
		posterPath: string | null;
		backdropPath: string | null;
		runtime: number | null;
		genres: string[] | null;
	};
}

export interface CreateMovieResponse {
	movie: {
		id: string;
		tmdbId: number;
		title: string;
		year: number | null;
		path: string;
		monitored: boolean | null;
		searchTriggered: boolean;
		searchWarning?: string;
	};
}

export interface BulkAddMoviesResponse {
	added: number;
	skipped: number;
	errors: Array<{ tmdbId: number; title?: string; error: string }>;
	movies: Array<{ id: string; tmdbId: number; title: string }>;
}

export interface BulkAddSeriesResponse {
	added: number;
	skipped: number;
	errors: Array<{ tmdbId: number; title?: string; error: string }>;
	series: Array<{ id: string; tmdbId: number; title: string }>;
}

/** Episode file row nested in series detail episodes. */
export interface EpisodeFileSummary {
	id: string;
	seriesId: string;
	seasonNumber: number;
	episodeIds: string[] | null;
	relativePath: string;
	size: number | null;
	dateAdded: string;
	sceneName: string | null;
	releaseGroup: string | null;
	edition: string | null;
	releaseType: string | null;
	quality: FileQuality | null;
	mediaInfo: FileMediaInfo | null;
	languages: string[] | null;
	infoHash: string | null;
	lastSeenScanId: string | null;
	contentCategory: string;
	filenameSignature: string | null;
	contentHash: string | null;
	contentHashAlgorithm: string | null;
}

/** Episode row (full columns) plus per-episode subtitle aggregates. */
export interface SeriesEpisodeDetail {
	id: string;
	seriesId: string;
	seasonId: string | null;
	tmdbId: number | null;
	tvdbId: number | null;
	seasonNumber: number;
	episodeNumber: number;
	absoluteEpisodeNumber: number | null;
	title: string | null;
	overview: string | null;
	airDate: string | null;
	runtime: number | null;
	monitored: boolean | null;
	hasFile: boolean | null;
	wantsSubtitlesOverride: boolean | null;
	subtitleRequirementsOverride: SubtitleRequirement[] | null;
	lastSearchTime: string | null;
	file: EpisodeFileSummary | null;
	subtitles: Array<Omit<MovieSubtitleSummary, 'relativePath'>>;
	subtitleCount: number;
	subtitleLanguages: string[];
}

export interface SeriesSeasonDetail {
	id: string;
	seriesId: string;
	seasonNumber: number;
	monitored: boolean | null;
	name: string | null;
	overview: string | null;
	posterPath: string | null;
	airDate: string | null;
	episodeCount: number | null;
	episodeFileCount: number | null;
	episodes: SeriesEpisodeDetail[];
}

/** Full series detail as returned by GET /api/library/series/[id]. */
export interface SeriesDetail {
	id: string;
	tmdbId: number;
	tvdbId: number | null;
	imdbId: string | null;
	title: string;
	originalTitle: string | null;
	year: number | null;
	overview: string | null;
	posterPath: string | null;
	backdropPath: string | null;
	status: string | null;
	network: string | null;
	genres: string[] | null;
	path: string;
	rootFolderId: string | null;
	rootFolderPath: string | null;
	scoringProfileId: string | null;
	languageProfileId: string | null;
	monitored: boolean | null;
	seasonFolder: boolean | null;
	seriesType: string | null;
	providerRefs: Partial<Record<'tmdb' | 'anilist' | 'mal', string>>;
	added: string;
	episodeCount: number | null;
	episodeFileCount: number | null;
	wantsSubtitles: boolean | null;
	episodeGroupId: string | null;
	metadataLanguageMode: string;
	metadataLanguageValue: string | null;
	preferOriginalTitle: boolean | null;
	/** Legacy view derived from the v2 language pair. */
	metadataLanguage: string | null;
	percentComplete: number;
	seasons: SeriesSeasonDetail[];
	subtitleStatus: {
		episodesMissingSubtitles: number;
		totalSubtitles: number;
		languages: string[];
	};
	effectiveLanguageProfile: EffectiveLanguageProfile | null;
	effectiveSubtitleRequirements: EffectiveSubtitleRequirements | null;
}

export interface SeriesDetailResponse {
	series: SeriesDetail;
}

export interface SeriesUpdateResponse {
	moveQueued: boolean;
	moveTaskId: string | undefined;
	moveTaskHistoryId: string | undefined;
}

export interface SeriesDeletedResponse {
	removed?: boolean;
}

export interface CreateSeriesResponse {
	series: {
		id: string;
		tmdbId: number;
		title: string;
		year: number | null;
		path: string;
		monitored: boolean | null;
		episodeCount: number | null;
		searchTriggered: boolean;
		searchWarning?: string;
	};
}

export interface EpisodeGroupInfo {
	id: string;
	name: string;
	type: number;
	groupCount: number;
	episodeCount: number;
	description: string;
	selected: boolean;
}

export interface SeriesEpisodeGroupsResponse {
	episodeGroups: EpisodeGroupInfo[];
	selectedGroupId: string | null;
}

export interface LibraryJobsResponse {
	jobs: LibraryJob[];
}

export interface LibraryJobResponse {
	job: LibraryJob;
}

export interface ImportBatchSummaryItem {
	key: string;
	total: number;
	completed: number;
	failed: number;
	active: boolean;
	createdAt: string;
	itemName: string | null;
	acknowledged: boolean;
}

export interface ImportBatchSummaryResponse {
	batches: ImportBatchSummaryItem[];
}

export interface RetryImportBatchResponse {
	retried: number;
}

export interface DismissImportBatchResponse {
	acknowledged: number;
}

export interface CancelImportBatchResponse {
	cancelled: number;
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

export async function detectMedia(sourcePath: string, mediaType?: string, requireFile?: boolean) {
	return apiPost<ImportDetectResponse>('/api/library/import/detect', {
		sourcePath,
		mediaType,
		...(requireFile ? { requireFile } : {})
	});
}

export async function executeImport(payload: ManualImportRequest) {
	return apiPost<ImportExecuteResponse>('/api/library/import/execute', payload);
}

export interface BulkImportJob {
	request: ManualImportRequest;
	groupName?: string;
}

export async function bulkImport(jobs: BulkImportJob[]) {
	return apiPost<BulkImportResponse>('/api/library/import/bulk', { jobs });
}

/** Poll every manual_import job belonging to a bulk-submitted parentJobId. */
export async function getBulkImportProgress(parentJobId: string) {
	return getLibraryJobs({ parentJobId, type: 'manual_import', limit: MAX_BULK_IMPORT_JOBS });
}

export async function getLibraryStatus(params?: {
	tmdbIds?: number[];
	tmdbId?: number;
	mediaType?: string;
}): Promise<ApiResponse<LibraryStatusMapResponse> | ApiResponse<LibraryStatusResponse>> {
	if (params?.tmdbIds) {
		return apiPost<LibraryStatusMapResponse>('/api/library/status', {
			tmdbIds: params.tmdbIds,
			mediaType: params.mediaType
		});
	}
	if (params?.tmdbId) {
		return apiGet<LibraryStatusResponse>('/api/library/status', {
			tmdbId: String(params.tmdbId),
			...(params.mediaType ? { mediaType: params.mediaType } : {})
		});
	}
	return apiGet<LibraryStatusResponse>('/api/library/status');
}

export async function batchMovies(
	movieIds: string[],
	updates: { monitored?: boolean; scoringProfileId?: string | null }
) {
	return apiPatch<BatchUpdateResponse>('/api/library/movies/batch', { movieIds, updates });
}

export async function batchDeleteMovieFiles(
	movieIds: string[],
	deleteFiles?: boolean,
	removeFromLibrary?: boolean
) {
	return apiDelete<BatchDeleteResponse>('/api/library/movies/batch', {
		movieIds,
		deleteFiles,
		removeFromLibrary
	});
}

export async function batchSeries(
	seriesIds: string[],
	updates: { monitored?: boolean; scoringProfileId?: string | null }
) {
	return apiPatch<BatchUpdateResponse>('/api/library/series/batch', { seriesIds, updates });
}

export async function batchDeleteSeriesFiles(
	seriesIds: string[],
	deleteFiles?: boolean,
	removeFromLibrary?: boolean
) {
	return apiDelete<BatchDeleteResponse>('/api/library/series/batch', {
		seriesIds,
		deleteFiles,
		removeFromLibrary
	});
}

export async function scanLibrary(payload?: LibraryScanRequest) {
	return apiPost<ScanQueuedResponse>('/api/library/scan', payload);
}

export async function getScanStatus() {
	return apiGet<ScanStatusResponse>('/api/library/scan/status');
}

export async function getUnmatchedItems() {
	return apiGet<UnmatchedListResponse>('/api/library/unmatched');
}

export async function matchUnmatched(id: string, payload: UnmatchedSingleMatch) {
	return apiPost<UnmatchedMatchResponse>('/api/library/unmatched/match', {
		fileIds: [id],
		...payload
	});
}

export async function forceMatchUnmatched(id: string, tmdbId: number, mediaType: 'movie' | 'tv') {
	return apiPatch<UnmatchedMatchResponse>(`/api/library/unmatched/${id}`, { tmdbId, mediaType });
}

export async function reprocessUnmatched() {
	return apiPost<ReprocessUnmatchedResponse>('/api/library/unmatched');
}

export async function forceMatchAllUnmatched(minScore: number) {
	return apiPost<ForceMatchAllResponse>('/api/library/unmatched/force-match-all', { minScore });
}

export async function autoSearchMovie(movieId: string) {
	// SSE stream endpoint, not a JSON payload - deliberately untyped.
	return apiPost(`/api/library/movies/${movieId}/auto-search`);
}

export async function autoSearchSeries(seriesId: string) {
	// SSE stream endpoint, not a JSON payload - deliberately untyped.
	return apiPost(`/api/library/series/${seriesId}/auto-search`);
}

export async function refreshMovie(movieId: string) {
	return apiPost<MovieRefreshResponse>(`/api/library/movies/${movieId}/refresh`);
}

export interface RematchResponse {
	title: string;
	year?: number | null;
}

export async function rematchMovie(movieId: string, tmdbId: number) {
	return apiPost<RematchResponse>(`/api/library/movies/${movieId}/rematch`, { tmdbId });
}

export async function getMovie(movieId: string) {
	return apiGet<MovieDetailResponse>(`/api/library/movies/${movieId}`);
}

export async function updateMovie(movieId: string, data: MovieUpdate) {
	return apiPut<MovieUpdateResponse>(`/api/library/movies/${movieId}`, data);
}

export async function deleteMovie(
	movieId: string,
	deleteFiles?: boolean,
	removeFromLibrary?: boolean
) {
	const params = new URLSearchParams();
	if (deleteFiles) params.set('deleteFiles', 'true');
	if (removeFromLibrary) params.set('removeFromLibrary', 'true');
	const query = params.toString();
	return apiDelete<MovieDeletedResponse>(
		`/api/library/movies/${movieId}${query ? '?' + query : ''}`
	);
}

export async function deleteMovieFile(movieId: string, fileId: string) {
	return apiDelete(`/api/library/movies/${movieId}/files/${fileId}`);
}

export async function getMovieScore(movieId: string) {
	return apiGet<MovieScoreResponse>(`/api/library/movies/${movieId}/score`);
}

export async function getSeries(seriesId: string) {
	return apiGet<SeriesDetailResponse>(`/api/library/series/${seriesId}`);
}

export async function updateSeries(seriesId: string, data: SeriesUpdate) {
	return apiPut<SeriesUpdateResponse>(`/api/library/series/${seriesId}`, data);
}

export async function deleteSeries(
	seriesId: string,
	deleteFiles?: boolean,
	removeFromLibrary?: boolean
) {
	const params = new URLSearchParams();
	if (deleteFiles) params.set('deleteFiles', 'true');
	if (removeFromLibrary) params.set('removeFromLibrary', 'true');
	const query = params.toString();
	return apiDelete<SeriesDeletedResponse>(
		`/api/library/series/${seriesId}${query ? '?' + query : ''}`
	);
}

export async function refreshSeries(seriesId: string) {
	// SSE stream endpoint, not a JSON payload - deliberately untyped.
	return apiPost(`/api/library/series/${seriesId}/refresh`);
}

export async function rematchSeries(seriesId: string, tmdbId: number) {
	return apiPost<RematchResponse>(`/api/library/series/${seriesId}/rematch`, { tmdbId });
}

export async function getSeriesEpisodeGroups(seriesId: string) {
	return apiGet<SeriesEpisodeGroupsResponse>(`/api/library/series/${seriesId}/episode-groups`);
}

export async function createMovie(payload: AddMovieRequest) {
	return apiPost<CreateMovieResponse>('/api/library/movies', payload);
}

export async function createSeries(payload: AddSeriesRequest) {
	return apiPost<CreateSeriesResponse>('/api/library/series', payload);
}

export async function bulkAddMovies(payload: BulkAddMoviesRequest) {
	return apiPost<BulkAddMoviesResponse>('/api/library/movies/bulk', payload);
}

export async function bulkAddSeries(payload: BulkAddSeriesRequest) {
	return apiPost<BulkAddSeriesResponse>('/api/library/series/bulk', payload);
}

export async function getUnmatchedIssues() {
	return apiGet<UnmatchedIssuesResponse>('/api/library/unmatched/issues');
}

export async function batchUnmatchedMatch(payload: UnmatchedMatch) {
	return apiPost<UnmatchedMatchResponse>('/api/library/unmatched/match', payload);
}

export async function deleteSeason(seasonId: string, deleteFiles?: boolean): Promise<ApiResponse> {
	const params = new URLSearchParams();
	if (deleteFiles) params.set('deleteFiles', 'true');
	const query = params.toString();
	return apiDelete(`/api/library/seasons/${seasonId}${query ? '?' + query : ''}`);
}

export async function deleteEpisode(
	episodeId: string,
	deleteFiles?: boolean
): Promise<ApiResponse> {
	const params = new URLSearchParams();
	if (deleteFiles) params.set('deleteFiles', 'true');
	const query = params.toString();
	return apiDelete(`/api/library/episodes/${episodeId}${query ? '?' + query : ''}`);
}

export async function updateSeason(
	seasonId: string,
	data: Record<string, unknown>
): Promise<ApiResponse> {
	return apiPut(`/api/library/seasons/${seasonId}`, data);
}

export async function updateEpisode(
	episodeId: string,
	data: Record<string, unknown>
): Promise<ApiResponse> {
	return apiPut(`/api/library/episodes/${episodeId}`, data);
}

export async function getLibraryJobs(params?: {
	limit?: number;
	type?: string;
	status?: string;
	parentJobId?: string;
}) {
	const query: Record<string, string> = {};
	if (params?.limit) query.limit = String(params.limit);
	if (params?.type) query.type = params.type;
	if (params?.status) query.status = params.status;
	if (params?.parentJobId) query.parentJobId = params.parentJobId;
	return apiGet<LibraryJobsResponse>(
		'/api/library/jobs',
		Object.keys(query).length > 0 ? query : undefined
	);
}

export async function getLibraryJob(id: string) {
	return apiGet<LibraryJobResponse>(`/api/library/jobs/${id}`);
}

export async function cancelLibraryJob(id: string) {
	return apiPost<LibraryJobResponse>(`/api/library/jobs/${id}/cancel`);
}

export async function retryLibraryJob(id: string) {
	return apiPost<LibraryJobResponse>(`/api/library/jobs/${id}/retry`);
}

export async function getImportBatchSummary() {
	return apiGet<ImportBatchSummaryResponse>('/api/library/jobs/import-summary');
}

export async function retryImportBatch(key: string) {
	return apiPost<RetryImportBatchResponse>(
		`/api/library/jobs/batches/${encodeURIComponent(key)}/retry`
	);
}

export async function dismissImportBatch(key: string) {
	return apiPost<DismissImportBatchResponse>(
		`/api/library/jobs/batches/${encodeURIComponent(key)}/dismiss`
	);
}

export async function getImportBatchJobs(key: string) {
	return apiGet<LibraryJobsResponse>(`/api/library/jobs/batches/${encodeURIComponent(key)}`);
}

export async function cancelImportBatch(key: string) {
	return apiPost<CancelImportBatchResponse>(
		`/api/library/jobs/batches/${encodeURIComponent(key)}/cancel`
	);
}

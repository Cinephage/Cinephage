import type {
	SmartListCreateRequest,
	SmartListPreviewRequest,
	SmartListExternalPreviewRequest,
	SmartListItemsAction
} from '#lib/validation/schemas.js';

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import type { MonitoringTaskResult } from './monitoring.js';

// ---------------------------------------------------------------------------
// Response payload types (client mirrors of the JSON the server emits)
// ---------------------------------------------------------------------------

/** TMDB discover filter set stored on a smart list (JSON column mirror). */
export interface SmartListFilters {
	withGenres?: number[];
	withoutGenres?: number[];
	genreMode?: 'and' | 'or';
	yearMin?: number;
	yearMax?: number;
	releaseDateMin?: string;
	releaseDateMax?: string;
	voteAverageMin?: number;
	voteAverageMax?: number;
	voteCountMin?: number;
	popularityMin?: number;
	popularityMax?: number;
	withCast?: number[];
	withCrew?: number[];
	withKeywords?: number[];
	withoutKeywords?: number[];
	withWatchProviders?: number[];
	watchRegion?: string;
	certification?: string;
	certificationCountry?: string;
	runtimeMin?: number;
	runtimeMax?: number;
	withOriginalLanguage?: string;
	withStatus?: string;
	withReleaseType?: number[];
}

/** External source configuration stored on a smart list (JSON column mirror). */
export interface SmartListExternalSourceConfig {
	url?: string;
	headers?: Record<string, string>;
	listId?: string;
	username?: string;
}

/**
 * A smart_lists row as serialized by SmartListService (same shape for the
 * list, detail, create, and update endpoints; timestamps are ISO strings).
 */
export interface SmartListSummary {
	id: string;
	name: string;
	description: string | null;
	mediaType: 'movie' | 'tv';
	enabled: boolean | null;
	filters: SmartListFilters;
	sortBy: string | null;
	itemLimit: number;
	excludeInLibrary: boolean | null;
	showUpgradeableOnly: boolean | null;
	excludedTmdbIds: number[] | null;
	scoringProfileId: string | null;
	autoAddBehavior: 'disabled' | 'add_only' | 'add_and_search' | null;
	rootFolderId: string | null;
	autoAddMonitored: boolean | null;
	minimumAvailability: string | null;
	wantsSubtitles: boolean | null;
	languageProfileId: string | null;
	listSourceType: 'tmdb-discover' | 'external-json' | 'trakt-list' | 'custom-manual';
	externalSourceConfig: SmartListExternalSourceConfig | null;
	presetId: string | null;
	presetProvider: string | null;
	presetSettings: Record<string, unknown> | null;
	refreshIntervalHours: number;
	lastRefreshTime: string | null;
	lastRefreshStatus: string | null;
	lastRefreshError: string | null;
	nextRefreshTime: string | null;
	lastExternalSyncTime: string | null;
	externalSyncError: string | null;
	cachedItemCount: number | null;
	itemsInLibrary: number | null;
	itemsAutoAdded: number | null;
	createdAt: string | null;
	updatedAt: string | null;
}

/** Result of POST /api/smartlists/[id]/refresh (SmartListService RefreshResult). */
export interface SmartListRefreshResponse {
	smartListId: string;
	status: 'running' | 'success' | 'partial' | 'failed';
	itemsFound: number;
	itemsNew: number;
	itemsRemoved: number;
	itemsAutoAdded: number;
	itemsFailed: number;
	failureDetails?: Array<{ tmdbId: number; title: string; error: string }>;
	durationMs: number;
	errorMessage?: string;
}

/**
 * Response of POST /api/smartlists/[id]/items. The shape depends on the
 * action: exclude/include return `{ success, excluded | included }` while
 * addToLibrary returns the bulk-add summary.
 */
export interface SmartListItemsActionResponse {
	success?: boolean;
	excluded?: number;
	included?: number;
	added?: number;
	failed?: number;
	alreadyInLibrary?: number;
	errors?: Array<{ tmdbId: number; title: string; error: string }>;
}

/** A configurable setting exposed by a curated external-list preset. */
export interface SmartListPresetSetting {
	name: string;
	label: string;
	type: 'number' | 'string' | 'boolean' | 'select';
	min?: number;
	max?: number;
	default?: number | string | boolean;
	options?: Array<{ value: string | number; label: string }>;
	helpText?: string;
}

/** An external list preset as served by GET /api/smartlists/presets. */
export interface SmartListPreset {
	id: string;
	provider: string;
	providerName: string;
	name: string;
	description: string;
	icon: string;
	url?: string;
	config?: Record<string, unknown>;
	isDefault: boolean;
	settings: SmartListPresetSetting[];
}

/**
 * A TMDB discover (or resolved external) item as emitted by the preview
 * endpoints after the content filter pipeline stamps library status.
 */
export interface SmartListPreviewItem {
	id: number;
	title?: string;
	name?: string;
	poster_path: string | null;
	vote_average: number;
	release_date?: string;
	first_air_date?: string;
	overview?: string;
	inLibrary?: boolean;
}

/** Response of POST /api/smartlists/preview (no success envelope). */
export interface SmartListPreviewResponse {
	items: SmartListPreviewItem[];
	page: number;
	totalPages: number;
	totalResults: number;
	itemLimit: number;
	unfilteredTotal: number;
}

/** Response of POST /api/smartlists/external/preview (no success envelope). */
export interface SmartListExternalPreviewResponse {
	items: SmartListPreviewItem[];
	totalResults: number;
	totalPages: number;
	unfilteredTotal: number;
	resolvedCount: number;
	failedCount: number;
	duplicatesRemoved: number;
	/** Not emitted by the endpoint today; kept for the editor's debug panel. */
	failedItems?: Array<{ imdbId?: string; title: string; year?: number; error?: string }>;
}

/** Response of POST /api/smartlists/external/test. */
export interface SmartListExternalTestResponse {
	totalCount: number;
	failedCount: number;
}

/** Response of POST /api/smartlists/refresh-all. */
export interface SmartListRefreshAllResponse {
	message: string;
	result: MonitoringTaskResult;
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

export async function getSmartLists(): Promise<SmartListSummary[]> {
	const response = await apiGet('/api/smartlists');
	return response as unknown as SmartListSummary[];
}

export async function getSmartList(id: string): Promise<SmartListSummary> {
	const response = await apiGet(`/api/smartlists/${id}`);
	return response as unknown as SmartListSummary;
}

export async function createSmartList(payload: SmartListCreateRequest): Promise<SmartListSummary> {
	const response = await apiPost('/api/smartlists', payload);
	return response as unknown as SmartListSummary;
}

export async function updateSmartList(
	id: string,
	payload: Partial<SmartListCreateRequest>
): Promise<SmartListSummary> {
	const response = await apiPut(`/api/smartlists/${id}`, payload);
	return response as unknown as SmartListSummary;
}

export async function deleteSmartList(id: string) {
	// The endpoint responds with only the success envelope.
	return apiDelete(`/api/smartlists/${id}`);
}

export async function refreshSmartList(id: string): Promise<SmartListRefreshResponse> {
	const response = await apiPost(`/api/smartlists/${id}/refresh`);
	return response as unknown as SmartListRefreshResponse;
}

export async function refreshAllSmartLists() {
	return apiPost<SmartListRefreshAllResponse>('/api/smartlists/refresh-all');
}

export async function getSmartListPresets(): Promise<SmartListPreset[]> {
	const response = await apiGet('/api/smartlists/presets');
	return response as unknown as SmartListPreset[];
}

export async function getSmartListPreview(
	payload: SmartListPreviewRequest
): Promise<SmartListPreviewResponse> {
	const response = await apiPost('/api/smartlists/preview', payload);
	return response as unknown as SmartListPreviewResponse;
}

export async function getExternalListPreview(
	payload: SmartListExternalPreviewRequest
): Promise<SmartListExternalPreviewResponse> {
	const response = await apiPost('/api/smartlists/external/preview', payload);
	return response as unknown as SmartListExternalPreviewResponse;
}

export async function testExternalList(payload: Record<string, unknown>) {
	return apiPost<SmartListExternalTestResponse>('/api/smartlists/external/test', payload);
}

export async function getSmartListHelpers(params?: Record<string, string>) {
	// The payload depends entirely on the `helper` query param (genres,
	// providers, certifications, keywords, people, companies, languages, and
	// countries each return a different bare array), so it stays untyped.
	return apiGet('/api/smartlists/helpers', params);
}

export async function addSmartListItems(listId: string, payload: SmartListItemsAction) {
	return apiPost<SmartListItemsActionResponse>(`/api/smartlists/${listId}/items`, payload);
}

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

// ---------------------------------------------------------------------------
// Response payload types (client mirrors of the JSON the server emits)
// ---------------------------------------------------------------------------

export type RequestStatus =
	| 'pending'
	| 'approved'
	| 'awaiting_target'
	| 'failed'
	| 'declined'
	| 'expired'
	| 'cancelled'
	| 'fulfilled';

export type RequestMediaType = 'movie' | 'series';

export interface RequestEpisodeEntry {
	seasonNumber: number;
	episodeNumber: number;
}

export interface MediaRequest {
	id: string;
	mediaType: RequestMediaType;
	tmdbId: number;
	title: string;
	posterPath: string | null;
	year: number | null;
	movieId: string | null;
	seriesId: string | null;
	status: RequestStatus;
	seasons: number[] | null;
	episodes: RequestEpisodeEntry[] | null;
	requestedBy: string;
	decidedBy: string | null;
	autoApproved: boolean;
	declineReason: string | null;
	failureReason: string | null;
	expiresAt: string | null;
	decidedAt: string | null;
	fulfilledAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface QuotaStatus {
	days: number | null;
	limit: number | null;
	used: number;
	remaining: number | null;
	restricted: boolean;
}

export interface RequestCounts {
	total: number;
	pending: number;
	approved: number;
	awaiting_target: number;
	failed: number;
	declined: number;
	expired: number;
	cancelled: number;
	fulfilled: number;
}

export interface RequestCountResponse {
	counts: RequestCounts;
	quota: { movie: QuotaStatus; tv: QuotaStatus };
	autoApprove?: { movie: boolean; series: boolean };
	tvQuotaUnit?: 'episodes' | 'seasons';
}

export interface CreateRequestInput {
	mediaType: RequestMediaType;
	tmdbId: number;
	seasons?: number[];
	episodes?: RequestEpisodeEntry[];
}

export interface RequestNotification {
	id: string;
	userId: string;
	requestId: string | null;
	event: string;
	payload: Record<string, unknown>;
	readAt: string | null;
	createdAt: string;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export async function listRequests(
	options: {
		filter?: string;
		mediaType?: 'movie' | 'series';
		take?: number;
		skip?: number;
		sort?: 'added' | 'modified';
	} = {}
): Promise<MediaRequest[]> {
	const params = new URLSearchParams();
	if (options.filter && options.filter !== 'all') params.set('filter', options.filter);
	if (options.mediaType) params.set('mediaType', options.mediaType);
	if (options.take !== undefined) params.set('take', String(options.take));
	if (options.skip !== undefined) params.set('skip', String(options.skip));
	if (options.sort) params.set('sort', options.sort);
	const qs = params.toString();
	const response = await apiGet<{ requests: MediaRequest[] }>(`/api/requests${qs ? `?${qs}` : ''}`);
	return response.requests ?? [];
}

export async function getRequestCounts(): Promise<RequestCountResponse> {
	return apiGet<RequestCountResponse>('/api/requests/count');
}

export interface RequestMediaStatus {
	mediaType: 'movie' | 'series';
	tmdbId: number;
	/** Series: scopes held by active requests for this title (any requester). */
	activeScopes?: Array<{ seasons: number[]; episodes: RequestEpisodeEntry[] }>;
	/** Movie: whether any active request exists. */
	active?: boolean;
	inLibrary: boolean;
	hasFile: boolean;
	monitored: boolean;
	/** "SxEy" keys of episodes that already have files. */
	availableEpisodes: string[];
}

export async function getRequestMediaStatus(
	mediaType: 'movie' | 'series',
	tmdbId: number
): Promise<RequestMediaStatus> {
	return apiGet<RequestMediaStatus>(
		`/api/requests/media-status?mediaType=${mediaType}&tmdbId=${tmdbId}`
	);
}

export async function createRequest(input: CreateRequestInput): Promise<MediaRequest> {
	// Failures throw ApiError carrying the machine `code` (cooldown, quotas,
	// duplicates...) so callers can explain exactly why a request was refused.
	const response = await apiPost<{ request: MediaRequest }>('/api/requests', input);
	return response.request;
}

export async function cancelRequest(id: string): Promise<MediaRequest> {
	const response = await apiDelete<{ request: MediaRequest }>(`/api/requests/${id}`);
	return response.request;
}

/**
 * DELETE verb: cancels a pending request, removes a decided one outright.
 * The response shape says which happened.
 */
export async function deleteRequest(
	id: string
): Promise<{ cancelled: boolean; request?: MediaRequest }> {
	const response = await apiDelete<{
		request?: MediaRequest;
		deleted?: boolean;
	}>(`/api/requests/${id}`);
	return { cancelled: !response.deleted, request: response.request };
}

export async function approveRequest(id: string): Promise<MediaRequest> {
	const response = await apiPost<{ request: MediaRequest }>(`/api/requests/${id}/approve`, {});
	return response.request;
}

export async function declineRequest(id: string, reason: string): Promise<MediaRequest> {
	const response = await apiPost<{ request: MediaRequest }>(`/api/requests/${id}/decline`, {
		reason
	});
	return response.request;
}

export async function retryRequest(id: string): Promise<MediaRequest> {
	const response = await apiPost<{ request: MediaRequest }>(`/api/requests/${id}/retry`, {});
	return response.request;
}

export async function fulfillRequest(id: string): Promise<MediaRequest> {
	const response = await apiPost<{ request: MediaRequest }>(`/api/requests/${id}/fulfill`, {});
	return response.request;
}

export interface BulkOutcome {
	id: string;
	ok: boolean;
	status?: string;
	error?: string;
}

export async function bulkRequestAction(
	ids: string[],
	action: 'approve' | 'decline',
	reason?: string
): Promise<BulkOutcome[]> {
	const response = await apiPost<{ results: BulkOutcome[] }>('/api/requests/bulk', {
		ids,
		action,
		...(action === 'decline' && reason ? { reason } : {})
	});
	return response.results ?? [];
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function listNotifications(
	options: { unread?: boolean; take?: number } = {}
): Promise<{
	notifications: RequestNotification[];
	unreadCount: number;
}> {
	const params = new URLSearchParams();
	if (options.unread) params.set('unread', 'true');
	if (options.take !== undefined) params.set('take', String(options.take));
	const qs = params.toString();
	return apiGet<{ notifications: RequestNotification[]; unreadCount: number }>(
		`/api/user/notifications${qs ? `?${qs}` : ''}`
	);
}

export async function markNotificationsRead(ids?: string[]): Promise<void> {
	await apiPost('/api/user/notifications/read', ids ? { ids } : {});
}

// ---------------------------------------------------------------------------
// Admin settings
// ---------------------------------------------------------------------------

export interface RequestSettings {
	requestsEnabled: boolean;
	autoApprove: { movie: boolean; series: boolean };
	defaultQuotas: {
		movie: { limit: number | null; days: number | null };
		tv: { limit: number | null; days: number | null };
	};
	tvQuotaUnit: 'episodes' | 'seasons';
	pendingTtlDays: number;
	reRequestCooldownDays: number;
}

export async function getRequestSettings(): Promise<{ settings: RequestSettings }> {
	const response = await apiGet<{ settings: RequestSettings }>('/api/settings/request-settings');
	return { settings: response.settings };
}

export async function saveRequestSettings(
	settings: RequestSettings
): Promise<{ settings: RequestSettings }> {
	const response = await apiPut<{ settings: RequestSettings }>(
		'/api/settings/request-settings',
		settings
	);
	return { settings: response.settings };
}

export interface UserRequestSettings {
	userId: string;
	requestsDisabled: boolean;
	autoApprove: boolean | null;
	movieQuotaLimit: number | null;
	movieQuotaDays: number | null;
	tvQuotaLimit: number | null;
	tvQuotaDays: number | null;
}

export async function getUserRequestSettings(
	userId: string
): Promise<{ settings: UserRequestSettings }> {
	const response = await apiGet<{ settings: UserRequestSettings }>(
		`/api/settings/users/${userId}/request-settings`
	);
	return { settings: response.settings };
}

export async function saveUserRequestSettings(
	userId: string,
	settings: Partial<UserRequestSettings>
): Promise<{ settings: UserRequestSettings }> {
	const response = await apiPut<{ settings: UserRequestSettings }>(
		`/api/settings/users/${userId}/request-settings`,
		settings
	);
	return { settings: response.settings };
}

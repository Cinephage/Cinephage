import type { GrabRequest } from '#lib/validation/schemas.js';
import type { GrabResponse, QueueItem, QueueItemWithMedia, QueueStats } from '#lib/types/queue.js';

import { apiGet, apiPost, apiPatch, apiDelete, type ApiResponse } from './client.js';

/** Response of GET /api/queue. */
export interface QueueListResponse {
	data: {
		items: QueueItemWithMedia[];
		stats: QueueStats;
	};
}

/** Response of POST /api/queue/relink-orphans. */
export interface RelinkOrphansResponse {
	relinked: number;
	details: string[];
}

/** One unmatched client download from GET /api/queue/unmatched. */
export interface UnmatchedDownloadItem {
	hash: string;
	name: string;
	size: number;
	status: string;
	progress: number;
	category?: string;
	/** Movie vs TV, resolved from the client's configured category mapping. */
	mediaType: 'movie' | 'tv' | null;
	savePath: string;
	clientId: string;
	clientName: string;
	attachable: {
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		title: string;
	} | null;
	suggestion: {
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		title: string;
		year?: number;
		confidence: number;
	} | null;
}

/** Response of GET /api/queue/unmatched. */
export interface QueueUnmatchedListResponse {
	items: UnmatchedDownloadItem[];
	total: number;
	page: number;
	limit: number;
}

/** Response of POST /api/queue/clear-failed. */
export interface ClearFailedResponse {
	dryRun: boolean;
	olderThanDays: number | null;
	summary: {
		cleared: number;
		total: number;
	};
}

/** Response of POST /api/queue/:id/retry. */
export interface RetryQueueResponse {
	message: string;
	retryMode: string;
	queueItem: QueueItem;
}

export async function grabRelease(payload: GrabRequest) {
	return apiPost<GrabResponse>('/api/download/grab', payload);
}

export async function getQueue(params?: Record<string, string>) {
	return apiGet<QueueListResponse>('/api/queue', params);
}

/**
 * The single-item endpoint returns the bare queue row (no envelope) with
 * media and client info attached.
 */
export async function getQueueItem(
	id: string
): Promise<QueueItem & { media: unknown; downloadClient: unknown }> {
	const response = await apiGet(`/api/queue/${id}`);
	return response as unknown as QueueItem & { media: unknown; downloadClient: unknown };
}

export async function pauseQueueItem(id: string) {
	return apiPatch<{ action: 'paused' }>(`/api/queue/${id}`, { action: 'pause' });
}

export async function resumeQueueItem(id: string) {
	return apiPatch<{ action: 'resumed' }>(`/api/queue/${id}`, { action: 'resume' });
}

export async function removeQueueItem(
	id: string,
	opts?: { removeFromClient?: boolean; deleteFiles?: boolean; blocklist?: boolean }
) {
	const params: Record<string, string> = {};
	if (opts?.removeFromClient === false) params.removeFromClient = 'false';
	if (opts?.deleteFiles) params.deleteFiles = 'true';
	if (opts?.blocklist) params.blocklist = 'true';
	return apiDelete<{ message: string }>(`/api/queue/${id}${buildQuery(params)}`);
}

export async function retryQueueItem(id: string): Promise<ApiResponse<RetryQueueResponse>> {
	return apiPost<RetryQueueResponse>(`/api/queue/${id}/retry`);
}

/**
 * Blocklist the release behind a download history record. Works even when
 * the item no longer has a live queue row (the usual case for a failed
 * item viewed in Activity > History).
 */
export async function blocklistHistoryItem(
	historyId: string
): Promise<ApiResponse<{ blocklistId: string }>> {
	return apiPost<{ blocklistId: string }>(`/api/queue/history/${historyId}/blocklist`);
}

export async function refreshQueue(): Promise<ApiResponse> {
	return apiPost('/api/queue/refresh');
}

export async function relinkOrphans(): Promise<ApiResponse<RelinkOrphansResponse>> {
	return apiPost<RelinkOrphansResponse>('/api/queue/relink-orphans');
}

export async function getUnmatched(params?: {
	clientId?: string;
	page?: number;
	limit?: number;
	search?: string;
	mediaType?: 'movie' | 'tv';
}): Promise<ApiResponse<QueueUnmatchedListResponse>> {
	const query: Record<string, string> = {};
	if (params?.clientId) query.clientId = params.clientId;
	if (params?.page !== undefined) query.page = String(params.page);
	if (params?.limit !== undefined) query.limit = String(params.limit);
	if (params?.search) query.search = params.search;
	if (params?.mediaType) query.mediaType = params.mediaType;
	return apiGet<QueueUnmatchedListResponse>(`/api/queue/unmatched${buildQuery(query)}`);
}

export interface UnmatchedResolveResponse {
	resolved: {
		clientId: string;
		hash: string;
		name: string;
		size: number;
		progress: number;
		localPath: string | null;
		insideManagedRoot: boolean;
		searchHint: string;
	}[];
	missing: { clientId: string; hash: string; reason: string }[];
	alreadyTracked: { clientId: string; hash: string }[];
}

export async function resolveUnmatched(
	entries: { clientId: string; hash: string }[]
): Promise<ApiResponse<UnmatchedResolveResponse>> {
	const query = entries.map((e) => `${e.clientId}:${e.hash}`).join(',');
	return apiGet<UnmatchedResolveResponse>(
		`/api/queue/unmatched/resolve${buildQuery({ entries: query })}`
	);
}

export interface TrackUnmatchedResponse {
	tracked: number;
	skipped: { hash: string; reason: string }[];
	details: { hash: string; queueId?: string; reason?: string }[];
}

export function trackUnmatched(
	pairs: {
		hash: string;
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		seasonNumber?: number | null;
		episodeNumber?: number | null;
	}[]
): Promise<ApiResponse<TrackUnmatchedResponse>> {
	return apiPost<TrackUnmatchedResponse>('/api/queue/unmatched/track', { pairs });
}

export interface EnrollUnmatchedResponse {
	enrolled: number;
	skipped: { hash: string; reason: string }[];
	details: { hash: string; queueId?: string; reason?: string }[];
}

export function enrollUnmatched(
	pairs: {
		hash: string;
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		seasonNumber?: number | null;
		episodeNumber?: number | null;
		rootFolderId?: string | null;
	}[]
): Promise<ApiResponse<EnrollUnmatchedResponse>> {
	return apiPost<EnrollUnmatchedResponse>('/api/queue/unmatched/enroll', { pairs });
}

export async function clearFailedQueue(): Promise<ApiResponse<ClearFailedResponse>> {
	return apiPost<ClearFailedResponse>('/api/queue/clear-failed');
}

function buildQuery(params: Record<string, string>): string {
	const entries = Object.entries(params);
	return entries.length ? '?' + new URLSearchParams(params).toString() : '';
}

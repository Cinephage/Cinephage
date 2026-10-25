import type {
	NntpServerCreate,
	NntpServerUpdate,
	NntpServerTest
} from '#lib/validation/schemas.js';

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

/** Public NNTP server info as returned by the API (password redacted server-side). */
export interface UsenetServerInfo {
	id: string;
	name: string;
	host: string;
	port: number;
	useSsl: boolean;
	username: string | null;
	hasPassword: boolean;
	maxConnections: number;
	priority: number;
	enabled: boolean;
	downloadClientId: string | null;
	autoFetched: boolean;
	lastTestedAt: string | null;
	testResult: string | null;
	testError: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

/** Response of GET /api/usenet/servers (raw array payload). */
export type UsenetServersResponse = UsenetServerInfo[];

/** Response of POST /api/usenet/servers and PUT /api/usenet/servers/:id. */
export interface UsenetServerResponse {
	server: UsenetServerInfo;
}

/** Response of POST /api/usenet/servers/test (by id or by payload). */
export interface UsenetServerTestResponse {
	greeting?: string;
}

/** Response of POST /api/usenet/servers/sync. */
export interface UsenetServersSyncResponse {
	synced: number;
	skipped: number;
	errors: string[];
}

export async function getUsenetServers() {
	return apiGet<UsenetServersResponse>('/api/usenet/servers');
}

export async function createUsenetServer(payload: NntpServerCreate) {
	return apiPost<UsenetServerResponse>('/api/usenet/servers', payload);
}

export async function updateUsenetServer(id: string, payload: NntpServerUpdate) {
	return apiPut<UsenetServerResponse>(`/api/usenet/servers/${id}`, payload);
}

export async function deleteUsenetServer(id: string) {
	return apiDelete(`/api/usenet/servers/${id}`);
}

export async function testUsenetServer(idOrPayload: string | NntpServerTest) {
	const url =
		typeof idOrPayload === 'string'
			? `/api/usenet/servers/${idOrPayload}/test`
			: '/api/usenet/servers/test';
	return apiPost<UsenetServerTestResponse>(
		url,
		typeof idOrPayload === 'string' ? undefined : idOrPayload
	);
}

export async function syncUsenetServers() {
	return apiPost<UsenetServersSyncResponse>('/api/usenet/servers/sync');
}

import { apiGet } from './client.js';

/**
 * Client-safe mirror of the logo library payload. Source of truth:
 * src/lib/server/logos/logo-library.ts (LogoInfo + listLogos return).
 */
export interface LogoInfo {
	path: string;
	country: string;
	name: string;
	filename: string;
	url: string;
}

/** Response of GET /api/logos. */
export interface LogosResponse {
	data: LogoInfo[];
	pagination: {
		total: number;
		limit: number;
		offset: number;
		hasMore: boolean;
	};
	library: {
		totalCount: number;
	};
}

export async function getLogos(params?: Record<string, string>) {
	return apiGet<LogosResponse>('/api/logos', params);
}

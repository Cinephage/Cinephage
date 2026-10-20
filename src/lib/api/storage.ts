import { apiGet, type ApiResponse } from './client.js';

export interface InsightItem {
	id: string;
	kind: 'movie' | 'series' | 'episode' | 'file' | 'folder';
	title: string;
	subtitle?: string;
	sizeBytes?: number;
	badges?: Array<{ label: string; tone: 'info' | 'warn' | 'critical' }>;
	href?: string;
}

export interface InsightItemsResponse {
	items: InsightItem[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		totalPages: number;
	};
}

export interface InsightItemsMeta {
	insightId: string;
	insightType: string;
	filters: { page: number; limit: number };
	/**
	 * The insight's title/summary/itemCount as of this request - re-synced
	 * server-side against the live resolver total when the cached values had
	 * drifted (see the items endpoint). Prefer this over a stale `insight`
	 * prop for display once a response has come back.
	 */
	insight: { itemCount: number; summary: string | null; title: string };
}

export async function getInsightItems(
	insightId: string,
	params?: { page?: number; limit?: number }
): Promise<ApiResponse<{ data: InsightItemsResponse; meta: InsightItemsMeta }>> {
	return apiGet(`/api/storage/insights/${insightId}/items`, {
		page: String(params?.page ?? 1),
		limit: String(params?.limit ?? 50)
	});
}

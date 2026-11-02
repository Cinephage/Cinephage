import type { RequestHandler } from './$types';
import { activityService, activityStreamEvents } from '#lib/server/activity/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { ActivityFilters, ActivitySortOptions, ActivityScope } from '#lib/types/activity.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';

const logger = createChildLogger({ module: 'ActivityApi', logDomain: 'monitoring' });

const deleteHistorySchema = z.object({
	activityIds: z.array(z.string().min(1)).min(1).max(500)
});

/**
 * GET - Get unified activity with optional filtering
 *
 * Query params:
 * - status: Filter by status ('imported', 'failed', 'search_error', 'downloading', 'no_results', 'success', 'all')
 * - mediaType: Filter by media type ('movie', 'tv', 'all')
 * - search: Search in media title or release title
 * - protocol: Filter by protocol ('torrent', 'usenet', 'streaming', 'all')
 * - indexer: Filter by indexer name
 * - releaseGroup: Filter by release group
 * - resolution: Filter by resolution (e.g., '1080p', '4K')
 * - isUpgrade: Filter for upgrades only ('true', 'false')
 * - includeNoResults: Include 'no_results' activities ('true', 'false') - defaults to false
 * - downloadClientId: Filter by download client ID
 * - startDate: Filter activities after this date (ISO string)
 * - endDate: Filter activities before this date (ISO string)
 * - scope: View scope ('all', 'active', 'history')
 * - limit: Max number of results (default 50)
 * - offset: Pagination offset (default 0)
 * - sort: Sort field ('time', 'media', 'size', 'status')
 * - direction: Sort direction ('asc', 'desc')
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		// Parse query parameters
		const statusParam = url.searchParams.get('status') as ActivityFilters['status'] | null;
		const mediaType = url.searchParams.get('mediaType') as ActivityFilters['mediaType'] | null;
		const search = url.searchParams.get('search') || undefined;
		const protocol = url.searchParams.get('protocol') as ActivityFilters['protocol'] | null;
		const indexer = url.searchParams.get('indexer') || undefined;
		const releaseGroup = url.searchParams.get('releaseGroup') || undefined;
		const resolution = url.searchParams.get('resolution') || undefined;
		const isUpgradeParam = url.searchParams.get('isUpgrade');
		const includeNoResultsParam = url.searchParams.get('includeNoResults');
		const downloadClientId = url.searchParams.get('downloadClientId') || undefined;
		const startDate = url.searchParams.get('startDate') || undefined;
		const endDate = url.searchParams.get('endDate') || undefined;
		const scopeParam = url.searchParams.get('scope');
		const limitParam = url.searchParams.get('limit');
		const offsetParam = url.searchParams.get('offset');
		const sortField = url.searchParams.get('sort') as ActivitySortOptions['field'] | null;
		const sortDirection = url.searchParams.get('direction') as
			ActivitySortOptions['direction'] | null;

		// Build filters
		const filters: ActivityFilters = {
			status: statusParam || 'all',
			mediaType: mediaType || 'all',
			search,
			protocol: protocol || 'all',
			indexer,
			releaseGroup,
			resolution,
			isUpgrade: isUpgradeParam === 'true' ? true : isUpgradeParam === 'false' ? false : undefined,
			includeNoResults: includeNoResultsParam === 'true' ? true : undefined,
			downloadClientId,
			startDate,
			endDate
		};

		// Build sort options
		const sort: ActivitySortOptions = {
			field: sortField || 'time',
			direction: sortDirection || 'desc'
		};

		const scope: ActivityScope =
			scopeParam === 'active' || scopeParam === 'history' ? scopeParam : 'all';

		// Build pagination
		const limit = Math.min(limitParam ? parseInt(limitParam, 10) : 50, 500);
		const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

		// Get activities from service
		const result = await activityService.getActivities(filters, sort, { limit, offset }, scope);

		return Response.json({
			success: true,
			activities: result.activities,
			total: result.total,
			hasMore: result.hasMore,
			summary: result.summary,
			failedCount: result.failedCount
		});
	} catch (err) {
		logger.error('Error fetching activity', err instanceof Error ? err : undefined);
		return Response.json({ error: 'Failed to fetch activity', success: false }, { status: 500 });
	}
};

/**
 * DELETE - Bulk delete history rows from activity IDs
 *
 * Supported IDs:
 * - history-<downloadHistoryId>
 * - monitoring-<monitoringHistoryId>
 *
 * Queue IDs are skipped (queue lifecycle uses /api/queue handlers).
 */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = deleteHistorySchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{
				success: false,
				error: 'Validation failed',
				details: parsed.error.flatten()
			},
			{ status: 400 }
		);
	}

	try {
		const result = await activityService.deleteHistoryActivities(parsed.data.activityIds);
		const totalDeleted =
			result.deletedDownloadHistory + result.deletedMonitoringHistory + result.deletedTaskHistory;
		if (totalDeleted > 0) {
			activityStreamEvents.emitRefresh({
				action: 'delete_selected',
				timestamp: new Date().toISOString()
			});
		}
		return Response.json({
			success: true,
			...result,
			totalDeleted
		});
	} catch (err) {
		logger.error('Error deleting activity history rows', err instanceof Error ? err : undefined);
		return Response.json(
			{ success: false, error: 'Failed to delete activity entries' },
			{ status: 500 }
		);
	}
};

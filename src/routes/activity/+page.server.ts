import type { PageServerLoad } from './$types';
import type { ActivityFilters, FilterOptions } from '#lib/types/activity.js';
import { db } from '#lib/server/db/index.js';
import { downloadClients, indexers } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { activityService } from '#lib/server/activity/index.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { z } from 'zod';

type ActivityTab = 'active' | 'history' | 'unmatched';
const ACTIVE_TAB_STATUSES: NonNullable<ActivityFilters['status']>[] = [
	'all',
	'downloading',
	'seeding',
	'paused'
];
const HISTORY_TAB_STATUSES: NonNullable<ActivityFilters['status']>[] = [
	'all',
	'success',
	'failed',
	'search_error',
	'removed',
	'rejected',
	'no_results'
];

function normalizeStatusForTab(
	status: string,
	tab: ActivityTab
): NonNullable<ActivityFilters['status']> {
	const allowedStatuses = tab === 'active' ? ACTIVE_TAB_STATUSES : HISTORY_TAB_STATUSES;
	return allowedStatuses.includes(status as NonNullable<ActivityFilters['status']>)
		? (status as NonNullable<ActivityFilters['status']>)
		: 'all';
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdminPage(locals);
	const tabParam = url.searchParams.get('tab');
	const explicitTab: ActivityTab | null =
		tabParam === 'active' || tabParam === 'history' || tabParam === 'unmatched' ? tabParam : null;

	// Parse all filter parameters
	const rawStatus = url.searchParams.get('status') || 'all';
	const mediaType = url.searchParams.get('mediaType') || 'all';
	const search = url.searchParams.get('search') || '';
	const protocol = url.searchParams.get('protocol') || 'all';
	const indexer = url.searchParams.get('indexer') || '';
	const releaseGroup = url.searchParams.get('releaseGroup') || '';
	const resolution = url.searchParams.get('resolution') || '';
	const isUpgrade = url.searchParams.get('isUpgrade') === 'true';
	const includeNoResults = url.searchParams.get('includeNoResults') === 'true';
	const downloadClientId = url.searchParams.get('downloadClientId') || '';

	const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
	const dateSchema = z.object({
		startDate: z.string().regex(DATE_REGEX).optional(),
		endDate: z.string().regex(DATE_REGEX).optional()
	});
	const dateParams = dateSchema.safeParse(Object.fromEntries(url.searchParams));
	const startDate = dateParams.data?.startDate || '';
	const endDate = dateParams.data?.endDate || '';

	function buildFiltersForTab(tab: ActivityTab): ActivityFilters {
		return {
			status: normalizeStatusForTab(rawStatus, tab) as ActivityFilters['status'],
			mediaType: mediaType as ActivityFilters['mediaType'],
			search: search || undefined,
			protocol: protocol as ActivityFilters['protocol'],
			indexer: indexer || undefined,
			releaseGroup: releaseGroup || undefined,
			resolution: resolution || undefined,
			isUpgrade: isUpgrade || undefined,
			includeNoResults: tab === 'history' && includeNoResults ? true : undefined,
			downloadClientId: downloadClientId || undefined,
			startDate: startDate || undefined,
			endDate: endDate || undefined
		};
	}

	let tab: ActivityTab = explicitTab ?? 'history';
	if (!explicitTab) {
		try {
			// Lightweight COUNT query instead of a full API round-trip through the 8-query pipeline
			const activeCount = await activityService.getActiveCount();
			// A running/queued background import has nothing in the download
			// queue, so it never shows up in activeCount; check it too, or the
			// page defaults to History while an import is actively running.
			const hasActiveImports = libraryJobService.hasActiveJobs('manual_import');
			tab = activeCount > 0 || hasActiveImports ? 'active' : 'history';
		} catch {
			tab = 'history';
		}
	}

	const filters = buildFiltersForTab(tab);

	// Fetch filter options and activity data in parallel — call the service directly
	// instead of routing through an internal HTTP fetch
	// The unmatched tab fetches live client state on demand client-side;
	// server-render it empty so page loads never block on client timeouts.
	const [indexerRows, clientRows, activityResult, cardStats, importBatches] = await Promise.all([
		db
			.select({ id: indexers.id, name: indexers.name })
			.from(indexers)
			.where(eq(indexers.enabled, true))
			.orderBy(indexers.name),
		db
			.select({ id: downloadClients.id, name: downloadClients.name })
			.from(downloadClients)
			.where(eq(downloadClients.enabled, true))
			.orderBy(downloadClients.name),
		tab === 'unmatched'
			? Promise.resolve(null)
			: activityService
					.getActivities(
						filters,
						{ field: 'time', direction: 'desc' },
						{ limit: 50, offset: 0 },
						tab
					)
					.catch(() => null),
		activityService.getQueueCardStats().catch(() => null),
		(async () => libraryJobService.summarizeManualImportBatches())().catch(() => [])
	]);

	const filterOptions: FilterOptions = {
		indexers: indexerRows,
		downloadClients: clientRows,
		releaseGroups: [],
		resolutions: ['4K', '2160p', '1080p', '720p', '480p', 'SD']
	};

	if (activityResult) {
		return {
			activities: activityResult.activities,
			total: activityResult.total,
			hasMore: activityResult.hasMore,
			summary: activityResult.summary,
			cardStats,
			importBatches,
			tab,
			filters,
			filterOptions
		};
	}

	return {
		activities: [],
		total: 0,
		hasMore: false,
		summary: null,
		cardStats,
		importBatches,
		tab,
		filters,
		filterOptions
	};
};

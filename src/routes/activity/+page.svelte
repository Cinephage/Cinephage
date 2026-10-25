<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { onMount, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { resolvePath } from '#lib/utils/routing.js';
	import { createSSE } from '#lib/sse/index.js';
	import {
		getActivity,
		getActivitySettings,
		setRetentionDays,
		deleteActivity,
		purgeHistory as purgeHistoryApi
	} from '#lib/api/activity.js';
	import { ApiError } from '#lib/api/client.js';
	import {
		pauseQueueItem,
		resumeQueueItem,
		removeQueueItem as removeQueueItemApi,
		retryQueueItem as retryQueueItemApi,
		refreshQueue,
		relinkOrphans,
		getUnmatched,
		blocklistHistoryItem as blocklistHistoryItemApi
	} from '#lib/api/downloads.js';
	import { layoutState, deriveMobileSseStatus } from '#lib/layout.svelte.js';
	import ActivityTable from '#lib/components/activity/ActivityTable.svelte';
	import ActivityUnmatchedCard from '#lib/components/activity/ActivityUnmatchedCard.svelte';
	import ActivityFilters from '#lib/components/activity/ActivityFilters.svelte';
	import ActiveFilters from '#lib/components/activity/ActiveFilters.svelte';
	import QueueStatsCards from '#lib/components/activity/QueueStatsCards.svelte';
	import LibraryImportJobsCard from '#lib/components/activity/LibraryImportJobsCard.svelte';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import {
		isActiveActivity,
		type UnifiedActivity,
		type ActivityFilters as FiltersType,
		type ActivityStatus,
		type ActivitySummary
	} from '#lib/types/activity.js';
	import type { ActivityStreamEvents } from '#lib/types/sse/events/activity-events.js';
	import {
		Loader2,
		Download,
		History,
		Unlink,
		Pause,
		Play,
		Ban,
		X,
		RefreshCw,
		Link2,
		Trash2,
		RotateCcw,
		Save,
		CalendarX,
		AlertTriangle
	} from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { supportsQueuePauseResume } from '#lib/components/activity/activity-display-utils.js';
	import {
		ACTIVITY_REFRESH_MIN_INTERVAL_MS,
		type ActivityTab,
		type HistoryConfirmAction,
		type ActiveBulkAction,
		type QueueCardStats,
		type QueueCardStatusFilter
	} from './activity-constants.js';
	import {
		createDefaultFilters,
		normalizeFiltersForTab,
		isHistoryActivity,
		isQueueActivityId,
		normalizeActivityStatus,
		normalizeActivity,
		sortActivitiesList,
		parseQueueStats,
		createDefaultQueueCardStats,
		buildActivityApiQueryString,
		buildFilterQueryString,
		matchesActivityFilters
	} from './activity-utils.js';

	let { data } = $props();

	// Local state for activities (for SSE updates)
	// Initialize directly from server data so the first render already has correct content.
	// The $effect below re-syncs on subsequent data changes (navigation / tab switch).
	function getInitialTab(): ActivityTab {
		return data.tab === 'active' ? 'active' : data.tab === 'unmatched' ? 'unmatched' : 'history';
	}

	function getInitialFilters(): FiltersType {
		return data.filters ? { ...data.filters } : createDefaultFilters();
	}

	let activities = $state<UnifiedActivity[]>([]);
	let total = $state(0);
	let currentPage = $state(1);
	const ACTIVITY_PAGE_SIZE = 25;
	let selectedHistoryIds = new SvelteSet<string>();
	let selectedActiveIds = new SvelteSet<string>();
	let canManageHistory = $state(false);
	let retentionDays = $state(90);
	let settingsLoading = $state(true);
	let saveRetentionLoading = $state(false);
	let purgeOlderLoading = $state(false);
	let purgeAllLoading = $state(false);
	let deleteSelectedLoading = $state(false);
	let historyConfirmOpen = $state(false);
	let historyConfirmAction = $state<HistoryConfirmAction | null>(null);
	let historyConfirmRemoveFromClient = $state(false);
	let activeConfirmOpen = $state(false);
	let activeConfirmAction = $state<ActiveBulkAction | null>(null);
	let activeConfirmBlocklist = $state(false);
	let activeBulkLoading = $state(false);
	let refreshQueueLoading = $state(false);
	let relinkOrphansLoading = $state(false);

	// Filter state - initialize from server data
	let filters = $state<FiltersType>(createDefaultFilters());
	let activeTabFilters = $state<FiltersType>(createDefaultFilters());
	let historyTabFilters = $state<FiltersType>(createDefaultFilters());
	let unmatchedTabFilters = $state<FiltersType>(createDefaultFilters());
	let activityTab = $state<ActivityTab>('history');

	// Sort state
	let sortField = $state('time');
	let sortDirection = $state<'asc' | 'desc'>('desc');

	// Loading states
	let isLoading = $state(false);
	let scrollY = $state(0);

	let refreshInFlight = $state(false);
	let lastActivityRefreshAt = 0;
	let activityRequestToken = 0;
	let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	let queueStats = $state<QueueCardStats>(createDefaultQueueCardStats());
	let unmatchedCount = $state<number | null>(null);

	// Unmatched total for the stat card. Deliberately lightweight (limit 1:
	// items discarded, suggestions computed for one row at most) and silent —
	// a dead client must never break the cards. Refreshed on mount and
	// whenever returning to the active tab.
	async function refreshUnmatchedCount(): Promise<void> {
		try {
			const res = await getUnmatched({ page: 1, limit: 1 });
			unmatchedCount = res.total;
		} catch {
			unmatchedCount = null;
		}
	}

	function getFiltersForTab(tab: ActivityTab): FiltersType {
		if (tab === 'active') return activeTabFilters;
		if (tab === 'unmatched') return unmatchedTabFilters;
		return historyTabFilters;
	}

	function setFiltersForTab(tab: ActivityTab, nextFilters: FiltersType): void {
		if (tab === 'active') {
			activeTabFilters = { ...nextFilters };
			return;
		}
		if (tab === 'unmatched') {
			unmatchedTabFilters = { ...nextFilters };
			return;
		}
		historyTabFilters = { ...nextFilters };
	}

	function isActiveQueueActivity(activity: UnifiedActivity): boolean {
		return isActiveActivity(activity) && Boolean(activity.queueItemId);
	}

	function handleToggleSelection(activityId: string, selected: boolean): void {
		if (selected) {
			selectedHistoryIds.add(activityId);
		} else {
			selectedHistoryIds.delete(activityId);
		}
	}

	function handleToggleSelectionAll(activityIds: string[], selected: boolean): void {
		if (selected) {
			for (const id of activityIds) {
				selectedHistoryIds.add(id);
			}
			return;
		}

		for (const id of activityIds) {
			selectedHistoryIds.delete(id);
		}
	}

	function handleToggleActiveSelection(activityId: string, selected: boolean): void {
		if (selected) {
			selectedActiveIds.add(activityId);
		} else {
			selectedActiveIds.delete(activityId);
		}
	}

	function handleToggleActiveSelectionAll(activityIds: string[], selected: boolean): void {
		if (selected) {
			for (const id of activityIds) {
				selectedActiveIds.add(id);
			}
			return;
		}

		for (const id of activityIds) {
			selectedActiveIds.delete(id);
		}
	}

	function reconcileSelectedHistoryIds(sourceActivities: UnifiedActivity[]): void {
		const validIds = new Set(
			sourceActivities
				.filter((a) => isHistoryActivity(a) && selectedHistoryIds.has(a.id))
				.map((a) => a.id)
		);
		if (validIds.size === selectedHistoryIds.size) return;
		selectedHistoryIds.clear();
		for (const id of validIds) selectedHistoryIds.add(id);
	}

	function reconcileSelectedActiveIds(sourceActivities: UnifiedActivity[]): void {
		const validIds = new Set(
			sourceActivities
				.filter((a) => isActiveQueueActivity(a) && selectedActiveIds.has(a.id))
				.map((a) => a.id)
		);
		if (validIds.size === selectedActiveIds.size) return;
		selectedActiveIds.clear();
		for (const id of validIds) selectedActiveIds.add(id);
	}

	function getSelectedQueueIdsByStatus(statuses: ActivityStatus[]): string[] {
		const queueIds: string[] = [];

		for (const activity of activities) {
			if (!selectedActiveIds.has(activity.id)) continue;
			if (!isActiveQueueActivity(activity) || !activity.queueItemId) continue;
			if (!supportsQueuePauseResume(activity)) continue;
			if (!statuses.includes(activity.status)) continue;
			if (!queueIds.includes(activity.queueItemId)) {
				queueIds.push(activity.queueItemId);
			}
		}

		return queueIds;
	}

	const selectedPausableQueueIds = $derived.by(() =>
		getSelectedQueueIdsByStatus(['downloading', 'seeding'])
	);
	const selectedPausedQueueIds = $derived.by(() => getSelectedQueueIdsByStatus(['paused']));

	// Cancel (terminate + remove) is eligible for anything not seeding and not
	// mid-import ('downloading' covers queued/stalled/awaiting too, collapsed
	// by mapQueueStatus). Unlike pause/resume, debrid items ARE cancelable,
	// DELETE /api/queue/[id] is protocol-agnostic, so this doesn't reuse
	// getSelectedQueueIdsByStatus, which filters out debrid via
	// supportsQueuePauseResume.
	const selectedCancelableQueueIds = $derived.by(() => {
		const queueIds: string[] = [];
		for (const activity of activities) {
			if (!selectedActiveIds.has(activity.id)) continue;
			if (!isActiveQueueActivity(activity) || !activity.queueItemId) continue;
			if (activity.status !== 'downloading' && activity.status !== 'paused') continue;
			if (!queueIds.includes(activity.queueItemId)) {
				queueIds.push(activity.queueItemId);
			}
		}
		return queueIds;
	});

	// Failed downloads live in the History tab. Retry/Remove operate on the
	// queue item linked from each selected history record via queueItemId.
	const selectedHistoryFailedQueueIds = $derived.by(() => {
		const ids: string[] = [];
		for (const activity of activities) {
			if (!selectedHistoryIds.has(activity.id)) continue;
			if (activity.status !== 'failed' || !activity.queueItemId) continue;
			if (!ids.includes(activity.queueItemId)) ids.push(activity.queueItemId);
		}
		return ids;
	});

	function getActiveBulkActionQueueIds(action: ActiveBulkAction): string[] {
		switch (action) {
			case 'pause':
				return selectedPausableQueueIds;
			case 'resume':
				return selectedPausedQueueIds;
			case 'cancel':
				return selectedCancelableQueueIds;
			case 'retry_failed':
			case 'remove_failed':
				return selectedHistoryFailedQueueIds;
		}
	}

	function applyQueueCardFilter(status: QueueCardStatusFilter): void {
		const currentStatus = filters.status ?? 'all';
		if (currentStatus === status && activityTab === (status === 'failed' ? 'history' : 'active'))
			return;

		// Failed downloads live in history (they are never active queue items),
		// so route the "Failed" card to the history tab. All other stat cards
		// filter the active queue.
		const targetTab: ActivityTab = status === 'failed' ? 'history' : 'active';
		const tabFilters = normalizeFiltersForTab({ ...filters, status }, targetTab);
		fetchActivityData(tabFilters, targetTab, { updateUrl: true });
	}

	function syncActivityUrl(nextFilters: FiltersType, tab: ActivityTab): void {
		if (typeof window === 'undefined') return;
		const queryString = buildFilterQueryString(nextFilters, tab);
		const nextUrl = resolvePath(`/activity${queryString ? `?${queryString}` : ''}`);
		window.history.replaceState(window.history.state, '', nextUrl);
	}

	function applyActivityResult(payload: {
		activities?: UnifiedActivity[];
		total?: number;
		summary?: Partial<ActivitySummary> | null;
		failedCount?: number;
	}): void {
		activities = Array.isArray(payload.activities) ? payload.activities : [];
		total = typeof payload.total === 'number' ? payload.total : total;
		if (payload.summary != null) {
			queueStats = parseQueueStats(payload.summary as Partial<ActivitySummary>);
		} else if (typeof payload.failedCount === 'number') {
			// History tab: summary is null, but failedCount is always returned.
			// Update only failedCount so the "Clear All Failed" button stays accurate.
			queueStats = { ...queueStats, failedCount: payload.failedCount };
		}
	}

	async function fetchActivityData(
		nextFilters: FiltersType,
		tab: ActivityTab,
		options: {
			offset?: number;
			updateUrl?: boolean;
			force?: boolean;
			silent?: boolean;
			limit?: number;
		} = {}
	): Promise<void> {
		const {
			offset = 0,
			updateUrl = false,
			force = false,
			silent = false,
			limit = ACTIVITY_PAGE_SIZE
		} = options;
		const normalizedFilters = normalizeFiltersForTab(nextFilters, tab);
		const requestToken = ++activityRequestToken;
		const previousActivities = [...activities];
		const previousPage = currentPage;

		if (!silent) {
			activities = [];
			isLoading = true;
		}

		try {
			const queryString = buildActivityApiQueryString(normalizedFilters, tab, {
				limit,
				offset
			});
			const params = Object.fromEntries(new URLSearchParams(queryString));
			const payload = (await getActivity(params)) as unknown as {
				success?: boolean;
				error?: string;
				activities?: UnifiedActivity[];
				total?: number;
				summary?: Partial<ActivitySummary> | null;
			};
			if (requestToken !== activityRequestToken) return;
			if (!payload?.success) {
				throw new Error(
					typeof payload?.error === 'string' ? payload.error : 'Failed to load activity'
				);
			}

			filters = normalizedFilters;
			activityTab = tab;
			setFiltersForTab(tab, normalizedFilters);
			applyActivityResult(payload);
			currentPage = Math.floor(offset / limit) + 1;

			if (updateUrl) {
				syncActivityUrl(normalizedFilters, tab);
			}

			if (force) {
				lastActivityRefreshAt = Date.now();
			}
		} catch (error) {
			activities = previousActivities;
			currentPage = previousPage;
			throw error;
		} finally {
			if (requestToken === activityRequestToken) {
				isLoading = false;
			}
		}
	}

	async function goToPage(page: number): Promise<void> {
		if (page < 1 || page > totalPages || page === currentPage) return;
		try {
			await fetchActivityData(filters, activityTab, {
				offset: (page - 1) * ACTIVITY_PAGE_SIZE,
				limit: ACTIVITY_PAGE_SIZE,
				silent: true
			});
		} catch (_error) {
			toasts.error(m.toast_activity_failedToLoadMore());
		}
	}

	const totalPages = $derived(Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE)));

	// ── Derived sorted view (server handles filtering; client handles sort) ──
	const filteredActivities = $derived.by(() => {
		const field = sortField;
		const direction = sortDirection;
		return sortActivitiesList(activities, field, direction);
	});

	// Derived inline stats (replaces inline template computations)
	const hasDownloading = $derived(
		activityTab === 'active' && filteredActivities.some((a) => a.status === 'downloading')
	);
	const downloadingCount = $derived(
		hasDownloading ? filteredActivities.filter((a) => a.status === 'downloading').length : 0
	);

	function getStatusLabel(status: NonNullable<FiltersType['status']>): string {
		switch (status) {
			case 'downloading':
				return m.status_downloading();
			case 'seeding':
				return m.status_seeding();
			case 'paused':
				return m.status_paused();
			case 'failed':
				return m.status_failed();
			case 'success':
				return m.status_success();
			case 'search_error':
				return m.status_searchError();
			case 'removed':
				return m.status_removed();
			case 'rejected':
				return m.status_rejected();
			case 'no_results':
				return m.status_noResults();
			default:
				return status;
		}
	}

	// Contextual count label: reflects the active status filter instead of
	// always saying "active downloads" / "history items".
	const countLabel = $derived.by((): string => {
		const status = filters.status ?? 'all';
		if (status === 'all') {
			return activityTab === 'active'
				? m.activity_activeCount({ total })
				: m.activity_historyCount({ total });
		}
		return m.activity_statusCount({ total, status: getStatusLabel(status) });
	});

	function removeStaleQueueLinkedRows(queueActivity: UnifiedActivity): number {
		if (!isQueueActivityId(queueActivity.id) || !queueActivity.queueItemId) {
			return 0;
		}

		const staleRowIds = new Set(
			activities
				.filter(
					(activity) =>
						activity.id !== queueActivity.id &&
						!isQueueActivityId(activity.id) &&
						activity.queueItemId === queueActivity.queueItemId
				)
				.map((activity) => activity.id)
		);

		if (staleRowIds.size === 0) {
			return 0;
		}

		activities = activities.filter((activity) => !staleRowIds.has(activity.id));

		return staleRowIds.size;
	}

	function upsertActivity(activity: Partial<UnifiedActivity>): void {
		const normalized = normalizeActivity(activity);
		if (!normalized) return;
		const inScope = matchesActivityFilters(normalized, filters, activityTab);

		const existingIndex = activities.findIndex((a) => a.id === normalized.id);

		// If the item already exists, update in place
		if (existingIndex >= 0) {
			if (!inScope) {
				const removed = activities[existingIndex];
				activities = activities.filter((entry) => entry.id !== removed.id);
				total = Math.max(0, total - 1);
				return;
			}

			const existing = activities[existingIndex];
			Object.assign(existing, normalized);
			const removedDuplicates = removeStaleQueueLinkedRows(existing);
			if (removedDuplicates > 0) {
				total = Math.max(0, total - removedDuplicates);
			}
			// Trigger reactivity by reassigning (no sort needed -- $derived handles it)
			activities = activities;
			return;
		}

		// New item: check if it belongs in the current tab scope at all
		if (!inScope) {
			return;
		}

		// Add new item (no sort needed -- $derived handles it)
		activities = [normalized, ...activities];
		const removedDuplicates = removeStaleQueueLinkedRows(normalized);
		total = Math.max(0, total + 1 - removedDuplicates);
	}

	// Update activities when data changes (navigation / tab switch / filter change)
	$effect(() => {
		const nextTab = getInitialTab();
		const initialFilters = getInitialFilters();
		activityTab = nextTab;
		activeTabFilters = nextTab === 'active' ? { ...initialFilters } : createDefaultFilters();
		historyTabFilters = nextTab === 'history' ? { ...initialFilters } : createDefaultFilters();
		// Store unsorted master list; $derived filteredActivities handles sort
		activities = data.activities;
		total = data.total;
		currentPage = 1;
		if (data.cardStats) {
			queueStats = data.cardStats as QueueCardStats;
		} else {
			queueStats = parseQueueStats((data.summary ?? null) as Partial<ActivitySummary> | null);
		}
		filters = initialFilters;
		setFiltersForTab(nextTab, initialFilters);
		// Reconcile selections against the new data (untracked to avoid circular deps)
		untrack(() => {
			reconcileSelectedHistoryIds(data.activities);
			reconcileSelectedActiveIds(data.activities);
		});
	});

	$effect(() => {
		// Only reconcile when selection mode is active to avoid unnecessary work
		// Read activities to trigger on data changes, but untrack the mutations
		const currentActivities = activities;
		if (selectedHistoryIds.size > 0) {
			untrack(() => reconcileSelectedHistoryIds(currentActivities));
		}
		if (selectedActiveIds.size > 0) {
			untrack(() => reconcileSelectedActiveIds(currentActivities));
		}
	});

	$effect(() => {
		if (activityTab !== 'history' && selectedHistoryIds.size > 0) {
			selectedHistoryIds.clear();
		}
		if (activityTab !== 'active' && selectedActiveIds.size > 0) {
			selectedActiveIds.clear();
		}
		if (
			activityTab !== 'active' &&
			activeConfirmOpen &&
			!activeBulkLoading &&
			activeConfirmAction !== 'retry_failed' &&
			activeConfirmAction !== 'remove_failed'
		) {
			activeConfirmOpen = false;
			activeConfirmAction = null;
		}
	});

	// ── Batched SSE progress updates ────────────────────────────────────
	let pendingProgressUpdates = new SvelteMap<
		string,
		{ progress: UnifiedActivity['downloadProgress']; status?: string }
	>();
	let progressFlushFrame: ReturnType<typeof requestAnimationFrame> | null = null;

	function flushProgressUpdates(): void {
		progressFlushFrame = null;
		if (pendingProgressUpdates.size === 0) return;

		const updates = pendingProgressUpdates;
		pendingProgressUpdates = new SvelteMap();

		for (const activity of activities) {
			const update = updates.get(activity.id);
			if (!update) continue;
			activity.downloadProgress = update.progress;
			if (update.status) {
				activity.status = normalizeActivityStatus(update.status);
			}
		}

		// Svelte 5 deep reactivity tracks individual property mutations on
		// $state arrays, so the template updates for downloadProgress/status
		// without needing to reassign the whole array.  Skipping the
		// `activities = activities` pattern here avoids triggering a full
		// $derived sort recomputation on every progress tick.
	}

	// SSE Connection - internally handles browser/SSR
	const sse = createSSE<ActivityStreamEvents>(
		resolvePath('/api/activity/stream'),
		{
			'activity:new': (newActivity) => {
				upsertActivity(newActivity);
			},
			'activity:seed': (seedActivities) => {
				for (const activity of seedActivities) {
					upsertActivity(activity);
				}
			},
			'activity:updated': (updated) => {
				upsertActivity(updated);
			},
			'activity:progress': (data) => {
				// Batch progress updates and flush on next animation frame
				pendingProgressUpdates.set(data.id, {
					progress: data.progress,
					status: data.status
				});
				if (progressFlushFrame === null) {
					progressFlushFrame = requestAnimationFrame(flushProgressUpdates);
				}
			},
			'activity:refresh': () => {
				if (refreshDebounceTimer !== null) clearTimeout(refreshDebounceTimer);
				refreshDebounceTimer = setTimeout(() => {
					refreshDebounceTimer = null;
					void refreshActivityData({ force: true, silent: true });
				}, 800);
			}
		},
		{
			maxRetries: Infinity
		}
	);

	$effect(() => {
		layoutState.setMobileSseStatus(deriveMobileSseStatus(sse));
		return () => {
			layoutState.clearMobileSseStatus();
		};
	});

	async function refreshActivityData(
		options: { force?: boolean; silent?: boolean } = {}
	): Promise<void> {
		const { force = false, silent = false } = options;
		if (refreshInFlight) return;
		const now = Date.now();
		if (!force && now - lastActivityRefreshAt < ACTIVITY_REFRESH_MIN_INTERVAL_MS) {
			return;
		}

		refreshInFlight = true;
		try {
			// Refresh re-fetches whichever page is currently on screen, so the
			// user's position in the paginated list is preserved across refreshes.
			await fetchActivityData(filters, activityTab, {
				force,
				silent,
				offset: (currentPage - 1) * ACTIVITY_PAGE_SIZE,
				limit: ACTIVITY_PAGE_SIZE
			});
		} finally {
			refreshInFlight = false;
			lastActivityRefreshAt = Date.now();
		}
	}

	async function handleRefreshQueue(): Promise<void> {
		if (refreshQueueLoading) return;
		refreshQueueLoading = true;
		try {
			await refreshQueue();
			toasts.success(m.toast_activity_refreshed());
			await refreshActivityData({ force: true, silent: true });
		} catch {
			toasts.error(m.toast_activity_failedToRefresh());
		} finally {
			refreshQueueLoading = false;
		}
	}

	async function handleRelinkOrphans(): Promise<void> {
		if (relinkOrphansLoading) return;
		relinkOrphansLoading = true;
		try {
			const result = (await relinkOrphans()) as {
				success: boolean;
				relinked?: number;
				error?: string;
			};
			if (!result.success) throw new Error(result.error);
			if ((result.relinked ?? 0) > 0) {
				toasts.success(m.toast_activity_relinked({ count: result.relinked! }));
			} else {
				toasts.info(m.toast_activity_relinkNone());
			}
			await refreshActivityData({ force: true, silent: true });
		} catch {
			toasts.error(m.toast_activity_failedToRelink());
		} finally {
			relinkOrphansLoading = false;
		}
	}

	async function loadHistorySettings(): Promise<void> {
		settingsLoading = true;
		try {
			let payload: { success?: boolean; retentionDays?: number; error?: string };
			try {
				payload = (await getActivitySettings()) as unknown as {
					success?: boolean;
					retentionDays?: number;
					error?: string;
				};
			} catch (error) {
				if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
					canManageHistory = false;
					return;
				}
				throw error;
			}
			if (payload.success && typeof payload.retentionDays === 'number') {
				retentionDays = payload.retentionDays;
			}
			canManageHistory = true;
		} catch (error) {
			toasts.error(m.toast_activity_failedToLoadSettings(), {
				description:
					error instanceof Error ? error.message : m.toast_activity_failedToLoadSettings()
			});
			canManageHistory = false;
		} finally {
			settingsLoading = false;
		}
	}

	onMount(() => {
		if (activityTab === 'history') {
			void loadHistorySettings();
		}
		void refreshUnmatchedCount();

		const handleFocus = () => {
			if (!sse.isConnected) {
				void refreshActivityData();
			}
		};

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible' && !sse.isConnected) {
				void refreshActivityData();
			}
		};

		const handlePageShow = () => {
			void refreshActivityData();
		};

		window.addEventListener('focus', handleFocus);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('pageshow', handlePageShow);

		return () => {
			if (progressFlushFrame !== null) {
				cancelAnimationFrame(progressFlushFrame);
				progressFlushFrame = null;
			}
			if (refreshDebounceTimer !== null) {
				clearTimeout(refreshDebounceTimer);
				refreshDebounceTimer = null;
			}
			window.removeEventListener('focus', handleFocus);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('pageshow', handlePageShow);
		};
	});

	$effect(() => {
		if (activityTab === 'history' && settingsLoading && !canManageHistory) {
			void loadHistorySettings();
		}
	});

	async function saveRetention(): Promise<void> {
		if (!canManageHistory || saveRetentionLoading) return;

		saveRetentionLoading = true;
		try {
			let payload;
			try {
				payload = await setRetentionDays(retentionDays);
			} catch (error) {
				if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
					canManageHistory = false;
					throw new Error('Admin access is required', { cause: error });
				}
				throw error;
			}

			if (!payload.success) {
				throw new Error(
					typeof payload.error === 'string' ? payload.error : 'Failed to save retention setting'
				);
			}

			retentionDays = payload.retentionDays ?? retentionDays;
			toasts.success(m.toast_activity_retentionUpdated({ count: retentionDays }));
		} catch (error) {
			toasts.error(
				error instanceof Error ? error.message : m.toast_activity_failedToSaveRetention()
			);
		} finally {
			saveRetentionLoading = false;
		}
	}

	const historyConfirmTitle = $derived.by((): string => {
		switch (historyConfirmAction) {
			case 'purge_all':
				return m.activity_history_confirmPurgeAllTitle();
			case 'purge_older_than_retention':
				return m.activity_history_confirmPurgeOlderTitle();
			case 'delete_selected':
				return m.activity_history_confirmDeleteSelectedTitle();
			default:
				return m.action_confirm();
		}
	});

	const historyConfirmMessage = $derived.by((): string => {
		switch (historyConfirmAction) {
			case 'purge_all':
				return m.activity_history_confirmPurgeAllMessage();
			case 'purge_older_than_retention':
				return m.activity_history_confirmPurgeOlderMessage({ days: retentionDays });
			case 'delete_selected':
				return m.activity_history_confirmDeleteSelectedMessage({ count: selectedHistoryIds.size });
			default:
				return '';
		}
	});

	const historyConfirmLabel = $derived.by((): string => {
		switch (historyConfirmAction) {
			case 'purge_all':
				return m.activity_history_purgeAll();
			case 'purge_older_than_retention':
				return m.activity_history_purgeOlder();
			case 'delete_selected':
				return m.activity_history_deleteSelectedCount({ count: selectedHistoryIds.size });
			default:
				return m.action_confirm();
		}
	});

	const historyConfirmLoading = $derived.by((): boolean => {
		switch (historyConfirmAction) {
			case 'purge_all':
				return purgeAllLoading;
			case 'purge_older_than_retention':
				return purgeOlderLoading;
			case 'delete_selected':
				return deleteSelectedLoading;
			default:
				return false;
		}
	});

	const activeConfirmTargetCount = $derived.by(() =>
		activeConfirmAction ? getActiveBulkActionQueueIds(activeConfirmAction).length : 0
	);

	const activeConfirmSkippedCount = $derived.by(() => {
		const isHistoryFailedAction =
			(activeConfirmAction === 'retry_failed' || activeConfirmAction === 'remove_failed') &&
			activityTab === 'history';
		const selectedCount = isHistoryFailedAction ? selectedHistoryIds.size : selectedActiveIds.size;
		return Math.max(0, selectedCount - activeConfirmTargetCount);
	});

	const activeConfirmTitle = $derived.by((): string => {
		switch (activeConfirmAction) {
			case 'pause':
				return m.activity_queue_confirmPauseTitle();
			case 'resume':
				return m.activity_queue_confirmResumeTitle();
			case 'cancel':
				return m.activity_queue_confirmCancelTitle();
			case 'retry_failed':
				return m.activity_queue_confirmRetryTitle();
			case 'remove_failed':
				return m.activity_queue_confirmRemoveTitle();
			default:
				return m.action_confirm();
		}
	});

	const activeConfirmMessage = $derived.by((): string => {
		const targetCount = activeConfirmTargetCount;
		const skippedCount = activeConfirmSkippedCount;
		const skippedSuffix =
			skippedCount > 0 ? ` ${m.activity_queue_skippedItems({ count: skippedCount })}` : '';

		switch (activeConfirmAction) {
			case 'pause':
				return m.activity_queue_confirmPauseMessage({ count: targetCount }) + skippedSuffix;
			case 'resume':
				return m.activity_queue_confirmResumeMessage({ count: targetCount }) + skippedSuffix;
			case 'cancel':
				return m.activity_queue_confirmCancelMessage({ count: targetCount }) + skippedSuffix;
			case 'retry_failed':
				return m.activity_queue_confirmRetryMessage({ count: targetCount }) + skippedSuffix;
			case 'remove_failed':
				return m.activity_queue_confirmRemoveMessage({ count: targetCount }) + skippedSuffix;
			default:
				return '';
		}
	});

	const activeConfirmLabel = $derived.by((): string => {
		switch (activeConfirmAction) {
			case 'pause':
				return m.activity_queue_pauseSelected();
			case 'resume':
				return m.activity_queue_resumeSelected();
			case 'cancel':
				return m.activity_queue_cancelSelected();
			case 'retry_failed':
				return m.activity_queue_retryFailed();
			case 'remove_failed':
				return m.activity_queue_removeFailed();
			default:
				return m.action_confirm();
		}
	});

	const activeConfirmVariant = $derived.by((): 'error' | 'warning' | 'primary' => {
		switch (activeConfirmAction) {
			case 'remove_failed':
			case 'cancel':
				return 'error';
			case 'retry_failed':
				return 'warning';
			default:
				return 'primary';
		}
	});

	const historyConfirmHasFailedItems = $derived.by((): boolean => {
		if (historyConfirmAction === 'delete_selected') return selectedHistoryFailedQueueIds.length > 0;
		return queueStats.failedCount > 0;
	});

	const historyConfirmFailedClientCount = $derived.by((): number => {
		if (historyConfirmAction === 'delete_selected') return selectedHistoryFailedQueueIds.length;
		return queueStats.failedCount;
	});

	function openHistoryConfirm(action: HistoryConfirmAction): void {
		if (!canManageHistory) return;
		if (action === 'purge_all' && (settingsLoading || purgeAllLoading)) return;
		if (action === 'purge_older_than_retention' && (settingsLoading || purgeOlderLoading)) return;
		if (action === 'delete_selected' && (deleteSelectedLoading || selectedHistoryIds.size === 0))
			return;

		historyConfirmRemoveFromClient = false;
		historyConfirmAction = action;
		historyConfirmOpen = true;
	}

	function closeHistoryConfirm(): void {
		if (historyConfirmLoading) return;
		historyConfirmOpen = false;
		historyConfirmAction = null;
		historyConfirmRemoveFromClient = false;
	}

	async function handleHistoryConfirm(): Promise<void> {
		if (!historyConfirmAction || historyConfirmLoading) return;

		const removeFromClient = historyConfirmRemoveFromClient;

		if (historyConfirmAction === 'purge_all') {
			await purgeHistory('all', { removeFromClient });
		} else if (historyConfirmAction === 'purge_older_than_retention') {
			await purgeHistory('older_than_retention', { removeFromClient });
		} else {
			await deleteSelectedHistory({ removeFromClient });
		}

		historyConfirmOpen = false;
		historyConfirmAction = null;
		historyConfirmRemoveFromClient = false;
	}

	async function purgeHistory(
		action: 'older_than_retention' | 'all',
		options: { removeFromClient?: boolean } = {}
	): Promise<void> {
		if (!canManageHistory) return;
		if (action === 'older_than_retention' && purgeOlderLoading) return;
		if (action === 'all' && purgeAllLoading) return;

		if (action === 'all') {
			purgeAllLoading = true;
		} else {
			purgeOlderLoading = true;
		}

		try {
			let payload;
			try {
				payload = await purgeHistoryApi(action, { removeFromClient: options.removeFromClient });
			} catch (error) {
				if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
					canManageHistory = false;
					throw new Error('Admin access is required', { cause: error });
				}
				throw error;
			}

			if (!payload.success) {
				throw new Error(
					typeof payload.error === 'string' ? payload.error : 'Failed to purge activity entries'
				);
			}

			const totalDeleted =
				typeof payload.totalDeleted === 'number'
					? payload.totalDeleted
					: (payload.deletedDownloadHistory ?? 0) +
						(payload.deletedMonitoringHistory ?? 0) +
						(payload.deletedTaskHistory ?? 0);
			toasts.success(m.toast_activity_deletedEntries({ count: totalDeleted }));
			selectedHistoryIds.clear();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.toast_activity_failedToPurge());
			return;
		}

		try {
			await refreshActivityData({ force: true, silent: true });
		} catch (_error) {
			toasts.info(m.toast_activity_purgeCompleted());
		} finally {
			purgeOlderLoading = false;
			purgeAllLoading = false;
		}
	}

	async function deleteSelectedHistory(
		options: { removeFromClient?: boolean } = {}
	): Promise<void> {
		if (!canManageHistory || deleteSelectedLoading || selectedHistoryIds.size === 0) return;

		deleteSelectedLoading = true;

		// Remove from download client first so the queue records exist when we call the endpoint
		if (options.removeFromClient && selectedHistoryFailedQueueIds.length > 0) {
			for (const queueId of selectedHistoryFailedQueueIds) {
				try {
					await removeQueueItemApi(queueId, { removeFromClient: true, deleteFiles: true });
				} catch (_err) {
					// Best-effort; proceed with history deletion regardless
				}
			}
		}

		try {
			let payload;
			try {
				payload = await deleteActivity([...selectedHistoryIds]);
			} catch (error) {
				if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
					canManageHistory = false;
					throw new Error(m.toast_activity_adminRequired(), { cause: error });
				}
				throw error;
			}

			if (!payload.success) {
				throw new Error(
					typeof payload.error === 'string'
						? payload.error
						: m.toast_activity_failedToDeleteSelected()
				);
			}

			const totalDeleted =
				typeof payload.totalDeleted === 'number'
					? payload.totalDeleted
					: (payload.deletedDownloadHistory ?? 0) +
						(payload.deletedMonitoringHistory ?? 0) +
						(payload.deletedTaskHistory ?? 0);
			const skippedQueue = typeof payload.skippedQueue === 'number' ? payload.skippedQueue : 0;
			const skippedRetryableFailed =
				typeof payload.skippedRetryableFailed === 'number' ? payload.skippedRetryableFailed : 0;

			toasts.success(m.toast_activity_deletedEntries({ count: totalDeleted }));
			if (skippedQueue > 0) {
				toasts.info(m.activity_history_skippedActiveDownloads({ count: skippedQueue }));
			}
			if (skippedRetryableFailed > 0) {
				toasts.info(m.activity_history_skippedRetryableFailed({ count: skippedRetryableFailed }));
			}

			selectedHistoryIds.clear();
		} catch (error) {
			toasts.error(
				error instanceof Error ? error.message : m.toast_activity_failedToDeleteSelected()
			);
			return;
		}

		try {
			await refreshActivityData({ force: true, silent: true });
		} catch (_error) {
			toasts.info(m.toast_activity_deleteCompleted());
		} finally {
			deleteSelectedLoading = false;
		}
	}

	function openActiveConfirm(action: ActiveBulkAction): void {
		if (activeBulkLoading) return;
		if (action === 'pause' || action === 'resume' || action === 'cancel') {
			if (activityTab !== 'active') return;
		} else {
			// retry_failed / remove_failed work from the History tab
			if (activityTab !== 'active' && activityTab !== 'history') return;
		}
		if (getActiveBulkActionQueueIds(action).length === 0) return;

		activeConfirmAction = action;
		activeConfirmBlocklist = false;
		activeConfirmOpen = true;
	}

	function closeActiveConfirm(): void {
		if (activeBulkLoading) return;
		activeConfirmOpen = false;
		activeConfirmAction = null;
	}

	const activeConfirmSupportsBlocklist = $derived(
		activeConfirmAction === 'cancel' || activeConfirmAction === 'remove_failed'
	);

	async function handleActiveConfirm(): Promise<void> {
		if (!activeConfirmAction || activeBulkLoading) return;

		await executeActiveBulkAction(activeConfirmAction, activeConfirmBlocklist);
		activeConfirmOpen = false;
		activeConfirmAction = null;
	}

	async function executeActiveBulkAction(
		action: ActiveBulkAction,
		blocklist = false
	): Promise<void> {
		const queueIds = getActiveBulkActionQueueIds(action);
		if (queueIds.length === 0) return;

		activeBulkLoading = true;
		let successCount = 0;
		let failedCount = 0;
		let firstFailureMessage: string | null = null;

		const runForQueueId =
			action === 'pause'
				? (queueId: string) => runQueueAction(queueId, 'pause')
				: action === 'resume'
					? (queueId: string) => runQueueAction(queueId, 'resume')
					: action === 'retry_failed'
						? (queueId: string) => retryQueueItem(queueId, { refresh: false })
						: // 'cancel' and 'remove_failed' both terminate-at-client + remove from
							// the queue; they differ only in which rows feed them and the toast
							// copy shown afterward.
							(queueId: string) =>
								removeQueueItem(queueId, {
									refresh: false,
									removeFromClient: true,
									deleteFiles: true,
									blocklist
								});

		for (const queueId of queueIds) {
			try {
				await runForQueueId(queueId);
				successCount += 1;
			} catch (error) {
				failedCount += 1;
				if (!firstFailureMessage) {
					firstFailureMessage =
						error instanceof Error ? error.message : 'One or more actions failed';
				}
			}
		}

		try {
			if (
				successCount > 0 &&
				(action === 'retry_failed' || action === 'remove_failed' || action === 'cancel')
			) {
				await refreshActivityData({ force: true, silent: true });
			}
		} catch (_error) {
			toasts.info(m.toast_activity_queueActionCompleted());
		} finally {
			activeBulkLoading = false;
		}

		if (successCount > 0) {
			const toastMessage =
				action === 'pause'
					? m.toast_activity_pausedDownloads({ count: successCount })
					: action === 'resume'
						? m.toast_activity_resumedDownloads({ count: successCount })
						: action === 'cancel'
							? m.toast_activity_cancelledDownloads({ count: successCount })
							: action === 'retry_failed'
								? m.toast_activity_retriedDownloads({ count: successCount })
								: m.toast_activity_removedDownloads({ count: successCount });
			toasts.success(toastMessage);
		}
		if (failedCount > 0) {
			const suffix = firstFailureMessage ? ` First error: ${firstFailureMessage}` : '';
			const toastMessage =
				action === 'pause'
					? m.toast_activity_failedToPause()
					: action === 'resume'
						? m.toast_activity_failedToResume()
						: action === 'cancel'
							? m.toast_activity_failedToCancel()
							: action === 'retry_failed'
								? m.toast_activity_failedToRetry()
								: m.toast_activity_failedToRemove();
			toasts.error(`${toastMessage}${suffix}`);
		}

		if (action === 'retry_failed' || action === 'remove_failed' || action === 'cancel') {
			if (activityTab === 'history') selectedHistoryIds.clear();
			else selectedActiveIds.clear();
		}
	}

	// Apply filters by fetching activity data directly and syncing the URL.
	async function applyFilters(newFilters: FiltersType, tab: ActivityTab = activityTab) {
		const normalizedFilters = normalizeFiltersForTab(newFilters, tab);
		try {
			await fetchActivityData(normalizedFilters, tab, { updateUrl: true });
		} catch (_error) {
			toasts.error(m.activity_failedToUpdateFilters());
		} finally {
			// handled by fetchActivityData
		}
	}

	// Unmatched has no queue/history fetch pipeline of its own (it reads
	// live client state directly - see switchTab's comment below), so unlike
	// applyFilters this only lifts state + syncs the URL; ActivityUnmatchedCard
	// does its own fetch.
	function applyUnmatchedFilters(newFilters: FiltersType): void {
		setFiltersForTab('unmatched', newFilters);
		syncActivityUrl(newFilters, 'unmatched');
	}

	async function switchTab(tab: ActivityTab): Promise<void> {
		if (tab === activityTab) return;

		// The unmatched tab fetches live client state itself; keep it out
		// of the queue/history fetch pipeline entirely.
		if (tab === 'unmatched') {
			activityTab = 'unmatched';
			setFiltersForTab('unmatched', getFiltersForTab('unmatched'));
			syncActivityUrl(getFiltersForTab('unmatched'), 'unmatched');
			return;
		}

		// Returning to the active tab re-syncs the unmatched card count.
		if (tab === 'active') {
			void refreshUnmatchedCount();
		}

		const tabFilters = normalizeFiltersForTab(getFiltersForTab(tab), tab);
		try {
			await fetchActivityData(tabFilters, tab, { updateUrl: true });
		} catch (_error) {
			toasts.error(m.toast_activity_failedToSwitchTab());
		} finally {
			// handled by fetchActivityData
		}
	}

	// Remove a specific filter
	function removeFilter(key: keyof FiltersType) {
		const newFilters = { ...filters };
		if (key === 'status' || key === 'mediaType' || key === 'protocol') {
			newFilters[key] = 'all';
		} else {
			delete newFilters[key];
		}
		applyFilters(newFilters);
	}

	// Clear all filters
	function clearAllFilters() {
		applyFilters({
			status: 'all',
			mediaType: 'all',
			protocol: 'all'
		});
	}

	// Handle sort (just update state; $derived filteredActivities recomputes)
	function handleSort(field: string) {
		if (sortField === field) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDirection = 'desc';
		}
	}

	function applyQueueStatusLocally(id: string, status: ActivityStatus, statusReason?: string) {
		let changed = false;
		for (const activity of activities) {
			if (activity.queueItemId === id) {
				activity.status = status;
				if (statusReason !== undefined) {
					activity.statusReason = statusReason;
				}
				changed = true;
			}
		}
		if (changed) {
			activities = activities;
		}
	}

	async function runQueueAction(id: string, action: 'pause' | 'resume') {
		try {
			if (action === 'pause') {
				await pauseQueueItem(id);
			} else {
				await resumeQueueItem(id);
			}
			applyQueueStatusLocally(id, action === 'pause' ? 'paused' : 'downloading');
		} catch (error) {
			const message =
				error instanceof ApiError
					? error.message
					: error instanceof Error
						? error.message
						: `Failed to ${action}`;
			throw new Error(message, { cause: error });
		}
	}

	async function removeQueueItem(
		id: string,
		options: {
			refresh?: boolean;
			removeFromClient?: boolean;
			deleteFiles?: boolean;
			blocklist?: boolean;
		} = {}
	): Promise<void> {
		const {
			refresh = true,
			removeFromClient = true,
			deleteFiles = false,
			blocklist = false
		} = options;
		await removeQueueItemApi(id, { removeFromClient, deleteFiles, blocklist });

		if (refresh) {
			await refreshActivityData({ force: true, silent: true });
		}
	}

	async function retryQueueItem(id: string, options: { refresh?: boolean } = {}): Promise<void> {
		const { refresh = true } = options;
		const data = await retryQueueItemApi(id);
		// Retry responses vary by mode (download vs import); read dynamically.
		const payload = data as unknown as Record<string, unknown>;

		const retryMode = typeof payload.retryMode === 'string' ? payload.retryMode : 'download';
		const importStatus = typeof payload.importStatus === 'string' ? payload.importStatus : null;
		if (retryMode === 'import') {
			const reason =
				importStatus === 'pending_retry'
					? m.activity_retryMode_waitingForPath()
					: m.activity_retryMode_importInProgress();
			applyQueueStatusLocally(id, 'downloading', reason);
		} else {
			applyQueueStatusLocally(id, 'downloading');
		}

		if (refresh && retryMode !== 'import') {
			await refreshActivityData({ force: true, silent: true });
		}
	}

	// Queue actions
	async function handlePause(id: string) {
		await runQueueAction(id, 'pause');
	}

	async function handleResume(id: string) {
		await runQueueAction(id, 'resume');
	}

	async function handleRemove(
		id: string,
		options?: { deleteFiles?: boolean; blocklist?: boolean }
	) {
		await removeQueueItem(id, {
			deleteFiles: options?.deleteFiles,
			blocklist: options?.blocklist
		});
	}

	async function handleRetry(id: string) {
		await retryQueueItem(id);
	}

	async function handleBlocklistHistory(historyId: string) {
		await blocklistHistoryItemApi(historyId);
		await refreshActivityData({ force: true, silent: true });
	}
</script>

<svelte:head>
	<title>{m.activity_pageTitle()}</title>
</svelte:head>

<svelte:window
	onscroll={() => {
		scrollY = window.scrollY;
	}}
/>

<!-- Scroll to top -->
{#if scrollY > 300}
	<button
		class="btn fixed right-6 bottom-6 z-50 gap-1.5 opacity-80 shadow-lg transition-opacity btn-neutral btn-sm hover:opacity-100"
		onclick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
		aria-label="Scroll to top"
	>
		<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
			><path d="M8 12V4M4 8l4-4 4 4" /></svg
		>
	</button>
{/if}

<div class="space-y-5">
	<!-- Header -->
	<div>
		<h1 class="text-2xl font-bold">{m.activity_title()}</h1>
		<p class="mt-1 text-sm text-base-content/70">{m.activity_subtitle()}</p>
	</div>

	<!-- Always visible, above the tabs: Failed and Unmatched are shortcuts
	     into the other two tabs, so this row reads as a permanent dashboard
	     strip rather than something repeated per-tab - also leaves room to
	     grow (e.g. sub-cards scoped to whichever tab is active) without
	     fighting for space with the tab bar itself. -->
	<QueueStatsCards
		stats={queueStats}
		activeFilter={(filters.status ?? 'all') as QueueCardStatusFilter}
		onFilterSelect={applyQueueCardFilter}
		{unmatchedCount}
		unmatchedActive={activityTab === 'unmatched'}
		onUnmatchedSelect={() => switchTab('unmatched')}
	/>

	<LibraryImportJobsCard batches={data.importBatches} />

	<!-- Tabs -->
	<div class="flex scrollbar-none overflow-x-auto border-b border-base-200">
		<button
			class="flex shrink-0 cursor-pointer items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors
				{activityTab === 'active'
				? 'border-primary text-primary'
				: 'border-transparent text-base-content/60 hover:text-base-content'}"
			onclick={() => switchTab('active')}
		>
			<Download class="h-4 w-4" />
			{m.activity_tabActive()}
			{#if queueStats.totalCount > 0}
				<span class="badge badge-sm {activityTab === 'active' ? 'badge-primary' : 'badge-ghost'}">
					{queueStats.totalCount}
				</span>
			{/if}
		</button>
		<button
			class="flex shrink-0 cursor-pointer items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors
				{activityTab === 'history'
				? 'border-primary text-primary'
				: 'border-transparent text-base-content/60 hover:text-base-content'}"
			onclick={() => switchTab('history')}
		>
			<History class="h-4 w-4" />
			{m.activity_tabHistory()}
		</button>
		<button
			class="flex shrink-0 cursor-pointer items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors
				{activityTab === 'unmatched'
				? 'border-primary text-primary'
				: 'border-transparent text-base-content/60 hover:text-base-content'}"
			onclick={() => switchTab('unmatched')}
		>
			<Unlink class="h-4 w-4" />
			{m.activity_tabUnmatched()}
			{#if unmatchedCount}
				<span
					class="badge badge-sm {activityTab === 'unmatched' ? 'badge-primary' : 'badge-ghost'}"
				>
					{unmatchedCount}
				</span>
			{/if}
		</button>
	</div>

	{#if activityTab === 'unmatched'}
		<ActivityUnmatchedCard
			downloadClients={data.filterOptions.downloadClients}
			filters={unmatchedTabFilters}
			onFiltersChange={applyUnmatchedFilters}
		/>
	{:else}
		<!-- Unified Toolbar -->
		<ActivityFilters
			{filters}
			filterOptions={data.filterOptions}
			statusContext={activityTab}
			onFiltersChange={applyFilters}
			showActiveFilters={true}
			showHistoryControls={canManageHistory && activityTab === 'history'}
		>
			{#snippet activeFiltersContent()}
				<ActiveFilters
					{filters}
					downloadClients={data.filterOptions.downloadClients}
					onFilterRemove={removeFilter}
					onClearAll={clearAllFilters}
				/>
				{#if activityTab === 'active'}
					<div class="mt-3 flex flex-wrap items-center gap-2">
						<span class="text-sm font-bold tracking-wide text-base-content/70"
							>{m.activity_queue_bulkActionsHeading()}</span
						>
						<div class="divider m-0 divider-horizontal h-6"></div>

						{#if selectedActiveIds.size > 0}
							<span class="text-xs text-base-content/60"
								>{m.common_selected({ count: selectedActiveIds.size })}</span
							>
							<button
								class="btn gap-1.5 btn-outline btn-sm"
								onclick={() => openActiveConfirm('pause')}
								disabled={activeBulkLoading || selectedPausableQueueIds.length === 0}
							>
								<Pause class="h-3.5 w-3.5" />
								{m.activity_queue_pauseCount({ count: selectedPausableQueueIds.length })}
							</button>
							<button
								class="btn gap-1.5 btn-sm btn-success"
								onclick={() => openActiveConfirm('resume')}
								disabled={activeBulkLoading || selectedPausedQueueIds.length === 0}
							>
								<Play class="h-3.5 w-3.5" />
								{m.activity_queue_resumeCount({ count: selectedPausedQueueIds.length })}
							</button>
							<button
								class="btn gap-1.5 btn-error btn-sm"
								onclick={() => openActiveConfirm('cancel')}
								disabled={activeBulkLoading || selectedCancelableQueueIds.length === 0}
							>
								<Ban class="h-3.5 w-3.5" />
								{m.activity_queue_cancelCount({ count: selectedCancelableQueueIds.length })}
							</button>
							<div class="ml-auto"></div>
							<button
								class="btn gap-1.5 btn-outline btn-sm"
								onclick={() => {
									selectedActiveIds.clear();
								}}
								disabled={activeBulkLoading || selectedActiveIds.size === 0}
							>
								<X class="h-3.5 w-3.5" />
								{m.activity_queue_clearSelection()}
							</button>
						{:else}
							<span class="text-xs text-base-content/60">
								{m.activity_queue_bulkHint()}
							</span>
							<div class="ml-auto"></div>
							<div class="divider m-0 divider-horizontal h-6"></div>
							<button
								class="btn gap-1.5 btn-outline btn-sm"
								onclick={handleRefreshQueue}
								disabled={refreshQueueLoading}
							>
								{#if refreshQueueLoading}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else}
									<RefreshCw class="h-3.5 w-3.5" />
								{/if}
								{m.activity_queue_refresh()}
							</button>
							<button
								class="btn gap-1.5 btn-outline btn-sm"
								onclick={handleRelinkOrphans}
								disabled={relinkOrphansLoading}
							>
								{#if relinkOrphansLoading}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else}
									<Link2 class="h-3.5 w-3.5" />
								{/if}
								{m.activity_queue_relinkOrphans()}
							</button>
						{/if}
					</div>
				{/if}
			{/snippet}

			{#snippet historyControlsContent()}
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-sm font-bold tracking-wide text-base-content/70"
						>{m.activity_history_management()}</span
					>
					<div class="divider m-0 divider-horizontal h-6"></div>
					<label class="flex items-center gap-2 text-sm">
						<span class="text-base-content/70">{m.activity_history_retention()}</span>
						<select
							class="select border-base-content/20 bg-base-200 select-sm"
							bind:value={retentionDays}
							disabled={settingsLoading}
						>
							<option value={7}>{m.activity_history_days7()}</option>
							<option value={14}>{m.activity_history_days14()}</option>
							<option value={30}>{m.activity_history_days30()}</option>
							<option value={60}>{m.activity_history_days60()}</option>
							<option value={90}>{m.activity_history_days90()}</option>
						</select>
					</label>
					<button
						class="btn gap-1.5 btn-outline btn-sm"
						onclick={saveRetention}
						disabled={settingsLoading || saveRetentionLoading}
					>
						{#if saveRetentionLoading}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<Save class="h-3.5 w-3.5" />
						{/if}
						{m.action_save()}
					</button>
					<div class="divider m-0 divider-horizontal h-6"></div>
					<button
						class="btn gap-1.5 btn-outline btn-sm"
						onclick={() => openHistoryConfirm('purge_older_than_retention')}
						disabled={settingsLoading || purgeOlderLoading}
					>
						{#if purgeOlderLoading}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<CalendarX class="h-3.5 w-3.5" />
						{/if}
						{m.activity_history_purgeOlder()}
					</button>
					{#if selectedHistoryIds.size > 0}
						<div class="divider m-0 divider-horizontal h-6"></div>
						<span class="text-xs text-base-content/60"
							>{m.common_selected({ count: selectedHistoryIds.size })}</span
						>
						<button
							class="btn gap-1.5 btn-error btn-sm"
							onclick={() => openHistoryConfirm('delete_selected')}
							disabled={deleteSelectedLoading || selectedHistoryIds.size === 0}
						>
							{#if deleteSelectedLoading}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
							{:else}
								<Trash2 class="h-3.5 w-3.5" />
							{/if}
							{m.activity_history_deleteSelectedCount({ count: selectedHistoryIds.size })}
						</button>
						{#if selectedHistoryFailedQueueIds.length > 0}
							<button
								class="btn gap-1.5 btn-sm btn-warning"
								onclick={() => openActiveConfirm('retry_failed')}
								disabled={activeBulkLoading}
							>
								<RotateCcw class="h-3.5 w-3.5" />
								{m.activity_queue_retryFailedCount({ count: selectedHistoryFailedQueueIds.length })}
							</button>
							<button
								class="btn gap-1.5 btn-error btn-sm"
								onclick={() => openActiveConfirm('remove_failed')}
								disabled={activeBulkLoading}
							>
								<Trash2 class="h-3.5 w-3.5" />
								{m.activity_queue_removeFailedCount({
									count: selectedHistoryFailedQueueIds.length
								})}
							</button>
						{/if}
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							onclick={() => selectedHistoryIds.clear()}
							disabled={deleteSelectedLoading}
						>
							<X class="h-3.5 w-3.5" />
							{m.activity_queue_clearSelection()}
						</button>
					{/if}
					<div class="ml-auto"></div>
					<button
						class="btn gap-1.5 btn-outline btn-error btn-sm"
						onclick={() => openHistoryConfirm('purge_all')}
						disabled={settingsLoading || purgeAllLoading}
					>
						{#if purgeAllLoading}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<AlertTriangle class="h-3.5 w-3.5" />
						{/if}
						{m.activity_history_purgeAll()}
					</button>
				</div>
			{/snippet}
		</ActivityFilters>

		<!-- Activity Stats -->
		<div class="flex items-center gap-4 text-sm text-base-content/70">
			<span>{countLabel}</span>
			{#if hasDownloading}
				<span class="badge gap-1 badge-info">
					<Loader2 class="h-3 w-3 animate-spin" />
					{m.activity_downloadingCount({ count: downloadingCount })}
				</span>
			{/if}
		</div>

		<!-- Activity Table -->
		{#if isLoading && filteredActivities.length === 0}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="h-8 w-8 animate-spin" />
			</div>
		{:else}
			<ActivityTable
				activities={filteredActivities}
				{sortField}
				{sortDirection}
				selectedIds={activityTab === 'history' ? selectedHistoryIds : selectedActiveIds}
				isSelectable={activityTab === 'history' ? isHistoryActivity : isActiveQueueActivity}
				onSort={handleSort}
				onPause={handlePause}
				onResume={handleResume}
				onRemove={handleRemove}
				onRetry={handleRetry}
				onBlocklistHistory={handleBlocklistHistory}
				showProgressDetail={activityTab !== 'history'}
				onToggleSelection={activityTab === 'history'
					? handleToggleSelection
					: handleToggleActiveSelection}
				onToggleSelectionAll={activityTab === 'history'
					? handleToggleSelectionAll
					: handleToggleActiveSelectionAll}
				{currentPage}
				{totalPages}
				onPageChange={goToPage}
			/>
		{/if}
	{/if}
</div>

<ConfirmationModal
	open={historyConfirmOpen}
	title={historyConfirmTitle}
	message={historyConfirmMessage}
	confirmLabel={historyConfirmLabel}
	confirmVariant="error"
	loading={historyConfirmLoading}
	onConfirm={handleHistoryConfirm}
	onCancel={closeHistoryConfirm}
>
	{#if historyConfirmHasFailedItems}
		<label class="mt-2 flex cursor-pointer items-start gap-2 text-sm">
			<input
				type="checkbox"
				class="checkbox mt-0.5 checkbox-sm checkbox-primary"
				bind:checked={historyConfirmRemoveFromClient}
				disabled={historyConfirmLoading}
			/>
			<span>
				{m.activity_history_alsoRemoveFromClient()}
				<span class="text-base-content/60">
					({m.activity_history_alsoRemoveFromClientHint({
						count: historyConfirmFailedClientCount
					})})
				</span>
			</span>
		</label>
	{/if}
</ConfirmationModal>

<ConfirmationModal
	open={activeConfirmOpen}
	title={activeConfirmTitle}
	message={activeConfirmMessage}
	confirmLabel={activeConfirmLabel}
	confirmVariant={activeConfirmVariant}
	loading={activeBulkLoading}
	onConfirm={handleActiveConfirm}
	onCancel={closeActiveConfirm}
>
	{#if activeConfirmSupportsBlocklist}
		<label class="label cursor-pointer justify-start gap-2 py-1">
			<input type="checkbox" class="checkbox checkbox-sm" bind:checked={activeConfirmBlocklist} />
			<span class="label-text text-sm">{m.activity_detail_alsoBlocklist()}</span>
		</label>
	{/if}
</ConfirmationModal>

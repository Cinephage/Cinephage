<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		Search,
		RefreshCw,
		Loader2,
		History as HistoryIcon,
		Filter,
		ChevronDown,
		ChevronUp,
		ChevronRight,
		X,
		ArrowUpDown,
		ArrowUp,
		ArrowDown,
		RotateCcw,
		Trash2,
		Pause,
		Play,
		PauseCircle,
		ExternalLink,
		Clapperboard,
		Tv,
		Info
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getSearchActivity,
		resetSearchFailures,
		deleteActivity,
		getSearchItemDetail,
		setSearchItemPaused,
		setGlobalSearchPaused
	} from '#lib/api/activity.js';
	import { ApiError } from '#lib/api/client.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import { getMediaLink } from '#lib/utils/media-link.js';
	import type {
		SearchActivityItem,
		SearchItemDetail
	} from '#lib/server/activity/activity-transformers.js';
	import type { ActivityFilters } from '#lib/types/activity.js';
	import { TASK_TYPE_LABELS } from '#lib/types/activity.js';
	import { formatRelativeTime, statusConfig } from './activity-display-utils.js';
	import { formatDuration, formatDisplayDate } from '#lib/utils/format.js';
	import ActiveFilters from './ActiveFilters.svelte';

	interface Props {
		filters: ActivityFilters;
		onFiltersChange: (filters: ActivityFilters) => void;
	}

	let { filters, onFiltersChange }: Props = $props();

	const PAGE_LIMIT = 25;
	type SearchStatusFilter = SearchActivityItem['status'] | 'all';
	type SortField = 'media' | 'status' | 'releasesFound' | 'failures' | 'time';

	// Seed local filter state from the initial prop value only (same pattern
	// as the Activity page's own getInitialFilters) - this card owns its
	// filters once mounted, same as ActivityUnmatchedCard.
	function getInitialSearch(): string {
		return filters.search ?? '';
	}
	function getInitialMediaType(): 'all' | 'movie' | 'tv' {
		return filters.mediaType === 'movie' || filters.mediaType === 'tv' ? filters.mediaType : 'all';
	}
	function getInitialStartDate(): string | undefined {
		return filters.startDate;
	}
	function getInitialEndDate(): string | undefined {
		return filters.endDate;
	}
	function getInitialStatus(): SearchStatusFilter {
		return (filters.searchStatus as SearchStatusFilter) ?? 'all';
	}
	function getInitialPausedOnly(): boolean {
		return filters.pausedOnly === true;
	}

	let items = $state<SearchActivityItem[]>([]);
	let total = $state(0);
	let page = $state(1);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let search = $state(getInitialSearch());
	let mediaType = $state<'all' | 'movie' | 'tv'>(getInitialMediaType());
	let status = $state<SearchStatusFilter>(getInitialStatus());
	let pausedOnly = $state<boolean>(getInitialPausedOnly());
	let startDate = $state<string | undefined>(getInitialStartDate());
	let endDate = $state<string | undefined>(getInitialEndDate());
	let sortField = $state<SortField>('time');
	let sortDirection = $state<'asc' | 'desc'>('desc');
	let moreFiltersExpanded = $state(false);
	let searchDebounce: ReturnType<typeof setTimeout> | undefined;

	let selected = new SvelteSet<string>();
	let bulkActionLoading = $state(false);
	let maxConsecutiveFailures = $state(5);
	let globallyPaused = $state(false);
	let globalPauseLoading = $state(false);

	let expandedId = $state<string | null>(null);
	let detail = $state<SearchItemDetail | null>(null);
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);
	let rowActionLoading = new SvelteSet<string>();

	const totalPages = $derived(Math.max(1, Math.ceil(total / PAGE_LIMIT)));
	const allSelected = $derived(items.length > 0 && items.every((item) => selected.has(item.id)));

	const statusOptions: { value: SearchStatusFilter; label: string }[] = [
		{ value: 'all', label: m.common_all() },
		{ value: 'grabbed', label: m.activity_searches_statusGrabbed() },
		{ value: 'no_results', label: m.activity_searches_statusNoResults() },
		{ value: 'skipped', label: m.activity_searches_statusSkipped() },
		{ value: 'error', label: m.status_failed() }
	];

	async function load(resetPage = false): Promise<void> {
		if (resetPage) page = 1;
		loading = true;
		loadError = null;
		try {
			const query: Record<string, string> = {
				page: String(page),
				limit: String(PAGE_LIMIT),
				sort: sortField,
				order: sortDirection
			};
			if (mediaType !== 'all') query.mediaType = mediaType;
			if (status !== 'all') query.status = status;
			if (search.trim()) query.search = search.trim();
			if (startDate) query.startDate = startDate;
			if (endDate) query.endDate = endDate;
			if (pausedOnly) query.pausedOnly = 'true';

			const res = await getSearchActivity(query);
			items = res.items ?? [];
			total = res.total ?? 0;
			if (res.maxConsecutiveFailures) maxConsecutiveFailures = res.maxConsecutiveFailures;
			globallyPaused = res.globallyPaused ?? false;
		} catch (error) {
			loadError =
				error instanceof ApiError
					? error.message
					: error instanceof Error
						? error.message
						: m.activity_searches_loadFailed();
		} finally {
			loading = false;
		}
	}

	// The manual Refresh button toasts (matching ActivityUnmatchedCard's
	// handleRefresh); filter-triggered load(true) calls stay silent -
	// loadError already surfaces those, a toast on every filter click would
	// be noise.
	async function handleRefresh(): Promise<void> {
		await load(true);
		if (loadError) toasts.error(m.activity_searches_refreshFailed());
		else toasts.success(m.activity_searches_refreshed());
	}

	// Blocks every automatic search entry point (including a manual "Run Now"
	// on the whole task) until resumed - unlike per-item pause, which a
	// single-item manual "Search Now" still bypasses.
	async function handleGlobalPauseToggle(): Promise<void> {
		const next = !globallyPaused;
		globalPauseLoading = true;
		try {
			const res = await setGlobalSearchPaused(next);
			if (res.success) {
				globallyPaused = next;
				toasts.success(
					next
						? m.activity_searches_globalPauseSuccess()
						: m.activity_searches_globalResumeSuccess()
				);
			} else {
				toasts.error(res.error ?? m.activity_searches_pauseFailed());
			}
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.activity_searches_pauseFailed());
		} finally {
			globalPauseLoading = false;
		}
	}

	function toggleSelect(id: string): void {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}

	function toggleSelectAll(): void {
		if (allSelected) {
			for (const item of items) selected.delete(item.id);
		} else {
			for (const item of items) selected.add(item.id);
		}
	}

	function selectedItems(): SearchActivityItem[] {
		return items.filter((item) => selected.has(item.id));
	}

	// Subset of the selection each bulk action actually does something to -
	// mirrors classifyActionRelevance's per-row gating (ActivityUnmatchedCard's
	// selectedAttachable/selectedSuggestable/selectedImportable precedent) so
	// the bulk buttons never silently no-op on rows they can't act on.
	function selectedSearchableItems(): SearchActivityItem[] {
		return selectedItems().filter(
			(item) =>
				classifyActionRelevance(item.status, item.errorMessage, item.consecutiveFailureCount)
					.canSearch &&
				((item.mediaType === 'movie' && item.movieId) ||
					(item.mediaType === 'episode' && item.seriesId))
		);
	}

	function selectedResettableItems(): SearchActivityItem[] {
		return selectedItems().filter(
			(item) =>
				item.consecutiveFailureCount > 0 &&
				((item.mediaType === 'movie' && item.movieId) ||
					(item.mediaType === 'episode' && item.episodeId))
		);
	}

	// Pause/resume is per-movie/episode (unlike Search Now, which groups TV at
	// the series level), so episode rows use their own episodeId here. Pause
	// is gated the same way as the per-row detail panel (nothing to pause
	// once an item is genuinely resolved); resume is never gated - a user
	// who paused something should always be able to clear that themselves.
	function selectedPausableItems(): SearchActivityItem[] {
		return selectedItems().filter(
			(item) =>
				!item.autoSearchPaused &&
				classifyActionRelevance(item.status, item.errorMessage, item.consecutiveFailureCount)
					.canPause &&
				((item.mediaType === 'movie' && item.movieId) ||
					(item.mediaType === 'episode' && item.episodeId))
		);
	}

	function selectedResumableItems(): SearchActivityItem[] {
		return selectedItems().filter(
			(item) =>
				item.autoSearchPaused &&
				((item.mediaType === 'movie' && item.movieId) ||
					(item.mediaType === 'episode' && item.episodeId))
		);
	}

	// Episode rows have no per-episode search endpoint - the series-level
	// auto-search covers all its missing episodes, same as the "Search"
	// button on a series detail page.
	async function handleSearchNow(): Promise<void> {
		const movieIds = new SvelteSet<string>();
		const seriesIds = new SvelteSet<string>();
		for (const item of selectedSearchableItems()) {
			if (item.mediaType === 'movie' && item.movieId) movieIds.add(item.movieId);
			else if (item.mediaType === 'episode' && item.seriesId) seriesIds.add(item.seriesId);
		}
		if (movieIds.size === 0 && seriesIds.size === 0) return;

		bulkActionLoading = true;
		try {
			const results = await Promise.all([
				...Array.from(movieIds).map((id) =>
					fetch(`/api/library/movies/${id}/auto-search`, { method: 'POST' })
						.then((r) => r.ok)
						.catch(() => false)
				),
				...Array.from(seriesIds).map((id) =>
					fetch(`/api/library/series/${id}/auto-search`, { method: 'POST' })
						.then((r) => r.ok)
						.catch(() => false)
				)
			]);
			const triggered = results.filter(Boolean).length;
			if (triggered > 0) {
				toasts.success(m.activity_searches_searchNowTriggered({ count: triggered }));
			}
			selected.clear();
		} finally {
			bulkActionLoading = false;
		}
	}

	async function handleResetFailures(): Promise<void> {
		const movieIds = new SvelteSet<string>();
		const episodeIds = new SvelteSet<string>();
		for (const item of selectedResettableItems()) {
			if (item.mediaType === 'movie' && item.movieId) movieIds.add(item.movieId);
			else if (item.mediaType === 'episode' && item.episodeId) episodeIds.add(item.episodeId);
		}
		if (movieIds.size === 0 && episodeIds.size === 0) return;

		bulkActionLoading = true;
		try {
			const res = await resetSearchFailures(Array.from(movieIds), Array.from(episodeIds));
			if (res.success) {
				toasts.success(
					m.activity_searches_resetFailuresSuccess({ count: movieIds.size + episodeIds.size })
				);
				selected.clear();
				await load();
			} else {
				toasts.error(res.error ?? m.activity_searches_resetFailuresFailed());
			}
		} catch (error) {
			toasts.error(
				error instanceof Error ? error.message : m.activity_searches_resetFailuresFailed()
			);
		} finally {
			bulkActionLoading = false;
		}
	}

	async function handleBulkPauseToggle(paused: boolean): Promise<void> {
		const targetItems = paused ? selectedPausableItems() : selectedResumableItems();
		const movieIds = new SvelteSet<string>();
		const episodeIds = new SvelteSet<string>();
		for (const item of targetItems) {
			if (item.mediaType === 'movie' && item.movieId) movieIds.add(item.movieId);
			else if (item.mediaType === 'episode' && item.episodeId) episodeIds.add(item.episodeId);
		}
		if (movieIds.size === 0 && episodeIds.size === 0) return;

		bulkActionLoading = true;
		try {
			const res = await setSearchItemPaused(Array.from(movieIds), Array.from(episodeIds), paused);
			if (res.success) {
				const count = movieIds.size + episodeIds.size;
				toasts.success(
					paused
						? m.activity_searches_bulkPauseSuccess({ count })
						: m.activity_searches_bulkResumeSuccess({ count })
				);
				selected.clear();
				await load();
			} else {
				toasts.error(res.error ?? m.activity_searches_pauseFailed());
			}
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.activity_searches_pauseFailed());
		} finally {
			bulkActionLoading = false;
		}
	}

	async function handleDeleteSelected(): Promise<void> {
		const ids = Array.from(selected);
		if (ids.length === 0) return;

		bulkActionLoading = true;
		try {
			const res = await deleteActivity(ids.map((id) => `monitoring-${id}`));
			if (res.success) {
				toasts.success(m.activity_searches_deleteSelectedSuccess({ count: ids.length }));
				selected.clear();
				await load();
			} else {
				toasts.error(res.error ?? m.activity_searches_deleteSelectedFailed());
			}
		} catch (error) {
			toasts.error(
				error instanceof Error ? error.message : m.activity_searches_deleteSelectedFailed()
			);
		} finally {
			bulkActionLoading = false;
		}
	}

	async function loadDetail(item: SearchActivityItem): Promise<void> {
		detail = null;
		detailError = null;
		detailLoading = true;
		try {
			const target =
				item.mediaType === 'movie' ? { movieId: item.movieId } : { episodeId: item.episodeId };
			const res = await getSearchItemDetail(target);
			detail = res.item;
		} catch (error) {
			detailError = error instanceof Error ? error.message : m.activity_searches_detailLoadFailed();
		} finally {
			detailLoading = false;
		}
	}

	async function toggleExpand(item: SearchActivityItem): Promise<void> {
		if (expandedId === item.id) {
			expandedId = null;
			detail = null;
			return;
		}
		expandedId = item.id;
		await loadDetail(item);
	}

	// Episode rows have no per-episode search endpoint - see handleSearchNow.
	async function handleSearchNowSingle(item: SearchActivityItem): Promise<void> {
		rowActionLoading.add(item.id);
		try {
			const url =
				item.mediaType === 'movie'
					? `/api/library/movies/${item.movieId}/auto-search`
					: `/api/library/series/${item.seriesId}/auto-search`;
			const [searchOk] = await Promise.all([
				fetch(url, { method: 'POST' })
					.then((r) => r.ok)
					.catch(() => false),
				item.movieId || item.episodeId
					? resetSearchFailures(
							item.movieId ? [item.movieId] : [],
							item.episodeId ? [item.episodeId] : []
						)
					: Promise.resolve()
			]);
			if (searchOk) {
				toasts.success(m.activity_searches_searchNowTriggered({ count: 1 }));
			}
			await load();
			if (expandedId === item.id) await loadDetail(item);
		} finally {
			rowActionLoading.delete(item.id);
		}
	}

	async function handlePauseToggle(item: SearchActivityItem, paused: boolean): Promise<void> {
		rowActionLoading.add(item.id);
		try {
			const movieIds = item.mediaType === 'movie' && item.movieId ? [item.movieId] : [];
			const episodeIds = item.mediaType === 'episode' && item.episodeId ? [item.episodeId] : [];
			const res = await setSearchItemPaused(movieIds, episodeIds, paused);
			if (res.success) {
				toasts.success(
					paused ? m.activity_searches_pauseSuccess() : m.activity_searches_resumeSuccess()
				);
				item.autoSearchPaused = paused;
				if (detail) detail.paused = paused;
			} else {
				toasts.error(res.error ?? m.activity_searches_pauseFailed());
			}
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.activity_searches_pauseFailed());
		} finally {
			rowActionLoading.delete(item.id);
		}
	}

	function onSearchInput(value: string): void {
		search = value;
		if (searchDebounce) clearTimeout(searchDebounce);
		searchDebounce = setTimeout(() => {
			onFiltersChange({ ...filters, search: search || undefined });
			void load(true);
		}, 300);
	}

	function setMediaType(next: 'all' | 'movie' | 'tv'): void {
		mediaType = next;
		onFiltersChange({ ...filters, mediaType: next });
		void load(true);
	}

	function setStatus(next: SearchStatusFilter): void {
		status = next;
		onFiltersChange({ ...filters, searchStatus: next === 'all' ? undefined : next });
		void load(true);
	}

	function setPausedOnly(next: boolean): void {
		pausedOnly = next;
		onFiltersChange({ ...filters, pausedOnly: next || undefined });
		void load(true);
	}

	// Mirrors ActivityUnmatchedCard's removeUnmatchedFilter/clearAllUnmatchedFilters
	// for the shared ActiveFilters component.
	function removeSearchesFilter(key: keyof ActivityFilters): void {
		const newFilters = { ...filters };
		if (key === 'mediaType' || key === 'searchStatus') {
			newFilters[key] = 'all' as never;
		} else {
			delete newFilters[key];
		}
		switch (key) {
			case 'mediaType':
				mediaType = 'all';
				break;
			case 'searchStatus':
				status = 'all';
				break;
			case 'pausedOnly':
				pausedOnly = false;
				break;
			case 'search':
				search = '';
				break;
			case 'startDate':
				startDate = undefined;
				break;
			case 'endDate':
				endDate = undefined;
				break;
		}
		onFiltersChange(newFilters);
		void load(true);
	}

	function clearAllSearchesFilters(): void {
		mediaType = 'all';
		status = 'all';
		pausedOnly = false;
		search = '';
		startDate = undefined;
		endDate = undefined;
		onFiltersChange({ mediaType: 'all' });
		void load(true);
	}

	function updateStartDate(value: string): void {
		startDate = value || undefined;
		onFiltersChange({ ...filters, startDate });
		void load(true);
	}

	function updateEndDate(value: string): void {
		endDate = value || undefined;
		onFiltersChange({ ...filters, endDate });
		void load(true);
	}

	function clearDateRange(): void {
		startDate = undefined;
		endDate = undefined;
		onFiltersChange({ ...filters, startDate: undefined, endDate: undefined });
		void load(true);
	}

	function handleSort(field: SortField): void {
		if (sortField === field) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDirection = 'asc';
		}
		void load(true);
	}

	function getSortIcon(field: SortField) {
		if (sortField !== field) return ArrowUpDown;
		return sortDirection === 'asc' ? ArrowUp : ArrowDown;
	}

	// formatRelativeTime is past-only (diff = now - date), so a future
	// nextAttempt always collapsed to "Just now" - mirrors TaskCard's own
	// "in Xh Ym" / "Overdue" pattern for scheduled times instead.
	function formatNextAttempt(dateStr: string): string {
		const diffMs = new Date(dateStr).getTime() - Date.now();
		if (diffMs <= 0) return m.activity_searches_detailEligibleNow();
		return `in ${formatDuration(diffMs)}`;
	}

	function mediaLabel(item: SearchActivityItem): string {
		if (item.mediaType === 'episode' && item.seasonNumber !== undefined) {
			const season = `S${String(item.seasonNumber).padStart(2, '0')}`;
			const episode =
				item.episodeNumber !== undefined ? `E${String(item.episodeNumber).padStart(2, '0')}` : '';
			return `${item.seriesTitle ?? item.mediaTitle} ${season}${episode}`;
		}
		return item.mediaTitle;
	}

	// No stable id survives from a grab to its eventual download_history row
	// (ImportService/DownloadMonitorService both mint a fresh id when a queue
	// item is historified), so rather than attempt a fragile downloadId-based
	// join, this just hands the exact release title to the History tab's
	// existing free-text search filter - specific enough to reliably land on
	// the right row without risking a silent wrong-row link.
	function historyLink(item: SearchActivityItem): string | null {
		if (!item.releaseGrabbed) return null;
		return resolvePath(`/activity?tab=history&search=${encodeURIComponent(item.releaseGrabbed)}`);
	}

	/**
	 * Whether Search Now / Pause can do anything useful, based on the reason
	 * text of the item's most recent attempt. Reason strings come from the
	 * monitoring specifications (src/lib/server/monitoring/specifications/) -
	 * most start with their RejectionReason/AvailabilityRejectionReason enum
	 * value verbatim, which is what the prefix checks below key off.
	 *
	 * - Hard gates (not yet released/aired) - hide both; the item isn't stuck,
	 *   it's correctly waiting, and nothing happens until that date passes.
	 * - Monitoring-state gates (not_monitored, etc.) - hide both; the real fix
	 *   is the Monitored toggle, not these buttons. Note: this can only ever
	 *   match a scheduled/task-triggered row - every manual auto-grab entry
	 *   point passes bypassMonitoring: true, so a 'manual' row can never
	 *   actually carry one of these reasons in the first place.
	 * - Already-resolved (already has file / already at cutoff / upgrades
	 *   disallowed) - hide both; there's nothing left to search or pause.
	 * - Config/indexer problems - hide Search Now only (it'll fail the same
	 *   way until the config is fixed); Pause stays available since a user
	 *   may want to silence an item they know will stay broken for a while.
	 * - Everything else (cooldown, failure cap, blocklist, a worse/equal
	 *   candidate, transient errors) - both stay available; these are exactly
	 *   the cases the buttons exist for.
	 * - A 'grabbed' row with consecutiveFailureCount === 0 - hide both; the
	 *   release is genuinely done (downloaded and imported), nothing left to
	 *   search or pause. "View in History" is the right next step from here.
	 * - A 'grabbed' row with consecutiveFailureCount > 0 - both stay
	 *   available. A grab failing downstream (the download itself, or the
	 *   import) doesn't rewrite this row - monitoringHistory only gets a new
	 *   row on the *next* search attempt, which can be hours away behind the
	 *   cooldown/backoff. The failure count already going up is the proof
	 *   this specific grab didn't actually resolve the item, so it's still
	 *   eligible even while the row still reads "Grabbed".
	 */
	const HARD_GATE_PREFIXES = ['not_yet_available', 'not_yet_aired', 'unknown_availability'];
	const MONITORING_STATE_REASONS = new Set([
		'not_monitored',
		'series_not_monitored',
		'season_not_monitored',
		'season_link_missing'
	]);
	const ALREADY_RESOLVED_PREFIXES = [
		'already_has_file',
		'already_at_cutoff',
		'upgrades_not_allowed',
		'no_existing_file'
	];

	function classifyActionRelevance(
		status: SearchActivityItem['status'],
		reason: string | null | undefined,
		consecutiveFailureCount: number
	): {
		canSearch: boolean;
		canPause: boolean;
	} {
		if (status === 'grabbed' && consecutiveFailureCount === 0) {
			return { canSearch: false, canPause: false };
		}
		const normalized = reason?.trim();
		if (!normalized) return { canSearch: true, canPause: true };
		const lower = normalized.toLowerCase();

		if (HARD_GATE_PREFIXES.some((p) => lower.startsWith(p))) {
			return { canSearch: false, canPause: false };
		}
		if (
			MONITORING_STATE_REASONS.has(normalized) ||
			ALREADY_RESOLVED_PREFIXES.some((p) => normalized.startsWith(p))
		) {
			return { canSearch: false, canPause: false };
		}
		if (
			lower.includes('indexer') ||
			normalized === 'no_profile' ||
			normalized === 'read_only_folder'
		) {
			return { canSearch: false, canPause: true };
		}
		return { canSearch: true, canPause: true };
	}

	onMount(() => {
		void load();
	});
</script>

{#snippet sortIcon(field: SortField)}
	{@const Icon = getSortIcon(field)}
	<Icon class="h-3 w-3 opacity-50" />
{/snippet}

{#snippet statusBadge(status: SearchActivityItem['status'], compact: boolean = false)}
	{@const config = statusConfig[status] ?? statusConfig.no_results}
	{@const StatusIcon = config.icon}
	<span class="badge gap-1 whitespace-nowrap {compact ? 'badge-sm' : ''} {config.variant}">
		<StatusIcon class="h-3 w-3" />
		{config.label}
	</span>
{/snippet}

{#snippet detailPanel(item: SearchActivityItem)}
	{#if detailLoading}
		<div class="flex items-center gap-2 text-sm text-base-content/60">
			<Loader2 class="h-4 w-4 animate-spin" />
			{m.activity_table_noActivity()}
		</div>
	{:else if detailError}
		<div class="text-sm text-error">{detailError}</div>
	{:else if detail}
		{@const relevance = classifyActionRelevance(
			item.status,
			item.errorMessage,
			item.consecutiveFailureCount
		)}
		{@const searchType = TASK_TYPE_LABELS[detail.timeline[0]?.taskType ?? item.taskType ?? '']}
		<div class="flex flex-wrap items-start gap-x-6 gap-y-2">
			<div class="flex flex-wrap items-center gap-1.5 text-sm">
				<span class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase">
					{m.activity_searches_detailQualityProfile()}
				</span>
				<span class="rounded bg-base-100 px-2 py-1">{detail.qualityProfileName ?? '-'}</span>
			</div>
			<div class="flex flex-wrap items-center gap-1.5 text-sm">
				<span class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase">
					{m.activity_searches_detailSearchType()}
				</span>
				<span class="rounded bg-base-100 px-2 py-1">{searchType ?? '-'}</span>
			</div>
			{#if item.indexerName}
				<div class="flex flex-wrap items-center gap-1.5 text-sm">
					<span class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase">
						{m.activity_searches_detailIndexer()}
					</span>
					<span class="rounded bg-base-100 px-2 py-1">{item.indexerName}</span>
				</div>
			{:else if item.indexersQueried != null}
				<div class="flex flex-wrap items-center gap-1.5 text-sm">
					<span class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase">
						{m.activity_searches_detailIndexersQueried()}
					</span>
					<span class="rounded bg-base-100 px-2 py-1">{item.indexersQueried}</span>
				</div>
			{/if}
			<div class="flex flex-wrap items-center gap-1.5 text-sm">
				<span class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase">
					{m.activity_searches_detailAttempts()}
				</span>
				<span
					class="badge badge-sm {detail.consecutiveFailureCount >= detail.maxConsecutiveFailures
						? 'badge-error'
						: detail.consecutiveFailureCount > 0
							? 'badge-warning'
							: 'badge-ghost'}"
				>
					{detail.consecutiveFailureCount} / {detail.maxConsecutiveFailures}
				</span>
			</div>
			<div class="flex flex-wrap items-center gap-1.5 text-sm">
				<span class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase">
					{m.activity_searches_detailFirstAttempt()}
				</span>
				<span class="rounded bg-base-100 px-2 py-1">
					{detail.firstAttempt
						? formatRelativeTime(detail.firstAttempt)
						: m.activity_searches_detailNeverSearched()}
				</span>
			</div>
			<div class="flex flex-wrap items-center gap-1.5 text-sm">
				<span class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase">
					{m.activity_searches_detailLastAttempt()}
				</span>
				<span class="rounded bg-base-100 px-2 py-1">
					{detail.lastAttempt
						? formatRelativeTime(detail.lastAttempt)
						: m.activity_searches_detailNeverSearched()}
				</span>
			</div>
			<div class="flex flex-wrap items-center gap-1.5 text-sm">
				<span class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase">
					{m.activity_searches_detailNextAttempt()}
				</span>
				<span
					class="rounded bg-base-100 px-2 py-1"
					title={detail.nextAttempt ? formatDisplayDate(detail.nextAttempt) : undefined}
				>
					{detail.nextAttempt
						? formatNextAttempt(detail.nextAttempt)
						: m.activity_searches_detailEligibleNow()}
				</span>
			</div>
			{#if item.isUpgrade && item.status === 'grabbed' && item.oldScore !== null && item.newScore !== null}
				<div class="text-sm">
					<span class="font-medium text-base-content/55">{m.activity_table_upgrade()}</span>
					<span class="font-semibold">{item.oldScore} → {item.newScore}</span>
				</div>
			{/if}

			<div
				class="order-first flex w-full flex-wrap items-center gap-2 sm:order-0 sm:ml-auto sm:w-auto"
			>
				{#if relevance.canSearch}
					<button
						class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-sm hover:bg-base-200"
						disabled={rowActionLoading.has(item.id)}
						onclick={() => handleSearchNowSingle(item)}
						title={m.activity_searches_searchNowAndReset()}
					>
						{#if rowActionLoading.has(item.id)}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<Search class="h-3.5 w-3.5" />
						{/if}
						{m.activity_searches_searchNow()}
					</button>
				{/if}
				{#if relevance.canPause}
					<button
						class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-sm hover:bg-base-200"
						disabled={rowActionLoading.has(item.id)}
						onclick={() => handlePauseToggle(item, !detail?.paused)}
					>
						{#if detail.paused}
							<Play class="h-3.5 w-3.5" />
							{m.activity_searches_resume()}
						{:else}
							<Pause class="h-3.5 w-3.5" />
							{m.activity_searches_pause()}
						{/if}
					</button>
				{/if}
				{#if historyLink(item)}
					<a
						href={historyLink(item)}
						class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-sm hover:bg-base-200"
					>
						<ExternalLink class="h-3.5 w-3.5" />
						{m.activity_searches_viewInHistory()}
					</a>
				{/if}
			</div>
		</div>
		{#if detail.timeline.length > 0}
			<div class="mt-4 border-t border-base-content/10 pt-3">
				<div class="mb-2 flex items-center gap-1.5">
					<span class="text-[11px] font-semibold tracking-widest text-base-content/50 uppercase">
						{m.activity_searches_detailTimeline()}
					</span>
					<span title={m.activity_searches_detailTimelineHint()}>
						<Info class="h-3 w-3 text-base-content/40" />
					</span>
				</div>
				<div class="overflow-hidden rounded-lg border border-base-content/10 bg-base-100">
					<ul class="divide-y divide-base-content/8 text-sm">
						{#each detail.timeline.slice(0, 6) as row (row.id)}
							<li class="flex items-center gap-2 px-3 py-2 hover:bg-base-200/50">
								{@render statusBadge(row.status, true)}
								<span class="min-w-0 flex-1 truncate text-base-content/70">
									{row.releaseGrabbed ?? row.errorMessage ?? '-'}
								</span>
								<span class="shrink-0 text-xs whitespace-nowrap text-base-content/50">
									{formatRelativeTime(row.executedAt)}
								</span>
							</li>
						{/each}
					</ul>
				</div>
			</div>
		{/if}
	{/if}
{/snippet}

<div class="space-y-4">
	<div class="rounded-lg border border-base-content/12 bg-base-100 p-4 shadow-sm">
		<div class="flex flex-wrap items-center gap-2">
			<div class="form-control min-w-50 flex-1 sm:max-w-64">
				<div class="group relative">
					<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
						<Search
							class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
						/>
					</div>
					<input
						type="text"
						placeholder={m.action_search()}
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						value={search}
						oninput={(e) => onSearchInput(e.currentTarget.value)}
					/>
				</div>
			</div>
			<span class="h-4 w-px bg-base-content/15"></span>
			<div class="join">
				<button
					class="btn join-item btn-sm {mediaType === 'all' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => setMediaType('all')}
				>
					{m.common_all()}
				</button>
				<button
					class="btn join-item btn-sm {mediaType === 'movie' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => setMediaType('movie')}
				>
					{m.common_movies()}
				</button>
				<button
					class="btn join-item btn-sm {mediaType === 'tv' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => setMediaType('tv')}
				>
					{m.common_tvShows()}
				</button>
			</div>
			<button
				class="btn ml-auto gap-1.5 btn-ghost btn-sm"
				onclick={() => (moreFiltersExpanded = !moreFiltersExpanded)}
				aria-label={moreFiltersExpanded ? 'Collapse filters' : 'Expand filters'}
			>
				<Filter class="h-4 w-4 text-base-content/50" />
				{#if moreFiltersExpanded}
					<span>{m.activity_filters_lessFilters()}</span>
					<ChevronUp class="h-4 w-4" />
				{:else}
					<span>{m.activity_filters_moreFilters()}</span>
					<ChevronDown class="h-4 w-4" />
				{/if}
			</button>
		</div>

		{#if moreFiltersExpanded}
			<div class="mt-3 grid gap-4 border-t border-base-content/10 pt-4 md:grid-cols-3">
				<div class="space-y-2">
					<label class="text-sm font-medium" for="searches-status-filter">
						{m.common_status()}
					</label>
					<select
						id="searches-status-filter"
						class="select-bordered select w-full select-sm"
						value={status}
						onchange={(e) => setStatus(e.currentTarget.value as SearchStatusFilter)}
					>
						{#each statusOptions as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
				</div>
				<div class="space-y-2">
					<label class="text-sm font-medium" for="searches-start-date">
						{m.activity_filters_dateRange()}
					</label>
					<div class="flex items-center gap-2">
						<input
							id="searches-start-date"
							type="date"
							class="input-bordered input input-sm"
							value={startDate || ''}
							onchange={(e) => updateStartDate(e.currentTarget.value)}
						/>
						<span class="text-base-content/50">{m.activity_activeFilters_toSeparator()}</span>
						<input
							type="date"
							class="input-bordered input input-sm"
							value={endDate || ''}
							onchange={(e) => updateEndDate(e.currentTarget.value)}
							aria-label={m.activity_filters_dateRange()}
						/>
						{#if startDate || endDate}
							<button class="btn btn-ghost btn-error btn-sm" onclick={clearDateRange}>
								<X class="h-4 w-4" />
							</button>
						{/if}
					</div>
				</div>
				<div class="space-y-2">
					<label class="flex items-center gap-2 text-sm font-medium">
						<Pause class="h-4 w-4" />
						{m.activity_searches_pausedOnly()}
					</label>
					<div class="form-control">
						<label class="label cursor-pointer justify-start gap-2">
							<input
								type="checkbox"
								class="toggle toggle-primary toggle-sm"
								checked={pausedOnly}
								onchange={(e) => setPausedOnly(e.currentTarget.checked)}
							/>
							<span class="label-text text-sm">{m.activity_searches_showPausedOnly()}</span>
						</label>
					</div>
				</div>
			</div>
		{/if}

		<div class="mt-3 border-t border-base-content/10 pt-3">
			<ActiveFilters
				{filters}
				onFilterRemove={removeSearchesFilter}
				onClearAll={clearAllSearchesFilters}
			/>
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-sm font-bold tracking-wide text-base-content/70">
					{m.activity_queue_bulkActionsHeading()}
				</span>
				<div class="divider m-0 divider-horizontal h-6"></div>
				{#if selected.size > 0}
					{@const searchableCount = selectedSearchableItems().length}
					{@const resettableCount = selectedResettableItems().length}
					{@const pausableCount = selectedPausableItems().length}
					{@const resumableCount = selectedResumableItems().length}
					<span class="text-xs text-base-content/60">
						{m.common_selected({ count: selected.size })}
					</span>
					{#if searchableCount > 0}
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							disabled={bulkActionLoading}
							onclick={handleSearchNow}
						>
							{#if bulkActionLoading}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
							{:else}
								<Search class="h-3.5 w-3.5" />
							{/if}
							{m.activity_searches_searchNowCount({ count: searchableCount })}
						</button>
					{/if}
					{#if resettableCount > 0}
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							disabled={bulkActionLoading}
							onclick={handleResetFailures}
						>
							<RotateCcw class="h-3.5 w-3.5" />
							{m.activity_searches_resetFailuresCount({ count: resettableCount })}
						</button>
					{/if}
					{#if pausableCount > 0}
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							disabled={bulkActionLoading}
							onclick={() => handleBulkPauseToggle(true)}
						>
							<Pause class="h-3.5 w-3.5" />
							{m.activity_searches_pauseCount({ count: pausableCount })}
						</button>
					{/if}
					{#if resumableCount > 0}
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							disabled={bulkActionLoading}
							onclick={() => handleBulkPauseToggle(false)}
						>
							<Play class="h-3.5 w-3.5" />
							{m.activity_searches_resumeCount({ count: resumableCount })}
						</button>
					{/if}
					<button
						class="btn gap-1.5 btn-outline btn-error btn-sm"
						disabled={bulkActionLoading}
						onclick={handleDeleteSelected}
					>
						<Trash2 class="h-3.5 w-3.5" />
						{m.activity_searches_deleteSelectedCount({ count: selected.size })}
					</button>
					<div class="ml-auto"></div>
					<button class="btn gap-1.5 btn-outline btn-sm" onclick={() => selected.clear()}>
						<X class="h-3.5 w-3.5" />
						{m.activity_queue_clearSelection()}
					</button>
				{:else}
					<span class="text-xs text-base-content/60">
						{m.activity_searches_bulkHint()}
					</span>
					<div class="ml-auto"></div>
					<div class="divider m-0 divider-horizontal h-6"></div>
					<button class="btn gap-1.5 btn-outline btn-sm" onclick={handleRefresh} disabled={loading}>
						{#if loading}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<RefreshCw class="h-3.5 w-3.5" />
						{/if}
						{m.activity_unmatched_refresh()}
					</button>
					<button
						class="btn gap-1.5 btn-sm {globallyPaused ? 'btn-warning' : 'btn-outline'}"
						disabled={globalPauseLoading}
						onclick={handleGlobalPauseToggle}
						title={globallyPaused
							? m.activity_searches_globalResumeHint()
							: m.activity_searches_globalPauseHint()}
					>
						{#if globalPauseLoading}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else if globallyPaused}
							<Play class="h-3.5 w-3.5" />
						{:else}
							<Pause class="h-3.5 w-3.5" />
						{/if}
						{globallyPaused ? m.activity_searches_resumeAll() : m.activity_searches_pauseAll()}
					</button>
				{/if}
			</div>
		</div>
	</div>

	{#if loadError}
		<div class="alert alert-error">
			<span>{loadError}</span>
		</div>
	{:else if loading && items.length === 0}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin" />
		</div>
	{:else if items.length === 0}
		<div class="py-20 text-center">
			<HistoryIcon class="mx-auto mb-4 h-12 w-12 text-base-content/15" />
			<p class="font-medium text-base-content/60">
				{search ? m.activity_unmatched_noFilterResults() : m.activity_table_noActivity()}
			</p>
			{#if !search}
				<p class="mt-1 text-sm text-base-content/40">{m.activity_table_noActivityHint()}</p>
			{/if}
		</div>
	{:else}
		<div class="flex items-center justify-between text-sm text-base-content/70">
			<span>{m.activity_searches_count({ count: total })}</span>
			<span
				class="flex items-center gap-1.5 text-xs {globallyPaused
					? 'badge badge-warning'
					: 'badge badge-info'}"
			>
				<Search class="h-3.5 w-3.5" />
				{globallyPaused
					? m.activity_searches_globalPausedDescriptor()
					: m.activity_searches_globalRunningDescriptor()}
			</span>
		</div>

		<div class="overflow-x-auto rounded-lg border border-base-content/12 bg-base-100 shadow-sm">
			<table class="table w-full table-sm">
				<thead>
					<tr
						class="border-b border-base-content/10 bg-base-200 text-[11px] font-semibold tracking-widest text-base-content/50 uppercase"
					>
						<th class="w-10 px-2">
							<input
								type="checkbox"
								class="checkbox checkbox-xs checkbox-primary"
								checked={allSelected}
								onchange={toggleSelectAll}
								aria-label={m.activity_searches_selectAll()}
							/>
						</th>
						<th
							class="cursor-pointer select-none hover:bg-base-300/40"
							onclick={() => handleSort('status')}
						>
							<span class="flex items-center gap-1">
								{m.common_status()}
								{@render sortIcon('status')}
							</span>
						</th>
						<th
							class="cursor-pointer select-none hover:bg-base-300/40"
							onclick={() => handleSort('media')}
						>
							<span class="flex items-center gap-1">
								{m.activity_table_media()}
								{@render sortIcon('media')}
							</span>
						</th>
						<th class="hidden md:table-cell">{m.activity_table_release()}</th>
						<th
							class="hidden cursor-pointer select-none hover:bg-base-300/40 md:table-cell"
							onclick={() => handleSort('failures')}
						>
							<span class="flex items-center gap-1">
								{m.activity_searches_failures()}
								{@render sortIcon('failures')}
							</span>
						</th>
						<th class="hidden lg:table-cell">{m.activity_searches_qualityProfile()}</th>
						<th class="hidden lg:table-cell">{m.activity_searches_source()}</th>
						<th class="hidden xl:table-cell">{m.activity_searches_detailNextAttempt()}</th>
						<th
							class="cursor-pointer select-none hover:bg-base-300/40"
							onclick={() => handleSort('time')}
						>
							<span class="flex items-center gap-1">
								{m.activity_table_time()}
								{@render sortIcon('time')}
							</span>
						</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-base-content/8">
					{#each items as item (item.id)}
						<tr
							class="cursor-pointer hover:bg-base-200/50 {selected.has(item.id)
								? 'bg-primary/5'
								: ''} {expandedId === item.id ? 'bg-base-200/60' : ''}"
							onclick={() => toggleExpand(item)}
						>
							<td class="px-2" onclick={(e) => e.stopPropagation()}>
								<input
									type="checkbox"
									class="checkbox checkbox-xs checkbox-primary"
									checked={selected.has(item.id)}
									onchange={() => toggleSelect(item.id)}
									aria-label={mediaLabel(item)}
								/>
							</td>
							<td class="px-2">
								<div class="flex items-center gap-1">
									<ChevronRight
										class="h-3.5 w-3.5 shrink-0 text-base-content/30 transition-transform {expandedId ===
										item.id
											? 'rotate-90'
											: ''}"
									/>
									{@render statusBadge(item.status)}
									{#if item.autoSearchPaused}
										<PauseCircle class="h-3.5 w-3.5 shrink-0 text-base-content/60" />
									{/if}
									{#if item.isUpgrade && item.status === 'grabbed'}
										<span
											class="badge gap-1 badge-ghost badge-sm whitespace-nowrap"
											title={item.oldScore !== null && item.newScore !== null
												? `${item.oldScore} → ${item.newScore}`
												: undefined}
										>
											<ArrowUp class="h-3 w-3" />
											{m.activity_table_upgrade()}
										</span>
									{/if}
								</div>
							</td>

							<td class="min-w-0">
								<div class="flex flex-col gap-0.5">
									{#if item.movieId || item.seriesId}
										<a
											href={getMediaLink({
												mediaType: item.mediaType,
												mediaId: item.movieId ?? item.episodeId ?? '',
												seriesId: item.seriesId
											})}
											class="flex items-center gap-1.5 hover:text-primary"
											onclick={(e) => e.stopPropagation()}
										>
											{#if item.mediaType === 'movie'}
												<Clapperboard class="h-4 w-4 shrink-0" />
											{:else}
												<Tv class="h-4 w-4 shrink-0" />
											{/if}
											<span class="max-w-18 truncate sm:max-w-48" title={mediaLabel(item)}>
												{mediaLabel(item)}
											</span>
										</a>
									{:else}
										<div class="flex items-center gap-1.5">
											{#if item.mediaType === 'movie'}
												<Clapperboard class="h-4 w-4 shrink-0" />
											{:else}
												<Tv class="h-4 w-4 shrink-0" />
											{/if}
											{#if item.autoSearchPaused}
												<PauseCircle class="h-3.5 w-3.5 shrink-0 text-base-content/40" />
											{/if}
											<span class="max-w-18 truncate sm:max-w-48" title={mediaLabel(item)}>
												{mediaLabel(item)}
											</span>
										</div>
									{/if}
								</div>
							</td>
							<td class="hidden max-w-xs truncate md:table-cell" title={item.releaseGrabbed ?? ''}>
								<span class="text-sm">
									{item.releaseGrabbed ?? m.activity_searches_noReleaseGrabbed()}
								</span>
							</td>
							<td class="hidden md:table-cell">
								{#if item.consecutiveFailureCount > 0}
									<span
										class="badge badge-sm {item.consecutiveFailureCount >= maxConsecutiveFailures
											? 'badge-error'
											: 'badge-warning'}"
									>
										{item.consecutiveFailureCount} / {maxConsecutiveFailures}
									</span>
								{:else}
									<span class="text-base-content/40">-</span>
								{/if}
							</td>
							<td
								class="hidden max-w-xs truncate lg:table-cell"
								title={item.qualityProfileName ?? ''}
							>
								<span class="text-sm">{item.qualityProfileName ?? '-'}</span>
							</td>
							<td class="hidden lg:table-cell">
								<span class="text-sm">
									{TASK_TYPE_LABELS[item.taskType ?? ''] ?? item.taskType ?? '-'}
								</span>
							</td>
							<td class="hidden whitespace-nowrap xl:table-cell">
								<span
									class="text-sm"
									title={item.nextAttempt ? formatDisplayDate(item.nextAttempt) : undefined}
								>
									{item.nextAttempt
										? formatNextAttempt(item.nextAttempt)
										: m.activity_searches_detailEligibleNow()}
								</span>
							</td>
							<td class="whitespace-nowrap">
								<span class="text-xs text-base-content/50">
									{formatRelativeTime(item.executedAt)}
								</span>
							</td>
						</tr>
						{#if expandedId === item.id}
							<tr class="bg-base-200">
								<td colspan={9} class="w-full max-w-0 border-l-4 border-l-primary py-5 pr-6 pl-10">
									{@render detailPanel(item)}
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
				{#if totalPages > 1}
					<tfoot>
						<tr>
							<td colspan={9} class="border-t border-base-content/8 py-2">
								<div class="flex items-center justify-center gap-2">
									<button
										class="btn btn-ghost btn-xs"
										disabled={page <= 1 || loading}
										onclick={() => {
											page -= 1;
											void load();
										}}
									>
										{m.reports_pagination_prev()}
									</button>
									<span class="text-xs text-base-content/60">{page} / {totalPages}</span>
									<button
										class="btn btn-ghost btn-xs"
										disabled={page >= totalPages || loading}
										onclick={() => {
											page += 1;
											void load();
										}}
									>
										{m.reports_pagination_next()}
									</button>
								</div>
							</td>
						</tr>
					</tfoot>
				{/if}
			</table>
		</div>
	{/if}
</div>

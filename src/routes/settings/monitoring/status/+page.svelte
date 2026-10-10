<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		HardDrive,
		RefreshCw,
		Lightbulb,
		ArrowLeft,
		Film,
		Tv,
		Monitor,
		Search,
		X
	} from '@lucide/svelte';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import { StorageDashboard, InsightCard } from '#lib/components/storage/index.js';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';
	import {
		severityBadgeClass,
		insightTypeLabel,
		dismissInsight,
		badgeToneColor,
		getInsightFooterLink
	} from '#lib/components/storage/utils.js';
	import { getInsightItems, type InsightItem } from '#lib/api/storage.js';
	import { layoutState } from '#lib/layout.svelte.js';
	import { refreshAll } from '$app/navigation';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import {
		scanLibrary,
		batchMovies,
		batchSeries,
		deleteMovie,
		deleteSeries
	} from '#lib/api/library.js';
	import { syncMediaServerStats } from '#lib/api/settings.js';
	import { apiDelete } from '#lib/api/client.js';
	import { createSearchProgress } from '#lib/stores/searchProgress.svelte.js';
	import { getPrimaryAutoSearchIssue } from '#lib/utils/autoSearchIssues.js';
	import { MediaSearchModal } from '#lib/components/search/index.js';
	import {
		getHistoryRetention,
		saveHistoryRetention,
		getStorageForecast,
		type HistoryRetentionSettings,
		type StorageForecast
	} from '#lib/api/history-retention.js';
	import { formatBytes } from '#lib/utils/format.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type ScanSuccess = { message: string; unmatchedCount: number };

	// One-shot feedback for the most recent user-triggered action. Ongoing
	// scan/sync state lives in layoutState so it survives sub-page navigation;
	// these flags are only for transient messages tied to this dashboard view.
	let scanError = $state<string | null>(null);
	let scanSuccess = $state<ScanSuccess | null>(null);

	let retention = $state<HistoryRetentionSettings | null>(null);
	let forecast = $state<StorageForecast | null>(null);
	let retentionSaving = $state(false);
	let insightsOpen = $state(false);
	let scanStarting = $state(false);
	let scanStartTimeout: ReturnType<typeof setTimeout> | null = null;
	let syncStarting = $state(false);
	const isScanning = $derived(layoutState.scanInProgress || scanStarting);
	const isSyncing = $derived(layoutState.mediaServerSyncing || syncStarting);

	// Once the SSE confirms the scan is underway, hand off from scanStarting to
	// layoutState.scanInProgress so the button stays in "Scanning..." without a
	// brief reset between the API return and the SSE event.
	$effect(() => {
		if (layoutState.scanInProgress && scanStarting) {
			if (scanStartTimeout !== null) {
				clearTimeout(scanStartTimeout);
				scanStartTimeout = null;
			}
			scanStarting = false;
		}
	});

	type Insight = {
		id: string;
		insightType: string;
		severity: 'info' | 'warning' | 'critical';
		title: string;
		summary: string | null;
		reclaimableBytes: number | null;
	};

	let selectedInsight = $state<Insight | null>(null);
	let detailItems = $state<InsightItem[]>([]);
	let detailTotal = $state(0);
	let detailPage = $state(1);
	let detailTotalPages = $state(0);
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);
	let expandedItemId = $state<string | null>(null);
	let expandedGroupKey = $state<string | null>(null);
	let actionLoading = $state(new Set<string>());
	let syncingServer = $state(false);
	const searchProgress = createSearchProgress();
	let searchModalOpen = $state(false);
	let searchModalItem = $state<InsightItem | null>(null);

	function extractIdFromHref(href: string | undefined): string | null {
		if (!href) return null;
		const parts = href.split('/');
		return parts[parts.length - 1] || null;
	}

	function isMovieHref(href: string | undefined): boolean {
		return href?.includes('/library/movie/') ?? false;
	}

	function parseOrphanedUuid(itemId: string): string | null {
		if (itemId.startsWith('of-')) return itemId.slice(3);
		return null;
	}

	function handleDashboardInsightClick(insight: Insight) {
		insightsOpen = true;
		openInsightDetail(insight);
	}

	async function handleSyncServer() {
		syncingServer = true;
		try {
			await syncMediaServerStats();
		} finally {
			syncingServer = false;
		}
	}

	async function handleAutoSearch(item: InsightItem) {
		if (!item.href) return;
		const id = extractIdFromHref(item.href);
		if (!id) return;
		actionLoading.add(item.id);
		try {
			if (isMovieHref(item.href)) {
				await searchProgress.startSearch(`/api/library/movies/${id}/auto-search`);
				if (searchProgress.results) {
					if (searchProgress.results.grabbed) {
						toasts.success(`Grabbed: ${searchProgress.results.releaseName || 'release'}`);
					} else if (getPrimaryAutoSearchIssue(searchProgress.results)) {
						toasts.error(getPrimaryAutoSearchIssue(searchProgress.results)!.message);
					} else if (searchProgress.results.found) {
						toasts.info('Found releases but none were grabbed');
					} else {
						toasts.info('No releases found');
					}
				}
			} else {
				const seasonEp = parseSeasonEpisode(item.title);
				await searchProgress.startSearch(`/api/library/series/${id}/auto-search`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						type: 'season',
						seasonNumber: seasonEp?.season ?? 1
					})
				});
				if (searchProgress.results) {
					if (searchProgress.results.grabbed) {
						toasts.success(`Grabbed: ${searchProgress.results.releaseName || 'release'}`);
					} else if (getPrimaryAutoSearchIssue(searchProgress.results)) {
						toasts.error(getPrimaryAutoSearchIssue(searchProgress.results)!.message);
					} else if (searchProgress.results.found) {
						toasts.info('Found releases but none were grabbed');
					} else {
						toasts.info('No releases found');
					}
				}
			}
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Search failed');
		} finally {
			actionLoading.delete(item.id);
			searchProgress.reset();
		}
	}

	function handleInteractiveSearch(item: InsightItem) {
		searchModalItem = item;
		searchModalOpen = true;
	}

	function parseSeasonEpisode(title: string): { season: number; episode: number } | null {
		const match = title.match(/[Ss](\d{1,2})[Ee](\d{1,2})/);
		if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
		return null;
	}

	async function handleUnmonitor(item: InsightItem) {
		if (!item.href) return;
		const id = extractIdFromHref(item.href);
		if (!id) return;
		actionLoading.add(item.id);
		try {
			if (isMovieHref(item.href)) {
				await batchMovies([id], { monitored: false });
			} else {
				await batchSeries([id], { monitored: false });
			}
			toasts.success('Unmonitored');
			void refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to unmonitor');
		} finally {
			actionLoading.delete(item.id);
		}
	}

	async function handleRemoveFromLibrary(item: InsightItem) {
		if (!item.href) return;
		const id = extractIdFromHref(item.href);
		if (!id) return;
		actionLoading.add(item.id);
		try {
			if (isMovieHref(item.href)) {
				await deleteMovie(id, false, true);
			} else {
				await deleteSeries(id, false, true);
			}
			toasts.success('Removed from library');
			void refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to remove');
		} finally {
			actionLoading.delete(item.id);
		}
	}

	async function handleDeleteOrphaned(item: InsightItem) {
		const uuid = parseOrphanedUuid(item.id);
		if (!uuid) return;
		actionLoading.add(item.id);
		try {
			await apiDelete(`/api/library/unmatched/${uuid}?deleteFile=true`);
			toasts.success('File deleted');
			void refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to delete');
		} finally {
			actionLoading.delete(item.id);
		}
	}

	async function handleDeleteAllOrphaned(items: InsightItem[]) {
		const uuids = items.map((i) => parseOrphanedUuid(i.id)).filter(Boolean);
		if (uuids.length === 0) return;
		actionLoading.add('orphaned-all');
		try {
			await apiDelete('/api/library/unmatched', { fileIds: uuids, deleteFromDisk: true });
			toasts.success(`Deleted ${uuids.length} file${uuids.length === 1 ? '' : 's'}`);
			void refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to delete');
		} finally {
			actionLoading.delete('orphaned-all');
		}
	}

	// Only these insight types return items that legitimately share a parent
	// (multiple episodes under the same series, grouped by subtitle =
	// seriesName). Every other resolver's subtitle is a generic per-item
	// descriptor ("N files", "N redundant files") that happens to collide
	// across unrelated items with the same count - grouping by it there
	// collapsed distinct movies/items into a single unusable row.
	const SUBTITLE_GROUPED_INSIGHT_TYPES = new Set([
		'missing-from-media-server',
		'untracked-by-cinephage'
	]);

	const groupedItems = $derived.by(() => {
		const groups: {
			key: string;
			label: string;
			kind: string;
			href?: string;
			items: InsightItem[];
			count: number;
		}[] = [];
		const groupBySubtitle =
			!!selectedInsight && SUBTITLE_GROUPED_INSIGHT_TYPES.has(selectedInsight.insightType);
		const seen: Record<string, number> = {};
		for (const item of detailItems) {
			const groupKey = groupBySubtitle && item.subtitle ? item.subtitle : item.id;
			const idx = seen[groupKey];
			if (idx !== undefined) {
				groups[idx].items.push(item);
				groups[idx].count++;
			} else {
				seen[groupKey] = groups.length;
				groups.push({
					key: groupKey,
					label: groupBySubtitle && item.subtitle ? item.subtitle : item.title,
					kind: item.kind,
					href: item.href,
					items: [item],
					count: 1
				});
			}
		}
		return groups;
	});

	function getRemediation(insightType: string, _item: InsightItem): string {
		const remediations: Record<string, string> = {
			'missing-from-media-server':
				'This item was not found during the last media server sync. Re-sync your media server library from the dashboard, or verify the file still exists at the expected path.',
			'untracked-by-cinephage':
				'This item exists on your media server but is not tracked in Cinephage. Import it to enable monitoring, downloads, and quality upgrades.',
			'orphaned-files':
				'This file has no matching library item. Either import it into a library or delete it manually to free storage space.',
			'duplicate-items':
				'Multiple entries exist for what appears to be the same media. Review and remove the duplicate from your library.',
			'redundant-quality-tiers':
				'This item has more files than your multi-quality setting keeps. Review the extra files and remove the ones you no longer need.',
			'filename-duplicates':
				'Multiple files share the same name. Review and remove unnecessary duplicates to avoid library clutter.',
			'quality-below-cutoff':
				'The current quality is below your configured cutoff profile. Consider upgrading to a higher quality release.',
			unplayed:
				'This item has never been played since being added to the library. Review whether you still want to keep it, or reclaim the storage.',
			'broken-paths':
				'The file path no longer exists on disk. Either fix the path in library settings or remove the broken reference.',
			'health-issues':
				'Review the item details to identify what needs attention. This could be a path issue, missing media, or configuration problem.'
		};
		return remediations[insightType] ?? 'Review this item and resolve the issue accordingly.';
	}

	function openInsightDetail(insight: Insight) {
		selectedInsight = insight;
		detailPage = 1;
		expandedGroupKey = null;
		fetchInsightItems();
	}

	async function fetchInsightItems() {
		if (!selectedInsight) return;
		detailLoading = true;
		detailError = null;
		try {
			const res = await getInsightItems(selectedInsight.id, { page: detailPage, limit: 50 });
			if (res.success && res.data) {
				detailItems = res.data.items;
				detailTotal = res.data.pagination.total;
				detailTotalPages = res.data.pagination.totalPages;
			} else {
				detailError = res.error ?? 'Failed to load items';
			}
		} catch (e) {
			detailError = e instanceof Error ? e.message : 'Failed to load items';
		} finally {
			detailLoading = false;
		}
	}

	async function changeDetailPage(newPage: number) {
		detailPage = newPage;
		expandedItemId = null;
		expandedGroupKey = null;
		await fetchInsightItems();
	}

	async function handleDismissInsight(insightId: string) {
		const success = await dismissInsight(insightId);
		if (success) {
			selectedInsight = null;
			void refreshAll();
		}
	}

	function closeInsightDetail() {
		selectedInsight = null;
		expandedItemId = null;
		expandedGroupKey = null;
		actionLoading.clear();
	}

	function closeInsightsModal() {
		insightsOpen = false;
		closeInsightDetail();
	}

	const detailPageButtons = $derived.by(() => {
		const buttons: (number | '...')[] = [];
		if (detailTotalPages <= 7) {
			for (let i = 1; i <= detailTotalPages; i++) buttons.push(i);
		} else {
			buttons.push(1);
			if (detailPage > 3) buttons.push('...');
			const start = Math.max(2, detailPage - 1);
			const end = Math.min(detailTotalPages - 1, detailPage + 1);
			for (let i = start; i <= end; i++) buttons.push(i);
			if (detailPage < detailTotalPages - 2) buttons.push('...');
			buttons.push(detailTotalPages);
		}
		return buttons;
	});

	const footerLink = $derived(
		selectedInsight ? getInsightFooterLink(selectedInsight.insightType, selectedInsight.id) : null
	);

	const activeInsights = $derived(data.allInsights?.filter((i) => !i.dismissedAt) ?? []);
	const dismissedInsights = $derived(data.allInsights?.filter((i) => i.dismissedAt) ?? []);

	$effect(() => {
		void (async () => {
			try {
				[retention, forecast] = await Promise.all([getHistoryRetention(), getStorageForecast()]);
			} catch {
				/* silent */
			}
		})();
	});

	async function handleSaveRetention() {
		if (!retention) return;
		retentionSaving = true;
		try {
			await saveHistoryRetention(retention);
			toasts.success(m.settings_history_saved());
			forecast = await getStorageForecast();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : m.settings_history_failed());
		} finally {
			retentionSaving = false;
		}
	}

	function resetScanState() {
		scanError = null;
		scanSuccess = null;
	}

	async function triggerLibraryScan(rootFolderId?: string) {
		resetScanState();
		if (scanStartTimeout !== null) {
			clearTimeout(scanStartTimeout);
			scanStartTimeout = null;
		}
		scanStarting = true;
		try {
			await scanLibrary(rootFolderId ? { rootFolderId } : { fullScan: true });
			toasts.info(m.settings_general_scanQueued());
			// Keep scanStarting=true until SSE scanStart confirms the job is running.
			// Fallback: clear after 15s in case the SSE event never arrives.
			scanStartTimeout = setTimeout(() => {
				scanStarting = false;
				scanStartTimeout = null;
			}, 15_000);
		} catch (error) {
			scanError = error instanceof Error ? error.message : m.settings_general_failedToStartScan();
			scanStarting = false;
		}
	}

	async function triggerServerSync() {
		syncStarting = true;
		try {
			await syncMediaServerStats();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.status_sync_failed());
		} finally {
			syncStarting = false;
		}
	}
</script>

<svelte:head>
	<title>{m.nav_storageMaintenance()}</title>
</svelte:head>

<SettingsPage title={m.nav_storageMaintenance()} subtitle={m.status_dashboard_subtitle()}>
	{#snippet actions()}
		<div class="flex gap-2">
			<button
				type="button"
				class="btn gap-2 btn-primary btn-sm"
				onclick={() => void triggerLibraryScan()}
				disabled={isScanning || data.rootFolders.length === 0}
			>
				{#if isScanning}
					<RefreshCw class="h-4 w-4 animate-spin" />
					{m.settings_general_scanning()}
				{:else}
					<HardDrive class="h-4 w-4" />
					{m.settings_general_scanLibraries()}
				{/if}
			</button>
			{#if data.servers?.length > 0}
				<button
					type="button"
					class="btn gap-2 btn-outline btn-sm"
					onclick={() => void triggerServerSync()}
					disabled={isSyncing}
				>
					<RefreshCw class="h-4 w-4 {isSyncing ? 'animate-spin' : ''}" />
					{isSyncing ? 'Syncing...' : 'Sync Servers'}
				</button>
			{/if}
			{#if activeInsights.length > 0 || dismissedInsights.length > 0}
				<button
					type="button"
					class="btn gap-1 btn-ghost btn-sm"
					onclick={() => (insightsOpen = true)}
				>
					<Lightbulb class="h-4 w-4" />
					Insights
					{#if activeInsights.length > 0}
						<span class="badge badge-sm badge-warning">{activeInsights.length}</span>
					{/if}
				</button>
			{/if}
		</div>
	{/snippet}

	<StorageDashboard
		storage={data.storage}
		libraryBreakdown={data.storage.libraryBreakdown}
		rootFolderBreakdown={data.storage.rootFolderBreakdown}
		insights={data.insights}
		mediaServerStats={data.mediaServerStats}
		topItems={data.topItems}
		largestItems={data.largestItems}
		{scanError}
		{scanSuccess}
		serverStatuses={data.serverStatuses}
		onOpenInsight={handleDashboardInsightClick}
	/>

	<!-- History Retention -->
	<div class="card bg-base-200">
		<div class="card-body gap-4">
			<div>
				<h2 class="text-base font-semibold">{m.settings_history_title()}</h2>
				<p class="mt-0.5 text-sm text-base-content/60">{m.settings_history_description()}</p>
			</div>

			{#if retention}
				<div class="divide-y divide-base-300">
					<div class="flex items-center justify-between gap-4 py-3">
						<div>
							<div class="text-sm font-medium">{m.settings_history_file_days()}</div>
							<div class="text-xs text-base-content/50">{m.settings_history_file_days_help()}</div>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							<input
								id="h-file"
								type="number"
								class="input-bordered input w-20 input-sm"
								bind:value={retention.fileHistoryDays}
								min="0"
								max="3650"
							/>
							<span class="w-8 text-sm text-base-content/50">days</span>
						</div>
					</div>

					<div class="flex items-center justify-between gap-4 py-3">
						<div>
							<div class="text-sm font-medium">{m.settings_history_library_days()}</div>
							<div class="text-xs text-base-content/50">
								{m.settings_history_library_days_help()}
							</div>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							<input
								id="h-lib"
								type="number"
								class="input-bordered input w-20 input-sm"
								bind:value={retention.libraryHistoryDays}
								min="0"
								max="3650"
							/>
							<span class="w-8 text-sm text-base-content/50">days</span>
						</div>
					</div>

					<div class="flex items-center justify-between gap-4 py-3">
						<div>
							<div class="text-sm font-medium">{m.settings_history_scan_days()}</div>
							<div class="text-xs text-base-content/50">{m.settings_history_scan_days_help()}</div>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							<input
								id="h-scan"
								type="number"
								class="input-bordered input w-20 input-sm"
								bind:value={retention.scanHistoryDays}
								min="0"
								max="3650"
							/>
							<span class="w-8 text-sm text-base-content/50">days</span>
						</div>
					</div>
				</div>

				{#if forecast}
					<div>
						<div class="mb-2 text-xs font-medium tracking-wide text-base-content/50 uppercase">
							{m.settings_history_forecast()}
						</div>
						<div class="grid grid-cols-3 gap-3">
							<div class="rounded-lg bg-base-300 px-4 py-3">
								<div class="text-xs text-base-content/50">
									{m.settings_history_forecast_current()}
								</div>
								<div class="mt-0.5 text-sm font-semibold">
									{formatBytes(forecast.currentEstimatedBytes)}
								</div>
							</div>
							<div class="rounded-lg bg-base-300 px-4 py-3">
								<div class="text-xs text-base-content/50">{m.settings_history_forecast_30d()}</div>
								<div class="mt-0.5 text-sm font-semibold">
									{formatBytes(forecast.projectedBytes30d)}
								</div>
							</div>
							<div class="rounded-lg bg-base-300 px-4 py-3">
								<div class="text-xs text-base-content/50">{m.settings_history_forecast_90d()}</div>
								<div class="mt-0.5 text-sm font-semibold">
									{formatBytes(forecast.projectedBytes90d)}
								</div>
							</div>
						</div>
					</div>
				{/if}

				<div class="flex justify-end">
					<button
						class="btn btn-primary btn-sm"
						onclick={handleSaveRetention}
						disabled={retentionSaving}
					>
						{#if retentionSaving}
							<span class="loading loading-xs loading-spinner"></span>
						{/if}
						Save
					</button>
				</div>
			{:else}
				<div class="flex items-center justify-center py-8">
					<span class="loading loading-sm loading-spinner text-base-content/30"></span>
				</div>
			{/if}
		</div>
	</div>
</SettingsPage>

<ModalWrapper
	open={insightsOpen}
	onClose={closeInsightsModal}
	maxWidth="4xl"
	flexContent
	labelledBy="status-insights-title"
>
	{#if selectedInsight}
		{@const s = selectedInsight}
		<!-- Detail view -->
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="flex items-center justify-between border-b border-base-300 px-6 py-4">
				<div class="flex min-w-0 items-center gap-3">
					<button
						class="btn btn-circle btn-ghost btn-sm"
						onclick={closeInsightDetail}
						aria-label="Back"
					>
						<ArrowLeft class="h-4 w-4" />
					</button>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span class="badge border-none badge-sm {severityBadgeClass(s.severity)}">
								{insightTypeLabel(s.insightType)}
							</span>
							{#if s.reclaimableBytes}
								<span class="text-xs text-base-content/50">
									{formatBytes(s.reclaimableBytes)} reclaimable
								</span>
							{/if}
						</div>
						<h3 id="status-insights-title" class="mt-1 text-lg font-bold text-base-content">
							{s.title}
						</h3>
						{#if s.summary}
							<p class="mt-0.5 text-sm text-base-content/70">{s.summary}</p>
						{/if}
						{#if s.insightType === 'missing-from-media-server'}
							<button
								class="btn mt-2 gap-1 btn-outline btn-xs"
								onclick={handleSyncServer}
								disabled={syncingServer}
							>
								{#if syncingServer}
									<span class="loading loading-xs loading-spinner"></span>
								{/if}
								Sync Now
							</button>
						{/if}
					</div>
				</div>
				<button
					class="btn btn-circle btn-ghost btn-sm"
					onclick={closeInsightsModal}
					aria-label={m.action_close()}
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex-1 overflow-y-auto px-6 py-4">
				{#if detailLoading}
					<div class="flex items-center justify-center py-16">
						<span class="loading loading-lg loading-dots text-base-content/50"></span>
					</div>
				{:else if detailError}
					<div class="flex flex-col items-center gap-3 py-12 text-center">
						<p class="text-sm text-error">{detailError}</p>
						<div class="flex gap-2">
							<button class="btn btn-ghost btn-sm" onclick={closeInsightDetail}>Back</button>
							<button class="btn btn-ghost btn-sm" onclick={fetchInsightItems}>Retry</button>
						</div>
					</div>
				{:else if detailItems.length === 0}
					<div class="flex items-center justify-center py-12 text-sm text-base-content/40">
						No items found
					</div>
				{:else}
					<div class="space-y-1">
						{#each groupedItems as group (group.key)}
							{@const isGroupExpanded = expandedGroupKey === group.key}
							{@const showGroupActions = s && s.insightType === 'orphaned-files'}
							{@const flatItem = group.count === 1 ? group.items[0] : null}
							{@const isFlatExpanded = flatItem !== null && expandedItemId === flatItem.id}
							{@const flatItemLoading = flatItem !== null && actionLoading.has(flatItem.id)}
							<div
								role="button"
								tabindex="0"
								class="w-full cursor-pointer rounded-lg border border-base-300 bg-base-200/50 px-3 py-2.5 text-left transition-colors hover:bg-base-200"
								onclick={() => {
									if (flatItem) {
										expandedItemId = isFlatExpanded ? null : flatItem.id;
									} else {
										expandedGroupKey = isGroupExpanded ? null : group.key;
									}
								}}
								onkeydown={(e) => {
									if (e.key !== 'Enter') return;
									if (flatItem) {
										expandedItemId = isFlatExpanded ? null : flatItem.id;
									} else {
										expandedGroupKey = isGroupExpanded ? null : group.key;
									}
								}}
							>
								<div class="flex items-center gap-3">
									{#if group.kind === 'movie'}
										<Film class="h-4 w-4 shrink-0 text-base-content/40" />
									{:else}
										<Tv class="h-4 w-4 shrink-0 text-base-content/40" />
									{/if}
									<div class="min-w-0 flex-1">
										<div class="truncate text-sm font-medium text-base-content">
											{group.label}
										</div>
									</div>
									{#if flatItem?.badges}
										{#each flatItem.badges as badge (badge.label + badge.tone)}
											<span class={`badge border badge-sm ${badgeToneColor(badge.tone)}`}>
												{badge.label}
											</span>
										{/each}
									{:else if group.count > 1}
										<span class="badge badge-sm">{group.count}</span>
									{/if}
									{#if flatItem?.sizeBytes}
										<span class="text-xs text-base-content/50"
											>{formatBytes(flatItem.sizeBytes)}</span
										>
									{/if}
									{#if flatItem?.href}
										<a
											href={resolvePath(flatItem.href)}
											class="btn btn-ghost btn-xs"
											onclick={(e) => e.stopPropagation()}
										>
											Open
										</a>
									{/if}
									{#if showGroupActions && !flatItem}
										<button
											class="btn btn-ghost text-error btn-xs"
											onclick={(e) => {
												e.stopPropagation();
												handleDeleteAllOrphaned(group.items);
											}}
											disabled={actionLoading.has('orphaned-all')}
										>
											{#if actionLoading.has('orphaned-all')}
												<span class="loading loading-xs loading-spinner"></span>
											{/if}
											Delete All
										</button>
									{/if}
								</div>
								<!-- Inline remediation for flat (single) items -->
								{#if flatItem && isFlatExpanded && s}
									<div class="mt-2 border-t border-base-300 pt-2">
										<p class="text-xs text-base-content/70">
											{getRemediation(s.insightType, flatItem)}
										</p>
										<div class="mt-2 flex gap-1">
											{#if s.insightType === 'quality-below-cutoff'}
												<button
													class="btn btn-ghost btn-xs"
													onclick={(e) => {
														e.stopPropagation();
														handleAutoSearch(flatItem);
													}}
													disabled={flatItemLoading}
												>
													{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
														></span>{/if}
													<Search class="h-3 w-3" /> Auto
												</button>
											{/if}
											{#if s.insightType === 'missing-from-media-server'}
												<button
													class="btn btn-ghost btn-xs"
													onclick={(e) => {
														e.stopPropagation();
														handleAutoSearch(flatItem);
													}}
													disabled={flatItemLoading}
												>
													{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
														></span>{/if}
													<Search class="h-3 w-3" /> Auto
												</button>
												<button
													class="btn btn-ghost btn-xs"
													onclick={(e) => {
														e.stopPropagation();
														handleInteractiveSearch(flatItem);
													}}
												>
													Interactive
												</button>
											{/if}
											{#if s.insightType === 'unplayed'}
												<button
													class="btn btn-ghost btn-xs"
													onclick={(e) => {
														e.stopPropagation();
														handleUnmonitor(flatItem);
													}}
													disabled={flatItemLoading}
												>
													{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
														></span>{/if}
													Unmonitor
												</button>
												<button
													class="btn btn-ghost text-error btn-xs"
													onclick={(e) => {
														e.stopPropagation();
														handleRemoveFromLibrary(flatItem);
													}}
													disabled={flatItemLoading}
												>
													{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
														></span>{/if}
													Remove
												</button>
											{/if}
											{#if s.insightType === 'broken-paths'}
												<button
													class="btn btn-ghost text-error btn-xs"
													onclick={(e) => {
														e.stopPropagation();
														handleRemoveFromLibrary(flatItem);
													}}
													disabled={flatItemLoading}
												>
													{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
														></span>{/if}
													Remove
												</button>
											{/if}
											{#if s.insightType === 'orphaned-files'}
												<button
													class="btn btn-ghost text-error btn-xs"
													onclick={(e) => {
														e.stopPropagation();
														handleDeleteOrphaned(flatItem);
													}}
													disabled={flatItemLoading}
												>
													{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
														></span>{/if}
													Delete
												</button>
											{/if}
										</div>
									</div>
								{/if}
							</div>
							<!-- Sub-item list only for grouped items (count > 1) -->
							{#if !flatItem && isGroupExpanded}
								<div class="space-y-1 pl-6">
									{#each group.items as item (item.id)}
										{@const isExpanded = expandedItemId === item.id}
										{@const itemLoading = actionLoading.has(item.id)}
										<div
											role="button"
											tabindex="0"
											class="w-full cursor-pointer rounded-lg border border-base-300 bg-base-200/30 px-3 py-2 text-left transition-colors hover:bg-base-200/50"
											onclick={() => (expandedItemId = isExpanded ? null : item.id)}
											onkeydown={(e) => {
												if (e.key === 'Enter') expandedItemId = isExpanded ? null : item.id;
											}}
										>
											<div class="flex items-center gap-2">
												<Monitor class="h-3.5 w-3.5 shrink-0 text-base-content/40" />
												<div class="min-w-0 flex-1">
													<div class="truncate text-xs font-medium text-base-content">
														{item.title}
													</div>
												</div>
												{#if item.badges}
													{#each item.badges as badge (badge.label + badge.tone)}
														<span class={`badge border badge-sm ${badgeToneColor(badge.tone)}`}>
															{badge.label}
														</span>
													{/each}
												{/if}
												{#if item.sizeBytes}
													<span class="text-xs text-base-content/50"
														>{formatBytes(item.sizeBytes)}</span
													>
												{/if}
												{#if item.href}
													<a
														href={resolvePath(item.href)}
														class="btn btn-ghost btn-xs"
														onclick={(e) => e.stopPropagation()}
													>
														Open
													</a>
												{/if}
											</div>
											{#if isExpanded && s}
												<div class="mt-2 border-t border-base-300 pt-2">
													<p class="text-xs text-base-content/70">
														{getRemediation(s.insightType, item)}
													</p>
													<div class="mt-2 flex gap-1">
														{#if s.insightType === 'quality-below-cutoff'}
															<button
																class="btn btn-ghost btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	handleAutoSearch(item);
																}}
																disabled={itemLoading}
															>
																{#if itemLoading}<span class="loading loading-xs loading-spinner"
																	></span>{/if}
																<Search class="h-3 w-3" /> Auto
															</button>
														{/if}
														{#if s.insightType === 'missing-from-media-server'}
															<button
																class="btn btn-ghost btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	handleAutoSearch(item);
																}}
																disabled={itemLoading}
															>
																{#if itemLoading}<span class="loading loading-xs loading-spinner"
																	></span>{/if}
																<Search class="h-3 w-3" /> Auto
															</button>
															<button
																class="btn btn-ghost btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	handleInteractiveSearch(item);
																}}
															>
																Interactive
															</button>
														{/if}
														{#if s.insightType === 'unplayed'}
															<button
																class="btn btn-ghost btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	handleUnmonitor(item);
																}}
																disabled={itemLoading}
															>
																{#if itemLoading}<span class="loading loading-xs loading-spinner"
																	></span>{/if}
																Unmonitor
															</button>
															<button
																class="btn btn-ghost text-error btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	handleRemoveFromLibrary(item);
																}}
																disabled={itemLoading}
															>
																{#if itemLoading}<span class="loading loading-xs loading-spinner"
																	></span>{/if}
																Remove
															</button>
														{/if}
														{#if s.insightType === 'broken-paths'}
															<button
																class="btn btn-ghost text-error btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	handleRemoveFromLibrary(item);
																}}
																disabled={itemLoading}
															>
																{#if itemLoading}<span class="loading loading-xs loading-spinner"
																	></span>{/if}
																Remove
															</button>
														{/if}
														{#if s.insightType === 'orphaned-files'}
															<button
																class="btn btn-ghost text-error btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	handleDeleteOrphaned(item);
																}}
																disabled={itemLoading}
															>
																{#if itemLoading}<span class="loading loading-xs loading-spinner"
																	></span>{/if}
																Delete
															</button>
														{/if}
													</div>
												</div>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						{/each}
					</div>

					{#if detailTotalPages > 1}
						<div class="mt-4 flex items-center justify-between">
							<span class="text-xs text-base-content/40">
								{detailTotal} item{detailTotal !== 1 ? 's' : ''}
							</span>
							<div class="join">
								<button
									class="btn join-item btn-ghost btn-xs"
									disabled={detailPage <= 1}
									onclick={() => changeDetailPage(detailPage - 1)}
								>
									Prev
								</button>
								{#each detailPageButtons as btn, idx (idx)}
									{@const isActive = btn === detailPage}
									{@const isEllipsis = btn === '...'}
									{#if isEllipsis}
										<button class="btn join-item btn-ghost btn-xs" disabled> ... </button>
									{:else}
										<button
											class="btn join-item btn-ghost btn-xs"
											class:btn-active={isActive}
											onclick={() => changeDetailPage(btn)}
										>
											{btn}
										</button>
									{/if}
								{/each}
								<button
									class="btn join-item btn-ghost btn-xs"
									disabled={detailPage >= detailTotalPages}
									onclick={() => changeDetailPage(detailPage + 1)}
								>
									Next
								</button>
							</div>
						</div>
					{/if}
				{/if}
			</div>

			<div class="flex items-center justify-between border-t border-base-300 px-6 py-3">
				{#if footerLink}
					<a href={resolvePath(footerLink)} class="link text-sm link-hover">
						View all in {insightTypeLabel(s.insightType)}
					</a>
				{/if}
				<div class="ml-auto flex items-center gap-2">
					<button class="btn btn-ghost btn-sm" onclick={() => handleDismissInsight(s.id)}>
						Dismiss
					</button>
					<button class="btn btn-ghost btn-sm" onclick={closeInsightsModal}> Close </button>
				</div>
			</div>
		</div>
	{:else}
		<!-- Card list view -->
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="flex items-center justify-between border-b border-base-300 px-6 py-4">
				<h3 id="status-insights-title" class="text-lg font-bold">Storage Insights</h3>
				<button
					class="btn btn-circle btn-ghost btn-sm"
					onclick={closeInsightsModal}
					aria-label={m.action_close()}
				>
					<X class="h-4 w-4" />
				</button>
			</div>
			<div class="flex-1 space-y-4 overflow-y-auto px-6 py-4">
				{#if activeInsights.length > 0}
					<div>
						<h4 class="mb-2 text-sm font-medium text-base-content/70">
							Active ({activeInsights.length})
						</h4>
						<div class="space-y-2">
							{#each activeInsights as insight (insight.id)}
								<InsightCard
									{insight}
									onOpen={() => openInsightDetail(insight)}
									onDismissed={() => void refreshAll()}
								/>
							{/each}
						</div>
					</div>
				{/if}
				{#if dismissedInsights.length > 0}
					<div>
						<h4 class="mb-2 text-sm font-medium text-base-content/70">
							Dismissed ({dismissedInsights.length})
						</h4>
						<div class="space-y-2">
							{#each dismissedInsights as insight (insight.id)}
								<InsightCard
									{insight}
									onOpen={() => openInsightDetail(insight)}
									onDismissed={() => void refreshAll()}
								/>
							{/each}
						</div>
					</div>
				{/if}
				{#if activeInsights.length === 0 && dismissedInsights.length === 0}
					<p class="text-sm text-base-content/50">No storage insights</p>
				{/if}
			</div>
		</div>
	{/if}
</ModalWrapper>

{#if searchModalItem}
	{@const id = extractIdFromHref(searchModalItem.href)}
	{@const isMovie = isMovieHref(searchModalItem.href)}
	{@const seasonEp = parseSeasonEpisode(searchModalItem.title)}
	<MediaSearchModal
		open={searchModalOpen}
		movieId={isMovie ? (id ?? undefined) : undefined}
		seriesId={!isMovie ? (id ?? undefined) : undefined}
		season={seasonEp?.season}
		episode={seasonEp?.episode}
		onClose={() => (searchModalOpen = false)}
	/>
{/if}

<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { HardDrive, RefreshCw, Lightbulb, X } from '@lucide/svelte';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import {
		StorageDashboard,
		InsightCard,
		InsightDetailModal
	} from '#lib/components/storage/index.js';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';
	import type { Insight } from '#lib/components/storage/utils.js';
	import { layoutState } from '#lib/layout.svelte.js';
	import { refreshAll } from '$app/navigation';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { scanLibrary } from '#lib/api/library.js';
	import { syncMediaServerStats } from '#lib/api/settings.js';
	import { formatBytes } from '#lib/utils/format.js';
	import {
		getHistoryRetention,
		saveHistoryRetention,
		getStorageForecast,
		type HistoryRetentionSettings,
		type StorageForecast
	} from '#lib/api/history-retention.js';
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

	let selectedInsight = $state<Insight | null>(null);

	function handleDashboardInsightClick(insight: Insight) {
		insightsOpen = true;
		selectedInsight = insight;
	}

	function closeInsightsModal() {
		insightsOpen = false;
		selectedInsight = null;
	}

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
	open={insightsOpen && !selectedInsight}
	onClose={closeInsightsModal}
	maxWidth="4xl"
	flexContent
	labelledBy="status-insights-title"
>
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
								onOpen={() => (selectedInsight = insight)}
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
								onOpen={() => (selectedInsight = insight)}
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
</ModalWrapper>

<InsightDetailModal
	open={selectedInsight !== null}
	insight={selectedInsight}
	onClose={closeInsightsModal}
	onDismissed={() => void refreshAll()}
/>

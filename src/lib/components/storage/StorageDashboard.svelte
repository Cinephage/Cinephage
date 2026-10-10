<script lang="ts">
	import {
		HardDrive,
		ShieldCheck,
		AlertTriangle,
		Library as LibraryIcon,
		BarChart3,
		RefreshCw,
		CheckCircle,
		ChevronRight,
		TrendingUp,
		Database
	} from '@lucide/svelte';
	import type { StorageSummary, ScanSuccess, ServerStatus } from './utils.js';
	import type { LibraryBreakdownItem, RootFolderBreakdownItem } from './utils.js';
	import {
		formatBytes,
		formatTimestamp,
		getScanTone,
		getServerTypeBadgeClass,
		getSyncStatusColor
	} from './utils.js';
	import StorageTile from './StorageTile.svelte';
	import { BreakdownBar } from '#lib/components/ui/index.js';

	type BreakdownItem = { label: string; count: number };

	type MediaListItem = {
		title: string;
		seriesName: string | null;
		playCount?: number | null;
		fileSize?: number | null;
		height?: number | null;
		videoCodec?: string | null;
		itemType: string;
	};

	type Insight = {
		id: string;
		insightType: string;
		severity: 'info' | 'warning' | 'critical';
		title: string;
		summary: string | null;
		reclaimableBytes: number | null;
		detailsJson: string | null;
		itemCount: number;
	};

	interface Props {
		storage: StorageSummary;
		libraryBreakdown: LibraryBreakdownItem[];
		rootFolderBreakdown: RootFolderBreakdownItem[];
		insights: Insight[];
		mediaServerStats: {
			uniqueItems: number;
			totalPlays: number;
			resolutionBreakdown: BreakdownItem[];
			codecBreakdown: BreakdownItem[];
			hdrBreakdown: BreakdownItem[];
			audioCodecBreakdown: BreakdownItem[];
		};
		topItems: MediaListItem[];
		largestItems: MediaListItem[];
		scanError: string | null;
		scanSuccess: ScanSuccess | null;
		serverStatuses: ServerStatus[];
		onOpenInsight?: (insight: Insight) => void;
	}

	let {
		storage,
		libraryBreakdown,
		rootFolderBreakdown,
		insights,
		mediaServerStats,
		topItems,
		largestItems,
		scanError,
		scanSuccess,
		serverStatuses,
		onOpenInsight
	}: Props = $props();

	// --- Tile computations ---
	const totalCapacity = $derived(
		rootFolderBreakdown.reduce((sum, f) => sum + (f.totalSpaceBytes ?? 0), 0)
	);
	const capacityPercent = $derived(
		totalCapacity > 0 ? Math.round((storage.totalUsedBytes / totalCapacity) * 100) : 0
	);
	const folderCount = $derived(rootFolderBreakdown.length);

	const criticalCount = $derived(insights.filter((i) => i.severity === 'critical').length);
	const warningCount = $derived(insights.filter((i) => i.severity === 'warning').length);

	const healthStatus = $derived(
		criticalCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'success'
	);
	const healthLabel = $derived(
		criticalCount > 0
			? `${criticalCount} critical`
			: warningCount > 0
				? `${warningCount} warning`
				: 'Healthy'
	);

	const libraryCount = $derived(libraryBreakdown.length);
	const totalItems = $derived(libraryBreakdown.reduce((sum, l) => sum + l.itemCount, 0));

	const belowCutoffCount = $derived(
		insights.find((i) => i.insightType === 'quality-below-cutoff')?.itemCount ?? 0
	);

	// --- Chart segment data ---
	const storageTypeSegments = $derived(
		[
			{ label: 'Movies', value: storage.moviesUsedBytes, colorClass: 'bg-primary' },
			{ label: 'TV', value: storage.tvUsedBytes, colorClass: 'bg-secondary' },
			{ label: 'Subtitles', value: storage.subtitlesUsedBytes, colorClass: 'bg-accent' }
		].filter((s) => s.value > 0)
	);

	const libraryStorageSegments = $derived(
		libraryBreakdown
			.filter((l) => l.usedBytes > 0)
			.map((l) => ({ label: l.name, value: l.usedBytes }))
	);

	const resolutionSegments = $derived(
		mediaServerStats.resolutionBreakdown.map((r) => ({ label: r.label, value: r.count }))
	);
	const codecSegments = $derived(
		mediaServerStats.codecBreakdown.map((c) => ({ label: c.label, value: c.count }))
	);
	const hdrSegments = $derived(
		mediaServerStats.hdrBreakdown.map((h) => ({ label: h.label, value: h.count }))
	);
	const audioSegments = $derived(
		mediaServerStats.audioCodecBreakdown.map((a) => ({ label: a.label, value: a.count }))
	);

	function heightToRes(h: number | null | undefined): string {
		if (!h) return '?';
		if (h >= 2160) return '4K';
		if (h >= 1080) return '1080p';
		if (h >= 720) return '720p';
		return 'SD';
	}

	function severityDot(sev: string): string {
		return sev === 'critical' ? 'bg-error' : sev === 'warning' ? 'bg-warning' : 'bg-info';
	}

	const topInsights = $derived(insights.slice(0, 5));

	function mediaTitle(item: MediaListItem): string {
		return item.seriesName ?? item.title;
	}

	const baseUrl = '/settings/monitoring/status';

	// Chart card helper — keeps the repeated pattern DRY
	const chartSections = $derived(
		[
			{
				title: 'Storage by Type',
				segments: storageTypeSegments,
				totalLabel: formatBytes(storage.totalUsedBytes),
				formatValues: true
			},
			{
				title: 'Storage by Library',
				segments: libraryStorageSegments,
				totalLabel: `${formatBytes(storage.totalUsedBytes)} \u00B7 ${libraryCount} libraries`,
				formatValues: true
			},
			{
				title: 'Resolution',
				segments: resolutionSegments,
				totalLabel: `${mediaServerStats.uniqueItems} items`,
				formatValues: false
			},
			{
				title: 'Video Codec',
				segments: codecSegments,
				totalLabel: `${codecSegments.length} codecs`,
				formatValues: false
			},
			{
				title: 'HDR / SDR',
				segments: hdrSegments,
				totalLabel: `${hdrSegments.length} formats`,
				formatValues: false
			},
			{
				title: 'Audio Codec',
				segments: audioSegments,
				totalLabel: `${audioSegments.length} codecs`,
				formatValues: false
			}
		].filter((c) => c.segments.length > 0)
	);
</script>

<!-- Scan alerts (transient one-shot feedback) -->
{#if scanError}
	<div class="mb-4 alert alert-error">
		<AlertTriangle class="h-5 w-5" />
		<span>{scanError}</span>
	</div>
{/if}

{#if scanSuccess}
	<div class="mb-4 alert alert-success">
		<CheckCircle class="h-5 w-5" />
		<span>{scanSuccess.message}</span>
	</div>
{/if}

<!-- SCAN STATUS BAR -->
<div
	class="mb-4 flex flex-col gap-3 rounded-lg border border-base-300 bg-base-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
>
	<div class="flex items-center gap-3 text-sm">
		<span class="inline-block h-2 w-2 rounded-full {getScanTone(storage.health.lastScan?.status)}"
		></span>
		{#if storage.health.lastScan}
			<span class="text-base-content/70">
				Last scan: <strong class="text-base-content"
					>{formatTimestamp(
						storage.health.lastScan.completedAt ?? storage.health.lastScan.startedAt
					)}</strong
				>
			</span>
		{:else}
			<span class="text-base-content/50">No scan history</span>
		{/if}
	</div>
	{#if serverStatuses.length > 0}
		<div class="flex flex-wrap gap-2">
			{#each serverStatuses as server (server.serverId)}
				<span class="inline-flex items-center gap-1.5 text-xs text-base-content/70">
					<span class="badge badge-xs {getServerTypeBadgeClass(server.serverType)}"></span>
					<span>{server.serverName}</span>
					<span
						class="badge badge-xs {getSyncStatusColor(server.lastSyncStatus, server.lastSyncAt)}"
						>{server.lastSyncStatus ?? 'pending'}</span
					>
				</span>
			{/each}
		</div>
	{/if}
</div>

<!-- KPI TILE GRID -->
<div class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3 sm:gap-4">
	<StorageTile
		icon={HardDrive}
		iconClass="bg-primary/10 text-primary"
		label="Capacity"
		value={formatBytes(storage.totalUsedBytes)}
		context={totalCapacity > 0
			? `${capacityPercent}% of ${formatBytes(totalCapacity)} \u00B7 ${folderCount} folder${folderCount === 1 ? '' : 's'}`
			: `${folderCount} folder${folderCount === 1 ? '' : 's'}`}
		href={`${baseUrl}/folders`}
		miniSegments={rootFolderBreakdown.length > 0
			? [
					{ value: storage.totalUsedBytes, colorClass: 'bg-primary' },
					{
						value: Math.max(0, totalCapacity - storage.totalUsedBytes),
						colorClass: 'bg-base-content/10'
					}
				]
			: undefined}
	/>
	<StorageTile
		icon={ShieldCheck}
		iconClass={healthStatus === 'success'
			? 'bg-success/10 text-success'
			: healthStatus === 'warning'
				? 'bg-warning/10 text-warning'
				: 'bg-error/10 text-error'}
		label="Health Insights"
		value={healthLabel}
		context={insights.length > 0
			? `${insights.length} insight${insights.length === 1 ? '' : 's'}`
			: 'No issues'}
		href={`${baseUrl}/insights`}
		statusDot={healthStatus}
	/>
	<StorageTile
		icon={LibraryIcon}
		iconClass="bg-secondary/10 text-secondary"
		label="Libraries"
		value={String(libraryCount)}
		context={`${totalItems} item${totalItems === 1 ? '' : 's'} tracked`}
		href={`${baseUrl}/libraries`}
	/>
	<StorageTile
		icon={BarChart3}
		iconClass="bg-accent/10 text-accent"
		label="Media Quality"
		value={mediaServerStats.uniqueItems > 0 ? `${mediaServerStats.uniqueItems} items` : 'No data'}
		context={mediaServerStats.totalPlays > 0
			? `${mediaServerStats.totalPlays} total plays`
			: belowCutoffCount > 0
				? `${belowCutoffCount} below cutoff`
				: 'No play data'}
		href={`${baseUrl}/media`}
		miniSegments={resolutionSegments.length > 0
			? [
					{
						value: mediaServerStats.resolutionBreakdown.find((r) => r.label === '4K')?.count ?? 0,
						colorClass: 'bg-accent'
					},
					{
						value:
							mediaServerStats.resolutionBreakdown.find((r) => r.label === '1080p')?.count ?? 0,
						colorClass: 'bg-accent/70'
					},
					{
						value: mediaServerStats.resolutionBreakdown.find((r) => r.label === '720p')?.count ?? 0,
						colorClass: 'bg-accent/40'
					},
					{
						value:
							mediaServerStats.resolutionBreakdown.find(
								(r) => r.label === '480p' || r.label === 'SD'
							)?.count ?? 0,
						colorClass: 'bg-accent/20'
					}
				].filter((s) => s.value > 0)
			: undefined}
	/>
	<StorageTile
		icon={RefreshCw}
		iconClass="bg-info/10 text-info"
		label="Sync Status"
		value={storage.health.lastScan
			? formatTimestamp(storage.health.lastScan.completedAt ?? storage.health.lastScan.startedAt)
			: 'Never'}
		context={serverStatuses.length > 0
			? `${serverStatuses.length} server${serverStatuses.length === 1 ? '' : 's'} \u00B7 ${serverStatuses.filter((s) => s.lastSyncStatus === 'completed').length} synced`
			: 'No servers'}
	/>
</div>

<!-- CHARTS GRID (auto-fit) -->
{#if chartSections.length > 0}
	<div class="mt-4 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
		{#each chartSections as section (section.title)}
			<div class="card bg-base-200 p-3">
				<div class="mb-2 flex items-center justify-between">
					<h3 class="text-xs font-semibold tracking-wide text-base-content/60 uppercase">
						{section.title}
					</h3>
					<span class="text-xs text-base-content/40">{section.totalLabel}</span>
				</div>
				<BreakdownBar
					segments={section.segments}
					variant="thin"
					showLegend={true}
					valueFormatter={section.formatValues ? formatBytes : undefined}
				/>
			</div>
		{/each}
	</div>
{/if}

<!-- MAIN BODY: Lists + Insights sidebar -->
<div class="mt-4 grid gap-4 lg:grid-cols-3">
	<!-- LEFT (2/3): Top Played + Largest Files -->
	<div class="space-y-4 lg:col-span-2">
		<!-- Top Played Items -->
		{#if topItems.length > 0}
			<div class="card bg-base-200">
				<div class="flex items-center gap-2 border-b border-base-300 p-3">
					<TrendingUp class="h-4 w-4 text-primary" />
					<h3 class="text-sm font-semibold text-base-content/70">Most Played</h3>
				</div>
				<div class="divide-y divide-base-300">
					{#each topItems as item, i (i)}
						<div class="flex items-center gap-3 p-2.5">
							<span class="w-5 shrink-0 text-center text-sm font-bold text-base-content/30"
								>{i + 1}</span
							>
							<div class="min-w-0 flex-1">
								<div class="truncate text-sm font-medium text-base-content">{mediaTitle(item)}</div>
								<div class="text-xs text-base-content/50">
									{item.playCount} play{item.playCount === 1 ? '' : 's'}
								</div>
							</div>
							<span class="badge shrink-0 badge-ghost badge-sm">{heightToRes(item.height)}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Largest Files -->
		{#if largestItems.length > 0}
			<div class="card bg-base-200">
				<div class="flex items-center gap-2 border-b border-base-300 p-3">
					<Database class="h-4 w-4 text-secondary" />
					<h3 class="text-sm font-semibold text-base-content/70">Largest Files</h3>
				</div>
				<div class="divide-y divide-base-300">
					{#each largestItems as item, i (i)}
						<div class="flex items-center gap-3 p-2.5">
							<span class="w-5 shrink-0 text-center text-sm font-bold text-base-content/30"
								>{i + 1}</span
							>
							<div class="min-w-0 flex-1">
								<div class="truncate text-sm font-medium text-base-content">{mediaTitle(item)}</div>
								<div class="text-xs text-base-content/50">
									{item.videoCodec?.toUpperCase() ?? '?'} &middot; {heightToRes(item.height)}
								</div>
							</div>
							<span class="shrink-0 text-sm font-medium text-base-content"
								>{formatBytes(item.fileSize ?? 0)}</span
							>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Browse media link -->
		<div class="flex justify-end">
			<a href={`${baseUrl}/media`} class="btn gap-1 btn-ghost btn-sm">
				Browse all media
				<ChevronRight class="h-3.5 w-3.5" />
			</a>
		</div>
	</div>

	<!-- RIGHT (1/3): Priority Insights + Per-Folder Disk -->
	<div class="space-y-4">
		<!-- Priority Insights -->
		<div class="space-y-2">
			<h3 class="text-sm font-semibold text-base-content/70">Priority Insights</h3>
			{#if topInsights.length === 0}
				<div
					class="flex items-center gap-2 rounded-lg border border-success/20 bg-success/5 p-3 text-sm text-base-content/60"
				>
					<CheckCircle class="h-4 w-4 shrink-0 text-success" />
					<span>Everything looks healthy</span>
				</div>
			{:else}
				{#each topInsights as insight (insight.id)}
					<button
						type="button"
						onclick={() => onOpenInsight?.(insight)}
						class="flex w-full items-center gap-2.5 rounded-lg border border-base-300 bg-base-200/50 p-2.5 text-left transition-colors hover:bg-base-300/50"
					>
						<span
							class={`inline-block h-2 w-2 shrink-0 rounded-full ${severityDot(insight.severity)}`}
						></span>
						<span class="min-w-0 flex-1 truncate text-sm text-base-content">{insight.title}</span>
						{#if insight.itemCount > 1}
							<span class="shrink-0 text-xs font-medium text-base-content/50"
								>{insight.itemCount}</span
							>
						{/if}
						<ChevronRight class="h-3.5 w-3.5 shrink-0 text-base-content/30" />
					</button>
				{/each}
			{/if}
		</div>

		<!-- Per-Folder Disk Usage -->
		{#if rootFolderBreakdown.length > 0}
			<div class="space-y-2">
				<h3 class="text-sm font-semibold text-base-content/70">Disk Usage</h3>
				<div class="card space-y-3 bg-base-200 p-3">
					{#each rootFolderBreakdown as folder (folder.id)}
						<!-- usedBytes is a real per-folder SUM(file sizes) (same source
						RootFolderOverview.svelte uses) - totalSpaceBytes/freeSpaceBytes
						are disk-level statfs() stats that were never wired up to refresh
						after folder creation, so using them here as "used" showed stale,
						identical-across-folders numbers. -->
						{@const total = folder.usedBytes + (folder.freeSpaceBytes ?? 0)}
						<div>
							<div class="mb-1 flex items-center justify-between text-xs">
								<span class="truncate text-base-content/70">{folder.name}</span>
								<span class="shrink-0 text-base-content/50">
									{total > 0 ? `${Math.round((folder.usedBytes / total) * 100)}%` : '?'}
								</span>
							</div>
							{#if folder.freeSpaceBytes !== null && folder.freeSpaceBytes !== undefined && total > 0}
								<div class="flex h-2 overflow-hidden rounded-full bg-base-300/60">
									<div
										class="h-full bg-primary"
										style="width: {(folder.usedBytes / total) * 100}%"
										title={`Used: ${formatBytes(folder.usedBytes)}`}
										role="img"
										aria-label={`${folder.name}: ${formatBytes(folder.usedBytes)} used of ${formatBytes(total)}`}
									></div>
									<div
										class="h-full bg-success/30"
										style="width: {(folder.freeSpaceBytes / total) * 100}%"
										title={`Free: ${formatBytes(folder.freeSpaceBytes)}`}
										role="img"
										aria-label={`${formatBytes(folder.freeSpaceBytes)} free`}
									></div>
								</div>
								<div class="mt-0.5 flex justify-between text-xs text-base-content/40">
									<span>{formatBytes(folder.usedBytes)} used</span>
									<span>{formatBytes(folder.freeSpaceBytes)} free</span>
								</div>
							{:else}
								<div class="flex h-2 items-center rounded-full bg-base-300/40">
									<span class="w-full text-center text-xs text-base-content/30">No disk data</span>
								</div>
							{/if}
						</div>
					{/each}
				</div>
				<a href={`${baseUrl}/folders`} class="btn w-full gap-1 btn-ghost btn-xs">
					Manage folders <ChevronRight class="h-3 w-3" />
				</a>
			</div>
		{/if}
	</div>
</div>

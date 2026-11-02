<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Clapperboard,
		Tv,
		Download,
		AlertCircle,
		CheckCircle,
		FileQuestion,
		Calendar,
		HardDrive,
		ChevronDown,
		ChevronUp
	} from '@lucide/svelte';
	import Skeleton from '#lib/components/ui/Skeleton.svelte';
	import { resolve } from '$app/paths';
	import { formatBytes } from '#lib/utils/format.js';
	import type { DashboardStats } from '#lib/types/dashboard.js';

	interface Props {
		stats: DashboardStats;
		missingEpisodesCount: number;
		isMissingEpisodesLoading: boolean;
	}

	let { stats, missingEpisodesCount, isMissingEpisodesLoading }: Props = $props();

	const movieSummary = $derived.by(() => {
		const parts: string[] = [m.dashboard_stats_filesCount({ count: stats.movies.withFile })];
		if (stats.movies.missing > 0)
			parts.push(m.dashboard_stats_missingCount({ count: stats.movies.missing }));
		return parts.join(' · ');
	});

	const movieDetails = $derived.by(() => {
		const parts: string[] = [];
		if (stats.movies.inCinemas > 0)
			parts.push(m.dashboard_stats_inTheatersCount({ count: stats.movies.inCinemas }));
		if (stats.movies.unreleased > 0)
			parts.push(m.dashboard_stats_unreleasedCount({ count: stats.movies.unreleased }));
		if (stats.movies.unmonitoredMissing > 0)
			parts.push(m.dashboard_stats_ignoredCount({ count: stats.movies.unmonitoredMissing }));
		return parts.join(' · ');
	});

	const episodeSummary = $derived.by(() => {
		const parts: string[] = [m.dashboard_stats_filesCount({ count: stats.episodes.withFile })];
		if (stats.episodes.missing > 0)
			parts.push(m.dashboard_stats_missingCount({ count: stats.episodes.missing }));
		return parts.join(' · ');
	});

	const episodeDetails = $derived.by(() => {
		const parts: string[] = [];
		if (stats.episodes.unaired > 0)
			parts.push(m.dashboard_stats_unairedCount({ count: stats.episodes.unaired }));
		if (stats.episodes.unmonitoredMissing > 0)
			parts.push(m.dashboard_stats_ignoredCount({ count: stats.episodes.unmonitoredMissing }));
		return parts.join(' · ');
	});

	const downloadSummary = $derived.by(() => {
		const parts: string[] = [];
		const downloadingCount = stats.activeDownloads - stats.stalledDownloads - stats.pausedDownloads;
		if (downloadingCount > 0)
			parts.push(m.dashboard_stats_downloadingCount({ count: downloadingCount }));
		if (stats.stalledDownloads > 0)
			parts.push(m.dashboard_stats_stalledCount({ count: stats.stalledDownloads }));
		if (stats.pausedDownloads > 0)
			parts.push(m.dashboard_stats_pausedCount({ count: stats.pausedDownloads }));
		if (stats.queuedDownloads > 0)
			parts.push(m.dashboard_stats_queuedCount({ count: stats.queuedDownloads }));
		if (stats.completedDownloadsLast24h > 0)
			parts.push(m.dashboard_stats_completedTodayCount({ count: stats.completedDownloadsLast24h }));
		return parts.length > 0 ? parts.join(' · ') : m.dashboard_stats_noActiveDownloads();
	});

	const storageMovieBytes = $derived(
		stats.storage.movieBytes > 0 ? formatBytes(stats.storage.movieBytes) : null
	);
	const storageTvBytes = $derived(
		stats.storage.tvBytes > 0 ? formatBytes(stats.storage.tvBytes) : null
	);
	const storageFreeSpace = $derived(
		stats.storage.freeBytes > 0
			? m.dashboard_stats_freeSpace({ size: formatBytes(stats.storage.freeBytes) })
			: null
	);

	const storageCapacity = $derived(stats.storage.totalBytes + stats.storage.freeBytes);

	let movieSummaryEl = $state<HTMLElement | null>(null);
	let movieTruncated = $state(false);
	let movieExpanded = $state(false);

	let episodeSummaryEl = $state<HTMLElement | null>(null);
	let episodeTruncated = $state(false);
	let episodeExpanded = $state(false);

	let storageSummaryEl = $state<HTMLElement | null>(null);
	let storageTruncated = $state(false);
	let storageExpanded = $state(false);

	$effect(() => {
		const el = movieSummaryEl;
		if (!el) return;
		const check = () => {
			movieTruncated = el.scrollWidth > el.clientWidth;
		};
		check();
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	});

	$effect(() => {
		const el = episodeSummaryEl;
		if (!el) return;
		const check = () => {
			episodeTruncated = el.scrollWidth > el.clientWidth;
		};
		check();
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	});

	$effect(() => {
		const el = storageSummaryEl;
		if (!el) return;
		const check = () => {
			storageTruncated = el.scrollWidth > el.clientWidth;
		};
		check();
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	});
</script>

<div class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] items-start gap-3 sm:gap-4">
	<div class="card relative bg-base-200 transition-colors hover:bg-base-300">
		<a
			href={resolve('library/movies')}
			class="absolute inset-0 z-0"
			aria-label={m.dashboard_stats_movies()}
		></a>
		<div class="card-body gap-1.5 p-3">
			<div class="flex items-center gap-2">
				<div class="shrink-0 rounded-lg bg-primary/10 p-1.5">
					<Clapperboard class="h-5 w-5 text-primary" />
				</div>
				<span class="text-xl font-bold">{stats.movies.total}</span>
				<span class="text-sm text-base-content/60">{m.dashboard_stats_movies()}</span>
			</div>
			<div class="relative flex min-w-0 items-start">
				<span
					bind:this={movieSummaryEl}
					class="text-xs text-base-content/50 {movieExpanded ? 'wrap-break-word' : 'truncate'}"
					>{movieSummary}{movieDetails ? ` · ${movieDetails}` : ''}</span
				>
				{#if movieTruncated && !movieExpanded}
					<button
						class="relative z-10 ml-0.5 shrink-0 p-1 text-base-content/30 hover:text-base-content/60 sm:p-0"
						onclick={(e) => {
							e.preventDefault();
							movieExpanded = true;
						}}
						aria-label="Show full stats"><ChevronDown class="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button
					>
				{:else if movieExpanded}
					<button
						class="relative z-10 ml-0.5 shrink-0 p-1 text-base-content/30 hover:text-base-content/60 sm:p-0"
						onclick={(e) => {
							e.preventDefault();
							movieExpanded = false;
						}}
						aria-label="Collapse stats"><ChevronUp class="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button
					>
				{/if}
			</div>
			{#if stats.movies.total > 0}
				<progress
					class="progress h-1 progress-primary"
					value={stats.movies.withFile}
					max={stats.movies.total}
				></progress>
			{:else}
				<div class="h-1"></div>
			{/if}
		</div>
	</div>

	<div class="card relative bg-base-200 transition-colors hover:bg-base-300">
		<a
			href={resolve('library/tv')}
			class="absolute inset-0 z-0"
			aria-label={m.dashboard_stats_tvShows()}
		></a>
		<div class="card-body gap-1.5 p-3">
			<div class="flex items-center gap-2">
				<div class="shrink-0 rounded-lg bg-secondary/10 p-1.5">
					<Tv class="h-5 w-5 text-secondary" />
				</div>
				<span class="text-xl font-bold">{stats.series.total}</span>
				<span class="text-sm text-base-content/60">{m.dashboard_stats_tvShows()}</span>
			</div>
			<div class="relative flex min-w-0 items-start">
				<span
					bind:this={episodeSummaryEl}
					class="text-xs text-base-content/50 {episodeExpanded ? 'wrap-break-word' : 'truncate'}"
					>{episodeSummary}{episodeDetails ? ` · ${episodeDetails}` : ''}</span
				>
				{#if episodeTruncated && !episodeExpanded}
					<button
						class="relative z-10 ml-0.5 shrink-0 p-1 text-base-content/30 hover:text-base-content/60 sm:p-0"
						onclick={(e) => {
							e.preventDefault();
							episodeExpanded = true;
						}}
						aria-label="Show full stats"><ChevronDown class="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button
					>
				{:else if episodeExpanded}
					<button
						class="relative z-10 ml-0.5 shrink-0 p-1 text-base-content/30 hover:text-base-content/60 sm:p-0"
						onclick={(e) => {
							e.preventDefault();
							episodeExpanded = false;
						}}
						aria-label="Collapse stats"><ChevronUp class="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button
					>
				{/if}
			</div>
			{#if stats.episodes.total > 0}
				<progress
					class="progress h-1 progress-secondary"
					value={stats.episodes.withFile}
					max={stats.episodes.total}
				></progress>
			{:else}
				<div class="h-1"></div>
			{/if}
		</div>
	</div>

	<div class="card relative bg-base-200 transition-colors hover:bg-base-300">
		<a
			href={resolve('activity')}
			class="absolute inset-0 z-0"
			aria-label={m.dashboard_stats_downloads()}
		></a>
		<div class="card-body gap-1.5 p-3">
			<div class="flex items-center gap-2">
				<div class="shrink-0 rounded-lg bg-accent/10 p-1.5">
					<Download class="h-5 w-5 text-accent" />
				</div>
				<span class="text-xl font-bold">{stats.activeDownloads}</span>
				<span class="text-sm text-base-content/60">
					{m.dashboard_stats_downloads()}
				</span>
				{#if stats.activeDownloads > 0 && stats.downloadSpeedBytes > 0}
					<span class="ml-auto text-xs text-accent">{formatBytes(stats.downloadSpeedBytes)}/s</span>
				{/if}
			</div>
			<div class="truncate text-xs text-base-content/50" title={downloadSummary}>
				{downloadSummary}
			</div>
			{#if stats.activeDownloads > 0 && stats.downloadAvgProgress > 0}
				<progress class="progress h-1 progress-accent" value={stats.downloadAvgProgress} max="100"
				></progress>
			{:else}
				<div class="h-1"></div>
			{/if}
		</div>
	</div>

	<div class="card bg-base-200">
		<div class="card-body gap-1.5 p-3">
			<div class="flex items-center gap-2">
				<div class="shrink-0 rounded-lg bg-warning/10 p-1.5">
					<Calendar class="h-5 w-5 text-warning" />
				</div>
				{#if isMissingEpisodesLoading}
					<Skeleton variant="text" class="h-7 w-8" />
				{:else}
					<span class="text-xl font-bold">{missingEpisodesCount}</span>
				{/if}
				<span class="text-sm text-base-content/60">
					<span class="sm:hidden">{m.dashboard_stats_missingEpisodesShort()}</span>
					<span class="hidden sm:inline">{m.dashboard_stats_missingEpisodes()}</span>
				</span>
			</div>
			<div class="truncate text-xs text-base-content/50">
				{m.dashboard_stats_airedNotDownloaded()}
			</div>
			<div class="h-1"></div>
		</div>
	</div>

	{#if stats.unmatchedFiles > 0}
		<a
			href={resolve('library/unmatched')}
			class="card bg-base-200 transition-colors hover:bg-base-300"
		>
			<div class="card-body gap-1.5 p-3">
				<div class="flex items-center gap-2">
					<div class="shrink-0 rounded-lg bg-error/10 p-1.5">
						<FileQuestion class="h-5 w-5 text-error" />
					</div>
					<span class="text-xl font-bold">{stats.unmatchedFiles}</span>
					<span class="text-sm text-base-content/60">{m.dashboard_stats_unmatched()}</span>
				</div>
				<div class="truncate text-xs text-base-content/50">
					{m.dashboard_stats_filesNeedAttention()}{stats.missingRootFolders > 0
						? ` · ${m.dashboard_stats_rootFolderIssues()}`
						: ''}
				</div>
				<div class="h-1"></div>
			</div>
		</a>
	{:else if stats.missingRootFolders > 0}
		<a
			href={resolve('library/unmatched')}
			class="card bg-base-200 transition-colors hover:bg-base-300"
		>
			<div class="card-body gap-1.5 p-3">
				<div class="flex items-center gap-2">
					<div class="shrink-0 rounded-lg bg-warning/10 p-1.5">
						<AlertCircle class="h-5 w-5 text-warning" />
					</div>
					<span class="text-xl font-bold">0</span>
					<span class="text-sm text-base-content/60">{m.dashboard_stats_unmatched()}</span>
				</div>
				<div class="truncate text-xs text-base-content/50">
					{m.dashboard_stats_rootFolderIssues()}
				</div>
				<div class="h-1"></div>
			</div>
		</a>
	{:else}
		<div class="card bg-base-200">
			<div class="card-body gap-1.5 p-3">
				<div class="flex items-center gap-2">
					<div class="shrink-0 rounded-lg bg-success/10 p-1.5">
						<CheckCircle class="h-5 w-5 text-success" />
					</div>
					<span class="text-xl font-bold">0</span>
					<span class="text-sm text-base-content/60">{m.dashboard_stats_unmatched()}</span>
				</div>
				<div class="truncate text-xs text-base-content/50">
					{m.dashboard_stats_allFilesMatched()}
				</div>
				<div class="h-1"></div>
			</div>
		</div>
	{/if}

	<a
		href={resolve('settings/monitoring/status')}
		class="card bg-base-200 transition-colors hover:bg-base-300"
	>
		<div class="card-body gap-1.5 p-3">
			<div class="flex items-center gap-2">
				<div class="shrink-0 rounded-lg bg-info/10 p-1.5">
					<HardDrive class="h-5 w-5 text-info" />
				</div>
				<span class="text-xl font-bold">{formatBytes(stats.storage.totalBytes)}</span>
				<span class="text-sm text-base-content/60">Storage</span>
			</div>
			<div class="relative flex min-w-0 items-start">
				<span
					bind:this={storageSummaryEl}
					class="flex min-w-0 items-center gap-1 text-xs text-base-content/50 {storageExpanded
						? 'flex-wrap gap-y-0.5'
						: 'overflow-hidden'}"
				>
					{#if storageMovieBytes}
						<span class="flex shrink-0 items-center gap-0.5 {!storageExpanded ? 'min-w-0' : ''}">
							<Clapperboard class="h-3 w-3 shrink-0" /><span
								class={!storageExpanded ? 'truncate' : ''}>{storageMovieBytes}</span
							>
						</span>
					{/if}
					{#if storageTvBytes}
						{#if storageMovieBytes}<span class="shrink-0 text-base-content/30">·</span>{/if}
						<span class="flex shrink-0 items-center gap-0.5">
							<Tv class="h-3 w-3 shrink-0" /><span>{storageTvBytes}</span>
						</span>
					{/if}
					{#if storageFreeSpace}
						{#if storageMovieBytes || storageTvBytes}<span class="shrink-0 text-base-content/30"
								>·</span
							>{/if}
						<span class="shrink-0">{storageFreeSpace}</span>
					{/if}
					{#if !storageMovieBytes && !storageTvBytes}
						{m.dashboard_stats_noFilesOnDisk()}
					{/if}
				</span>
				{#if storageTruncated && !storageExpanded}
					<button
						class="relative z-10 ml-0.5 shrink-0 p-1 text-base-content/30 hover:text-base-content/60 sm:p-0"
						onclick={(e) => {
							e.preventDefault();
							storageExpanded = true;
						}}
						aria-label="Show full storage breakdown"
						><ChevronDown class="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button
					>
				{:else if storageExpanded}
					<button
						class="relative z-10 ml-0.5 shrink-0 p-1 text-base-content/30 hover:text-base-content/60 sm:p-0"
						onclick={(e) => {
							e.preventDefault();
							storageExpanded = false;
						}}
						aria-label="Collapse storage breakdown"
						><ChevronUp class="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button
					>
				{/if}
			</div>
			{#if storageCapacity > 0}
				<progress
					class="progress h-1 progress-info"
					value={stats.storage.totalBytes}
					max={storageCapacity}
				></progress>
			{:else}
				<div class="h-1"></div>
			{/if}
		</div>
	</a>
</div>

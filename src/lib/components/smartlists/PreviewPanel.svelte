<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		AlertCircle,
		Check,
		ChevronLeft,
		ChevronRight,
		RefreshCw,
		Star,
		Image,
		Download
	} from '@lucide/svelte';
	import { getPosterUrl } from '#lib/utils/poster-url.js';

	interface PreviewItem {
		id: number;
		title?: string;
		name?: string;
		poster_path: string | null;
		vote_average: number;
		release_date?: string;
		first_air_date?: string;
		overview?: string;
		inLibrary?: boolean;
	}

	interface DebugData {
		timestamp: string;
		listType: string;
		configuration: {
			mediaType: string;
			filters?: Record<string, unknown>;
			sortBy: string;
			itemLimit: number;
			excludeInLibrary: boolean;
			listSourceType?: string;
			presetId?: string;
			presetProvider?: string;
			externalSourceConfig?: Record<string, unknown>;
		};
		pagination: {
			page: number;
			totalPages: number;
			totalResults: number;
			unfilteredTotal: number;
		};
		items: PreviewItem[];
		failedItems?: Array<{
			imdbId?: string;
			title: string;
			year?: number;
			error?: string;
		}>;
		metadata?: {
			resolvedCount?: number;
			failedCount?: number;
			duplicatesRemoved?: number;
		};
	}

	interface Props {
		items: PreviewItem[];
		loading: boolean;
		error: string | null;
		page: number;
		totalResults: number;
		totalPages: number;
		mediaType: 'movie' | 'tv';
		itemLimit: number;
		unfilteredTotal: number;
		onPageChange: (page: number) => void;
		onRetry: () => void;
		debugData?: DebugData;
	}

	let {
		items,
		loading,
		error,
		page,
		totalResults,
		totalPages,
		mediaType,
		itemLimit,
		unfilteredTotal,
		onPageChange,
		onRetry,
		debugData
	}: Props = $props();

	const isLimited = $derived(unfilteredTotal > itemLimit);
	const maxGridItems = 24;
	const gridItems = $derived(items.slice(0, maxGridItems));

	function downloadDebugJson() {
		if (!debugData) return;

		const blob = new Blob([JSON.stringify(debugData, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `smartlist-debug-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function getTitle(item: PreviewItem): string {
		return item.title ?? item.name ?? 'Unknown';
	}

	function getRatingColor(rating: number): string {
		if (rating >= 7.5) return 'bg-success/90 text-success-content';
		if (rating >= 6) return 'bg-warning/90 text-warning-content';
		return 'bg-base-300/90 text-base-content';
	}

	const mediaLabel = $derived(
		mediaType === 'movie' ? m.smartlists_preview_movies() : m.smartlists_preview_tvShows()
	);
	const hasMultiplePages = $derived(totalPages > 1);
</script>

<div class="card bg-base-100 shadow-xl">
	<div class="card-body p-4 sm:p-6">
		<!-- Header -->
		<div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
			<div class="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
				<h2 class="card-title text-lg sm:text-xl">{m.smartlists_preview_title()}</h2>
				{#if !loading && !error}
					{#if isLimited}
						<span class="badge badge-ghost badge-sm">
							{m.smartlists_preview_limited({
								shown: totalResults.toLocaleString(),
								total: unfilteredTotal.toLocaleString(),
								mediaType: mediaLabel
							})}
						</span>
						<span class="badge badge-outline badge-xs"
							>{m.smartlists_preview_limitedTo({ limit: itemLimit })}</span
						>
					{:else}
						<span class="badge badge-ghost badge-sm">
							{m.smartlists_preview_count({
								count: totalResults.toLocaleString(),
								mediaType: mediaLabel
							})}
						</span>
					{/if}
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				{#if debugData && !loading}
					<button
						class="btn gap-1 btn-ghost btn-xs"
						onclick={downloadDebugJson}
						title="Download debug JSON"
					>
						<Download class="h-3 w-3" />
						{m.smartlists_preview_debug()}
					</button>
				{/if}
				{#if loading}
					<RefreshCw class="h-5 w-5 animate-spin text-base-content/50" />
				{/if}
			</div>
		</div>

		<!-- Content -->
		<div class="min-h-100">
			{#if error}
				<div class="flex h-64 flex-col items-center justify-center gap-4">
					<AlertCircle class="h-12 w-12 text-error" />
					<p class="text-center text-base-content/70">{error}</p>
					<button class="btn btn-ghost btn-sm" onclick={onRetry}>
						<RefreshCw class="h-4 w-4" />
						{m.smartlists_preview_retry()}
					</button>
				</div>
			{:else if loading && items.length === 0}
				<!-- Loading skeleton -->
				<div
					class="grid grid-cols-5 gap-3 sm:grid-cols-5 sm:gap-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-8"
				>
					{#each Array(maxGridItems) as _, i (i)}
						<div class="animate-pulse">
							<div class="aspect-2/3 rounded-lg bg-base-300"></div>
						</div>
					{/each}
				</div>
			{:else if items.length === 0}
				<div class="flex h-64 flex-col items-center justify-center">
					<p class="text-center text-base-content/50">
						{m.smartlists_preview_noMatch({ mediaType: mediaLabel })}<br />
						{m.smartlists_preview_tryAdjusting()}
					</p>
				</div>
			{:else}
				<div class="relative">
					<!-- Loading overlay -->
					{#if loading}
						<div
							class="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-base-100/80 backdrop-blur-sm"
						>
							<div class="flex flex-col items-center gap-3">
								<RefreshCw class="h-10 w-10 animate-spin text-primary" />
								<span class="text-sm text-base-content/70">{m.smartlists_preview_loading()}</span>
							</div>
						</div>
					{/if}

					<!-- Grid -->
					<div
						class="grid grid-cols-5 gap-3 sm:grid-cols-5 sm:gap-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-8"
					>
						{#each gridItems as item (item.id)}
							<div class="group relative">
								<!-- Poster Card -->
								<div
									class="relative aspect-2/3 overflow-hidden rounded-lg bg-base-300 shadow-sm transition-all duration-200 group-hover:shadow-lg"
								>
									{#if item.poster_path}
										<img
											src={getPosterUrl(item.poster_path, 'w185')}
											alt={getTitle(item)}
											class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
											loading="lazy"
										/>
									{:else}
										<div class="flex h-full w-full items-center justify-center bg-base-200">
											<Image class="h-8 w-8 text-base-content/20" />
										</div>
									{/if}

									<!-- Rating badge -->
									{#if item.vote_average > 0}
										<div
											class="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[10px] font-semibold shadow-md {getRatingColor(
												item.vote_average
											)}"
										>
											<Star class="h-2.5 w-2.5 fill-current" />
											{item.vote_average.toFixed(1)}
										</div>
									{/if}

									<!-- In library overlay -->
									{#if item.inLibrary}
										<div
											class="absolute inset-0 flex items-center justify-center bg-success/30 backdrop-blur-[1px]"
											title={m.smartlists_preview_inLibrary()}
										>
											<div class="rounded-full bg-success p-1.5 shadow-lg">
												<Check class="h-4 w-4 text-success-content" />
											</div>
										</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<!-- Pagination -->
		{#if hasMultiplePages && !error && items.length > 0}
			<div class="mt-6 flex items-center justify-center gap-3 border-t border-base-200 pt-4">
				<button
					class="btn gap-1 btn-ghost btn-sm"
					onclick={() => onPageChange(page - 1)}
					disabled={page <= 1 || loading}
					aria-label="Previous page"
				>
					<ChevronLeft class="h-4 w-4" />
					{m.smartlists_preview_prev()}
				</button>

				<div class="flex items-center gap-2 rounded-full bg-base-200 px-4 py-1">
					<span class="text-sm font-medium text-base-content"
						>{m.smartlists_preview_pageOf({ page, totalPages })}</span
					>
				</div>

				<button
					class="btn gap-1 btn-ghost btn-sm"
					onclick={() => onPageChange(page + 1)}
					disabled={page >= totalPages || loading}
					aria-label="Next page"
				>
					{m.smartlists_preview_next()}
					<ChevronRight class="h-4 w-4" />
				</button>
			</div>
		{/if}
	</div>
</div>

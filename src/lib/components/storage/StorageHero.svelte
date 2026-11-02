<script lang="ts">
	import type { StorageSummary } from './utils.js';
	import { formatBytes } from '#lib/utils/format.js';

	interface Props {
		storage: StorageSummary;
	}

	let { storage }: Props = $props();

	const movieRatio = $derived(
		storage.totalUsedBytes > 0 ? (storage.moviesUsedBytes / storage.totalUsedBytes) * 100 : 0
	);
	const tvRatio = $derived(
		storage.totalUsedBytes > 0 ? (storage.tvUsedBytes / storage.totalUsedBytes) * 100 : 0
	);
	const subtitleRatio = $derived(
		storage.totalUsedBytes > 0 ? (storage.subtitlesUsedBytes / storage.totalUsedBytes) * 100 : 0
	);
</script>

<div class="card bg-base-200 p-5">
	<div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-8">
		<div class="shrink-0">
			<div class="text-4xl font-bold tracking-tight">{formatBytes(storage.totalUsedBytes)}</div>
			<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-base-content/60">
				<span>{storage.movieCount} movies</span>
				<span class="text-base-content/30">&middot;</span>
				<span>{storage.seriesCount} series</span>
				<span class="text-base-content/30">&middot;</span>
				<span>{storage.subtitleCount} subtitles</span>
			</div>
		</div>
		<div class="min-w-0 flex-1">
			{#if storage.totalUsedBytes > 0}
				<div class="flex h-3 overflow-hidden rounded-full bg-base-300/60">
					<div
						class="h-full bg-primary transition-all"
						style="width: {movieRatio}%"
						title={`Movies: ${formatBytes(storage.moviesUsedBytes)} (${Math.round(movieRatio)}%)`}
					></div>
					<div
						class="h-full bg-secondary transition-all"
						style="width: {tvRatio}%"
						title={`TV: ${formatBytes(storage.tvUsedBytes)} (${Math.round(tvRatio)}%)`}
					></div>
					<div
						class="h-full bg-accent transition-all"
						style="width: {subtitleRatio}%"
						title={`Subtitles: ${formatBytes(storage.subtitlesUsedBytes)} (${Math.round(subtitleRatio)}%)`}
					></div>
				</div>
			{/if}
			<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/60">
				<span class="inline-flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-full bg-primary"></span>
					Movies ({formatBytes(storage.moviesUsedBytes)}, {Math.round(movieRatio)}%)
				</span>
				<span class="inline-flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-full bg-secondary"></span>
					TV ({formatBytes(storage.tvUsedBytes)}, {Math.round(tvRatio)}%)
				</span>
				<span class="inline-flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-full bg-accent"></span>
					Subtitles ({formatBytes(storage.subtitlesUsedBytes)}, {Math.round(subtitleRatio)}%)
				</span>
			</div>
		</div>
	</div>
</div>

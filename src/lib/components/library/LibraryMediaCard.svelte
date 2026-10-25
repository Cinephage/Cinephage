<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { LibraryMovie, LibrarySeries } from '#lib/types/library.js';
	import { isLibraryMovie, getBestQualityFromFiles, displayTitle } from '#lib/types/library.js';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import { Eye, EyeOff, Check, X, Download, AlertTriangle } from '@lucide/svelte';
	import { resolvePath } from '#lib/utils/routing.js';

	type LibraryItem = LibraryMovie | LibrarySeries;

	interface Props {
		item: LibraryItem;
		selectable?: boolean;
		selected?: boolean;
		onSelectChange?: (id: string, selected: boolean) => void;
		collectionName?: string;
		/** Instance default for items with no explicit prefer-original flag. */
		preferOriginalTitleDefault?: boolean | null;
	}

	let {
		item,
		selectable = false,
		selected = false,
		onSelectChange,
		collectionName,
		preferOriginalTitleDefault = false
	}: Props = $props();

	function handleCheckboxClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		onSelectChange?.(item.id, !selected);
	}

	function handleCardClick(e: MouseEvent) {
		if (selectable) {
			e.preventDefault();
			onSelectChange?.(item.id, !selected);
		}
	}

	const isMovie = $derived(isLibraryMovie(item));
	// Link to library management pages using library database ID
	const link = $derived(isMovie ? `/library/movie/${item.id}` : `/library/tv/${item.id}`);

	// For movies: get file status and quality
	const movieQuality = $derived(
		isMovie ? getBestQualityFromFiles((item as LibraryMovie).files) : null
	);
	const hasFile = $derived(isMovie ? (item as LibraryMovie).hasFile : false);
	const isStreamerProfile = $derived(
		isMovie && (item as LibraryMovie).scoringProfileId === 'streamer'
	);

	// For series: get progress
	const seriesProgress = $derived(!isMovie ? (item as LibrarySeries).percentComplete : 0);
	const episodeCount = $derived(!isMovie ? (item as LibrarySeries).episodeCount : 0);
	const episodeFileCount = $derived(!isMovie ? (item as LibrarySeries).episodeFileCount : 0);
	const missingRootFolder = $derived(item.missingRootFolder === true);
	const partiallyMonitored = $derived(
		!isMovie && (item as LibrarySeries).partiallyMonitored === true
	);

	// Quality badge display
	const qualityBadge = $derived(() => {
		if (!isMovie || !movieQuality) return null;
		if (isStreamerProfile) return m.library_mediaCard_auto();
		const parts: string[] = [];
		if (movieQuality.quality) parts.push(movieQuality.quality);
		if (movieQuality.hdr) parts.push(movieQuality.hdr);
		return parts.length > 0 ? parts.join(' ') : null;
	});
</script>

<a
	href={selectable ? undefined : resolvePath(link)}
	onclick={handleCardClick}
	class="group relative block aspect-2/3 w-full overflow-hidden rounded-lg bg-base-300 shadow-sm transition-shadow hover:shadow-md {selected
		? 'ring-2 ring-primary ring-offset-2 ring-offset-base-100'
		: 'hover:ring-2 hover:ring-primary/50'} {selectable ? 'cursor-pointer' : ''}"
	style="content-visibility: auto; contain-intrinsic-size: auto 150px auto 225px;"
>
	<TmdbImage
		path={item.posterPath}
		size="w342"
		alt={item.title}
		class="h-full w-full object-cover"
	/>

	<!-- Selection checkbox -->
	{#if selectable}
		<div class="absolute top-2 left-2 z-20">
			<button
				type="button"
				class="flex h-6 w-6 items-center justify-center rounded-md border-2 bg-base-100/90 shadow-sm transition-colors {selected
					? 'border-primary bg-primary'
					: 'border-base-content/30 hover:border-primary'}"
				onclick={handleCheckboxClick}
			>
				{#if selected}
					<Check class="h-4 w-4 text-primary-content" />
				{/if}
			</button>
		</div>
	{/if}

	<!-- Top-right badges: Monitored + Type -->
	<div class="absolute top-2 right-2 z-10 flex max-w-[48%] flex-col items-end gap-1">
		<!-- Monitored status -->
		<div
			class="badge border-none badge-sm shadow-sm {item.monitored
				? partiallyMonitored
					? 'bg-warning/80 text-warning-content'
					: 'bg-success/80 text-success-content'
				: 'bg-base-300/80 text-base-content/60'}"
			title={item.monitored
				? partiallyMonitored
					? m.library_mediaCard_partiallyMonitored()
					: m.library_mediaCard_monitored()
				: m.library_mediaCard_notMonitored()}
		>
			{#if item.monitored}
				<Eye class="h-3 w-3" />
			{:else}
				<EyeOff class="h-3 w-3" />
			{/if}
		</div>

		<!-- Media type badge -->
		<div
			class="badge truncate border-none badge-xs font-semibold shadow-sm sm:badge-sm {isMovie
				? 'bg-primary/80 text-primary-content'
				: 'bg-secondary/80 text-secondary-content'}"
		>
			{isMovie ? m.common_movie() : m.common_tvShow()}
		</div>
	</div>

	<!-- Top-left: File status (movies) or Progress indicator (series) -->
	<div
		class="absolute left-2 z-10 flex max-w-[48%] flex-col gap-1 {selectable ? 'top-10' : 'top-2'}"
	>
		{#if isMovie}
			<!-- File status for movies -->
			<div
				class="badge border-none badge-sm shadow-sm {hasFile
					? 'bg-success/80 text-success-content'
					: 'bg-error/80 text-error-content'}"
				title={hasFile ? m.library_mediaCard_fileAvailable() : m.library_mediaCard_missingFile()}
			>
				{#if hasFile}
					<Check class="h-3 w-3" />
				{:else}
					<X class="h-3 w-3" />
				{/if}
			</div>
		{:else}
			<!-- Episode count for series -->
			<div
				class="badge border-none bg-base-100/80 badge-sm text-base-content shadow-sm"
				title={m.library_episodeProgress({
					episodeFileCount: episodeFileCount!,
					episodeCount: episodeCount!
				})}
			>
				{episodeFileCount}/{episodeCount}
			</div>
		{/if}

		<!-- Quality badge for movies with files -->
		{#if isMovie && hasFile && qualityBadge()}
			<div
				class="badge truncate border-none bg-primary/80 badge-xs font-medium text-primary-content shadow-sm sm:badge-sm"
			>
				{qualityBadge()}
			</div>
		{/if}
	</div>

	<!-- Series progress bar -->
	{#if !isMovie}
		<progress
			class="progress absolute right-0 bottom-0 left-0 h-1 w-full {seriesProgress === 100
				? 'progress-success'
				: 'progress-primary'}"
			value={seriesProgress}
			max="100"
		></progress>
	{/if}

	<!-- Missing root folder warning -->
	{#if missingRootFolder}
		<div
			class="absolute right-2 bottom-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-warning/90 text-warning-content shadow-sm"
			title={m.library_mediaCard_rootFolderNotSet()}
		>
			<AlertTriangle class="h-3.5 w-3.5" />
		</div>
	{/if}

	<!-- Hover Overlay -->
	<div
		class="absolute inset-0 flex flex-col justify-end bg-linear-to-t from-black/90 via-black/20 to-transparent p-3 opacity-0 transition-opacity duration-300 lg:group-hover:opacity-100"
	>
		<div
			class="translate-y-4 transform transition-transform duration-300 group-hover:translate-y-0"
		>
			<h3 class="line-clamp-2 text-sm leading-tight font-bold text-white">
				{displayTitle(item, preferOriginalTitleDefault)}
			</h3>
			<div class="mt-1 flex items-center justify-between gap-2">
				{#if item.year}
					<span class="text-xs text-white/70">{item.year}</span>
				{/if}
				{#if !isMovie}
					<span class="flex items-center gap-1 text-xs whitespace-nowrap text-white/70">
						<Download class="h-3 w-3" />
						{seriesProgress}%
					</span>
				{/if}
			</div>
			{#if collectionName}
				<span
					class="mt-1 inline-block max-w-full truncate rounded bg-white/20 px-1.5 py-0.5 text-xs text-white/80"
				>
					{collectionName}
				</span>
			{/if}
		</div>
	</div>
</a>

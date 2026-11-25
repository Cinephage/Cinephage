<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import {
		Eye,
		EyeOff,
		Check,
		X,
		Download,
		AlertTriangle,
		Clapperboard,
		Tv,
		Disc3,
		Mic2,
		Radio
	} from '@lucide/svelte';
	import { resolvePath } from '#lib/utils/routing.js';
	import { imageError } from '#lib/actions/image-error.js';
	import type { MediaCardView, LibraryKind } from './media-view.js';

	/**
	 * One library tile, whichever kind it is. The kind adapts itself into a
	 * MediaCardView (`media-view.ts`); this component owns the grammar only.
	 */
	interface Props {
		view: MediaCardView;
		selectable?: boolean;
		selected?: boolean;
		onSelectChange?: (id: string, selected: boolean) => void;
		/** Set when the item about to be shown is missing its root folder. */
		missingRootFolder?: boolean;
		/**
		 * Overrides navigation: the handler does its own work and navigates with
		 * `goto`. Used when the destination is not known until it is resolved
		 * (Discover's provider rows).
		 */
		onActivate?: (event: MouseEvent) => void;
	}

	let {
		view,
		selectable = false,
		selected = false,
		onSelectChange,
		missingRootFolder = false,
		onActivate
	}: Props = $props();

	const FALLBACK_ICON: Record<LibraryKind, typeof Clapperboard> = {
		movie: Clapperboard,
		tv: Tv,
		album: Disc3,
		artist: Mic2
	};
	const FallbackIcon = $derived(FALLBACK_ICON[view.kind]);

	// A cover URL can 404 (an album whose release has no Cover Art Archive
	// image). Without this the tile shows the browser's broken-image glyph
	// forever; the kind icon is the honest fallback.
	let artFailed = $state(false);

	const TYPE_TONE: Record<MediaCardView['typeTone'], string> = {
		primary: 'bg-primary/80 text-primary-content',
		secondary: 'bg-secondary/80 text-secondary-content',
		accent: 'bg-accent/80 text-accent-content'
	};

	const STATE_TONE: Record<'success' | 'error' | 'neutral', string> = {
		success: 'bg-success/80 text-success-content',
		error: 'bg-error/80 text-error-content',
		neutral: 'bg-base-100/80 text-base-content'
	};

	function handleCheckboxClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		onSelectChange?.(view.id, !selected);
	}

	function handleCardClick(e: MouseEvent) {
		if (selectable) {
			e.preventDefault();
			onSelectChange?.(view.id, !selected);
			return;
		}
		if (onActivate) {
			e.preventDefault();
			onActivate(e);
		}
	}
</script>

<a
	href={selectable ? undefined : resolvePath(view.href)}
	onclick={handleCardClick}
	class="group relative block w-full overflow-hidden rounded-lg bg-base-300 shadow-sm transition-shadow hover:shadow-md {view.square
		? 'aspect-square'
		: 'aspect-2/3'} {selected
		? 'ring-2 ring-primary ring-offset-2 ring-offset-base-100'
		: 'hover:ring-2 hover:ring-primary/50'} {selectable ? 'cursor-pointer' : ''}"
	style="content-visibility: auto; contain-intrinsic-size: auto 150px auto 225px;"
>
	{#if view.art?.source === 'tmdb'}
		<TmdbImage
			path={view.art.path}
			size="w342"
			alt={view.title}
			class="h-full w-full object-cover"
		/>
	{:else if view.art?.source === 'url' && !artFailed}
		<img
			src={view.art.url}
			alt={view.title}
			class="h-full w-full object-cover"
			loading="lazy"
			use:imageError={() => (artFailed = true)}
		/>
	{:else}
		<div class="flex h-full w-full items-center justify-center bg-base-300">
			<FallbackIcon class="h-10 w-10 text-base-content/25" />
		</div>
	{/if}

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

	<!-- Top-right badges: Monitored + kind -->
	<div class="absolute top-2 right-2 z-10 flex max-w-[48%] flex-col items-end gap-1">
		{#if !view.hideMonitored}
			<div
				class="badge border-none badge-sm shadow-sm {view.monitored
					? view.partiallyMonitored
						? 'bg-warning/80 text-warning-content'
						: 'bg-success/80 text-success-content'
					: 'bg-base-300/80 text-base-content/60'}"
				title={view.monitored
					? view.partiallyMonitored
						? m.library_mediaCard_partiallyMonitored()
						: m.library_mediaCard_monitored()
					: m.library_mediaCard_notMonitored()}
			>
				{#if view.monitored}
					<Eye class="h-3 w-3" />
				{:else}
					<EyeOff class="h-3 w-3" />
				{/if}
			</div>
		{/if}

		<div
			class="badge truncate border-none badge-xs font-semibold shadow-sm sm:badge-sm {TYPE_TONE[
				view.typeTone
			]}"
		>
			{view.typeLabel}
		</div>
	</div>

	<!-- Top-left: state badge (file, child count) + detail -->
	<div
		class="absolute left-2 z-10 flex max-w-[48%] flex-col gap-1 {selectable ? 'top-10' : 'top-2'}"
	>
		{#if view.state}
			<div
				class="badge border-none badge-sm shadow-sm {STATE_TONE[view.state.tone]}"
				title={view.state.label}
			>
				{#if view.state.icon === 'file'}
					<Check class="h-3 w-3" />
				{:else if view.state.icon === 'cross'}
					<X class="h-3 w-3" />
				{:else if view.state.icon === 'stream'}
					<Radio class="h-3 w-3" />
				{:else}
					{view.state.label}
				{/if}
			</div>
		{/if}

		{#if view.state?.icon === 'file' && view.detail}
			<div
				class="badge truncate border-none bg-primary/80 badge-xs font-medium text-primary-content shadow-sm sm:badge-sm"
			>
				{view.detail}
			</div>
		{/if}
	</div>

	<!-- Partial progress (series, artist shelves) -->
	{#if view.progress !== null && view.progress > 0 && view.progress < 100}
		<progress
			class="progress absolute right-0 bottom-0 left-0 h-1 w-full progress-primary"
			value={view.progress}
			max="100"
		></progress>
	{/if}

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
				{view.title}
			</h3>
			<div class="mt-1 flex items-center justify-between gap-2">
				{#if view.year}
					<span class="text-xs text-white/70">{view.year}</span>
				{:else if view.subtitle}
					<span class="truncate text-xs text-white/70">{view.subtitle}</span>
				{/if}
				{#if view.progress !== null && view.year}
					<span class="flex items-center gap-1 text-xs whitespace-nowrap text-white/70">
						<Download class="h-3 w-3" />
						{view.progress}%
					</span>
				{/if}
			</div>
			{#if view.year && view.subtitle}
				<span class="mt-0.5 block truncate text-xs text-white/60">{view.subtitle}</span>
			{/if}
			{#if view.tag}
				<span
					class="mt-1 inline-block max-w-full truncate rounded bg-white/20 px-1.5 py-0.5 text-xs text-white/80"
				>
					{view.tag}
				</span>
			{/if}
		</div>
	</div>
</a>

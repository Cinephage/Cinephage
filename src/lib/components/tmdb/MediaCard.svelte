<script lang="ts">
	import type { TmdbMediaItem } from '#lib/types/tmdb.js';
	import {
		getMediaTitle,
		getMediaDate,
		getMediaPoster,
		getMediaLink,
		getMediaTypeLabel
	} from '#lib/types/tmdb-guards.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import TmdbImage from './TmdbImage.svelte';
	import { Check, Clock, Plus, Clapperboard } from '@lucide/svelte';
	import {
		POSTER_CORNER,
		POSTER_CORNER_BELOW_CHECKBOX,
		POSTER_TAG,
		POSTER_TAG_TEXT,
		POSTER_ICON,
		POSTER_TONE
	} from '#lib/components/ui/poster-tags.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getSmartReleaseLine } from '#lib/utils/smartReleaseLine.js';
	import { formatReleaseLine } from '#lib/utils/releaseLineText.js';

	// Extended type that includes library status (added by enrichWithLibraryStatus)
	// and request state (added by annotateRequestState).
	type MediaItemWithLibraryStatus = TmdbMediaItem & {
		inLibrary?: boolean;
		hasFile?: boolean;
		libraryId?: string;
		releaseDate?: string | null;
		digitalReleaseDate?: string | null;
		physicalReleaseDate?: string | null;
		tvReleaseDate?: string | null;
		requested?: 'none' | 'pending' | 'approved' | 'fulfilled';
	};

	interface Props {
		item: MediaItemWithLibraryStatus;
		onAddToLibrary?: (item: MediaItemWithLibraryStatus) => void;
		/** Multi-select mode: clicking toggles selection instead of navigating. */
		selectable?: boolean;
		selected?: boolean;
		onToggleSelect?: () => void;
	}

	let {
		item,
		onAddToLibrary,
		selectable = false,
		selected = false,
		onToggleSelect
	}: Props = $props();

	function getBadgeClass(item: TmdbMediaItem): string {
		const label = getMediaTypeLabel(item);
		if (label === 'Movie') return POSTER_TONE.primary;
		if (label === 'TV') return POSTER_TONE.secondary;
		return POSTER_TONE.neutral;
	}

	const ratingColor = (rating: number): string => {
		if (rating >= 7) return 'text-success';
		if (rating >= 5) return 'text-warning';
		return 'text-error';
	};

	// Derived values using type-safe helpers
	const title = $derived(getMediaTitle(item));
	const date = $derived(getMediaDate(item));
	const poster = $derived(getMediaPoster(item));
	const link = $derived(getMediaLink(item));
	const typeLabel = $derived(getMediaTypeLabel(item));
	const badgeClass = $derived(getBadgeClass(item));

	// Library status
	const inLibrary = $derived(item.inLibrary ?? false);
	const hasFile = $derived(item.hasFile ?? false);
	// Open request (pending or approved) - server-annotated badge state.
	const requestedOpen = $derived(item.requested === 'pending' || item.requested === 'approved');

	// Only addable, not-yet-in-library movies/series take part in multi-select;
	// everything else keeps its normal navigation behavior.
	const canSelect = $derived(
		selectable && !inLibrary && (typeLabel === 'Movie' || typeLabel === 'TV')
	);
	const showQuickAdd = $derived(!selectable && !inLibrary && !!onAddToLibrary);

	function handleCardClick(e: MouseEvent) {
		if (canSelect) {
			e.preventDefault();
			onToggleSelect?.();
		}
	}

	function handleSelectClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		onToggleSelect?.();
	}

	function handleQuickAdd(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		onAddToLibrary?.(item);
	}

	const releaseLine = $derived.by(() => {
		const enriched = item as MediaItemWithLibraryStatus;
		const rec = item as unknown as Record<string, unknown>;
		const rd = enriched.releaseDate ?? (rec.release_date as string | null) ?? null;
		if (
			!rd &&
			!enriched.digitalReleaseDate &&
			!enriched.physicalReleaseDate &&
			!enriched.tvReleaseDate
		)
			return null;
		return getSmartReleaseLine({
			releaseDate: rd,
			digitalReleaseDate: enriched.digitalReleaseDate ?? null,
			physicalReleaseDate: enriched.physicalReleaseDate ?? null,
			tvReleaseDate: enriched.tvReleaseDate ?? null,
			status: rec.tmdbStatus as string | null | undefined
		});
	});
</script>

<a
	href={canSelect ? undefined : resolvePath(link)}
	onclick={handleCardClick}
	class="group relative block aspect-2/3 w-full overflow-hidden rounded-lg bg-base-300 shadow-sm transition-all {canSelect
		? 'cursor-pointer'
		: ''} {canSelect && selected
		? 'ring-2 ring-primary ring-offset-2 ring-offset-base-100'
		: 'hover:shadow-md hover:ring-2 hover:ring-primary/50'}"
>
	<TmdbImage
		path={poster}
		size="w342"
		alt={title}
		class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
	/>

	<!-- Selection checkbox (top-left, above the status badges) -->
	{#if canSelect}
		<div class="{POSTER_CORNER.topLeft} z-20">
			<button
				type="button"
				class="flex h-6 w-6 items-center justify-center rounded-md border-2 bg-base-100/90 shadow-sm transition-colors {selected
					? 'border-primary bg-primary'
					: 'border-base-content/30 hover:border-primary'}"
				aria-pressed={selected}
				aria-label={m.discover_select()}
				onclick={handleSelectClick}
			>
				{#if selected}
					<Check class="h-4 w-4 text-primary-content" strokeWidth={3} />
				{/if}
			</button>
		</div>
	{/if}

	<!-- Status column (top-left): library + request badges -->
	{#if inLibrary || requestedOpen}
		<div class={canSelect ? POSTER_CORNER_BELOW_CHECKBOX : POSTER_CORNER.topLeft}>
			{#if inLibrary}
				<div
					class="{POSTER_ICON} {hasFile ? POSTER_TONE.success : POSTER_TONE.warning}"
					title={hasFile ? m.tmdb_availableInLibrary() : m.tmdb_monitoredNotDownloaded()}
				>
					{#if hasFile}
						<Check class="size-3" strokeWidth={3} />
					{:else}
						<Clock class="size-3" strokeWidth={2.5} />
					{/if}
				</div>
			{/if}

			{#if requestedOpen}
				<div class="{POSTER_ICON} {POSTER_TONE.secondary}" title={m.requests_requested()}>
					<Clapperboard class="size-3" strokeWidth={2.5} />
				</div>
			{/if}
		</div>
	{/if}

	<!-- Top-right row: quick add (hover) + media type badge - siblings, so they never overlap -->
	<div class={POSTER_CORNER.topRightRow}>
		{#if showQuickAdd}
			<button
				type="button"
				class="pointer-events-none hidden h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-content opacity-0 shadow-lg transition-all group-hover:pointer-events-auto group-hover:opacity-100 hover:scale-110 focus-visible:pointer-events-auto focus-visible:opacity-100 active:scale-95 md:flex"
				title={m.tmdb_addToLibrary()}
				aria-label={m.tmdb_addToLibrary()}
				onclick={handleQuickAdd}
			>
				<Plus class="h-5 w-5" strokeWidth={2.5} />
			</button>
		{/if}

		{#if typeLabel}
			<span class="{POSTER_TAG} {badgeClass}">
				<span class={POSTER_TAG_TEXT}>{typeLabel}</span>
			</span>
		{/if}
	</div>

	<!-- Hover Overlay -->
	<div
		class="absolute inset-0 flex flex-col justify-end bg-linear-to-t from-black/90 via-black/20 to-transparent p-3 opacity-100 transition-opacity duration-300 md:opacity-0 md:group-hover:opacity-100"
	>
		<div
			class="translate-y-0 transform transition-transform duration-300 md:translate-y-4 md:group-hover:translate-y-0"
		>
			<h3 class="line-clamp-2 text-sm leading-tight font-bold text-white">
				{title}
			</h3>
			<div class="mt-1 flex items-center justify-between">
				{#if date}
					<span class="text-xs text-white/70">{new Date(date).getFullYear()}</span>
				{/if}
				{#if 'vote_average' in item && item.vote_average}
					<div class="flex items-center gap-1 text-xs font-medium {ratingColor(item.vote_average)}">
						<span>★</span>
						<span>{item.vote_average.toFixed(1)}</span>
					</div>
				{/if}
			</div>
			{#if releaseLine}
				<div
					class="mt-0.5 text-xs font-medium {releaseLine.variant === 'released'
						? 'text-success'
						: releaseLine.variant === 'theaters'
							? 'text-info'
							: releaseLine.variant === 'upcoming'
								? 'text-primary'
								: 'text-white/50'}"
				>
					{formatReleaseLine(releaseLine)}
				</div>
			{/if}
		</div>
	</div>
</a>

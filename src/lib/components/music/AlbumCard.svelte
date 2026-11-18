<script lang="ts">
	import { Check, Disc3, Eye, EyeOff, LoaderCircle, Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { AlbumCardData } from './music-card.js';
	import { formatRuntime } from './music-card.js';

	type Props = {
		album: AlbumCardData;
		/** Cover image URL. Album art is served by the API; the caller knows which. */
		coverUrl?: string | null;
		/** Where the art and title link to. Omit for a non-navigating card. */
		href?: string | null;
		/** Library cards carry the monitored badge and a selection box. */
		showMonitor?: boolean;
		selectable?: boolean;
		selected?: boolean;
		onSelectChange?: (id: string, selected: boolean) => void;
		/** Discover cards carry an add button in the hover footer. */
		onAdd?: () => void;
		addState?: 'idle' | 'busy' | 'added';
		/** Set on discover pages: already in the library, so adding is pointless. */
		inLibrary?: boolean;
	};

	let {
		album,
		coverUrl = null,
		href = null,
		showMonitor = false,
		selectable = false,
		selected = false,
		onSelectChange,
		onAdd,
		addState = 'idle',
		inLibrary = false
	}: Props = $props();

	const runtime = $derived(formatRuntime(album.duration));
	const meta = $derived(
		[album.artistName, album.year ? String(album.year) : null, album.primaryType, runtime]
			.filter(Boolean)
			.join(' · ')
	);
	const link = $derived(href ? resolvePath(href) : null);

	function onCheckbox(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		onSelectChange?.(album.id, !selected);
	}
</script>

<div class="group relative flex w-full flex-col">
	<div
		class="relative aspect-square w-full overflow-hidden rounded-lg bg-base-300 shadow-sm transition-shadow group-hover:shadow-md {selected
			? 'ring-2 ring-primary ring-offset-2 ring-offset-base-100'
			: 'group-hover:ring-2 group-hover:ring-primary/40'}"
	>
		{#if coverUrl}
			<img
				src={coverUrl}
				alt={album.title}
				loading="lazy"
				class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
			/>
		{:else}
			<div class="flex h-full w-full items-center justify-center bg-base-300">
				<Disc3 class="h-10 w-10 text-base-content/25" />
			</div>
		{/if}

		{#if link}
			<!-- One overlay carries the click: the card holds buttons of its own, so
			     an anchor wrapping the whole tile would nest interactive elements. -->
			<a
				href={link}
				class="absolute inset-0 z-10"
				aria-label={`${album.title} — ${album.artistName}`}
				onclick={(event) => {
					if (!selectable) return;
					event.preventDefault();
					onSelectChange?.(album.id, !selected);
				}}
			></a>
		{/if}

		{#if selectable}
			<button
				type="button"
				class="absolute top-2 left-2 z-20 flex h-6 w-6 items-center justify-center rounded-md border-2 bg-base-100/90 shadow-sm transition-colors {selected
					? 'border-primary bg-primary'
					: 'border-base-content/30 hover:border-primary'}"
				onclick={onCheckbox}
				aria-label={album.title}
			>
				{#if selected}<Check class="h-4 w-4 text-primary-content" />{/if}
			</button>
		{:else if inLibrary}
			<span
				class="absolute top-2 left-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-success/90 text-success-content shadow-md"
				title={m.music_inLibrary()}
			>
				<Check class="h-4 w-4" strokeWidth={3} />
			</span>
		{/if}

		{#if showMonitor}
			<span
				class="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full shadow-sm backdrop-blur-sm {album.monitored
					? 'bg-success/85 text-success-content'
					: 'bg-base-100/85 text-base-content/50'}"
				title={album.monitored ? m.common_monitored() : m.common_unmonitored()}
			>
				{#if album.monitored}
					<Eye class="h-3.5 w-3.5" />
				{:else}
					<EyeOff class="h-3.5 w-3.5" />
				{/if}
			</span>
		{/if}

		<!-- Hover footer: state under the art, revealed on intent so the grid stays
		     cover-forward like the movie and TV posters. -->
		<div
			class="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-2 bg-linear-to-t from-black/85 via-black/35 to-transparent px-2.5 pt-8 pb-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
		>
			<span class="truncate text-[11px] font-medium text-white/85">
				{#if album.trackCount}
					{m.music_tracksShort({ count: album.trackCount })}
				{:else}
					{album.primaryType ?? m.music_albumLabel()}
				{/if}
			</span>
			{#if onAdd}
				<button
					type="button"
					class="pointer-events-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors {addState ===
					'added' || inLibrary
						? 'bg-success/90 text-success-content'
						: 'bg-primary text-primary-content hover:bg-primary/90'}"
					disabled={addState === 'busy' || addState === 'added' || inLibrary}
					onclick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onAdd?.();
					}}
				>
					{#if addState === 'busy'}
						<LoaderCircle class="h-3 w-3 animate-spin" />
					{:else if addState === 'added' || inLibrary}
						<Check class="h-3 w-3" />
					{:else}
						<Plus class="h-3 w-3" />
					{/if}
					{addState === 'added' || inLibrary ? m.music_inLibrary() : m.music_add()}
				</button>
			{/if}
		</div>
	</div>

	<div class="mt-2 min-w-0 px-0.5">
		{#if link}
			<a href={link} class="block truncate text-sm leading-tight font-medium hover:text-primary" title={album.title}>
				{album.title}
			</a>
		{:else}
			<p class="truncate text-sm leading-tight font-medium" title={album.title}>{album.title}</p>
		{/if}
		<p class="mt-0.5 truncate text-xs text-base-content/55" title={meta}>{meta}</p>
	</div>
</div>

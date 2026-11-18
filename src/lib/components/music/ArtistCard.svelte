<script lang="ts">
	import { Eye, EyeOff, Mic2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { ArtistCardData } from './music-card.js';

	type Props = {
		artist: ArtistCardData;
		coverUrl?: string | null;
		href?: string | null;
		showMonitor?: boolean;
	};

	let { artist, coverUrl = null, href = null, showMonitor = false }: Props = $props();

	const link = $derived(href ? resolvePath(href) : null);
	// Initials stand in for art: most artists have no portrait cached yet, and an
	// empty disc is the one tile shape that looks broken in a grid of covers.
	const initials = $derived(
		artist.name
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part.charAt(0).toUpperCase())
			.join('')
	);
	const meta = $derived(
		artist.albumCount === 1
			? m.music_oneAlbum()
			: m.music_albumsCount({ count: artist.albumCount })
	);
</script>

<div class="group relative flex w-full flex-col">
	<div
		class="relative aspect-square w-full overflow-hidden rounded-lg bg-base-300 shadow-sm transition-shadow group-hover:shadow-md group-hover:ring-2 group-hover:ring-primary/40"
	>
		{#if coverUrl}
			<img
				src={coverUrl}
				alt={artist.name}
				loading="lazy"
				class="h-full w-full scale-110 object-cover opacity-90 blur-[1px] transition-transform duration-300 group-hover:scale-[1.14]"
			/>
			<div class="absolute inset-0 bg-linear-to-t from-base-300 via-base-300/20 to-transparent"></div>
			<div class="absolute inset-0 flex items-end justify-center pb-4">
				<div
					class="flex h-20 w-20 items-center justify-center rounded-full border border-white/20 bg-base-100/85 shadow-lg backdrop-blur-sm"
				>
					<span class="text-xl font-bold tracking-tight text-base-content/80">{initials}</span>
				</div>
			</div>
		{:else}
			<div
				class="flex h-full w-full items-center justify-center bg-linear-to-br from-base-300 via-base-200 to-base-300"
			>
				<div
					class="flex h-20 w-20 items-center justify-center rounded-full bg-base-100/70 shadow-inner"
				>
					{#if initials}
						<span class="text-xl font-bold tracking-tight text-base-content/60">{initials}</span>
					{:else}
						<Mic2 class="h-8 w-8 text-base-content/30" />
					{/if}
				</div>
			</div>
		{/if}

		{#if link}
			<a href={link} class="absolute inset-0 z-10" aria-label={artist.name}></a>
		{/if}

		{#if showMonitor}
			<span
				class="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full shadow-sm backdrop-blur-sm {artist.monitored
					? 'bg-success/85 text-success-content'
					: 'bg-base-100/85 text-base-content/50'}"
				title={artist.monitored ? m.common_monitored() : m.common_unmonitored()}
			>
				{#if artist.monitored}
					<Eye class="h-3.5 w-3.5" />
				{:else}
					<EyeOff class="h-3.5 w-3.5" />
				{/if}
			</span>
		{/if}
	</div>

	<div class="mt-2 min-w-0 px-0.5">
		{#if link}
			<a href={link} class="block truncate text-sm leading-tight font-medium hover:text-primary" title={artist.name}>
				{artist.name}
			</a>
		{:else}
			<p class="truncate text-sm leading-tight font-medium" title={artist.name}>{artist.name}</p>
		{/if}
		<p class="mt-0.5 truncate text-xs text-base-content/55">
			{meta}
			{#if artist.inLibraryCount < artist.albumCount}
				<span class="text-warning">· {m.music_albumsMissing({ count: artist.albumCount - artist.inLibraryCount })}</span>
			{/if}
		</p>
	</div>
</div>

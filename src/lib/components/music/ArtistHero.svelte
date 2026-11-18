<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ArrowLeft, ExternalLink, Eye, EyeOff, Globe, Mic2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';

	type Props = {
		artist: {
			id: string;
			name: string;
			mbid?: string | null;
			disambiguation?: string | null;
			type?: string | null;
			country?: string | null;
			genres?: string[] | null;
			monitored?: boolean | null;
		};
		/** Art for the backdrop — the artist's first album cover. */
		backdropUrl?: string | null;
		albumCount: number;
		inLibraryCount: number;
		backHref?: string | null;
		backLabel?: string;
		/** Where the MusicBrainz link goes; omit to hide it. */
		sourceUrl?: string | null;
		actions?: Snippet;
	};

	let {
		artist,
		backdropUrl = null,
		albumCount,
		inLibraryCount,
		backHref = null,
		backLabel = m.nav_music(),
		sourceUrl = null,
		actions
	}: Props = $props();

	const initials = $derived(
		artist.name
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part.charAt(0).toUpperCase())
			.join('')
	);
	const missing = $derived(Math.max(0, albumCount - inLibraryCount));
</script>

<div class="relative w-full overflow-hidden rounded-xl bg-base-200 shadow-xl">
	<div class="absolute inset-0">
		{#if backdropUrl}
			<img src={backdropUrl} alt="" aria-hidden="true" class="h-full w-full scale-110 object-cover opacity-25 blur-2xl" />
		{/if}
		<div class="absolute inset-0 bg-linear-to-t from-base-200 via-base-200/70 to-base-200/30"></div>
	</div>

	<div class="relative z-10 flex flex-col gap-6 p-5 sm:p-6 md:flex-row md:items-center md:p-8">
		<div class="flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/15 bg-base-100/70 shadow-lg backdrop-blur-sm sm:h-36 sm:w-36">
			{#if backdropUrl}
				<img src={backdropUrl} alt={artist.name} class="h-full w-full object-cover opacity-80" />
			{:else if initials}
				<span class="text-3xl font-bold text-base-content/60">{initials}</span>
			{:else}
				<Mic2 class="h-10 w-10 text-base-content/30" />
			{/if}
		</div>

		<div class="min-w-0 flex-1">
			{#if backHref}
				<a
					class="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-base-content/45 transition-colors hover:text-base-content/80"
					href={resolvePath(backHref)}
				>
					<ArrowLeft class="h-3.5 w-3.5" />
					{backLabel}
				</a>
			{/if}

			<div class="flex flex-wrap items-center gap-2">
				<h1 class="text-2xl leading-tight font-bold tracking-tight sm:text-3xl">{artist.name}</h1>
				{#if artist.monitored !== undefined && artist.monitored !== null}
					<span
						class="badge gap-1 badge-sm border-none {artist.monitored
							? 'bg-success/15 text-success'
							: 'bg-base-content/10 text-base-content/50'}"
					>
						{#if artist.monitored}
							<Eye class="h-3 w-3" />{m.common_monitored()}
						{:else}
							<EyeOff class="h-3 w-3" />{m.common_unmonitored()}
						{/if}
					</span>
				{/if}
			</div>

			{#if artist.disambiguation}
				<p class="mt-1 text-sm text-base-content/55">{artist.disambiguation}</p>
			{/if}

			<div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
				{#if artist.type}
					<span class="badge badge-sm border-base-content/15 bg-base-100/60">{artist.type}</span>
				{/if}
				{#if artist.country}
					<span class="badge badge-sm gap-1 border-base-content/15 bg-base-100/60">
						<Globe class="h-3 w-3" />{artist.country}
					</span>
				{/if}
				{#each (artist.genres ?? []).slice(0, 4) as genre (genre)}
					<span class="badge badge-sm border-base-content/15 bg-base-100/60 capitalize">{genre}</span>
				{/each}
			</div>

			<p class="mt-3 text-sm text-base-content/60">
				{m.music_albumsCount({ count: albumCount })}
				<span class="text-base-content/25">·</span>
				{m.music_inLibraryCount({ count: inLibraryCount })}
				{#if missing > 0}
					<span class="text-base-content/25">·</span>
					<span class="text-warning">{m.music_missingCount({ count: missing })}</span>
				{/if}
			</p>

			<div class="mt-4 flex flex-wrap items-center gap-2">
				{@render actions?.()}
				{#if sourceUrl}
					<a
						class="btn gap-1.5 btn-ghost btn-xs text-base-content/50 hover:text-base-content"
						href={sourceUrl}
						target="_blank"
						rel="noreferrer"
					>
						<ExternalLink class="h-3.5 w-3.5" />
						MusicBrainz
					</a>
				{/if}
			</div>
		</div>
	</div>
</div>

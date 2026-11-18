<script lang="ts">
	import { ArrowLeft, Check, Disc3 } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import * as m from '#lib/paraglide/messages.js';

	type ReleaseGroupRow = {
		mbid: string;
		title: string;
		primaryType?: string | null;
		secondaryTypes: string[];
		year?: number | null;
	};

	let {
		data
	}: {
		data: {
			artist: {
				mbid: string;
				name: string;
				disambiguation?: string | null;
				type?: string | null;
				country?: string | null;
				genres: string[];
			};
			releaseGroups: ReleaseGroupRow[];
			storedMbids: string[];
		};
	} = $props();

	const artist = $derived(data.artist);
	const stored = $derived(new Set(data.storedMbids));
	const coverErrors = new SvelteSet<string>();

	// A discography reads oldest-first, like every track listing in the app.
	const discography = $derived(
		[...data.releaseGroups].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
	);
</script>

<svelte:head><title>{artist.name} · Cinephage</title></svelte:head>

<div class="mx-auto max-w-6xl p-4 sm:p-6">
	<a class="link link-hover mb-4 inline-flex items-center gap-1.5 text-sm opacity-60" href="/discover?type=music">
		<ArrowLeft class="h-4 w-4" />
		{m.nav_music()}
	</a>

	<header class="mb-6">
		<h1 class="text-2xl font-semibold">{artist.name}</h1>
		{#if artist.disambiguation}
			<p class="mt-1 text-sm opacity-60">{artist.disambiguation}</p>
		{/if}
		<div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
			{#if artist.type}<span class="badge badge-ghost">{artist.type}</span>{/if}
			{#if artist.country}<span class="badge badge-ghost">{artist.country}</span>{/if}
			{#each artist.genres.slice(0, 5) as genre (genre)}
				<span class="badge badge-ghost">{genre}</span>
			{/each}
		</div>
	</header>

	{#if discography.length === 0}
		<p class="opacity-50">{m.music_noResults()}</p>
	{:else}
		<ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
			{#each discography as group (group.mbid)}
				<li>
					<a class="group block" href={`/discover/music/${group.mbid}`}>
						<div class="relative aspect-square overflow-hidden rounded-lg bg-base-300 shadow-md transition-all duration-300 group-hover:scale-105">
							{#if !coverErrors.has(group.mbid)}
								<img
									src={`https://coverartarchive.org/release-group/${group.mbid}/front-250`}
									alt={group.title}
									loading="lazy"
									class="h-full w-full object-cover"
									onerror={() => coverErrors.add(group.mbid)}
								/>
							{:else}
								<div class="flex h-full w-full items-center justify-center">
									<Disc3 class="h-10 w-10 opacity-40" />
								</div>
							{/if}
							{#if stored.has(group.mbid)}
								<div
									class="absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-full bg-success/90 text-success-content shadow-md"
									title={m.music_inLibrary()}
								>
									<Check class="h-4 w-4" strokeWidth={3} />
								</div>
							{/if}
							<div
								class="absolute inset-0 flex flex-col justify-end bg-linear-to-t from-black/90 via-black/20 to-transparent p-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
							>
								<h3 class="line-clamp-2 text-sm leading-tight font-bold text-white">
									{group.title}
								</h3>
								<div class="mt-1 flex items-center justify-between">
									<span class="text-xs text-white/70">{group.year ?? ''}</span>
									{#if group.primaryType}
										<span class="text-xs font-medium text-white/70">{group.primaryType}</span>
									{/if}
								</div>
							</div>
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { LoaderCircle, Plus } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import * as m from '#lib/paraglide/messages.js';
	import ArtistHero from '#lib/components/music/ArtistHero.svelte';
	import AlbumCard from '#lib/components/music/AlbumCard.svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';

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
	const stored = $derived(new SvelteSet(data.storedMbids));

	// A discography reads oldest-first, like every track listing in the app.
	const discography = $derived(
		[...data.releaseGroups].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
	);

	let busy = $state(false);

	/**
	 * Add the rest of the discography. The server writes a bounded batch and
	 * reports what it left, so this loops until nothing remains.
	 */
	async function addDiscography() {
		if (busy) return;
		busy = true;
		let added = 0;
		let batches = 0;
		try {
			for (;;) {
				const response = await fetch('/api/music/artists', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						artist: { mbid: artist.mbid, name: artist.name },
						limit: 25
					})
				});
				const body = await response.json();
				if (!response.ok) {
					toasts.error(body.details ?? body.error ?? m.music_addFailed());
					return;
				}
				batches += 1;
				added += body.added ?? 0;
				toasts.info(m.music_addingArtist({ artist: artist.name, added, remaining: body.remaining ?? 0 }));
				await invalidateAll();
				if (!body.remaining || batches >= 12) break;
			}
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.music_addFailed());
		} finally {
			busy = false;
		}
	}

	function coverUrl(mbid: string): string {
		return `https://coverartarchive.org/release-group/${mbid}/front-250`;
	}
</script>

<svelte:head><title>{artist.name} · Cinephage</title></svelte:head>

<div class="w-full px-4 pt-4 pb-20 md:px-6 lg:px-8">
	<ArtistHero
		artist={{ ...artist, id: artist.mbid, monitored: null }}
		backdropUrl={discography[0] ? coverUrl(discography[0].mbid) : null}
		albumCount={discography.length}
		inLibraryCount={discography.filter((group) => stored.has(group.mbid)).length}
		backHref="/discover?type=music"
		backLabel={m.nav_music()}
		sourceUrl={`https://musicbrainz.org/artist/${artist.mbid}`}
	>
		{#snippet actions()}
			<button class="btn gap-1.5 btn-primary btn-sm" disabled={busy} onclick={addDiscography}>
				{#if busy}
					<LoaderCircle class="h-4 w-4 animate-spin" />
				{:else}
					<Plus class="h-4 w-4" />
				{/if}
				{m.music_addArtist()}
			</button>
		{/snippet}
	</ArtistHero>

	<div class="mt-6">
		<h2 class="mb-3 text-sm font-semibold tracking-wide uppercase text-base-content/50">
			{m.music_discography()}
		</h2>

		{#if discography.length === 0}
			<p class="text-sm text-base-content/55">{m.music_noResults()}</p>
		{:else}
			<ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
				{#each discography as group (group.mbid)}
					<li>
						<AlbumCard
							album={{
								id: group.mbid,
								title: group.title,
								artistName: artist.name,
								year: group.year ?? null,
								primaryType: group.primaryType ?? null,
								mbid: group.mbid
							}}
							coverUrl={coverUrl(group.mbid)}
							href={`/discover/music/${group.mbid}`}
							inLibrary={stored.has(group.mbid)}
						/>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

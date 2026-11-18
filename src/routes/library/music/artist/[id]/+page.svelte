<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types.js';
	import { LoaderCircle, Plus, Search } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import ArtistHero from '#lib/components/music/ArtistHero.svelte';
	import AlbumCard from '#lib/components/music/AlbumCard.svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';

	let { data }: { data: PageData } = $props();

	const artist = $derived(data.artist);
	const albums = $derived(
		[...data.albums].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title))
	);
	const coverAlbum = $derived(albums.find((album) => album.hasCover) ?? null);

	// Optimistic toggle: null follows the server value, an override survives
	// until the PATCH settles (and reverts on failure).
	let monitoredOverride = $state<boolean | null>(null);
	const monitored = $derived(monitoredOverride ?? Boolean(data.artist.monitored));
	let monitorBusy = $state(false);
	let addingMissing = $state(false);

	async function toggleMonitor(next: boolean) {
		if (monitorBusy) return;
		monitorBusy = true;
		const previous = monitoredOverride;
		monitoredOverride = next;
		try {
			const response = await fetch(`/api/music/artists/${artist.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ monitored: next })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				monitoredOverride = previous;
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
			}
		} catch (err) {
			monitoredOverride = previous;
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			monitorBusy = false;
		}
	}

	/**
	 * Pull the rest of the discography. The server writes a bounded batch and
	 * reports what is left, so the loop keeps going until the discography is
	 * complete or the batch cap is hit — the same shape the add-modal uses.
	 */
	async function addMissing() {
		if (addingMissing || !artist.mbid) return;
		addingMissing = true;
		let added = 0;
		let batches = 0;
		try {
			for (;;) {
				const response = await fetch('/api/music/artists', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						artist: { mbid: artist.mbid, name: artist.name, sortName: artist.sortName ?? null },
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
			addingMissing = false;
		}
	}
</script>

<svelte:head><title>{artist.name} · {m.nav_music()} · Cinephage</title></svelte:head>

<div class="mx-auto max-w-6xl p-4 sm:p-6">
	<ArtistHero
		artist={{ ...artist, monitored }}
		backdropUrl={coverAlbum ? `/api/music/albums/${coverAlbum.id}/cover` : null}
		albumCount={data.counts.albums}
		inLibraryCount={data.counts.inLibrary}
		backHref="/library/music"
		backLabel={m.nav_music()}
		sourceUrl={artist.mbid ? `https://musicbrainz.org/artist/${artist.mbid}` : null}
	>
		{#snippet actions()}
			<button
				class="btn gap-1.5 btn-sm {monitored ? 'bg-success/10 text-success hover:bg-success/20' : 'btn-ghost'}"
				disabled={monitorBusy}
				onclick={() => toggleMonitor(!monitored)}
			>
				{#if monitorBusy}
					<LoaderCircle class="h-4 w-4 animate-spin" />
				{:else if monitored}
					{m.common_monitored()}
				{:else}
					{m.common_unmonitored()}
				{/if}
			</button>
			{#if artist.mbid}
				<button class="btn gap-1.5 btn-primary btn-sm" disabled={addingMissing} onclick={addMissing}>
					{#if addingMissing}
						<LoaderCircle class="h-4 w-4 animate-spin" />
					{:else}
						<Plus class="h-4 w-4" />
					{/if}
					{m.music_addMissing()}
				</button>
			{/if}
		{/snippet}
	</ArtistHero>

	<div class="mt-6">
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-semibold tracking-wide uppercase text-base-content/50">
				{m.music_discography()}
			</h2>
			<a class="link link-hover text-xs text-base-content/50" href="/discover?type=music">
				{m.music_browseDiscover()}
			</a>
		</div>

		{#if albums.length === 0}
			<div class="rounded-xl border border-dashed border-base-content/15 px-6 py-14 text-center">
				<Search class="mx-auto mb-3 h-8 w-8 text-base-content/25" />
				<p class="font-medium">{m.music_artistEmpty()}</p>
				<p class="mt-1 text-sm text-base-content/55">{m.music_artistEmptyHint()}</p>
			</div>
		{:else}
			<ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
				{#each albums as album (album.id)}
					<li>
						<AlbumCard
							{album}
							href={`/library/music/${album.id}`}
							coverUrl={album.hasCover ? `/api/music/albums/${album.id}/cover` : null}
							showMonitor
						/>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

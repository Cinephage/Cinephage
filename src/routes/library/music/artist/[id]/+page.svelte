<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types.js';
	import { Disc3, LoaderCircle, Music, Pencil, Plus, Search, Trash2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import ArtistHero from '#lib/components/music/ArtistHero.svelte';
	import AlbumAccordion from '#lib/components/music/AlbumAccordion.svelte';
	import TrackTable from '#lib/components/music/TrackTable.svelte';
	import type { AlbumWithTracks } from '#lib/components/music/music-card.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { ConfirmationModal, ModalWrapper } from '#lib/components/ui/modal/index.js';
	import { goto } from '$app/navigation';

	let { data }: { data: PageData } = $props();

	const artist = $derived(data.artist);
	const albums = $derived<AlbumWithTracks[]>(
		[...data.albums].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title))
	);
	const coverAlbum = $derived(albums.find((album) => album.hasCover) ?? null);

	/**
	 * Discography grouped the way a series page groups seasons: the primary type
	 * is the section (Albums, EPs, Singles…), and the section order is stable so
	 * the page does not reshuffle as albums are added.
	 */
	const TYPE_ORDER = ['Album', 'EP', 'Single', 'Broadcast', 'Other'];
	const groupLabel = (type: string): string =>
		type === 'Album'
			? m.music_tabAlbums()
			: type === 'EP'
				? m.music_groupEps()
				: type === 'Single'
					? m.music_groupSingles()
					: type;

	const groups = $derived.by(() => {
		const map = new Map<string, AlbumWithTracks[]>();
		for (const album of visibleAlbums) {
			const key = album.primaryType ?? 'Album';
			map.set(key, [...(map.get(key) ?? []), album]);
		}
		return [...map.entries()].sort(
			(a, b) =>
				(TYPE_ORDER.indexOf(a[0]) === -1 ? 99 : TYPE_ORDER.indexOf(a[0])) -
				(TYPE_ORDER.indexOf(b[0]) === -1 ? 99 : TYPE_ORDER.indexOf(b[0]))
		);
	});

	let tab = $state<'albums' | 'songs'>('albums');
	let filter = $state('');
	let searchingDiscography = $state(false);
	let searchProgress = $state<{ done: number; total: number } | null>(null);

	const needles = $derived(
		filter
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.filter(Boolean)
	);

	function matches(text: string): boolean {
		if (needles.length === 0) return true;
		const haystack = text.toLowerCase();
		return needles.every((needle) => haystack.includes(needle));
	}

	const visibleAlbums = $derived(
		albums.filter((album) => matches(`${album.title} ${album.primaryType ?? ''} ${album.year ?? ''}`))
	);
	const visibleSongs = $derived(
		data.songs.filter((song) => matches(`${song.title} ${song.albumTitle}`))
	);

	/**
	 * Walk the discography and grab the best accepted release for each album,
	 * one bounded batch at a time — the artist-level equivalent of the series
	 * page's search-all.
	 */
	let editOpen = $state(false);
	let editName = $state('');
	let editSortName = $state('');
	let savingEdit = $state(false);
	let deleteOpen = $state(false);
	let deleting = $state(false);

	function openEdit() {
		editName = artist.name;
		editSortName = artist.sortName ?? '';
		editOpen = true;
	}

	async function saveEdit() {
		if (savingEdit || editName.trim().length === 0) return;
		savingEdit = true;
		try {
			const response = await fetch(`/api/music/artists/${artist.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: editName.trim(),
					sortName: editSortName.trim() || null
				})
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
				return;
			}
			editOpen = false;
			toasts.success(m.music_artistSaved());
			await invalidateAll();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			savingEdit = false;
		}
	}

	async function removeArtist() {
		if (deleting) return;
		deleting = true;
		try {
			const response = await fetch(`/api/music/artists/${artist.id}`, { method: 'DELETE' });
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
				return;
			}
			toasts.success(m.music_removedArtist({ name: artist.name }));
			await goto('/library/music');
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			deleting = false;
		}
	}

	async function searchDiscography() {
		if (searchingDiscography) return;
		searchingDiscography = true;
		const total = data.albums.filter((album) => !album.hasFile).length;
		let done = 0;
		searchProgress = { done, total };
		try {
			for (;;) {
				const response = await fetch(`/api/music/artists/${artist.id}/search`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ limit: 5 })
				});
				const body = await response.json();
				if (!response.ok) {
					toasts.error(body.details ?? body.error ?? m.music_searchFailed());
					return;
				}
				done += body.searched ?? 0;
				searchProgress = { done, total };
				if (body.grabbed > 0) {
					toasts.success(m.music_discographyGrabbed({ count: body.grabbed }));
				}
				await invalidateAll();
				if (!body.remaining) break;
			}
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.music_searchFailed());
		} finally {
			searchingDiscography = false;
			searchProgress = null;
		}
	}
	let openAlbumId = $state<string | null>(null);

	function toggleAlbum(albumId: string) {
		openAlbumId = openAlbumId === albumId ? null : albumId;
	}

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

<div class="w-full px-4 pt-4 pb-20 md:px-6 lg:px-8">
	<!-- Action bar: the series page's Auto-grab / Edit / Delete row. -->
	<div class="mb-3 flex flex-wrap items-center justify-end gap-2">
		<button class="btn gap-1.5 btn-primary btn-sm" disabled={searchingDiscography} onclick={searchDiscography}>
			{#if searchingDiscography}
				<LoaderCircle class="h-4 w-4 animate-spin" />
			{:else}
				<Search class="h-4 w-4" />
			{/if}
			{#if searchProgress}
				{m.music_searchProgress({ done: searchProgress.done, total: searchProgress.total })}
			{:else}
				{m.music_searchDiscography()}
			{/if}
		</button>
		{#if artist.mbid}
			<button class="btn gap-1.5 btn-outline btn-sm" disabled={addingMissing} onclick={addMissing}>
				{#if addingMissing}
					<LoaderCircle class="h-4 w-4 animate-spin" />
				{:else}
					<Plus class="h-4 w-4" />
				{/if}
				{m.music_addMissing()}
			</button>
		{/if}
		<button
			class="btn gap-1.5 btn-sm {monitored ? 'bg-success/10 text-success hover:bg-success/20' : 'btn-ghost'}"
			disabled={monitorBusy}
			onclick={() => toggleMonitor(!monitored)}
		>
			{#if monitorBusy}
				<LoaderCircle class="h-4 w-4 animate-spin" />
			{:else if monitored}
				{m.music_unmonitorAction()}
			{:else}
				{m.music_monitorAction()}
			{/if}
		</button>
		<button class="btn gap-1.5 btn-ghost btn-sm" onclick={openEdit}>
			<Pencil class="h-4 w-4" />
			{m.music_editAction()}
		</button>
		<button class="btn gap-1.5 btn-ghost btn-sm text-error hover:bg-error/10" onclick={() => (deleteOpen = true)}>
			<Trash2 class="h-4 w-4" />
			{m.common_delete()}
		</button>
	</div>

	<ArtistHero
		artist={{ ...artist, monitored }}
		backdropUrl={coverAlbum ? `/api/music/albums/${coverAlbum.id}/cover` : null}
		albumCount={data.counts.albums}
		inLibraryCount={data.counts.inLibrary}
		songCount={data.counts.songs}
		featured={data.featured}
		backHref="/library/music"
		backLabel={m.nav_music()}
		sourceUrl={artist.mbid ? `https://musicbrainz.org/artist/${artist.mbid}` : null}
	/>

	<div class="mt-5 flex flex-wrap items-center justify-between gap-3">
		<div class="flex items-center gap-2">
			<h2 class="text-sm font-semibold tracking-wide uppercase text-base-content/50">
				{m.music_discography()}
			</h2>
			<span class="badge badge-sm badge-ghost">{visibleAlbums.length}</span>
		</div>
		<label class="input w-full max-w-sm input-sm">
			<Search class="h-4 w-4 opacity-40" />
			<input
				class="grow"
				placeholder={m.music_filterDiscography()}
				bind:value={filter}
				aria-label={m.music_filterDiscography()}
			/>
		</label>
	</div>

	<div class="mt-3 flex items-center justify-between gap-3 border-b border-base-content/10">
		<div class="flex items-center gap-1">
			<button
				class="flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors {tab ===
				'albums'
					? 'border-primary text-primary'
					: 'border-transparent text-base-content/55 hover:text-base-content'}"
				onclick={() => (tab = 'albums')}
			>
				<Disc3 class="h-4 w-4" />
				{m.music_tabAlbums()}
				<span class="badge badge-sm badge-ghost">{visibleAlbums.length}</span>
			</button>
			<button
				class="flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors {tab ===
				'songs'
					? 'border-primary text-primary'
					: 'border-transparent text-base-content/55 hover:text-base-content'}"
				onclick={() => (tab = 'songs')}
			>
				<Music class="h-4 w-4" />
				{m.music_tabSongs()}
				<span class="badge badge-sm badge-ghost">{visibleSongs.length}</span>
			</button>
		</div>
		<a class="link link-hover text-xs text-base-content/50" href="/discover?type=music">
			{m.music_browseDiscover()}
		</a>
	</div>

	<div class="mt-4">
		{#if albums.length === 0}
			<div class="rounded-xl border border-dashed border-base-content/15 px-6 py-14 text-center">
				<Search class="mx-auto mb-3 h-8 w-8 text-base-content/25" />
				<p class="font-medium">{m.music_artistEmpty()}</p>
				<p class="mt-1 text-sm text-base-content/55">{m.music_artistEmptyHint()}</p>
			</div>
		{:else if tab === 'songs'}
			<TrackTable tracks={visibleSongs} showArtist={false} />
		{:else}
			<div class="space-y-6">
				{#each groups as [type, groupAlbums] (type)}
					<section>
						<div class="mb-2 flex items-center gap-2">
							<h2 class="text-xs font-semibold tracking-wide uppercase text-base-content/45">
								{groupLabel(type)}
							</h2>
							<span class="badge badge-xs badge-ghost">{groupAlbums.length}</span>
						</div>
						<AlbumAccordion albums={groupAlbums} {openAlbumId} onToggle={toggleAlbum} />
					</section>
				{/each}
			</div>
		{/if}
	</div>
</div>

<ModalWrapper open={editOpen} onClose={() => (editOpen = false)} maxWidth="lg">
	<h2 class="text-lg font-bold">{m.music_editArtist()}</h2>
	<form
		class="mt-4 space-y-3"
		onsubmit={(event) => {
			event.preventDefault();
			saveEdit();
		}}
	>
		<label class="form-control">
			<span class="mb-1 text-xs uppercase text-base-content/50">{m.common_name()}</span>
			<input class="input w-full input-sm" bind:value={editName} />
		</label>
		<label class="form-control">
			<span class="mb-1 text-xs uppercase text-base-content/50">{m.music_sortName()}</span>
			<input class="input w-full input-sm" bind:value={editSortName} placeholder={artist.name} />
		</label>
		<div class="flex justify-end gap-2 pt-1">
			<button type="button" class="btn btn-ghost btn-sm" onclick={() => (editOpen = false)}>
				{m.action_cancel()}
			</button>
			<button type="submit" class="btn btn-primary btn-sm" disabled={savingEdit || !editName.trim()}>
				{#if savingEdit}<LoaderCircle class="h-4 w-4 animate-spin" />{/if}
				{m.action_save()}
			</button>
		</div>
	</form>
</ModalWrapper>

<ConfirmationModal
	open={deleteOpen}
	title={m.music_removeArtist({ name: artist.name })}
	message={m.music_removeArtistConfirm({ name: artist.name })}
	confirmLabel={m.common_delete()}
	confirmVariant="error"
	loading={deleting}
	onConfirm={removeArtist}
	onCancel={() => (deleteOpen = false)}
/>

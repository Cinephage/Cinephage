<script lang="ts">
	import { invalidateAll, goto } from '$app/navigation';
	import type { PageData } from './$types.js';
	import { LoaderCircle, Search } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import ArtistHero from '#lib/components/music/ArtistHero.svelte';
	import AlbumAccordion from '#lib/components/music/AlbumAccordion.svelte';
	import TrackTable from '#lib/components/music/TrackTable.svelte';
	import TrackSearchModal from '#lib/components/music/TrackSearchModal.svelte';
	import type { AlbumWithTracks } from '#lib/components/music/music-card.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { ConfirmationModal, ModalWrapper } from '#lib/components/ui/modal/index.js';

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

	let filter = $state('');
	let searchingDiscography = $state(false);
	let searchProgress = $state<{ done: number; total: number } | null>(null);
	let openAlbumId = $state<string | null>(null);

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

	/**
	 * The filter searches songs as well as albums, the same way the library's
	 * one box does. Song matches render as their own section under the
	 * discography so an album filter never hides a track that matched.
	 */
	const visibleSongs = $derived(
		needles.length === 0
			? []
			: data.songs.filter((song) => matches(`${song.title} ${song.albumTitle}`))
	);

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

	function toggleAlbum(albumId: string) {
		openAlbumId = openAlbumId === albumId ? null : albumId;
	}

	/** Per-album row actions: the same monitor / search / remove set a season row has. */
	const busyAlbumIds = new SvelteSet<string>();
	let searchTrack = $state<{
		track: { id: string; title: string };
		albumId: string;
		albumTitle: string;
	} | null>(null);
	let removeAlbumTarget = $state<AlbumWithTracks | null>(null);
	let removingAlbum = $state(false);

	async function toggleAlbumMonitorRow(album: AlbumWithTracks) {
		if (busyAlbumIds.has(album.id)) return;
		busyAlbumIds.add(album.id);
		try {
			const response = await fetch(`/api/music/albums/${album.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ monitored: !album.monitored })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
				return;
			}
			await invalidateAll();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			busyAlbumIds.delete(album.id);
		}
	}

	async function autoSearchAlbumRow(album: AlbumWithTracks) {
		if (busyAlbumIds.has(album.id)) return;
		busyAlbumIds.add(album.id);
		try {
			const response = await fetch(`/api/music/albums/${album.id}/auto-search`, { method: 'POST' });
			const body = await response.json().catch(() => ({}));
			if (body.grabbed) {
				toasts.success(m.music_grabbed({ title: body.release ?? album.title }));
				await invalidateAll();
			} else {
				toasts.info(body.error ?? m.music_noReleases());
			}
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.music_searchFailed());
		} finally {
			busyAlbumIds.delete(album.id);
		}
	}

	async function removeAlbumRow() {
		const album = removeAlbumTarget;
		if (!album || removingAlbum) return;
		removingAlbum = true;
		try {
			const response = await fetch(`/api/music/albums/${album.id}`, { method: 'DELETE' });
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
				return;
			}
			toasts.success(m.music_removedAlbum({ title: album.title }));
			removeAlbumTarget = null;
			await invalidateAll();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			removingAlbum = false;
		}
	}
</script>

<svelte:head><title>{artist.name} · {m.nav_music()} · Cinephage</title></svelte:head>

<div class="flex w-full flex-col gap-4 overflow-x-hidden px-4 pb-20 md:gap-6 md:px-6 lg:px-8">
	<!-- Header -->
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
		onMonitorToggle={toggleMonitor}
		{monitorBusy}
		onSearchDiscography={searchDiscography}
		searching={searchingDiscography}
		searchProgressText={searchProgress
			? m.music_searchProgress({ done: searchProgress.done, total: searchProgress.total })
			: null}
		onAddMissing={artist.mbid ? addMissing : null}
		{addingMissing}
		onEdit={openEdit}
		onRemove={() => (deleteOpen = true)}
	/>

	<!-- Main content: the series page's Seasons panel plus its sidebar. -->
	<div class="grid gap-4 lg:grid-cols-2 lg:gap-6 xl:grid-cols-3">
		<div class="min-w-0 space-y-4 md:col-span-2 lg:col-span-2">
			<div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex items-center gap-3">
					<h2 class="text-lg font-semibold">{m.music_discography()}</h2>
					<span class="badge badge-ghost badge-sm">{visibleAlbums.length}</span>
				</div>
				<label class="input w-full max-w-xs input-sm">
					<Search class="h-4 w-4 opacity-40" />
					<input
						class="grow"
						placeholder={m.music_filterDiscography()}
						bind:value={filter}
						aria-label={m.music_filterDiscography()}
					/>
				</label>
			</div>

			{#if albums.length === 0}
				<div class="rounded-xl bg-base-200 p-8 text-center text-base-content/60">
					<p class="font-medium">{m.music_artistEmpty()}</p>
					<p class="mt-1 text-sm">{m.music_artistEmptyHint()}</p>
				</div>
			{:else if visibleAlbums.length === 0}
				<div class="rounded-xl bg-base-200 p-8 text-center text-sm text-base-content/60">
					{m.music_noFilterMatch()}
				</div>
			{:else}
				{#each groups as [type, groupAlbums] (type)}
					<section class="space-y-2">
						<div class="flex items-center gap-2">
							<h3 class="text-xs font-semibold tracking-wide text-base-content/45 uppercase">
								{groupLabel(type)}
							</h3>
							<span class="badge badge-xs badge-ghost">{groupAlbums.length}</span>
						</div>
						<AlbumAccordion
							albums={groupAlbums}
							{openAlbumId}
							onToggle={toggleAlbum}
							onMonitorToggle={toggleAlbumMonitorRow}
							onAutoSearch={autoSearchAlbumRow}
							onRemove={(album) => (removeAlbumTarget = album)}
							{busyAlbumIds}
							onAutoSearchTrack={(_track, album) => autoSearchAlbumRow(album)}
							onOpenSearchTrack={(track, album) =>
								(searchTrack = {
									track: { id: track.id, title: track.title },
									albumId: album.id,
									albumTitle: album.title
								})}
						/>
					</section>
				{/each}
			{/if}

			{#if visibleSongs.length > 0}
				<section class="space-y-2 pt-2">
					<div class="flex items-center gap-2">
						<h3 class="text-xs font-semibold tracking-wide text-base-content/45 uppercase">
							{m.music_tabSongs()}
						</h3>
						<span class="badge badge-xs badge-ghost">{visibleSongs.length}</span>
					</div>
					<TrackTable tracks={visibleSongs} showArtist={false} />
				</section>
			{/if}
		</div>

		<!-- Sidebar -->
		<div class="min-w-0 space-y-4 md:space-y-6">
			<div class="rounded-xl bg-base-200 p-4 md:p-6">
				<h3 class="mb-3 font-semibold">{m.common_details()}</h3>
				<dl class="space-y-2 text-sm">
					{#if artist.genres && artist.genres.length > 0}
						<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
							<dt class="text-base-content/60">{m.music_genreLabel()}</dt>
							<dd class="flex flex-wrap gap-1 sm:justify-end">
								{#each artist.genres as genre (genre)}
									<span class="badge badge-sm badge-ghost">{genre}</span>
								{/each}
							</dd>
						</div>
					{/if}
					{#if artist.country}
						<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
							<dt class="text-base-content/60">{m.music_country()}</dt>
							<dd class="sm:text-right">{artist.country}</dd>
						</div>
					{/if}
					<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
						<dt class="text-base-content/60">{m.music_tabAlbums()}</dt>
						<dd class="sm:text-right">{data.counts.albums}</dd>
					</div>
					<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
						<dt class="text-base-content/60">{m.music_inLibrary()}</dt>
						<dd class="sm:text-right">{data.counts.inLibrary}</dd>
					</div>
					<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
						<dt class="text-base-content/60">{m.music_tabSongs()}</dt>
						<dd class="sm:text-right">{data.counts.songs}</dd>
					</div>
					{#if artist.mbid}
						<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
							<dt class="text-base-content/60">MusicBrainz</dt>
							<dd class="truncate font-mono text-[11px] text-base-content/60 sm:text-right" title={artist.mbid}>
								{artist.mbid}
							</dd>
						</div>
					{/if}
				</dl>
			</div>
		</div>
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
			<span class="mb-1 text-xs text-base-content/50 uppercase">{m.common_name()}</span>
			<input class="input w-full input-sm" bind:value={editName} />
		</label>
		<label class="form-control">
			<span class="mb-1 text-xs text-base-content/50 uppercase">{m.music_sortName()}</span>
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

{#if searchTrack}
	<TrackSearchModal
		open={searchTrack !== null}
		track={searchTrack.track}
		albumId={searchTrack.albumId}
		albumTitle={searchTrack.albumTitle}
		onClose={() => (searchTrack = null)}
	/>
{/if}

<ConfirmationModal
	open={removeAlbumTarget !== null}
	title={m.music_removeAlbum()}
	message={m.music_removeAlbumConfirm({ title: removeAlbumTarget?.title ?? '' })}
	confirmLabel={m.common_delete()}
	confirmVariant="error"
	loading={removingAlbum}
	onConfirm={removeAlbumRow}
	onCancel={() => (removeAlbumTarget = null)}
/>

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
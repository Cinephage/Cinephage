<script lang="ts">
	import { invalidateAll, replaceState } from '$app/navigation';
	import type { PageData } from './$types.js';
	import {
		Disc3,
		Eye,
		EyeOff,
		Search,
		ChevronDown,
		Plus,
		Mic2,
		Music,
		CheckSquare,
		XSquare
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import LibraryMediaCard from '#lib/components/library/LibraryMediaCard.svelte';
	import LibraryMediaTable from '#lib/components/library/LibraryMediaTable.svelte';
	import LibraryListHeader from '#lib/components/library/list/LibraryListHeader.svelte';
	import LibraryDrawer from '#lib/components/library/LibraryDrawer.svelte';
	import {
		albumCardView,
		albumRowView,
		artistCardView,
		artistRowView
	} from '#lib/components/library/media-view.js';
	import TrackTable from '#lib/components/music/TrackTable.svelte';
	import TrackSearchModal from '#lib/components/music/TrackSearchModal.svelte';
	import MusicAddModal from '#lib/components/music/MusicAddModal.svelte';
	import { viewPreferences } from '#lib/stores/view-preferences.svelte.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
	import LibraryBulkActionBar from '#lib/components/library/LibraryBulkActionBar.svelte';
	import { createListSelection } from '#lib/components/library/list/list-selection.svelte.js';
	import ConfirmationModal from '#lib/components/ui/modal/ConfirmationModal.svelte';
	import BulkQualityProfileModal from '#lib/components/library/BulkQualityProfileModal.svelte';
	import type { TrackTableRow } from '#lib/components/music/music-card.js';

	let { data }: { data: PageData } = $props();

	type Browse = 'artists' | 'albums' | 'songs';
	type FileFilter = 'all' | 'downloaded' | 'missing';
	type MonitorFilter = 'all' | 'monitored' | 'unmonitored';

	const initial = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
	const initialBrowse = initial.get('type');
	let browse = $state<Browse>(
		initialBrowse === 'albums' || initialBrowse === 'songs' ? initialBrowse : 'artists'
	);
	let searchQuery = $state(initial.get('q') ?? '');
	let fileFilter = $state<FileFilter>((initial.get('file') as FileFilter) ?? 'all');
	let monitorFilter = $state<MonitorFilter>((initial.get('monitor') as MonitorFilter) ?? 'all');
	let sortField = $state(initial.get('sort') ?? 'name-asc');
	let drawerOpen = $state(false);
	let addOpen = $state(false);

	const isAdminUser = $derived(data.user?.role === 'admin');

	/**
	 * One search box, three levels. A query looks at artists, albums and songs at
	 * once — the way the movie list's search looks at every movie — and the
	 * matching kind decides how a result is drawn. An empty query is the browse
	 * state, which shows one level at a time.
	 */
	const needles = $derived(searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean));

	function matches(text: string): boolean {
		if (needles.length === 0) return true;
		const haystack = text.toLowerCase();
		return needles.every((needle) => haystack.includes(needle));
	}

	function keepFile(hasFile: boolean | null | undefined): boolean {
		if (fileFilter === 'downloaded' && !hasFile) return false;
		if (fileFilter === 'missing' && hasFile) return false;
		return true;
	}

	function keepMonitor(monitored: boolean | null | undefined): boolean {
		if (monitorFilter === 'monitored' && !monitored) return false;
		if (monitorFilter === 'unmonitored' && monitored) return false;
		return true;
	}

	const artists = $derived(
		[...data.artists]
			.filter(
				(artist) =>
					matches(artist.name) &&
					keepMonitor(artist.monitored) &&
					(fileFilter === 'all' ||
						(fileFilter === 'downloaded' && artist.inLibraryCount > 0) ||
						(fileFilter === 'missing' && artist.inLibraryCount < artist.albumCount))
			)
			.sort((a, b) => {
				if (sortField === 'name-desc') return b.name.localeCompare(a.name);
				if (sortField === 'albums-desc') return b.albumCount - a.albumCount;
				if (sortField === 'missing-desc')
					return b.albumCount - b.inLibraryCount - (a.albumCount - a.inLibraryCount);
				return a.name.localeCompare(b.name);
			})
	);

	const albums = $derived(
		[...data.albums]
			.filter(
				(album) =>
					matches(`${album.title} ${album.artistName}`) &&
					keepFile(album.hasFile) &&
					keepMonitor(album.monitored)
			)
			.sort((a, b) => {
				if (sortField === 'title-asc') return a.title.localeCompare(b.title);
				if (sortField === 'year-desc') return (b.year ?? 0) - (a.year ?? 0);
				if (sortField === 'year-asc') return (a.year ?? 9999) - (b.year ?? 9999);
				if (sortField === 'tracks-desc') return (b.trackCount ?? 0) - (a.trackCount ?? 0);
				return (
					a.artistName.localeCompare(b.artistName) ||
					(a.year ?? 0) - (b.year ?? 0) ||
					a.title.localeCompare(b.title)
				);
			})
	);

	const songs = $derived(
		data.songs
			.filter(
				(song) =>
					matches(`${song.title} ${song.artistName} ${song.albumTitle}`) && keepFile(song.hasFile)
			)
			.sort((a, b) => {
				if (sortField === 'artist-asc') return a.artistName.localeCompare(b.artistName);
				if (sortField === 'album-asc') return a.albumTitle.localeCompare(b.albumTitle);
				if (sortField === 'duration-desc') return (b.duration ?? 0) - (a.duration ?? 0);
				return a.title.localeCompare(b.title);
			})
	);

	const searching = $derived(needles.length > 0);

	function defaultSort(view: Browse): string {
		if (view === 'songs') return 'title-asc';
		if (view === 'albums') return 'artist-asc';
		return 'name-asc';
	}

	const sortOptions = $derived.by(() => {
		if (browse === 'songs') {
			return [
				{ value: 'title-asc', label: m.music_sortTitleAsc() },
				{ value: 'artist-asc', label: m.music_sortArtistAsc() },
				{ value: 'album-asc', label: m.music_sortAlbumAsc() },
				{ value: 'duration-desc', label: m.music_sortDurationDesc() }
			];
		}
		if (browse === 'albums') {
			return [
				{ value: 'artist-asc', label: m.music_sortArtistAsc() },
				{ value: 'title-asc', label: m.music_sortTitleAsc() },
				{ value: 'year-desc', label: m.music_sortYearDesc() },
				{ value: 'year-asc', label: m.music_sortYearAsc() },
				{ value: 'tracks-desc', label: m.music_sortTracksDesc() }
			];
		}
		return [
			{ value: 'name-asc', label: m.music_sortNameAsc() },
			{ value: 'name-desc', label: m.music_sortNameDesc() },
			{ value: 'albums-desc', label: m.music_sortAlbumsDesc() },
			{ value: 'missing-desc', label: m.music_sortMissingDesc() }
		];
	});

	const filterOptions = $derived.by(() => {
		const options = [
			{
				key: 'type',
				label: m.music_typeLabel(),
				options: [
					{ value: 'artists', label: m.music_tabArtists() },
					{ value: 'albums', label: m.music_tabAlbums() },
					{ value: 'songs', label: m.music_tabSongs() }
				]
			},
			{
				key: 'file',
				label: m.music_filterFile(),
				options: [
					{ value: 'all', label: m.common_all() },
					{ value: 'downloaded', label: m.common_downloaded() },
					{ value: 'missing', label: m.common_missing() }
				]
			}
		];
		if (browse !== 'songs') {
			options.push({
				key: 'monitor',
				label: m.music_filterMonitoring(),
				options: [
					{ value: 'all', label: m.common_all() },
					{ value: 'monitored', label: m.common_monitored() },
					{ value: 'unmonitored', label: m.common_unmonitored() }
				]
			});
		}
		return options;
	});

	const activeFilterCount = $derived(
		(browse === 'artists' ? 0 : 1) +
			(fileFilter === 'all' ? 0 : 1) +
			(monitorFilter === 'all' ? 0 : 1)
	);

	const browseLabel = $derived(
		browse === 'albums'
			? m.music_tabAlbums()
			: browse === 'songs'
				? m.music_tabSongs()
				: m.music_tabArtists()
	);
	const browseCount = $derived(
		browse === 'albums'
			? data.counts.albums
			: browse === 'songs'
				? data.counts.songs
				: data.counts.artists
	);

	// Keep the view in the URL so a reload and the detail page's back link land on
	// the same slice. `replaceState`, not `goto`: filtering is not navigation.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const params = new SvelteURLSearchParams();
		if (browse !== 'artists') params.set('type', browse);
		if (searchQuery.trim()) params.set('q', searchQuery.trim());
		if (fileFilter !== 'all') params.set('file', fileFilter);
		if (monitorFilter !== 'all') params.set('monitor', monitorFilter);
		if (sortField !== sortOptions[0]?.value) params.set('sort', sortField);
		const next = params.toString();
		const current = window.location.search.replace(/^\?/, '');
		if (next !== current) replaceState(`/library/music${next ? `?${next}` : ''}`, {});
	});

	function clearFilters() {
		fileFilter = 'all';
		monitorFilter = 'all';
	}

	async function setMonitored(ids: string[], monitored: boolean) {
		if (ids.length === 0) return;
		const response = await fetch('/api/music/albums', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ids, monitored })
		});
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			toasts.error(body.details ?? body.error ?? m.common_failedToSave());
			return;
		}
		await invalidateAll();
	}

	async function handleMonitorAll(monitored: boolean) {
		if (browse === 'artists') {
			await setArtistsMonitored(
				artists.map((artist) => artist.id),
				monitored
			);
			return;
		}
		await setMonitored(
			albums.map((album) => album.id),
			monitored
		);
	}

	async function setArtistsMonitored(ids: string[], monitored: boolean) {
		if (ids.length === 0) return;
		const response = await fetch('/api/music/artists', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ids, monitored })
		});
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			toasts.error(body.details ?? body.error ?? m.common_failedToSave());
			return;
		}
		await invalidateAll();
	}

	async function toggleAlbumMonitored(id: string) {
		const album = data.albums.find((entry) => entry.id === id);
		if (!album) return;
		await setMonitored([id], !album.monitored);
	}

	async function toggleArtistMonitored(id: string) {
		const artist = data.artists.find((entry) => entry.id === id);
		if (!artist) return;
		await setArtistsMonitored([id], !artist.monitored);
	}

	async function removeAlbum(id: string) {
		const album = data.albums.find((entry) => entry.id === id);
		const response = await fetch(`/api/music/albums/${id}`, { method: 'DELETE' });
		if (!response.ok) {
			toasts.error(m.common_failedToSave());
			return;
		}
		toasts.success(m.music_removedAlbum({ title: album?.title ?? '' }));
		await invalidateAll();
	}

	async function removeArtist(id: string) {
		const artist = data.artists.find((entry) => entry.id === id);
		const response = await fetch(`/api/music/artists/${id}`, { method: 'DELETE' });
		if (!response.ok) {
			toasts.error(m.common_failedToSave());
			return;
		}
		toasts.success(m.music_removedArtist({ name: artist?.name ?? '' }));
		await invalidateAll();
	}

	/** Song rows search their album — the unit acquisition actually acts on. */
	const busySongIds = new SvelteSet<string>();
	let songSearch = $state<{
		track: { id: string; title: string };
		albumId: string;
		albumTitle: string;
	} | null>(null);

	async function autoSearchSong(track: TrackTableRow) {
		if (busySongIds.has(track.id)) return;
		busySongIds.add(track.id);
		try {
			const response = await fetch(`/api/music/albums/${track.albumId}/auto-search`, {
				method: 'POST'
			});
			const body = await response.json().catch(() => ({}));
			if (body.grabbed) {
				toasts.success(m.music_grabbed({ title: body.release ?? track.albumTitle }));
				await invalidateAll();
			} else {
				toasts.info(body.error ?? m.music_noReleases());
			}
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.music_searchFailed());
		} finally {
			busySongIds.delete(track.id);
		}
	}

	async function searchDiscography(id: string) {
		for (;;) {
			const response = await fetch(`/api/music/artists/${id}/search`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ limit: 5 })
			});
			const body = await response.json();
			if (!response.ok) {
				toasts.error(body.details ?? body.error ?? m.music_searchFailed());
				return;
			}
			if (!body.remaining) break;
		}
		await invalidateAll();
	}

	const selection = createListSelection();
	const selectedIds = selection.ids;

	const emptyLibrary = $derived(data.counts.albums === 0);

	/** The list selection acts on artists or albums, never on song rows. */
	const selectionItems = $derived(browse === 'artists' ? artists : albums);
	const selectable = $derived(browse !== 'songs' && isAdminUser);
	const bulkItemLabel = $derived(
		browse === 'artists'
			? selection.count === 1
				? m.music_tabArtist().toLowerCase()
				: m.music_tabArtists().toLowerCase()
			: selection.count === 1
				? m.music_tabAlbum().toLowerCase()
				: m.music_tabAlbums().toLowerCase()
	);

	let bulkLoading = $state(false);
	let bulkAction = $state<'monitor' | 'unmonitor' | 'quality' | 'delete' | null>(null);
	let removeSelectedOpen = $state(false);
	let qualityOpen = $state(false);

	async function bulkMonitor(monitored: boolean) {
		if (selection.count === 0) return;
		bulkLoading = true;
		bulkAction = monitored ? 'monitor' : 'unmonitor';
		try {
			const ids = [...selection.ids];
			await (browse === 'artists'
				? setArtistsMonitored(ids, monitored)
				: setMonitored(ids, monitored));
			selection.clear();
		} finally {
			bulkLoading = false;
			bulkAction = null;
		}
	}

	async function bulkQuality(profileId: string | null) {
		const ids = [...selection.ids];
		if (ids.length === 0) return;
		bulkLoading = true;
		bulkAction = 'quality';
		try {
			const response = await fetch(
				browse === 'artists' ? '/api/music/artists' : '/api/music/albums',
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ids, qualityProfileId: profileId })
				}
			);
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
				return;
			}
			qualityOpen = false;
			selection.clear();
			await invalidateAll();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			bulkLoading = false;
			bulkAction = null;
		}
	}

	async function bulkRemoveSelected() {
		const ids = [...selection.ids];
		if (ids.length === 0) return;
		bulkLoading = true;
		bulkAction = 'delete';
		try {
			let removed = 0;
			for (const id of ids) {
				const endpoint =
					browse === 'artists' ? `/api/music/artists/${id}` : `/api/music/albums/${id}`;
				const response = await fetch(endpoint, { method: 'DELETE' });
				if (response.ok) removed += 1;
			}
			removeSelectedOpen = false;
			selection.clear();
			if (removed === ids.length) {
				toasts.success(m.music_removedSelected({ count: removed }));
			} else {
				toasts.error(m.common_failedToSave());
			}
			await invalidateAll();
		} finally {
			bulkLoading = false;
			bulkAction = null;
		}
	}
</script>

<svelte:head><title>{m.nav_music()} · Cinephage</title></svelte:head>
<svelte:window onkeydown={selection.handleKeydown} />

<div class="min-h-screen bg-base-100 pb-20">
	<LibraryListHeader
		title={m.nav_music()}
		total={browseCount}
		totalUnfiltered={browseCount}
		ofTotalLabel=""
		searchPlaceholder={m.music_searchEverything()}
		clearSearchLabel={m.library_movies_clearSearch()}
		bind:searchQuery
		viewMode={viewPreferences.viewMode}
		switchToGridLabel={m.library_movies_switchToGrid()}
		switchToListLabel={m.library_movies_switchToList()}
		onToggleView={() => viewPreferences.toggleViewMode()}
		{activeFilterCount}
		filterLabel={m.library_drawer_title()}
		onOpenFilters={() => (drawerOpen = true)}
	>
		{#snippet notice()}
			{#if data.library && data.library.rootFolderCount === 0}
				<span class="hidden text-xs text-warning sm:inline">{m.music_noRootFolder()}</span>
			{/if}
		{/snippet}

		{#snippet actions()}
			{#if isAdminUser}
				<button class="btn gap-1.5 btn-primary btn-xs sm:btn-sm" onclick={() => (addOpen = true)}>
					<Plus class="h-4 w-4" />
					<span class="hidden xl:inline">{m.music_addMusic()}</span>
				</button>
			{/if}

			{#if selectable}
				<button
					class="btn gap-1.5 btn-ghost btn-xs sm:btn-sm {selection.mode ? 'btn-primary' : ''}"
					onclick={() => selection.cycle(selectionItems)}
				>
					{#if !selection.mode}
						<CheckSquare class="h-4 w-4" />
						<span class="hidden sm:inline">{m.library_movies_select()}</span>
					{:else if !selection.allSelected(selectionItems)}
						<CheckSquare class="h-4 w-4" />
						<span class="hidden sm:inline">{m.library_movies_selectAll()}</span>
					{:else}
						<XSquare class="h-4 w-4" />
						<span class="hidden sm:inline">{m.library_movies_done()}</span>
					{/if}
				</button>
			{/if}

			<div class="dropdown dropdown-end">
				<div
					tabindex="0"
					role="button"
					class="btn gap-1.5 btn-ghost btn-xs sm:btn-sm"
					aria-label={m.music_typeLabel()}
				>
					{#if browse === 'albums'}
						<Disc3 class="h-4 w-4" />
					{:else if browse === 'songs'}
						<Music class="h-4 w-4" />
					{:else}
						<Mic2 class="h-4 w-4" />
					{/if}
					<span class="hidden xl:inline">{browseLabel}</span>
					<ChevronDown class="hidden h-3 w-3 sm:block" />
				</div>
				<ul
					class="menu dropdown-content z-50 mt-2 w-44 rounded-box border border-base-300 bg-base-100 p-2 shadow-xl"
				>
					{#each [{ value: 'artists', label: m.music_tabArtists() }, { value: 'albums', label: m.music_tabAlbums() }, { value: 'songs', label: m.music_tabSongs() }] as option (option.value)}
						<li>
							<button
								class={browse === option.value ? 'menu-active' : ''}
								onclick={() => {
									browse = option.value as Browse;
									sortField = defaultSort(option.value as Browse);
									selection.clear();
								}}
							>
								{option.label}
							</button>
						</li>
					{/each}
				</ul>
			</div>

			<div class="dropdown dropdown-end">
				{#if isAdminUser}
					<div
						tabindex="0"
						role="button"
						class="btn gap-1.5 btn-ghost btn-xs sm:btn-sm"
						aria-label="Monitoring actions"
					>
						<Eye class="h-4 w-4" />
						<span class="hidden xl:inline">Monitoring</span>
						<ChevronDown class="hidden h-3 w-3 sm:block" />
					</div>
					<ul
						class="menu dropdown-content z-50 mt-2 w-44 rounded-box border border-base-300 bg-base-100 p-2 shadow-xl"
					>
						<li>
							<button onclick={() => handleMonitorAll(true)}>
								<Eye class="h-4 w-4" />
								{m.library_movies_monitorAll()}
							</button>
						</li>
						<li>
							<button onclick={() => handleMonitorAll(false)}>
								<EyeOff class="h-4 w-4" />
								{m.library_movies_unmonitorAll()}
							</button>
						</li>
					</ul>
				{/if}
			</div>
		{/snippet}
	</LibraryListHeader>

	<!-- Main content -->
	<main class="w-full px-4 py-8 lg:px-8">
		{#if emptyLibrary}
			<div class="flex flex-col items-center justify-center py-20 text-center opacity-50">
				<Disc3 class="mb-4 h-20 w-20" />
				<p class="text-2xl font-bold">{m.music_emptyTitle()}</p>
				<p class="mt-2">{m.music_emptyHint()}</p>
				<button class="btn mt-6 btn-primary" onclick={() => (addOpen = true)}>
					{m.music_addMusic()}
				</button>
			</div>
		{:else if searching}
			<!-- One query, every level. A section appears only when it has matches. -->
			{#if artists.length > 0}
				<section class="mb-8">
					<div class="mb-3 flex items-center gap-2">
						<h2 class="font-semibold">{m.music_tabArtists()}</h2>
						<span class="badge badge-ghost badge-sm">{artists.length}</span>
					</div>
					{#if viewPreferences.viewMode === 'grid'}
						<ul
							class="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9"
						>
							{#each artists as artist (artist.id)}
								<li>
									<LibraryMediaCard
										view={artistCardView(artist)}
										selectable={selectable && selection.mode}
										selected={selectedIds.has(artist.id)}
										onSelectChange={selection.toggle}
									/>
								</li>
							{/each}
						</ul>
					{:else}
						<LibraryMediaTable
							rows={artists.map((artist) => artistRowView(artist))}
							kind="artist"
							selectedItems={selectedIds}
							selectable={selectable && selection.mode}
							onSelectChange={selection.toggle}
							onMonitorToggle={isAdminUser ? toggleArtistMonitored : undefined}
							onAutoGrab={isAdminUser ? searchDiscography : undefined}
							onDelete={isAdminUser ? removeArtist : undefined}
						/>
					{/if}
				</section>
			{/if}

			{#if albums.length > 0}
				<section class="mb-8">
					<div class="mb-3 flex items-center gap-2">
						<h2 class="font-semibold">{m.music_tabAlbums()}</h2>
						<span class="badge badge-ghost badge-sm">{albums.length}</span>
					</div>
					{#if viewPreferences.viewMode === 'grid'}
						<ul
							class="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9"
						>
							{#each albums as album (album.id)}
								<li>
									<LibraryMediaCard
										view={albumCardView(album)}
										selectable={selectable && selection.mode}
										selected={selectedIds.has(album.id)}
										onSelectChange={selection.toggle}
									/>
								</li>
							{/each}
						</ul>
					{:else}
						<LibraryMediaTable
							rows={albums.map((album) => albumRowView(album))}
							kind="album"
							selectedItems={selectedIds}
							selectable={selectable && selection.mode}
							onSelectChange={selection.toggle}
							columnLabels={{ quality: m.music_typeLabel(), size: m.music_tracksLabel() }}
							onMonitorToggle={isAdminUser ? toggleAlbumMonitored : undefined}
							onDelete={isAdminUser ? removeAlbum : undefined}
						/>
					{/if}
				</section>
			{/if}

			{#if songs.length > 0}
				<section class="mb-8">
					<div class="mb-3 flex items-center gap-2">
						<h2 class="font-semibold">{m.music_tabSongs()}</h2>
						<span class="badge badge-ghost badge-sm">{songs.length}</span>
					</div>
					<TrackTable
						tracks={songs as TrackTableRow[]}
						onAutoSearch={autoSearchSong}
						onOpenSearch={(track) =>
							(songSearch = {
								track: { id: track.id, title: track.title },
								albumId: track.albumId,
								albumTitle: track.albumTitle
							})}
						busyTrackIds={busySongIds}
					/>
				</section>
			{/if}

			{#if artists.length === 0 && albums.length === 0 && songs.length === 0}
				<div class="flex flex-col items-center justify-center py-20 text-center">
					<div class="opacity-50">
						<Search class="mx-auto mb-4 h-16 w-16" />
						<p class="text-2xl font-bold">{m.music_noSearchMatch({ query: searchQuery })}</p>
						<p class="mt-2">{m.music_tryDifferentFilter()}</p>
					</div>
					<div class="mt-6 flex gap-3">
						<button class="btn btn-ghost" onclick={() => (searchQuery = '')}>
							{m.library_movies_clearSearchBtn()}
						</button>
						<a
							href={`/discover?type=music&q=${encodeURIComponent(searchQuery)}`}
							class="btn btn-primary"
						>
							Search in Discover
						</a>
					</div>
				</div>
			{/if}
		{:else if browse === 'songs'}
			{#if songs.length === 0}
				<div class="flex flex-col items-center justify-center py-20 text-center opacity-50">
					<Music class="mb-4 h-20 w-20" />
					<p class="text-2xl font-bold">{m.music_noFilterMatch()}</p>
					<button class="btn mt-6 btn-primary" onclick={clearFilters}>
						{m.library_movies_clearFilters()}
					</button>
				</div>
			{:else}
				<div class="animate-in fade-in slide-in-from-bottom-4 duration-500">
					<TrackTable
						tracks={songs as TrackTableRow[]}
						onAutoSearch={autoSearchSong}
						onOpenSearch={(track) =>
							(songSearch = {
								track: { id: track.id, title: track.title },
								albumId: track.albumId,
								albumTitle: track.albumTitle
							})}
						busyTrackIds={busySongIds}
					/>
				</div>
			{/if}
		{:else if browse === 'albums'}
			{#if albums.length === 0}
				<div class="flex flex-col items-center justify-center py-20 text-center opacity-50">
					<Disc3 class="mb-4 h-20 w-20" />
					<p class="text-2xl font-bold">{m.music_noFilterMatch()}</p>
					<p class="mt-2">{m.music_tryDifferentFilter()}</p>
					<button class="btn mt-6 btn-primary" onclick={clearFilters}>
						{m.library_movies_clearFilters()}
					</button>
				</div>
			{:else}
				<div class="animate-in fade-in slide-in-from-bottom-4 duration-500">
					{#if viewPreferences.viewMode === 'grid'}
						<ul
							class="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9"
						>
							{#each albums as album (album.id)}
								<li>
									<LibraryMediaCard
										view={albumCardView(album)}
										selectable={selectable && selection.mode}
										selected={selectedIds.has(album.id)}
										onSelectChange={selection.toggle}
									/>
								</li>
							{/each}
						</ul>
					{:else}
						<LibraryMediaTable
							rows={albums.map((album) => albumRowView(album))}
							kind="album"
							selectedItems={selectedIds}
							selectable={selectable && selection.mode}
							onSelectChange={selection.toggle}
							columnLabels={{ quality: m.music_typeLabel(), size: m.music_tracksLabel() }}
							onMonitorToggle={isAdminUser ? toggleAlbumMonitored : undefined}
							onDelete={isAdminUser ? removeAlbum : undefined}
						/>
					{/if}
				</div>
			{/if}
		{:else}
			{#if artists.length === 0}
				<div class="flex flex-col items-center justify-center py-20 text-center opacity-50">
					<Mic2 class="mb-4 h-20 w-20" />
					<p class="text-2xl font-bold">{m.music_noFilterMatch()}</p>
					<p class="mt-2">{m.music_tryDifferentFilter()}</p>
					<button class="btn mt-6 btn-primary" onclick={clearFilters}>
						{m.library_movies_clearFilters()}
					</button>
				</div>
			{:else}
				<div class="animate-in fade-in slide-in-from-bottom-4 duration-500">
					{#if viewPreferences.viewMode === 'grid'}
						<ul
							class="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9"
						>
							{#each artists as artist (artist.id)}
								<li>
									<LibraryMediaCard
										view={artistCardView(artist)}
										selectable={selectable && selection.mode}
										selected={selectedIds.has(artist.id)}
										onSelectChange={selection.toggle}
									/>
								</li>
							{/each}
						</ul>
					{:else}
						<LibraryMediaTable
							rows={artists.map((artist) => artistRowView(artist))}
							kind="artist"
							selectedItems={selectedIds}
							selectable={selectable && selection.mode}
							onSelectChange={selection.toggle}
							onMonitorToggle={isAdminUser ? toggleArtistMonitored : undefined}
							onAutoGrab={isAdminUser ? searchDiscography : undefined}
							onDelete={isAdminUser ? removeArtist : undefined}
						/>
					{/if}
				</div>
			{/if}
		{/if}
	</main>

	<LibraryBulkActionBar
		selectedCount={selection.count}
		loading={bulkLoading}
		currentAction={bulkAction}
		itemLabel={bulkItemLabel}
		onMonitor={() => bulkMonitor(true)}
		onUnmonitor={() => bulkMonitor(false)}
		onChangeQuality={() => (qualityOpen = true)}
		onDelete={() => (removeSelectedOpen = true)}
		onClear={selection.clear}
	/>

	<BulkQualityProfileModal
		open={qualityOpen}
		selectedCount={selection.count}
		qualityProfiles={data.qualityProfiles}
		saving={bulkLoading && bulkAction === 'quality'}
		itemLabel={bulkItemLabel}
		onSave={bulkQuality}
		onCancel={() => (qualityOpen = false)}
	/>

	<ConfirmationModal
		open={removeSelectedOpen}
		title={m.action_remove()}
		message={m.music_removeSelectedConfirm({ count: selection.count })}
		confirmLabel={m.action_remove()}
		confirmVariant="error"
		loading={bulkLoading}
		onConfirm={bulkRemoveSelected}
		onCancel={() => (removeSelectedOpen = false)}
	/>

	<LibraryDrawer
		isOpen={drawerOpen}
		{sortOptions}
		{filterOptions}
		currentSort={sortField}
		currentFilters={{ type: browse, file: fileFilter, monitor: monitorFilter }}
		hiddenActiveFilterKeys={[]}
		onClose={() => (drawerOpen = false)}
		onSortChange={(value) => (sortField = value)}
		onFilterChange={(key, value) => {
			if (key === 'type') {
				browse = value as Browse;
				sortField = defaultSort(value as Browse);
				selection.clear();
			}
			if (key === 'file') fileFilter = value as FileFilter;
			if (key === 'monitor') monitorFilter = value as MonitorFilter;
		}}
		onClearFilters={clearFilters}
	/>
</div>

{#if songSearch}
	<TrackSearchModal
		open={songSearch !== null}
		track={songSearch.track}
		albumId={songSearch.albumId}
		albumTitle={songSearch.albumTitle}
		onClose={() => (songSearch = null)}
	/>
{/if}

<MusicAddModal
	open={addOpen}
	onClose={() => (addOpen = false)}
	libraryId={data.library?.id ?? null}
	defaultProfileName={data.defaultProfileName}
/>

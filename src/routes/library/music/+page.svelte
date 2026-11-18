<script lang="ts">
	import type { PageData } from './$types.js';
	import { replaceState } from '$app/navigation';
	import {
		Disc3,
		Eye,
		EyeOff,
		LayoutGrid,
		List,
		LoaderCircle,
		Plus,
		Search,
		SlidersHorizontal,
		X
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AlbumCard from '#lib/components/music/AlbumCard.svelte';
	import ArtistCard from '#lib/components/music/ArtistCard.svelte';
	import MusicAddModal from '#lib/components/music/MusicAddModal.svelte';
	import type { AlbumCardData, ArtistCardData } from '#lib/components/music/music-card.js';
	import { formatRuntime } from '#lib/components/music/music-card.js';

	let { data }: { data: PageData } = $props();

	type Tab = 'artists' | 'albums';
	type FileFilter = 'all' | 'downloaded' | 'missing';
	type MonitorFilter = 'all' | 'monitored' | 'unmonitored';
	type Sort = 'artist-asc' | 'title-asc' | 'year-desc' | 'year-asc' | 'tracks-desc';

	const initial = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);

	let tab = $state<Tab>(initial.get('tab') === 'albums' ? 'albums' : 'artists');
	let query = $state(initial.get('q') ?? '');
	let sort = $state<Sort>((initial.get('sort') as Sort) ?? 'artist-asc');
	let fileFilter = $state<FileFilter>((initial.get('file') as FileFilter) ?? 'all');
	let monitorFilter = $state<MonitorFilter>((initial.get('monitor') as MonitorFilter) ?? 'all');
	let view = $state<'grid' | 'list'>(initial.get('view') === 'list' ? 'list' : 'grid');
	let addOpen = $state(false);
	let filtersOpen = $state(false);

	const sortOptions: Array<{ value: Sort; label: string }> = [
		{ value: 'artist-asc', label: m.music_sortArtistAsc() },
		{ value: 'title-asc', label: m.music_sortTitleAsc() },
		{ value: 'year-desc', label: m.music_sortYearDesc() },
		{ value: 'year-asc', label: m.music_sortYearAsc() },
		{ value: 'tracks-desc', label: m.music_sortTracksDesc() }
	];

	const needles = $derived(
		query
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

	const filteredAlbums = $derived.by(() => {
		const rows = data.albums.filter((album) => {
			if (!matches(`${album.title} ${album.artistName}`)) return false;
			if (fileFilter === 'downloaded' && !album.hasFile) return false;
			if (fileFilter === 'missing' && album.hasFile) return false;
			if (monitorFilter === 'monitored' && !album.monitored) return false;
			if (monitorFilter === 'unmonitored' && album.monitored) return false;
			return true;
		});

		return [...rows].sort((a, b) => {
			switch (sort) {
				case 'title-asc':
					return a.title.localeCompare(b.title);
				case 'year-desc':
					return (b.year ?? 0) - (a.year ?? 0);
				case 'year-asc':
					return (a.year ?? 9999) - (b.year ?? 9999);
				case 'tracks-desc':
					return (b.trackCount ?? 0) - (a.trackCount ?? 0);
				default:
					return a.artistName.localeCompare(b.artistName) || (a.year ?? 0) - (b.year ?? 0);
			}
		});
	});

	const filteredArtists = $derived.by(() =>
		data.artists
			.filter((artist) => {
				if (!matches(artist.name)) return false;
				if (fileFilter === 'downloaded' && artist.inLibraryCount === 0) return false;
				if (fileFilter === 'missing' && artist.inLibraryCount === artist.albumCount) return false;
				if (monitorFilter === 'monitored' && !artist.monitored) return false;
				if (monitorFilter === 'unmonitored' && artist.monitored) return false;
				return true;
			})
			.sort((a, b) => a.name.localeCompare(b.name))
	);

	const activeFilterCount = $derived(
		(fileFilter === 'all' ? 0 : 1) + (monitorFilter === 'all' ? 0 : 1)
	);

	const totalShown = $derived(tab === 'artists' ? filteredArtists.length : filteredAlbums.length);

	// Keep the view in the URL so a reload and the detail page's back link land on
	// the same slice. `replaceState`, not `goto`: filtering is not navigation.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const params = new URLSearchParams();
		if (tab !== 'artists') params.set('tab', tab);
		if (query.trim()) params.set('q', query.trim());
		if (sort !== 'artist-asc') params.set('sort', sort);
		if (fileFilter !== 'all') params.set('file', fileFilter);
		if (monitorFilter !== 'all') params.set('monitor', monitorFilter);
		if (view !== 'grid') params.set('view', view);
		const next = params.toString();
		const current = window.location.search.replace(/^\?/, '');
		if (next !== current) replaceState(`/library/music${next ? `?${next}` : ''}`, {});
	});

	function clearFilters() {
		fileFilter = 'all';
		monitorFilter = 'all';
	}

	function coverUrl(album: AlbumCardData): string | null {
		return album.hasCover ? `/api/music/albums/${album.id}/cover` : null;
	}

	function artistCover(artist: ArtistCardData): string | null {
		return artist.coverAlbumId ? `/api/music/albums/${artist.coverAlbumId}/cover` : null;
	}
</script>

<svelte:head><title>{m.nav_music()} · Cinephage</title></svelte:head>

<div class="min-h-screen bg-base-100 pb-20">
	<!-- Sticky toolbar: the movie and TV libraries' header, same shape. -->
	<div
		class="sticky top-16 z-30 -mx-4 border-b border-base-200 bg-base-100/80 backdrop-blur-md lg:top-0 lg:mx-0"
	>
		<div class="flex h-16 items-center gap-3 px-4 lg:px-8">
			<div class="flex min-w-0 items-center gap-2 sm:gap-3">
				<h1
					class="min-w-0 bg-linear-to-r from-primary to-secondary bg-clip-text text-xl font-bold text-transparent sm:text-2xl"
				>
					{data.library?.name ?? m.nav_music()}
				</h1>
				<span class="badge badge-ghost badge-sm sm:badge-lg">{data.counts.albums}</span>
				{#if data.library && data.library.rootFolderCount === 0}
					<span class="hidden text-xs text-warning sm:inline">{m.music_noRootFolder()}</span>
				{/if}
			</div>

			<div class="hidden flex-1 items-center justify-center gap-2 md:flex">
				<div class="group relative w-full max-w-md">
					<Search
						class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-base-content/40 transition-colors group-focus-within:text-primary"
					/>
					<input
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						placeholder={m.music_searchLibraryPlaceholder()}
						bind:value={query}
						aria-label={m.music_searchLibraryPlaceholder()}
					/>
					{#if query}
						<button
							class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
							onclick={() => (query = '')}
							aria-label={m.library_movies_clearSearch()}
						>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
			</div>

			<div class="ml-auto flex shrink-0 items-center gap-1.5">
				<button class="btn gap-1.5 btn-primary btn-xs sm:btn-sm" onclick={() => (addOpen = true)}>
					<Plus class="h-4 w-4" />
					<span class="hidden sm:inline">{m.music_addMusic()}</span>
				</button>

				<div class="join hidden sm:inline-flex">
					<button
						class="btn join-item btn-xs sm:btn-sm"
						class:btn-active={view === 'grid'}
						onclick={() => (view = 'grid')}
						title={m.library_movies_grid()}
						aria-label={m.library_movies_grid()}
					>
						<LayoutGrid class="h-4 w-4" />
					</button>
					<button
						class="btn join-item btn-xs sm:btn-sm"
						class:btn-active={view === 'list'}
						onclick={() => (view = 'list')}
						title={m.library_movies_list()}
						aria-label={m.library_movies_list()}
					>
						<List class="h-4 w-4" />
					</button>
				</div>

				<select class="select w-40 select-sm hidden lg:block" bind:value={sort} aria-label={m.music_sortTitleAsc()}>
					{#each sortOptions as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>

				<button
					class="btn gap-1.5 btn-xs sm:btn-sm {activeFilterCount > 0 ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => (filtersOpen = !filtersOpen)}
					aria-expanded={filtersOpen}
				>
					<SlidersHorizontal class="h-4 w-4" />
					{#if activeFilterCount > 0}
						<span class="badge badge-sm">{activeFilterCount}</span>
					{:else}
						<span class="hidden sm:inline">{m.music_filters()}</span>
					{/if}
				</button>
			</div>
		</div>

		{#if filtersOpen}
			<div class="border-t border-base-200 bg-base-100/95 px-4 py-3 lg:px-8">
				<div class="flex flex-wrap items-end gap-6">
					<div>
						<p class="mb-1.5 text-xs font-medium text-base-content/50">{m.music_filterFile()}</p>
						<div class="join">
							{#each [{ value: 'all', label: m.common_all() }, { value: 'downloaded', label: m.common_downloaded() }, { value: 'missing', label: m.common_missing() }] as option (option.value)}
								<button
									class="btn join-item btn-xs"
									class:btn-active={fileFilter === option.value}
									onclick={() => (fileFilter = option.value as FileFilter)}
								>
									{option.label}
								</button>
							{/each}
						</div>
					</div>
					<div>
						<p class="mb-1.5 text-xs font-medium text-base-content/50">{m.music_filterMonitoring()}</p>
						<div class="join">
							{#each [{ value: 'all', label: m.common_all() }, { value: 'monitored', label: m.common_monitored() }, { value: 'unmonitored', label: m.common_unmonitored() }] as option (option.value)}
								<button
									class="btn join-item btn-xs"
									class:btn-active={monitorFilter === option.value}
									onclick={() => (monitorFilter = option.value as MonitorFilter)}
								>
									{option.label}
								</button>
							{/each}
						</div>
					</div>
					{#if activeFilterCount > 0}
						<button class="btn btn-ghost btn-xs" onclick={clearFilters}>
							{m.library_movies_clearFilters()}
						</button>
					{/if}
					<div class="ml-auto lg:hidden">
						<select class="select w-40 select-xs" bind:value={sort} aria-label={m.music_sortTitleAsc()}>
							{#each sortOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<div class="px-4 pt-4 lg:px-8">
		<!-- Mobile search: the header field is hidden below md. -->
		<div class="mb-3 md:hidden">
			<label class="input w-full">
				<Search class="h-4 w-4 opacity-40" />
				<input
					class="grow"
					placeholder={m.music_searchLibraryPlaceholder()}
					bind:value={query}
					aria-label={m.music_searchLibraryPlaceholder()}
				/>
			</label>
		</div>

		<div class="mb-4 flex flex-wrap items-center gap-2">
			<div class="tabs tabs-box tabs-sm w-fit">
				<button class="tab gap-1.5" class:tab-active={tab === 'artists'} onclick={() => (tab = 'artists')}>
					{m.music_tabArtists()}
					<span class="badge badge-sm badge-ghost">{data.counts.artists}</span>
				</button>
				<button class="tab gap-1.5" class:tab-active={tab === 'albums'} onclick={() => (tab = 'albums')}>
					{m.music_tabAlbums()}
					<span class="badge badge-sm badge-ghost">{data.counts.albums}</span>
				</button>
			</div>

			<div class="ml-auto flex flex-wrap items-center gap-3 text-xs text-base-content/50">
				<span>{m.music_showingCount({ shown: totalShown })}</span>
				{#if data.counts.missing > 0}
					<span class="flex items-center gap-1 text-warning">
						<LoaderCircle class="h-3 w-3" />
						{m.music_missingCount({ count: data.counts.missing })}
					</span>
				{/if}
				{#if data.counts.monitored > 0}
					<span class="flex items-center gap-1 text-success">
						<Eye class="h-3 w-3" />
						{m.music_monitoredCount({ count: data.counts.monitored })}
					</span>
				{/if}
			</div>
		</div>

		{#if data.albums.length === 0}
			<div class="rounded-xl border border-dashed border-base-content/15 px-6 py-16 text-center">
				<Disc3 class="mx-auto mb-3 h-10 w-10 text-base-content/25" />
				<p class="font-semibold">{m.music_emptyTitle()}</p>
				<p class="mx-auto mt-1 max-w-sm text-sm text-base-content/55">{m.music_emptyHint()}</p>
				<button class="btn mt-4 gap-1.5 btn-primary btn-sm" onclick={() => (addOpen = true)}>
					<Plus class="h-4 w-4" />
					{m.music_addMusic()}
				</button>
			</div>
		{:else if totalShown === 0}
			<div class="rounded-xl border border-dashed border-base-content/15 px-6 py-14 text-center">
				<Search class="mx-auto mb-3 h-8 w-8 text-base-content/25" />
				<p class="font-medium">{m.music_noFilterMatch()}</p>
				<p class="mt-1 text-sm text-base-content/55">{m.music_tryDifferentFilter()}</p>
				<button
					class="btn mt-3 btn-ghost btn-sm"
					onclick={() => {
						query = '';
						clearFilters();
					}}
				>
					{m.library_movies_clearFilters()}
				</button>
			</div>
		{:else if view === 'grid' && tab === 'artists'}
			<ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
				{#each filteredArtists as artist (artist.id)}
					<li>
						<ArtistCard
							{artist}
							href={`/library/music/artist/${artist.id}`}
							coverUrl={artistCover(artist)}
							showMonitor
						/>
					</li>
				{/each}
			</ul>
		{:else if view === 'grid'}
			<ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
				{#each filteredAlbums as album (album.id)}
					<li>
						<AlbumCard {album} href={`/library/music/${album.id}`} coverUrl={coverUrl(album)} showMonitor />
					</li>
				{/each}
			</ul>
		{:else}
			<div class="overflow-hidden rounded-xl border border-base-content/10">
				<table class="table table-sm">
					<thead>
						<tr class="border-base-content/10 bg-base-200/50">
							<th class="w-10"></th>
							<th>{m.common_title()}</th>
							<th class="hidden sm:table-cell">{m.music_tabArtists()}</th>
							<th class="hidden w-16 text-right sm:table-cell">{m.common_year()}</th>
							<th class="hidden w-16 text-right md:table-cell">{m.music_tracksLabel()}</th>
							<th class="hidden w-20 text-right lg:table-cell">{m.music_durationLabel()}</th>
							<th class="w-28">{m.common_status()}</th>
						</tr>
					</thead>
					<tbody>
						{#if tab === 'artists'}
							{#each filteredArtists as artist (artist.id)}
								<tr class="border-base-content/5 hover:bg-base-200/50">
									<td>
										<a href={`/library/music/artist/${artist.id}`} class="block h-9 w-9 overflow-hidden rounded bg-base-300">
											{#if artistCover(artist)}
												<img src={artistCover(artist)} alt="" class="h-full w-full object-cover" />
											{:else}
												<div class="flex h-full w-full items-center justify-center text-xs font-bold text-base-content/40">
													{artist.name.charAt(0)}
												</div>
											{/if}
										</a>
									</td>
									<td class="max-w-0 truncate font-medium">
										<a href={`/library/music/artist/${artist.id}`} class="hover:text-primary">{artist.name}</a>
									</td>
									<td class="hidden sm:table-cell">{m.music_albumsCount({ count: artist.albumCount })}</td>
									<td class="hidden text-right text-base-content/40 sm:table-cell">–</td>
									<td class="hidden text-right md:table-cell">{artist.inLibraryCount}</td>
									<td class="hidden text-right lg:table-cell">–</td>
									<td>
										{#if artist.monitored}
											<span class="badge gap-1 badge-sm border-none bg-success/15 text-success">
												<Eye class="h-3 w-3" />{m.common_monitored()}
											</span>
										{:else}
											<span class="badge gap-1 badge-sm border-none bg-base-content/10 text-base-content/50">
												<EyeOff class="h-3 w-3" />{m.common_unmonitored()}
											</span>
										{/if}
									</td>
								</tr>
							{/each}
						{:else}
							{#each filteredAlbums as album (album.id)}
								<tr class="border-base-content/5 hover:bg-base-200/50">
									<td>
										<a href={`/library/music/${album.id}`} class="block h-9 w-9 overflow-hidden rounded bg-base-300">
											{#if coverUrl(album)}
												<img src={coverUrl(album)} alt="" class="h-full w-full object-cover" />
											{:else}
												<Disc3 class="m-2 h-5 w-5 text-base-content/30" />
											{/if}
										</a>
									</td>
									<td class="max-w-0 truncate font-medium">
										<a href={`/library/music/${album.id}`} class="hover:text-primary">{album.title}</a>
									</td>
									<td class="hidden max-w-0 truncate text-base-content/60 sm:table-cell">{album.artistName}</td>
									<td class="hidden text-right text-base-content/50 sm:table-cell">{album.year ?? '–'}</td>
									<td class="hidden text-right md:table-cell">{album.trackCount ?? '–'}</td>
									<td class="hidden text-right lg:table-cell">{formatRuntime(album.duration) ?? '–'}</td>
									<td>
										{#if album.hasFile}
											<span class="badge badge-sm border-none bg-success/15 text-success">{m.common_downloaded()}</span>
										{:else}
											<span class="badge badge-sm border-none bg-warning/15 text-warning">{m.common_missing()}</span>
										{/if}
									</td>
								</tr>
							{/each}
						{/if}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>

<MusicAddModal open={addOpen} onClose={() => (addOpen = false)} libraryId={data.library?.id ?? null} />

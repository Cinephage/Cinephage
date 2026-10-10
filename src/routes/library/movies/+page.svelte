<script lang="ts">
	import { page } from '$app/state';
	import { goto, beforeNavigate, afterNavigate, refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { resolvePath } from '#lib/utils/routing.js';
	import { SvelteSet } from 'svelte/reactivity';
	import LibraryMediaCard from '#lib/components/library/LibraryMediaCard.svelte';
	import LibraryMediaTable from '#lib/components/library/LibraryMediaTable.svelte';
	import LibraryDrawer from '#lib/components/library/LibraryDrawer.svelte';
	import LibraryBulkActionBar from '#lib/components/library/LibraryBulkActionBar.svelte';
	import BulkQualityProfileModal from '#lib/components/library/BulkQualityProfileModal.svelte';
	import BulkLanguageProfileModal from '#lib/components/library/BulkLanguageProfileModal.svelte';
	import BulkDeleteModal from '#lib/components/library/BulkDeleteModal.svelte';
	import DeleteConfirmationModal from '#lib/components/ui/modal/DeleteConfirmationModal.svelte';
	import { MediaSearchModal } from '#lib/components/search/index.js';
	import {
		Clapperboard,
		X,
		LayoutGrid,
		List,
		Search,
		SlidersHorizontal,
		CheckSquare,
		XSquare,
		Layers,
		Eye,
		EyeOff,
		ChevronDown,
		HardDrive,
		Captions,
		Loader2
	} from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { viewPreferences } from '#lib/stores/view-preferences.svelte.js';
	import { enhance } from '$app/forms';
	import {
		batchMovies,
		batchDeleteMovieFiles,
		updateMovie,
		deleteMovie
	} from '#lib/api/library.js';
	import { ApiError } from '#lib/api/client.js';
	import { createSearchProgress } from '#lib/stores/searchProgress.svelte.js';
	import { createSubtitleProgress } from '#lib/stores/subtitleProgress.svelte.js';
	import { getPrimaryAutoSearchIssue } from '#lib/utils/autoSearchIssues.js';
	import { createProgressiveRenderer } from '#lib/utils/progressive-render.svelte.js';
	import * as m from '#lib/paraglide/messages.js';

	let { data } = $props();

	// Viewer accounts browse a read-only library; admin controls stay hidden.
	const isAdminUser = $derived(data.user?.role === 'admin');

	function clearInsightScope() {
		const url = new URL(page.url.href);
		url.searchParams.delete('insightId');
		goto(url.pathname + url.search, { reset: false });
	}

	const SCROLL_KEY = 'cinephage:library:movies:scrollY';

	beforeNavigate(({ to, shallow, type }) => {
		if (shallow && type === 'goto') return;

		try {
			if (to?.url.pathname.startsWith('/library/movie/')) {
				localStorage.setItem(SCROLL_KEY, String(window.scrollY));
			} else {
				localStorage.removeItem(SCROLL_KEY);
			}
		} catch {
			// storage unavailable (blocked cookies / ETP)
		}
	});

	afterNavigate(({ from, shallow, type }) => {
		if (shallow && type === 'goto') return;

		try {
			if (from?.url.pathname.startsWith('/library/movie/')) {
				const saved = localStorage.getItem(SCROLL_KEY);
				if (saved) {
					requestAnimationFrame(() =>
						window.scrollTo({ top: parseInt(saved), behavior: 'instant' })
					);
					localStorage.removeItem(SCROLL_KEY);
				}
			}
		} catch {
			// storage unavailable (blocked cookies / ETP)
		}
	});

	// Selection state
	let selectedMovies = new SvelteSet<string>();
	let showCheckboxes = $state(false);
	let searchQuery = $state(page.url.searchParams.get('q') ?? '');

	// Keep the title search in the URL so refresh/back-navigation restores it and
	// the returnTo parameter carries it into the detail page. replaceState avoids a navigation per keystroke.
	$effect(() => {
		const query = searchQuery.trim();
		const url = new URL(window.location.href);
		if (query) url.searchParams.set('q', query);
		else url.searchParams.delete('q');
		history.replaceState(history.state, '', url.pathname + url.search);
	});

	let collapsedGroups = new SvelteSet<string>();
	let drawerOpen = $state(false);
	let collectionSubtitleAutoSearching = new SvelteSet<number>();

	const subtitleProgress = createSubtitleProgress();

	function groupMoviesByCollection(moviesList: typeof data.movies) {
		const groups: Record<string, typeof data.movies> = {};
		for (const movie of moviesList) {
			const key = movie.collectionName ?? '__none__';
			if (!groups[key]) {
				groups[key] = [];
			}
			groups[key].push(movie);
		}
		const result: {
			name: string | null;
			collectionId: number | null;
			movies: typeof data.movies;
		}[] = [];
		for (const [key, groupMovies] of Object.entries(groups)) {
			const firstWithId = groupMovies.find((m) => m.tmdbCollectionId != null);
			result.push({
				name: key === '__none__' ? null : key,
				collectionId: firstWithId?.tmdbCollectionId ?? null,
				movies: groupMovies
			});
		}
		result.sort((a, b) => {
			if (!a.name) return 1;
			if (!b.name) return -1;
			return a.name.localeCompare(b.name);
		});
		return result;
	}

	function toggleCollectionGroup(key: string) {
		if (collapsedGroups.has(key)) {
			collapsedGroups.delete(key);
		} else {
			collapsedGroups.add(key);
		}
	}

	const filteredMovies = $derived(
		searchQuery.trim()
			? data.movies.filter((mv) =>
					mv.title.toLowerCase().includes(searchQuery.trim().toLowerCase())
				)
			: data.movies
	);

	// Progressive rendering: only render a screenful + buffer at a time
	const renderer = createProgressiveRenderer(() => filteredMovies);
	let bulkLoading = $state(false);
	let currentBulkAction = $state<'monitor' | 'unmonitor' | 'quality' | 'delete' | null>(null);
	let isQualityModalOpen = $state(false);
	let isDeleteModalOpen = $state(false);
	let pendingDeleteMovieId = $state<string | null>(null);
	let isSearchModalOpen = $state(false);
	let selectedMovieForSearch = $state<(typeof data.movies)[number] | null>(null);
	let autoSearchingIds = new SvelteSet<string>();
	const searchProgress = createSearchProgress();

	const selectedCount = $derived(selectedMovies.size);

	function toggleSelectionMode() {
		showCheckboxes = !showCheckboxes;
		if (!showCheckboxes) {
			selectedMovies.clear();
		}
	}

	function handleItemSelectChange(id: string, selected: boolean) {
		if (selected) {
			selectedMovies.add(id);
		} else {
			selectedMovies.delete(id);
		}
	}

	function selectAll() {
		for (const movie of filteredMovies) {
			selectedMovies.add(movie.id);
		}
	}

	function clearSelection() {
		selectedMovies.clear();
	}

	const allSelected = $derived(
		showCheckboxes && selectedMovies.size > 0 && selectedMovies.size === filteredMovies.length
	);

	function handleSelectToggle() {
		if (!showCheckboxes) {
			showCheckboxes = true;
		} else if (!allSelected) {
			selectAll();
		} else {
			showCheckboxes = false;
			selectedMovies.clear();
		}
	}

	async function handleBulkMonitor(monitored: boolean) {
		bulkLoading = true;
		currentBulkAction = monitored ? 'monitor' : 'unmonitor';
		try {
			const result = await batchMovies([...selectedMovies], { monitored });
			if (result.success) {
				data = {
					...data,
					movies: data.movies.map((movie) =>
						selectedMovies.has(movie.id) ? { ...movie, monitored } : movie
					)
				};
				toasts.success(
					monitored
						? m.toast_library_movies_monitoringCount({ count: result.updatedCount })
						: m.toast_library_movies_unmonitoredCount({ count: result.updatedCount })
				);
			} else {
				toasts.error(result.error || m.toast_library_movies_failedToUpdate());
			}
		} catch (error) {
			toasts.error(
				error instanceof ApiError ? error.message : m.toast_library_movies_failedToUpdate()
			);
		} finally {
			bulkLoading = false;
			currentBulkAction = null;
		}
	}

	async function handleBulkQualityChange(profileId: string | null) {
		bulkLoading = true;
		currentBulkAction = 'quality';
		try {
			const result = await batchMovies([...selectedMovies], { scoringProfileId: profileId });
			if (result.success) {
				data = {
					...data,
					movies: data.movies.map((movie) =>
						selectedMovies.has(movie.id) ? { ...movie, scoringProfileId: profileId } : movie
					)
				};
				toasts.success(m.toast_library_movies_qualityUpdatedCount({ count: result.updatedCount }));
			} else {
				toasts.error(result.error || m.toast_library_movies_failedToUpdate());
			}
		} catch (error) {
			toasts.error(
				error instanceof ApiError ? error.message : m.toast_library_movies_failedToUpdate()
			);
		} finally {
			bulkLoading = false;
			currentBulkAction = null;
		}
	}

	let isLanguageModalOpen = $state(false);

	async function handleBulkLanguageApplied(updated: number) {
		selectedMovies.clear();
		toasts.success(m.toast_library_movies_qualityUpdatedCount({ count: updated }));
		await refreshAll();
	}

	async function handleBulkDelete(deleteFiles: boolean, removeFromLibrary: boolean) {
		bulkLoading = true;
		currentBulkAction = 'delete';
		try {
			const result = await batchDeleteMovieFiles(
				[...selectedMovies],
				deleteFiles,
				removeFromLibrary
			);
			if (result.success || result.deletedCount > 0 || result.removedCount > 0) {
				if (removeFromLibrary && result.removedCount > 0) {
					const updatedMovies = data.movies.filter((movie) => !selectedMovies.has(movie.id));
					data = { ...data, movies: updatedMovies };
					toasts.success(m.toast_library_movies_removedCount({ count: result.removedCount }));
				} else {
					const updatedMovies = data.movies.map((movie) =>
						selectedMovies.has(movie.id) ? { ...movie, hasFile: false, files: [] } : movie
					);
					data = { ...data, movies: updatedMovies };
					toasts.success(m.toast_library_movies_deletedFilesCount({ count: result.deletedCount }));
				}
				selectedMovies.clear();
				showCheckboxes = false;
				isDeleteModalOpen = false;
			} else {
				toasts.error(result.error || m.toast_library_movies_failedToDelete());
			}
		} catch (error) {
			toasts.error(
				error instanceof ApiError ? error.message : m.toast_library_movies_failedToDelete()
			);
		} finally {
			bulkLoading = false;
			currentBulkAction = null;
		}
	}

	// Table action handlers
	async function handleMonitorToggle(movieId: string, monitored: boolean) {
		const movie = data.movies.find((mv) => mv.id === movieId);
		if (!movie) return;

		try {
			const result = await updateMovie(movieId, { monitored });
			if (result.success) {
				data = {
					...data,
					movies: data.movies.map((mv) => (mv.id === movieId ? { ...mv, monitored } : mv))
				};
				toasts.success(
					m.toast_library_movies_monitorToggle({
						title: movie.title,
						status: monitored ? m.common_monitored() : m.common_unmonitored()
					})
				);
			} else {
				toasts.error(result.error || m.toast_library_movies_failedToUpdateSingle());
			}
		} catch {
			toasts.error(m.toast_library_movies_failedToUpdateMovie());
		}
	}

	async function handleDeleteMovie(movieId: string) {
		pendingDeleteMovieId = movieId;
		isDeleteModalOpen = true;
	}

	async function handleAutoGrab(movieId: string) {
		const movie = data.movies.find((mv) => mv.id === movieId);
		if (!movie || autoSearchingIds.has(movieId)) return;

		autoSearchingIds.add(movieId);

		try {
			await searchProgress.startSearch(`/api/library/movies/${movieId}/auto-search`);

			if (searchProgress.results) {
				const issue = getPrimaryAutoSearchIssue(searchProgress.results);
				if (searchProgress.results.grabbed) {
					toasts.success(
						m.toast_library_movies_autoGrabbed({
							release: searchProgress.results.releaseName ?? '',
							title: movie.title
						})
					);
				} else if (issue) {
					toasts.error(issue.message, { description: issue.description });
				} else if (searchProgress.results.found) {
					toasts.info(m.toast_library_movies_foundNoMatch({ title: movie.title }));
				} else {
					toasts.info(m.toast_library_movies_noReleases({ title: movie.title }));
				}
			}
		} catch (error) {
			toasts.error(
				error instanceof Error
					? error.message
					: m.toast_library_movies_failedAutoGrab({ title: movie.title })
			);
		} finally {
			autoSearchingIds.delete(movieId);
			searchProgress.reset();
		}
	}

	async function handleCollectionSubtitleAutoSearch(
		collectionId: number,
		_collectionName: string
	): Promise<void> {
		if (collectionSubtitleAutoSearching.has(collectionId)) return;
		collectionSubtitleAutoSearching.add(collectionId);

		try {
			const results = await subtitleProgress.startBatch({
				type: 'collection',
				collectionId
			});

			if (results.downloaded > 0) {
				toasts.success(
					m.toast_library_tvDetail_downloadedSubtitles({ count: String(results.downloaded) })
				);
			} else {
				toasts.info(m.toast_library_tvDetail_noSubtitlesFound());
			}
		} catch (error) {
			toasts.error(
				error instanceof Error ? error.message : 'Failed to auto-search collection subtitles'
			);
		} finally {
			collectionSubtitleAutoSearching.delete(collectionId);
			subtitleProgress.reset();
		}
	}

	function handleManualGrab(movieId: string) {
		const movie = data.movies.find((mv) => mv.id === movieId);
		if (!movie) return;
		selectedMovieForSearch = movie;
		isSearchModalOpen = true;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && showCheckboxes) {
			toggleSelectionMode();
		}
	}

	async function handleDeleteConfirm(deleteFiles: boolean, removeFromLibrary: boolean) {
		if (pendingDeleteMovieId) {
			// Single item delete from list view
			const movieId = pendingDeleteMovieId;
			const movie = data.movies.find((mv) => mv.id === movieId);
			if (!movie) return;

			bulkLoading = true;
			currentBulkAction = 'delete';
			try {
				const result = await deleteMovie(movieId, deleteFiles, removeFromLibrary);
				if (result.success) {
					if (removeFromLibrary) {
						data = { ...data, movies: data.movies.filter((m2) => m2.id !== movieId) };
						toasts.success(m.toast_library_movies_removedFromLibrary({ title: movie.title }));
					} else {
						data = {
							...data,
							movies: data.movies.map((m2) =>
								m2.id === movieId ? { ...m2, hasFile: false, files: [] } : m2
							)
						};
						toasts.success(m.toast_library_movies_filesDeleted({ title: movie.title }));
					}
					isDeleteModalOpen = false;
					pendingDeleteMovieId = null;
				} else {
					toasts.error(result.error || m.toast_library_movies_failedToDelete());
				}
			} catch {
				toasts.error(m.toast_library_movies_failedToUpdateMovie());
			} finally {
				bulkLoading = false;
				currentBulkAction = null;
			}
		} else {
			// Bulk delete
			await handleBulkDelete(deleteFiles, removeFromLibrary);
		}
	}

	const sortOptions = [
		{ value: 'title-asc', label: m.library_movies_sortTitleAsc() },
		{ value: 'title-desc', label: m.library_movies_sortTitleDesc() },
		{ value: 'added-desc', label: m.library_movies_sortAddedDesc() },
		{ value: 'added-asc', label: m.library_movies_sortAddedAsc() },
		{ value: 'year-desc', label: m.library_movies_sortYearDesc() },
		{ value: 'year-asc', label: m.library_movies_sortYearAsc() },
		{ value: 'size-desc', label: m.library_movies_sortSizeDesc() },
		{ value: 'size-asc', label: m.library_movies_sortSizeAsc() },
		{ value: 'collection-asc', label: m.library_movies_sortCollectionAsc() },
		{ value: 'collection-desc', label: m.library_movies_sortCollectionDesc() }
	];

	const defaultLibrarySlug = $derived.by(
		() => data.libraryScope?.options?.find((library) => library.isDefault)?.slug ?? ''
	);
	const showLibraryFilter = $derived.by(
		() => Boolean(data.libraryScope?.hasSubLibraries) && !data.libraryScope?.isSubLibraryScope
	);

	const filterOptions = $derived([
		...(showLibraryFilter
			? [
					{
						key: 'library',
						label: m.library_movies_filterLibrary(),
						options: (data.libraryScope?.options ?? []).map((library) => ({
							value: library.slug,
							label: library.name
						}))
					}
				]
			: []),
		{
			key: 'monitored',
			label: m.library_movies_filterMonitored(),
			options: [
				{ value: 'all', label: m.library_movies_filterAll() },
				{ value: 'monitored', label: m.library_movies_filterMonitoredOnly() },
				{ value: 'unmonitored', label: m.library_movies_filterNotMonitored() }
			]
		},
		{
			key: 'fileStatus',
			label: m.library_movies_filterFileStatus(),
			options: [
				{ value: 'all', label: m.library_movies_filterAll() },
				{ value: 'hasFile', label: m.library_movies_filterHasFile() },
				{ value: 'missingFile', label: m.library_movies_filterMissingFile() }
			]
		},
		{
			key: 'qualityProfile',
			label: m.library_movies_filterQualityProfile(),
			options: [
				{ value: 'all', label: m.library_movies_filterAll() },
				...data.qualityProfiles.map((p) => ({
					value: p.id,
					label: p.isDefault ? m.library_movies_profileDefault({ name: p.name }) : p.name
				}))
			]
		},
		...(data.uniqueResolutions.length > 0
			? [
					{
						key: 'resolution',
						label: m.library_movies_filterResolution(),
						options: [
							{ value: 'all', label: m.library_movies_filterAll() },
							...data.uniqueResolutions.map((r) => ({ value: r, label: r }))
						]
					}
				]
			: []),
		...(data.uniqueCodecs.length > 0
			? [
					{
						key: 'videoCodec',
						label: m.library_movies_filterVideoCodec(),
						options: [
							{ value: 'all', label: m.library_movies_filterAll() },
							...data.uniqueCodecs.map((c) => ({ value: c, label: c }))
						]
					}
				]
			: []),
		...(data.uniqueHdrFormats.length > 0
			? [
					{
						key: 'hdrFormat',
						label: m.library_movies_filterHdr(),
						options: [
							{ value: 'all', label: m.library_movies_filterAll() },
							{ value: 'sdr', label: m.library_movies_filterSdr() },
							...data.uniqueHdrFormats.map((h) => ({ value: h, label: h }))
						]
					}
				]
			: [])
	]);

	function updateUrlParam(key: string, value: string) {
		const url = new URL(page.url.href);
		const query = searchQuery.trim();
		if (query) url.searchParams.set('q', query);
		else url.searchParams.delete('q');
		if (key === 'library') {
			if (!value || value === defaultLibrarySlug) {
				url.searchParams.delete(key);
			} else {
				url.searchParams.set(key, value);
			}
		} else if (value === 'all' || (key === 'sort' && value === 'title-asc')) {
			url.searchParams.delete(key);
		} else {
			url.searchParams.set(key, value);
		}
		goto(resolvePath(url.pathname + url.search), { reset: false });
	}

	function clearFilters() {
		searchQuery = '';
		const url = new URL(resolve('library/movies'), page.url.origin);
		if (data.libraryScope?.isSubLibraryScope && data.libraryScope?.selected?.slug) {
			url.searchParams.set('library', data.libraryScope.selected.slug);
		}
		url.searchParams.delete('q');
		goto(resolvePath(url.pathname + url.search), { reset: false });
	}

	function handleMonitorAll() {
		(document.getElementById('movies-monitor-all') as HTMLFormElement)?.requestSubmit();
	}

	function handleUnmonitorAll() {
		(document.getElementById('movies-unmonitor-all') as HTMLFormElement)?.requestSubmit();
	}

	const currentFilters = $derived({
		library: data.filters.library,
		monitored: data.filters.monitored,
		fileStatus: data.filters.fileStatus,
		qualityProfile: data.filters.qualityProfile,
		resolution: data.filters.resolution,
		videoCodec: data.filters.videoCodec,
		hdrFormat: data.filters.hdrFormat
	});
	const activeFilterCount = $derived(
		Object.entries(currentFilters).filter(([key, value]) => key !== 'library' && value !== 'all')
			.length
	);
	const downloadingMovieIdSet = $derived(new Set(data.downloadingMovieIds));
	const deleteModalCount = $derived(pendingDeleteMovieId ? 1 : selectedCount);
	const pendingDeleteMovie = $derived(
		pendingDeleteMovieId ? data.movies.find((mv) => mv.id === pendingDeleteMovieId) : null
	);
	const pendingDeleteMovieTitle = $derived(pendingDeleteMovie?.title ?? '');
	const pendingDeleteMovieHasFiles = $derived(pendingDeleteMovie?.hasFile ?? false);
	const pendingDeleteMovieHasActiveDownload = $derived(
		pendingDeleteMovieId ? downloadingMovieIdSet.has(pendingDeleteMovieId) : false
	);
	const bulkActiveDownloadCount = $derived(
		pendingDeleteMovieId
			? 0
			: [...selectedMovies].filter((movieId) => downloadingMovieIdSet.has(movieId)).length
	);
	const bulkHasActiveDownloads = $derived(bulkActiveDownloadCount > 0);
</script>

<svelte:head><title>{m.library_movies_pageTitle()}</title></svelte:head>
<svelte:window onkeydown={handleKeydown} />

<div class="min-h-screen bg-base-100 pb-20">
	<!-- Header -->
	<div
		class="sticky top-16 z-30 -mx-4 border-b border-base-200 bg-base-100/80 backdrop-blur-md lg:top-0 lg:mx-0"
	>
		<div class="flex h-16 items-center gap-3 px-4 lg:px-8">
			<!-- Left: Title -->
			<div class="flex min-w-0 items-center gap-2 sm:gap-3">
				<h1
					class="min-w-0 bg-linear-to-r from-primary to-secondary bg-clip-text text-xl font-bold text-transparent sm:text-2xl"
				>
					{m.library_movies_heading()}
				</h1>
				<span class="badge badge-ghost badge-sm sm:badge-lg">{data.total}</span>
				{#if data.total !== data.totalUnfiltered}
					<span class="hidden text-sm text-base-content/50 sm:inline">
						{m.library_movies_ofTotal({ total: data.totalUnfiltered })}
					</span>
				{/if}
			</div>

			<!-- Center: Search (desktop) -->
			<div class="hidden flex-1 items-center justify-center gap-2 md:flex">
				<div class="group relative w-full max-w-lg">
					<Search
						class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-base-content/40 transition-colors group-focus-within:text-primary"
					/>
					<input
						type="text"
						placeholder={m.library_movies_searchPlaceholder()}
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						bind:value={searchQuery}
					/>
					{#if searchQuery}
						<button
							class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
							onclick={() => (searchQuery = '')}
							aria-label={m.library_movies_clearSearch()}
						>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
				{#if searchQuery && filteredMovies.length !== data.movies.length}
					<span class="shrink-0 text-xs text-base-content/50">
						{filteredMovies.length}/{data.movies.length}
					</span>
				{/if}
			</div>

			<!-- Right: Quick Actions -->
			<div class="flex shrink-0 items-center gap-1.5">
				{#if data.uniqueCollections.length > 0}
					<button
						class="btn gap-1.5 btn-xs sm:btn-sm {viewPreferences.groupByCollection
							? 'btn-primary'
							: 'btn-ghost'}"
						onclick={() => viewPreferences.toggleGroupByCollection()}
						aria-pressed={viewPreferences.groupByCollection}
						aria-label={viewPreferences.groupByCollection ? 'Hide collections' : 'Show collections'}
						title={viewPreferences.groupByCollection ? 'Hide collections' : 'Show collections'}
					>
						{#if viewPreferences.groupByCollection}
							<Layers class="h-4 w-4" />
						{:else}
							<Layers class="h-4 w-4" />
						{/if}
						<span class="hidden xl:inline">Collections</span>
					</button>
				{/if}

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
								<button onclick={handleMonitorAll}>
									<Eye class="h-4 w-4" />
									{m.library_movies_monitorAll()}
								</button>
							</li>
							<li>
								<button onclick={handleUnmonitorAll}>
									<EyeOff class="h-4 w-4" />
									{m.library_movies_unmonitorAll()}
								</button>
							</li>
						</ul>
					{/if}
				</div>

				{#if isAdminUser}
					<button
						class="btn gap-1.5 btn-ghost btn-xs sm:btn-sm {showCheckboxes ? 'btn-primary' : ''}"
						onclick={handleSelectToggle}
					>
						{#if !showCheckboxes}
							<CheckSquare class="h-4 w-4" />
							<span class="hidden sm:inline">{m.library_movies_select()}</span>
						{:else if !allSelected}
							<CheckSquare class="h-4 w-4" />
							<span class="hidden sm:inline">{m.library_movies_selectAll()}</span>
						{:else}
							<XSquare class="h-4 w-4" />
							<span class="hidden sm:inline">{m.library_movies_done()}</span>
						{/if}
					</button>
				{/if}

				<!-- View Toggle -->
				<button
					class="btn btn-ghost btn-sm"
					onclick={() => viewPreferences.toggleViewMode()}
					aria-label={viewPreferences.viewMode === 'grid'
						? m.library_movies_switchToList()
						: m.library_movies_switchToGrid()}
				>
					{#if viewPreferences.viewMode === 'grid'}
						<List class="h-4 w-4" />
					{:else}
						<LayoutGrid class="h-4 w-4" />
					{/if}
				</button>

				<!-- Options Drawer Button -->
				<button
					class="btn gap-1.5 btn-sm {activeFilterCount > 0 ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => (drawerOpen = true)}
					aria-label={m.library_drawer_title()}
				>
					<SlidersHorizontal class="h-4 w-4" />
					{#if activeFilterCount > 0}
						<span class="badge badge-sm">{activeFilterCount}</span>
					{/if}
				</button>
			</div>
		</div>

		<!-- Search (mobile) -->
		<div class="flex items-center gap-2 border-t border-base-200/50 px-4 py-2 md:hidden">
			<div class="group relative w-full">
				<Search
					class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-base-content/40 transition-colors group-focus-within:text-primary"
				/>
				<input
					type="text"
					placeholder={m.library_movies_searchPlaceholder()}
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					bind:value={searchQuery}
				/>
				{#if searchQuery}
					<button
						class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
						onclick={() => (searchQuery = '')}
						aria-label={m.library_movies_clearSearch()}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
			{#if searchQuery && filteredMovies.length !== data.movies.length}
				<span class="shrink-0 text-xs text-base-content/50">
					{filteredMovies.length}/{data.movies.length}
				</span>
			{/if}
		</div>
	</div>

	<!-- Main Content -->
	<main class="w-full px-4 py-8 lg:px-8">
		{#if data.insightContext}
			<div
				class="mb-4 alert flex items-center justify-between gap-2 border border-info/20 bg-info/10 py-2 text-sm"
			>
				<span>
					{m.library_movies_insightScope({
						count: data.total,
						rawCount: data.insightContext.rawItemCount,
						title: data.insightContext.title
					})}
				</span>
				<button class="btn gap-1 btn-ghost btn-xs" onclick={clearInsightScope}>
					<X class="h-3 w-3" />
					{m.action_clear()}
				</button>
			</div>
		{/if}
		{#if data.error}
			<div role="alert" class="alert alert-error">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-6 w-6 shrink-0 stroke-current"
					fill="none"
					viewBox="0 0 24 24"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
					></path>
				</svg>
				<span>{data.error}</span>
			</div>
		{:else if filteredMovies.length === 0 && searchQuery}
			<!-- Search Empty State -->
			<div class="flex flex-col items-center justify-center py-20 text-center">
				<div class="opacity-50">
					<Search class="mx-auto mb-4 h-16 w-16" />
					<p class="text-2xl font-bold">{m.library_movies_noSearchMatch({ query: searchQuery })}</p>
					<p class="mt-2">{m.library_movies_tryDifferentSearch()}</p>
				</div>
				<div class="mt-6 flex gap-3">
					<button class="btn btn-ghost" onclick={() => (searchQuery = '')}
						>{m.library_movies_clearSearchBtn()}</button
					>

					<a
						href={resolvePath(`/discover?type=movie&q=${encodeURIComponent(searchQuery)}`)}
						class="btn btn-primary"
					>
						Search in Discover
					</a>
				</div>
			</div>
		{:else if data.movies.length === 0}
			<!-- Empty State -->
			<div class="flex flex-col items-center justify-center py-20 text-center opacity-50">
				<Clapperboard class="mb-4 h-20 w-20" />
				{#if data.totalUnfiltered === 0}
					<p class="text-2xl font-bold">{m.library_movies_emptyLibrary()}</p>
					<p class="mt-2">{m.library_movies_emptyLibraryHint()}</p>
					<a href={resolvePath('/discover?type=movie')} class="btn mt-6 btn-primary">
						{m.library_movies_discoverMovies()}
					</a>
				{:else}
					<p class="text-2xl font-bold">{m.library_movies_noFilterMatch()}</p>
					<p class="mt-2">{m.library_movies_noFilterMatchHint()}</p>
					<button class="btn mt-6 btn-primary" onclick={clearFilters}
						>{m.library_movies_clearFilters()}</button
					>
				{/if}
			</div>
		{:else}
			<!-- Movies Grid or List -->
			{#if !viewPreferences.isReady}
				<!-- Defer until client resolves view preference to avoid grid flash -->
			{:else}
				<div class="animate-in fade-in slide-in-from-bottom-4 duration-500">
					{#if data.uniqueCollections.length > 0 && viewPreferences.groupByCollection}
						{@const collectionGroups = groupMoviesByCollection(filteredMovies)}
						{#each collectionGroups as group (group.name ?? '__none__')}
							{@const fileCount = group.movies.filter((mv) => mv.hasFile).length}
							{@const monitoredCount = group.movies.filter((mv) => mv.monitored).length}
							<div class="mb-8">
								<div class="flex items-center">
									<button
										class="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-base-200/60"
										onclick={() => toggleCollectionGroup(group.name ?? '__none__')}
									>
										<svg
											class="h-4 w-4 shrink-0 transition-transform {collapsedGroups.has(
												group.name ?? '__none__'
											)
												? ''
												: 'rotate-90'}"
											viewBox="0 0 20 20"
											fill="currentColor"
										>
											<path
												fill-rule="evenodd"
												d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
												clip-rule="evenodd"
											></path>
										</svg>
										<div class="flex min-w-0 flex-1 items-center gap-2">
											<h3 class="min-w-0 truncate text-lg font-semibold">
												{group.name ?? m.library_movies_other()}
											</h3>
											<span class="badge shrink-0 badge-ghost badge-sm">
												{group.movies.length}
											</span>
										</div>
										<span
											class="flex shrink-0 items-center gap-3 text-xs text-base-content/50"
											aria-label={`${fileCount}/${group.movies.length} files, ${monitoredCount}/${group.movies.length} monitored`}
										>
											<span class="inline-flex items-center gap-1">
												<HardDrive class="h-3.5 w-3.5" />
												{fileCount}/{group.movies.length}
											</span>
											<span class="inline-flex items-center gap-1">
												<Eye class="h-3.5 w-3.5" />
												{monitoredCount}/{group.movies.length}
											</span>
										</span>
									</button>
									{#if isAdminUser && group.collectionId}
										<button
											class="btn shrink-0 btn-ghost btn-sm"
											onclick={() =>
												handleCollectionSubtitleAutoSearch(group.collectionId!, group.name ?? '')}
											disabled={collectionSubtitleAutoSearching.has(group.collectionId)}
											title="Auto-download subtitles for collection"
										>
											{#if collectionSubtitleAutoSearching.has(group.collectionId)}
												<Loader2 size={14} class="animate-spin" />
											{:else}
												<Captions size={14} />
											{/if}
										</button>
									{/if}
								</div>
								{#if !collapsedGroups.has(group.name ?? '__none__')}
									{#if viewPreferences.viewMode === 'grid'}
										<div
											class="grid grid-cols-3 gap-3 pt-2 sm:grid-cols-4 sm:gap-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9"
										>
											{#each group.movies as movie (movie.id)}
												<LibraryMediaCard
													item={movie}
													selectable={showCheckboxes}
													selected={selectedMovies.has(movie.id)}
													onSelectChange={handleItemSelectChange}
													collectionName={movie.collectionName ?? undefined}
													preferOriginalTitleDefault={data.preferOriginalTitleDefault}
												/>
											{/each}
										</div>
									{:else}
										<div class="pt-2">
											<LibraryMediaTable
												items={group.movies}
												mediaType="movie"
												selectedItems={selectedMovies}
												selectable={showCheckboxes}
												downloadingIds={downloadingMovieIdSet}
												{autoSearchingIds}
												onSelectChange={handleItemSelectChange}
												onMonitorToggle={isAdminUser ? handleMonitorToggle : undefined}
												onDelete={isAdminUser ? handleDeleteMovie : undefined}
												onAutoGrab={isAdminUser ? handleAutoGrab : undefined}
												onManualGrab={isAdminUser ? handleManualGrab : undefined}
												preferOriginalTitleDefault={data.preferOriginalTitleDefault}
											/>
										</div>
									{/if}
								{/if}
							</div>
						{/each}
					{:else}
						{#if viewPreferences.viewMode === 'grid'}
							<div
								class="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9"
							>
								{#each renderer.visible as movie (movie.id)}
									<LibraryMediaCard
										item={movie}
										selectable={showCheckboxes}
										selected={selectedMovies.has(movie.id)}
										onSelectChange={handleItemSelectChange}
										collectionName={movie.collectionName ?? undefined}
										preferOriginalTitleDefault={data.preferOriginalTitleDefault}
									/>
								{/each}
							</div>
						{:else}
							<LibraryMediaTable
								items={renderer.visible}
								mediaType="movie"
								selectedItems={selectedMovies}
								selectable={showCheckboxes}
								downloadingIds={downloadingMovieIdSet}
								{autoSearchingIds}
								onSelectChange={handleItemSelectChange}
								onMonitorToggle={isAdminUser ? handleMonitorToggle : undefined}
								onDelete={isAdminUser ? handleDeleteMovie : undefined}
								onAutoGrab={isAdminUser ? handleAutoGrab : undefined}
								onManualGrab={isAdminUser ? handleManualGrab : undefined}
								preferOriginalTitleDefault={data.preferOriginalTitleDefault}
							/>
						{/if}

						<!-- Progressive rendering sentinel -->
						{#if renderer.hasMore}
							<div bind:this={renderer.sentinel} class="flex justify-center py-8">
								<span class="loading loading-md loading-dots text-base-content/30"></span>
							</div>
						{/if}
					{/if}
				</div>
			{/if}
		{/if}
	</main>

	<!-- Hidden forms for monitor actions -->
	<form
		id="movies-monitor-all"
		action="?/toggleAllMonitored"
		method="POST"
		use:enhance
		class="hidden"
		aria-hidden="true"
	>
		<input type="hidden" name="monitored" value="true" />
		<input type="hidden" name="library" value={data.filters.library} />
	</form>
	<form
		id="movies-unmonitor-all"
		action="?/toggleAllMonitored"
		method="POST"
		use:enhance
		class="hidden"
		aria-hidden="true"
	>
		<input type="hidden" name="monitored" value="false" />
		<input type="hidden" name="library" value={data.filters.library} />
	</form>

	<LibraryDrawer
		isOpen={drawerOpen}
		onClose={() => (drawerOpen = false)}
		{sortOptions}
		{filterOptions}
		currentSort={data.filters.sort}
		{currentFilters}
		hiddenActiveFilterKeys={['library']}
		onSortChange={(sort) => updateUrlParam('sort', sort)}
		onFilterChange={(key, value) => updateUrlParam(key, value)}
		onClearFilters={clearFilters}
	/>
</div>

<!-- Bulk Action Bar (admin only) -->
{#if isAdminUser}
	<LibraryBulkActionBar
		{selectedCount}
		loading={bulkLoading}
		currentAction={currentBulkAction}
		mediaType="movie"
		onMonitor={() => handleBulkMonitor(true)}
		onUnmonitor={() => handleBulkMonitor(false)}
		onChangeQuality={() => (isQualityModalOpen = true)}
		onLanguage={() => (isLanguageModalOpen = true)}
		onDelete={() => (isDeleteModalOpen = true)}
		onClear={clearSelection}
	/>
{/if}

<!-- Bulk Quality Profile Modal -->
<BulkQualityProfileModal
	open={isQualityModalOpen}
	{selectedCount}
	qualityProfiles={data.qualityProfiles}
	saving={bulkLoading && currentBulkAction === 'quality'}
	mediaType="movie"
	onSave={handleBulkQualityChange}
	onCancel={() => (isQualityModalOpen = false)}
/>

<!-- Bulk Language Profile Modal -->
<BulkLanguageProfileModal
	open={isLanguageModalOpen}
	mediaType="movie"
	selectedIds={[...selectedMovies]}
	onClose={() => (isLanguageModalOpen = false)}
	onApplied={handleBulkLanguageApplied}
/>

<!-- Single Item Delete Modal -->
<DeleteConfirmationModal
	open={isDeleteModalOpen && pendingDeleteMovieId !== null}
	title={m.library_movies_deleteMovieTitle()}
	itemName={pendingDeleteMovieTitle}
	hasFiles={pendingDeleteMovieHasFiles}
	hasActiveDownload={pendingDeleteMovieHasActiveDownload}
	loading={bulkLoading && currentBulkAction === 'delete'}
	onConfirm={handleDeleteConfirm}
	onCancel={() => {
		isDeleteModalOpen = false;
		pendingDeleteMovieId = null;
	}}
/>

<!-- Bulk Delete Modal -->
<BulkDeleteModal
	open={isDeleteModalOpen && pendingDeleteMovieId === null}
	selectedCount={deleteModalCount}
	mediaType="movie"
	hasActiveDownloads={bulkHasActiveDownloads}
	activeDownloadCount={bulkActiveDownloadCount}
	loading={bulkLoading && currentBulkAction === 'delete'}
	onConfirm={handleDeleteConfirm}
	onCancel={() => {
		isDeleteModalOpen = false;
	}}
/>

<!-- Interactive Search Modal -->
<MediaSearchModal
	open={isSearchModalOpen}
	movieId={selectedMovieForSearch?.id}
	onClose={() => {
		isSearchModalOpen = false;
		selectedMovieForSearch = null;
	}}
/>

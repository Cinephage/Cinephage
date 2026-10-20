<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { goto, refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { TmdbMediaItem } from '#lib/types/tmdb.js';
	import { tick } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import MediaCard from '#lib/components/tmdb/MediaCard.svelte';
	import FilterDrawer from '#lib/components/discover/FilterDrawer.svelte';
	import SectionRow from '#lib/components/discover/SectionRow.svelte';
	import SelectionActionBar from '#lib/components/discover/SelectionActionBar.svelte';
	import BulkAddToLibraryModal from '#lib/components/discover/BulkAddToLibraryModal.svelte';
	import AddToLibraryModal from '#lib/components/library/AddToLibraryModal.svelte';
	import TmdbConfigRequired from '#lib/components/ui/TmdbConfigRequired.svelte';
	import { UI } from '#lib/config/constants.js';
	import {
		parseProviderIds,
		parseGenreIds,
		parseKeywordIds,
		extractYear
	} from '#lib/utils/discoverParams.js';
	import {
		discoverSelectionKey,
		toDiscoverSelectionEntry,
		type DiscoverSelectionEntry
	} from '#lib/utils/discoverSelection.js';
	import { Search, Eye, EyeOff, X, Loader2, Bug, CheckSquare, XSquare } from '@lucide/svelte';
	import { getMediaTypeLabel } from '#lib/types/tmdb-guards.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { searchTmdb, getDiscover, getDiscoverUnfiltered } from '#lib/api/index.js';

	let { data } = $props();

	// Only admins add content; viewers browse Discover without the add actions.
	const isAdminUser = $derived(data.user?.role === 'admin');
	const addHandler = $derived(isAdminUser ? handleAddToLibrary : undefined);

	// Add to Library Modal state
	let addModalOpen = $state(false);
	let selectedItem = $state<{
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		title: string;
		year?: number;
		posterPath?: string | null;
	} | null>(null);

	// Handle adding item to library - accepts data from various TMDB endpoints
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function handleAddToLibrary(item: any) {
		const mediaType = getMediaTypeLabel(item as TmdbMediaItem);
		const isMovie = mediaType === 'Movie';
		const isTv = mediaType === 'TV';

		if (!isMovie && !isTv) return;

		const tmdbId = item.id as number;
		const title = (item.title || item.name || 'Unknown') as string;
		const releaseDate = (item.release_date || item.first_air_date) as string | undefined;
		const year = releaseDate ? new Date(releaseDate).getFullYear() : undefined;
		const posterPath = item.poster_path as string | null | undefined;

		selectedItem = {
			mediaType: isMovie ? 'movie' : 'tv',
			tmdbId,
			title,
			year,
			posterPath
		};
		addModalOpen = true;
	}

	function handleAddSuccess() {
		// Refresh the page data to update library status indicators
		refreshAll();
	}

	// Search state
	let searchQuery = $state(page.url.searchParams.get('q') ?? '');
	let debounceTimer = $state<ReturnType<typeof setTimeout>>();
	// Search results from TMDB multi-search API
	// Type is loose since TMDB returns various media types - MediaCard handles the union
	let searchResults = $state<Array<Record<string, unknown> & { id: number; media_type?: string }>>(
		[]
	);
	let isSearching = $state(false);
	let searchPagination = $state<{
		page: number;
		total_pages: number;
		total_results: number;
	} | null>(null);
	let searchLoadMoreTrigger = $state<HTMLElement>();

	const normalizedSearchQuery = $derived(searchQuery.trim());
	// Computed: are we in search mode?
	let isSearchMode = $derived(normalizedSearchQuery.length > 0);

	function handleSearchInput(e: Event) {
		const target = e.target as HTMLInputElement;
		searchQuery = target.value.replace(/^\s+/, '');
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			handleSearch(searchQuery);
		}, 600);
	}

	function clearSearch() {
		searchQuery = '';
		clearTimeout(debounceTimer);
		handleSearch('');
	}

	async function handleSearch(query: string, exclude?: boolean) {
		searchQuery = query;
		const normalizedQuery = query.trim();

		// Keep q in URL so browser back restores search state.
		// Use native replaceState to avoid updating page.url reactively, which would
		// re-trigger derived filter values and loop back into handleSearch.
		const url = new URL(window.location.href);
		if (normalizedQuery) url.searchParams.set('q', normalizedQuery);
		else url.searchParams.delete('q');
		history.replaceState(history.state, '', url.pathname + url.search);

		if (!normalizedQuery) {
			searchResults = [];
			searchPagination = null;
			return;
		}

		isSearching = true;
		try {
			const result = (await searchTmdb({
				query: normalizedQuery,
				type,
				...(exclude ? { exclude_in_library: 'true' } : {})
			})) as unknown as {
				results: Array<Record<string, unknown> & { id: number; media_type?: string }>;
				pagination: { page: number; total_pages: number; total_results: number };
			};
			searchResults = result.results ?? [];
			searchPagination = result.pagination;
		} catch (e) {
			toasts.error(m.discover_searchFailed(), {
				description: e instanceof Error ? e.message : m.discover_searchFailed()
			});
			searchResults = [];
		} finally {
			isSearching = false;
		}
	}

	async function loadMoreSearchResults() {
		if (!searchPagination || searchPagination.page >= searchPagination.total_pages || isSearching)
			return;

		isSearching = true;
		try {
			const nextPage = searchPagination.page + 1;
			const result = (await searchTmdb({
				query: normalizedSearchQuery,
				type,
				page: String(nextPage),
				...(excludeInLibrary ? { exclude_in_library: 'true' } : {})
			})) as unknown as {
				results: Array<Record<string, unknown> & { id: number; media_type?: string }>;
				pagination: { page: number; total_pages: number; total_results: number };
			};
			// Deduplicate
			const existingIds = new Set(searchResults.map((r) => r.id + (r.media_type || '')));
			const newResults = result.results.filter(
				(r: { id: number; media_type?: string }) => !existingIds.has(r.id + (r.media_type || ''))
			);

			searchResults = [...searchResults, ...newResults];
			searchPagination = result.pagination;
		} finally {
			isSearching = false;
		}
	}

	// Re-run search when type or excludeInLibrary filter changes
	$effect(() => {
		if (searchQuery && type) {
			handleSearch(searchQuery, excludeInLibrary);
		}
	});

	// Infinite scroll for search results
	$effect(() => {
		if (!searchLoadMoreTrigger || !isSearchMode) return;

		const observer = new IntersectionObserver(
			async (entries) => {
				if (entries[0].isIntersecting && !isSearching) {
					await loadMoreSearchResults();
				}
			},
			{ rootMargin: '200px' }
		);

		observer.observe(searchLoadMoreTrigger);

		return () => observer.disconnect();
	});

	// Derived state from URL params
	let type = $derived(page.url.searchParams.get('type') || 'all');
	let sortBy = $derived(page.url.searchParams.get('sort_by') || 'popularity.desc');
	let selectedProviders = $derived(
		parseProviderIds(page.url.searchParams.get('with_watch_providers'))
	);
	let selectedGenres = $derived(parseGenreIds(page.url.searchParams.get('with_genres')));
	let selectedLanguage = $derived(
		page.url.searchParams.get('with_original_language') ||
			data.filters?.with_original_language ||
			''
	);
	let minYear = $derived(extractYear(page.url.searchParams.get('primary_release_date.gte')));
	let maxYear = $derived(extractYear(page.url.searchParams.get('primary_release_date.lte')));
	let minRating = $derived(Number(page.url.searchParams.get('vote_average.gte')) || 0);
	let selectedCertification = $derived(page.url.searchParams.get('certification') || '');
	let selectedNetworks = $derived(parseProviderIds(page.url.searchParams.get('with_networks')));
	let selectedKeywords = $derived(parseKeywordIds(page.url.searchParams.get('with_keywords')));
	let selectedExcludedKeywords = $derived(
		parseKeywordIds(page.url.searchParams.get('without_keywords'))
	);
	let keywordNames = $state<Map<number, string>>(new Map());

	let displayKeywords = $derived(
		selectedKeywords.map((id) => ({
			id,
			name: keywordNames.get(id) || String(id),
			exclude: false
		}))
	);
	let displayExcludedKeywords = $derived(
		selectedExcludedKeywords.map((id) => ({
			id,
			name: keywordNames.get(id) || String(id),
			exclude: true
		}))
	);

	let excludeInLibrary = $derived(page.url.searchParams.get('exclude_in_library') === 'true');
	let isFilteredTrending = $derived(
		(page.url.searchParams.get('trending') === 'day' ||
			page.url.searchParams.get('trending') === 'week') &&
			(type !== 'all' ||
				sortBy !== 'popularity.desc' ||
				selectedProviders.length > 0 ||
				selectedNetworks.length > 0 ||
				selectedGenres.length > 0 ||
				selectedKeywords.length > 0 ||
				selectedExcludedKeywords.length > 0 ||
				!!selectedLanguage ||
				!!minYear ||
				!!maxYear ||
				minRating > 0 ||
				!!selectedCertification)
	);

	let hasActiveFilters = $derived(
		type !== 'all' ||
			selectedProviders.length > 0 ||
			selectedNetworks.length > 0 ||
			selectedGenres.length > 0 ||
			selectedKeywords.length > 0 ||
			selectedExcludedKeywords.length > 0 ||
			!!selectedLanguage ||
			!!minYear ||
			!!maxYear ||
			minRating > 0 ||
			!!selectedCertification
	);

	function updateFilter(key: string, value: string | null) {
		const url = new URL(page.url.href);
		if (value) {
			url.searchParams.set(key, value);
		} else {
			url.searchParams.delete(key);
		}
		// Reset page on filter change
		if (key !== 'page') {
			url.searchParams.set('page', '1');
		}
		goto(resolvePath(url.pathname + url.search), { reset: false });
	}

	function updateYear(min: string, max: string) {
		const url = new URL(page.url.href);

		if (min) url.searchParams.set('primary_release_date.gte', `${min}-01-01`);
		else url.searchParams.delete('primary_release_date.gte');
		if (max) url.searchParams.set('primary_release_date.lte', `${max}-12-31`);
		else url.searchParams.delete('primary_release_date.lte');

		url.searchParams.set('page', '1');
		goto(resolvePath(url.pathname + url.search), { reset: false });
	}

	function toggleProvider(providerId: number) {
		const current = new SvelteSet(selectedProviders);
		if (current.has(providerId)) {
			current.delete(providerId);
		} else {
			current.add(providerId);
		}
		updateFilter('with_watch_providers', Array.from(current).join(','));
	}

	function toggleNetwork(networkId: number) {
		const current = new SvelteSet(selectedNetworks);
		if (current.has(networkId)) {
			current.delete(networkId);
		} else {
			current.add(networkId);
		}
		updateFilter('with_networks', Array.from(current).join(','));
	}

	/**
	 * Switching type drops filters the target type cannot express, rather than
	 * leaving them to silently blank the results (a certification plus TV
	 * returns nothing, and networks only exist for TV).
	 */
	function handleTypeChange(nextType: string) {
		const url = new URL(page.url.href);
		if (nextType === 'all') {
			url.searchParams.delete('type');
		} else {
			url.searchParams.set('type', nextType);
		}
		if (nextType === 'tv') url.searchParams.delete('certification');
		if (nextType === 'movie') url.searchParams.delete('with_networks');
		url.searchParams.set('page', '1');
		goto(resolvePath(url.pathname + url.search), { reset: false });
	}

	function toggleGenre(genreId: number) {
		const current = new SvelteSet(selectedGenres);
		if (current.has(genreId)) {
			current.delete(genreId);
		} else {
			current.add(genreId);
		}
		updateFilter('with_genres', Array.from(current).join(','));
	}

	function toggleCertification(cert: string) {
		updateFilter('certification', cert || null);
	}

	function handleKeywordAdd(keyword: { id: number; name: string }, exclude: boolean) {
		keywordNames.set(keyword.id, keyword.name);
		const paramKey = exclude ? 'without_keywords' : 'with_keywords';
		const current = new SvelteSet(parseKeywordIds(page.url.searchParams.get(paramKey)));
		current.add(keyword.id);
		updateFilter(paramKey, Array.from(current).join(','));
	}

	function handleKeywordRemove(keywordId: number, exclude: boolean) {
		const paramKey = exclude ? 'without_keywords' : 'with_keywords';
		const current = new SvelteSet(parseKeywordIds(page.url.searchParams.get(paramKey)));
		current.delete(keywordId);
		updateFilter(paramKey, current.size > 0 ? Array.from(current).join(',') : null);
	}

	function toggleExcludeInLibrary() {
		updateFilter('exclude_in_library', excludeInLibrary ? null : 'true');
	}

	let isFilterOpen = $state(false);

	// Multi-select ("add several items with the same settings")
	let selectMode = $state(false);
	let bulkModalOpen = $state(false);
	/** Selected items keyed by `discoverSelectionKey` so dashboard duplicates collapse. */
	const selection = new SvelteMap<string, DiscoverSelectionEntry>();

	function toggleSelectMode() {
		selectMode = !selectMode;
		if (!selectMode) {
			selection.clear();
		}
	}

	function isItemSelected(item: unknown): boolean {
		const key = discoverSelectionKey(item as TmdbMediaItem);
		return key ? selection.has(key) : false;
	}

	/** Items already in the library keep their normal card behavior in select mode. */
	function isSelectableItem(item: Record<string, unknown>): boolean {
		if ('inLibrary' in item && item.inLibrary === true) return false;
		return discoverSelectionKey(item as unknown as TmdbMediaItem) !== null;
	}

	function toggleItemSelect(item: unknown) {
		const record = item as Record<string, unknown>;
		const key = discoverSelectionKey(item as TmdbMediaItem);
		if (!key || !isSelectableItem(record)) return;
		if (selection.has(key)) {
			selection.delete(key);
			return;
		}
		const entry = toDiscoverSelectionEntry(item as TmdbMediaItem);
		if (entry) selection.set(key, entry);
	}

	/** Items the "select all" action considers: whatever the current view shows. */
	function selectablePool(): Array<Record<string, unknown> & { id: number }> {
		if (isSearchMode) return searchResults;
		return allResults as unknown as Array<Record<string, unknown> & { id: number }>;
	}

	const allVisibleSelected = $derived.by(() => {
		const pool = selectablePool();
		const keys = pool
			.filter((item) => isSelectableItem(item))
			.map((item) => discoverSelectionKey(item as unknown as TmdbMediaItem))
			.filter((key): key is string => !!key);
		return keys.length > 0 && keys.every((key) => selection.has(key));
	});

	function handleSelectAll() {
		const pool = selectablePool();
		if (allVisibleSelected) {
			for (const item of pool) {
				const key = discoverSelectionKey(item as unknown as TmdbMediaItem);
				if (key) selection.delete(key);
			}
			return;
		}
		for (const item of pool) {
			if (!isSelectableItem(item)) continue;
			const key = discoverSelectionKey(item as unknown as TmdbMediaItem);
			if (!key || selection.has(key)) continue;
			const entry = toDiscoverSelectionEntry(item as unknown as TmdbMediaItem);
			if (entry) selection.set(key, entry);
		}
	}

	function clearSelection() {
		selection.clear();
	}

	function handleBulkAddSuccess() {
		selection.clear();
		selectMode = false;
		refreshAll();
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && selectMode && !bulkModalOpen) {
			toggleSelectMode();
		}
	}

	function resetFilters() {
		goto(resolve('discover'));
	}

	function applyFilters() {
		// Filters are applied instantly via URL, so this is just for closing the drawer if needed
		// But the drawer applies changes via the bound props which call updateFilter
		// Wait, the props are derived from URL, so we need to update URL.
		// The FilterPanel calls the callbacks which update URL.
		// So "Apply" button in drawer might just close it, or we can make the drawer state local and only apply on "Apply".
		// For now, let's keep the instant update pattern as it's more responsive,
		// but the drawer has an "Apply" button which implies batching.
		// Let's stick to instant updates for now as implemented in the callbacks.
		isFilterOpen = false;
	}

	type MediaItemWithLibraryStatus = TmdbMediaItem & {
		inLibrary?: boolean;
		hasFile?: boolean;
		libraryId?: string;
		media_type?: string;
	};
	type ResultsType = MediaItemWithLibraryStatus[];
	let allResults = $state<ResultsType>([]);
	let currentPage = $state(1);
	let isLoadingMore = $state(false);
	let loadMoreTrigger = $state<HTMLElement>();

	let debugMode = $state(
		(() => {
			try {
				return localStorage.getItem('discover_debugMode') === 'true';
			} catch {
				return false;
			}
		})()
	);
	let filteredOutResults = $state<ResultsType>([]);
	let debugLoading = $state(false);

	let debugResultsLoaded = $state(false);
	$effect(() => {
		if (debugMode && !debugResultsLoaded && !debugLoading) {
			loadDebugResults();
		}
	});

	async function loadDebugResults() {
		debugLoading = true;
		try {
			const params: Record<string, string> = {};
			page.url.searchParams.forEach((value, key) => {
				params[key] = value;
			});
			params.page = '1';

			const unfiltered = (await getDiscoverUnfiltered(params)) as unknown as {
				results: Array<{ id: number; media_type?: string | null }>;
			};
			const filteredIds = new Set(allResults.map((r) => (r as { id: number }).id));
			filteredOutResults = (unfiltered.results?.filter(
				(r) => !filteredIds.has((r as { id: number }).id)
			) ?? []) as ResultsType;
		} catch {
			toasts.error('Failed to load debug results');
		} finally {
			debugLoading = false;
			debugResultsLoaded = true;
		}
	}

	function toggleDebug() {
		debugMode = !debugMode;
		try {
			localStorage.setItem('discover_debugMode', String(debugMode));
		} catch {
			// storage unavailable (blocked cookies / ETP)
		}
		if (debugMode) {
			debugResultsLoaded = false;
			loadDebugResults();
		} else {
			filteredOutResults = [];
			debugResultsLoaded = false;
		}
	}

	// Sync results from props - handles initial load and filter changes
	$effect(() => {
		if (data.results) {
			// Reset when filters change (page resets to 1) or on initial load
			if (data.pagination?.page === 1 || allResults.length === 0) {
				allResults = data.results as ResultsType;
				currentPage = data.pagination?.page ?? 1;
			}
		} else if (data.viewType === 'dashboard' && data.sections) {
			// Collect all unique items across dashboard sections so debug mode
			// has a populated ID set to diff against.
			const seen = new SvelteSet<number>();
			const combined: ResultsType = [];
			for (const section of [
				data.sections.trendingWeek,
				data.sections.popularMovies,
				data.sections.popularTV,
				data.sections.topRatedMovies,
				data.sections.topRatedTV,
				data.sections.nowPlaying
			]) {
				for (const item of section ?? []) {
					if (!seen.has((item as { id: number }).id)) {
						seen.add((item as { id: number }).id);
						combined.push(item as unknown as ResultsType[number]);
					}
				}
			}
			allResults = combined;
		}
	});

	// Cap results to prevent unbounded memory growth
	$effect(() => {
		if (allResults.length > UI.MAX_DISPLAY_ITEMS) {
			// Keep most recent results
			allResults = allResults.slice(-UI.MAX_DISPLAY_ITEMS);
		}
	});

	async function loadMoreResults() {
		if (isLoadingMore || !data.pagination || currentPage >= data.pagination.total_pages) return;

		isLoadingMore = true;
		try {
			const nextPage = currentPage + 1;
			const params: Record<string, string> = {};
			page.url.searchParams.forEach((value, key) => {
				params[key] = value;
			});
			params.page = String(nextPage);

			const newData = (await getDiscover(params)) as unknown as {
				results: Array<{ id: number; media_type?: string | null }>;
			};

			if (!newData.results || newData.results.length === 0) return;

			// Filter out duplicates based on ID and media_type
			const getResultKey = (item: { id: number; media_type?: string | null }) =>
				`${item.id}-${item.media_type ?? ''}`;
			const existingIds = new Set(allResults.map((i) => getResultKey(i)));
			const uniqueNewResults = newData.results.filter(
				(i: { id: number; media_type?: string | null }) => !existingIds.has(getResultKey(i))
			);

			if (uniqueNewResults.length > 0) {
				allResults = [...allResults, ...(uniqueNewResults as ResultsType)];
			}
			currentPage = nextPage;
		} catch (e) {
			toasts.error(m.discover_failedToLoadMore(), {
				description: e instanceof Error ? e.message : m.discover_failedToLoadMore()
			});
		} finally {
			isLoadingMore = false;
		}
	}

	$effect(() => {
		if (!loadMoreTrigger || data.viewType !== 'grid') return;

		const observer = new IntersectionObserver(
			async (entries) => {
				if (entries[0].isIntersecting && !isLoadingMore) {
					await loadMoreResults();
					// After loading, check if still visible and load more if needed
					await tick();
					if (loadMoreTrigger) {
						const rect = loadMoreTrigger.getBoundingClientRect();
						if (
							rect.top < window.innerHeight + 200 &&
							currentPage < (data.pagination?.total_pages ?? 0)
						) {
							loadMoreResults();
						}
					}
				}
			},
			{ rootMargin: '200px' }
		);

		observer.observe(loadMoreTrigger);

		return () => observer.disconnect();
	});
</script>

<svelte:head>
	<title>{m.discover_pageTitle()}</title>
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="min-h-screen bg-base-100 pb-20">
	<!-- Header -->
	<div
		class="sticky top-16 z-30 -mx-4 border-b border-base-200 bg-base-100/80 backdrop-blur-md lg:top-0 lg:mx-0"
	>
		<div class="flex h-16 w-full items-center gap-4 px-4 lg:px-8">
			<h1
				class="flex-1 bg-linear-to-r from-primary to-secondary bg-clip-text text-2xl font-bold text-transparent"
			>
				{isSearchMode ? m.discover_headingSearch() : m.discover_heading()}
			</h1>

			<!-- Search (desktop) -->
			<div class="hidden w-full max-w-md items-center gap-2 px-4 md:flex">
				<div class="group relative w-full">
					<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
						{#if isSearching}
							<Loader2
								class="h-4 w-4 animate-spin text-base-content/40 transition-colors group-focus-within:text-primary"
							/>
						{:else}
							<Search
								class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
							/>
						{/if}
					</div>
					<input
						type="text"
						placeholder={m.discover_searchPlaceholder()}
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						value={searchQuery}
						oninput={handleSearchInput}
						onkeydown={(e) => e.key === 'Escape' && clearSearch()}
					/>
					{#if searchQuery}
						<button
							class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
							onclick={clearSearch}
							aria-label={m.discover_clearSearch()}
						>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
			</div>

			<div class="flex flex-1 items-center justify-end gap-3">
				<!-- Multi-select toggle (admins only, matching the add action) -->
				{#if isAdminUser}
					<button
						class="btn btn-circle btn-sm {selectMode
							? 'btn-primary'
							: 'border border-base-300 btn-ghost'}"
						onclick={toggleSelectMode}
						title={selectMode ? m.discover_exitSelectMode() : m.discover_selectMode()}
						aria-pressed={selectMode}
					>
						{#if selectMode && allVisibleSelected}
							<XSquare class="h-4 w-4" />
						{:else}
							<CheckSquare class="h-4 w-4" />
						{/if}
					</button>
				{/if}

				<!-- Hide In Library Toggle -->
				<button
					class="btn btn-circle btn-sm {excludeInLibrary
						? 'btn-primary'
						: 'border border-base-300 btn-ghost'}"
					onclick={toggleExcludeInLibrary}
					title={excludeInLibrary
						? m.discover_showItemsInLibrary()
						: m.discover_hideItemsInLibrary()}
				>
					{#if excludeInLibrary}
						<EyeOff class="h-4 w-4" />
					{:else}
						<Eye class="h-4 w-4" />
					{/if}
				</button>

				<!-- Debug Toggle -->
				<button
					class="btn btn-circle btn-sm {debugMode
						? 'btn-warning'
						: 'border border-base-300 btn-ghost'}"
					onclick={toggleDebug}
					title={debugMode ? 'Hide filtered items' : 'Show filtered items (debug)'}
				>
					<Bug class="h-4 w-4" />
				</button>

				<button
					class="btn gap-2 shadow-lg shadow-primary/20 btn-primary btn-sm"
					onclick={() => (isFilterOpen = true)}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-4 w-4"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
						></path>
					</svg>
					{m.discover_filtersButton()}
				</button>
			</div>
		</div>

		<!-- Type tabs + active filter summary -->
		<div
			class="flex flex-wrap items-center justify-between gap-2 border-t border-base-200/50 px-4 py-2 lg:px-8"
		>
			<div class="join" role="group" aria-label={m.discover_filter_mediaType()}>
				{#each [{ value: 'all', label: m.common_all() }, { value: 'movie', label: m.common_movies() }, { value: 'tv', label: m.common_tvShows() }] as tab (tab.value)}
					<button
						class="btn join-item btn-sm {type === tab.value
							? 'btn-primary'
							: 'border-base-300/60 bg-base-200/40 btn-outline'}"
						aria-pressed={type === tab.value}
						onclick={() => handleTypeChange(tab.value)}
					>
						{tab.label}
					</button>
				{/each}
			</div>

			<div class="hidden flex-wrap items-center justify-end gap-2 md:flex">
				{#if selectedGenres.length > 0}
					<div class="badge badge-outline badge-sm">
						{m.discover_filterBadgeGenres({ count: selectedGenres.length })}
					</div>
				{/if}
				{#if selectedNetworks.length > 0}
					<div class="badge badge-outline badge-sm">
						{m.discover_filterBadgeNetworks({ count: selectedNetworks.length })}
					</div>
				{/if}
				{#if selectedProviders.length > 0}
					<div class="badge badge-outline badge-sm">
						{m.discover_filterBadgeProviders({ count: selectedProviders.length })}
					</div>
				{/if}
				{#if selectedKeywords.length + selectedExcludedKeywords.length > 0}
					<div class="badge badge-outline badge-sm">
						{m.discover_filterBadgeKeywords({
							count: selectedKeywords.length + selectedExcludedKeywords.length
						})}
					</div>
				{/if}
				{#if selectedLanguage}
					<div class="badge badge-outline badge-sm">{m.discover_filterBadgeLanguage()}</div>
				{/if}
				{#if minYear || maxYear}
					<div class="badge badge-outline badge-sm">{minYear || '…'} - {maxYear || '…'}</div>
				{/if}
				{#if minRating > 0}
					<div class="badge badge-outline badge-sm">{minRating}+</div>
				{/if}
				{#if selectedCertification}
					<div class="badge badge-outline badge-sm">{selectedCertification}</div>
				{/if}
				{#if hasActiveFilters}
					<button class="btn btn-ghost text-error btn-xs" onclick={resetFilters}
						>{m.action_clear()}</button
					>
				{/if}
			</div>
		</div>

		<!-- Search (mobile) -->
		<div class="flex items-center gap-2 border-t border-base-200/50 px-4 py-2 md:hidden">
			<div class="group relative w-full">
				<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
					{#if isSearching}
						<Loader2
							class="h-4 w-4 animate-spin text-base-content/40 transition-colors group-focus-within:text-primary"
						/>
					{:else}
						<Search
							class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
						/>
					{/if}
				</div>
				<input
					type="text"
					placeholder={m.discover_searchPlaceholder()}
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					value={searchQuery}
					oninput={handleSearchInput}
					onkeydown={(e) => e.key === 'Escape' && clearSearch()}
				/>
				{#if searchQuery}
					<button
						class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
						onclick={clearSearch}
						aria-label={m.discover_clearSearch()}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
		</div>
	</div>

	<!-- Main Content -->
	<main class="w-full space-y-12 px-4 py-8 lg:px-8">
		{#if data.viewType === 'not_configured'}
			<div class="mx-auto max-w-2xl py-12">
				<TmdbConfigRequired message={m.discover_tmdbConfigMessage()} />
				<div class="mt-8 text-center">
					<p class="text-base-content/60">
						{m.discover_tmdbConfigDescription()}
					</p>
				</div>
			</div>
		{:else if data.error}
			<div role="alert" class="alert alert-error">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-6 w-6 shrink-0 stroke-current"
					fill="none"
					viewBox="0 0 24 24"
					><path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
					></path>
				</svg>
				<span>{data.error}</span>
			</div>
		{:else if isSearchMode}
			<!-- Search Results View -->
			<div class="animate-in fade-in slide-in-from-bottom-4 duration-500">
				<div class="mb-6 flex items-center justify-between">
					<h2 class="text-xl font-bold opacity-70">
						{#if searchPagination}
							{m.discover_searchResultsCount({
								count: searchPagination.total_results.toLocaleString(),
								query: searchQuery
							})}
						{:else}
							{m.common_searching()}
						{/if}
					</h2>
				</div>

				<div class="grid grid-cols-3 gap-2 sm:gap-4 lg:grid-cols-9">
					{#each searchResults as item (item.id + (item.media_type || ''))}
						<MediaCard
							item={item as unknown as TmdbMediaItem}
							onAddToLibrary={addHandler}
							selectable={selectMode}
							selected={isItemSelected(item)}
							onToggleSelect={() => toggleItemSelect(item)}
						/>
					{/each}
				</div>

				{#if searchResults.length === 0 && !isSearching && searchPagination}
					<div class="flex flex-col items-center justify-center py-20 text-center opacity-50">
						<Search class="mb-4 h-20 w-20" />
						<p class="text-2xl font-bold">{m.discover_noResultsFound()}</p>
						<p class="mt-2">{m.discover_noResultsTryDifferent()}</p>
					</div>
				{/if}

				<!-- Infinite Scroll Trigger for Search -->
				<div bind:this={searchLoadMoreTrigger} class="flex justify-center py-12">
					{#if isSearching}
						<span class="loading loading-lg loading-dots text-primary"></span>
					{:else if searchPagination && searchPagination.page >= searchPagination.total_pages && searchResults.length > 0}
						<span class="text-sm tracking-widest text-base-content/30 uppercase"
							>{m.common_endOfResults()}</span
						>
					{/if}
				</div>
			</div>
		{:else if data.viewType === 'dashboard' && data.sections}
			<!-- Dashboard View -->
			<div class="animate-in fade-in space-y-12 duration-500">
				<SectionRow
					title={m.common_inTheaters()}
					items={data.sections.nowPlaying}
					link="/discover?now_playing=true{excludeInLibrary ? '&exclude_in_library=true' : ''}"
					endpoint="movie/now_playing"
					onAddToLibrary={addHandler}
					{excludeInLibrary}
					selectable={selectMode}
					isSelected={isItemSelected}
					onToggleSelect={toggleItemSelect}
				/>
				<SectionRow
					title={m.discover_trendingThisWeek()}
					items={data.sections.trendingWeek}
					link="/discover?trending=week{excludeInLibrary ? '&exclude_in_library=true' : ''}"
					endpoint="trending/all/week"
					onAddToLibrary={addHandler}
					{excludeInLibrary}
					selectable={selectMode}
					isSelected={isItemSelected}
					onToggleSelect={toggleItemSelect}
				/>
				<SectionRow
					title={m.discover_popularMovies()}
					items={data.sections.popularMovies}
					link="/discover?type=movie&sort_by=popularity.desc{excludeInLibrary
						? '&exclude_in_library=true'
						: ''}"
					endpoint="movie/popular"
					onAddToLibrary={addHandler}
					{excludeInLibrary}
					selectable={selectMode}
					isSelected={isItemSelected}
					onToggleSelect={toggleItemSelect}
				/>
				<SectionRow
					title={m.discover_popularTvShows()}
					items={data.sections.popularTV}
					link="/discover?type=tv&sort_by=popularity.desc{excludeInLibrary
						? '&exclude_in_library=true'
						: ''}"
					endpoint="tv/popular"
					onAddToLibrary={addHandler}
					{excludeInLibrary}
					selectable={selectMode}
					isSelected={isItemSelected}
					onToggleSelect={toggleItemSelect}
				/>
				<SectionRow
					title={m.discover_topRatedMovies()}
					items={data.sections.topRatedMovies}
					link="/discover?type=movie&top_rated=true{excludeInLibrary
						? '&exclude_in_library=true'
						: ''}"
					endpoint="movie/top_rated"
					onAddToLibrary={addHandler}
					{excludeInLibrary}
					selectable={selectMode}
					isSelected={isItemSelected}
					onToggleSelect={toggleItemSelect}
				/>
				<SectionRow
					title={m.discover_topRatedTvShows()}
					items={data.sections.topRatedTV}
					link="/discover?type=tv&top_rated=true{excludeInLibrary
						? '&exclude_in_library=true'
						: ''}"
					endpoint="tv/top_rated"
					onAddToLibrary={addHandler}
					{excludeInLibrary}
					selectable={selectMode}
					isSelected={isItemSelected}
					onToggleSelect={toggleItemSelect}
				/>
			</div>
		{:else if data.viewType === 'grid' && data.results}
			<!-- Grid View -->
			<div class="animate-in fade-in slide-in-from-bottom-4 duration-500">
				<div class="mb-6 flex items-center justify-between">
					<div>
						<h2 class="text-xl font-bold opacity-70">
							{#if isFilteredTrending}
								Popular & Matching
							{:else}
								{m.discover_resultsCount({ count: data.pagination.total_results.toLocaleString() })}
							{/if}
						</h2>
						{#if isFilteredTrending}
							<p class="text-sm text-base-content/50">
								{m.discover_resultsCount({ count: data.pagination.total_results.toLocaleString() })}
							</p>
						{/if}
					</div>
				</div>

				<div class="grid grid-cols-3 gap-2 sm:gap-4 lg:grid-cols-9">
					{#each allResults as item (`${item.id}-${item.media_type ?? ''}`)}
						<MediaCard
							{item}
							onAddToLibrary={addHandler}
							selectable={selectMode}
							selected={isItemSelected(item)}
							onToggleSelect={() => toggleItemSelect(item)}
						/>
					{/each}
				</div>

				{#if allResults.length === 0}
					<div class="flex flex-col items-center justify-center py-20 text-center opacity-50">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="mb-4 h-20 w-20"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1"
								d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
							></path>
						</svg>
						<p class="text-2xl font-bold">{m.discover_noResultsFound()}</p>
						<p class="mt-2">{m.discover_noGridResultsHint()}</p>
						<button class="btn mt-6 btn-primary" onclick={resetFilters}
							>{m.discover_clearFilters()}</button
						>
					</div>
				{/if}

				<!-- Infinite Scroll Trigger -->
				<div bind:this={loadMoreTrigger} class="flex justify-center py-12">
					{#if isLoadingMore}
						<span class="loading loading-lg loading-dots text-primary"></span>
					{:else if currentPage >= data.pagination.total_pages && allResults.length > 0}
						<span class="text-sm tracking-widest text-base-content/30 uppercase"
							>{m.common_endOfResults()}</span
						>
					{/if}
				</div>
			</div>
		{/if}

		{#if debugMode}
			<section class="rounded-lg border border-warning/30 bg-warning/5 p-6">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="flex items-center gap-2 text-lg font-bold text-warning">
						<Bug class="h-5 w-5" />
						Filtered by keyword blocklist ({filteredOutResults.length})
					</h2>
					{#if debugLoading}
						<span class="loading loading-sm loading-spinner text-warning"></span>
					{/if}
				</div>
				{#if filteredOutResults.length > 0}
					<div class="grid grid-cols-3 gap-2 opacity-60 sm:gap-3 lg:grid-cols-6">
						{#each filteredOutResults as item (item.id + (item.media_type || ''))}
							<MediaCard item={item as unknown as TmdbMediaItem} onAddToLibrary={addHandler} />
						{/each}
					</div>
				{:else if !debugLoading}
					<p class="text-sm text-base-content/50">No items filtered on this page.</p>
				{/if}
			</section>
		{/if}
	</main>

	<!-- Filter Drawer -->
	<FilterDrawer
		bind:isOpen={isFilterOpen}
		{type}
		{sortBy}
		{selectedProviders}
		genres={data.genres}
		{selectedGenres}
		{selectedLanguage}
		{minYear}
		{maxYear}
		{minRating}
		certifications={data.certifications}
		{selectedCertification}
		providers={data.providers}
		networks={data.networks ?? []}
		{selectedNetworks}
		languages={data.languages ?? []}
		onSortChange={(s) => updateFilter('sort_by', s)}
		onProviderToggle={toggleProvider}
		onNetworkToggle={toggleNetwork}
		onGenreToggle={toggleGenre}
		onLanguageChange={(lang) => updateFilter('with_original_language', lang || null)}
		onYearChange={updateYear}
		onRatingChange={(r) => updateFilter('vote_average.gte', String(r))}
		onCertificationChange={toggleCertification}
		selectedKeywords={displayKeywords}
		selectedExcludedKeywords={displayExcludedKeywords}
		onKeywordAdd={handleKeywordAdd}
		onKeywordRemove={handleKeywordRemove}
		onReset={resetFilters}
		onApply={applyFilters}
	/>

	<!-- Add to Library Modal -->
	{#if selectedItem}
		<AddToLibraryModal
			open={addModalOpen}
			mediaType={selectedItem.mediaType}
			tmdbId={selectedItem.tmdbId}
			title={selectedItem.title}
			year={selectedItem.year}
			posterPath={selectedItem.posterPath}
			onClose={() => (addModalOpen = false)}
			onSuccess={handleAddSuccess}
		/>
	{/if}

	<!-- Multi-select: floating bar + bulk add modal -->
	{#if isAdminUser}
		<SelectionActionBar
			selectedCount={selection.size}
			loading={false}
			onSelectAll={handleSelectAll}
			onAdd={() => (bulkModalOpen = true)}
			onClear={clearSelection}
		/>
		<BulkAddToLibraryModal
			open={bulkModalOpen}
			items={Array.from(selection.values())}
			onClose={() => (bulkModalOpen = false)}
			onSuccess={handleBulkAddSuccess}
		/>
	{/if}
</div>

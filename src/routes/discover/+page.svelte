<script lang="ts" module>
	/**
	 * Views already seen in this tab, by query string. Coming back to one (the
	 * back button, a tab, a revisit) paints it at once from here while the
	 * fresh data streams in underneath: stale-while-revalidate in the browser.
	 * Small and in memory only; a reload starts empty.
	 */
	const VIEW_CACHE_LIMIT = 20;
	// Deliberately not reactive: it is read when a view is painted, never rendered.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const viewCache = new Map<string, unknown>();

	function rememberView(key: string, value: unknown) {
		viewCache.delete(key);
		viewCache.set(key, value);
		if (viewCache.size > VIEW_CACHE_LIMIT) {
			const oldest = viewCache.keys().next().value;
			if (oldest !== undefined) viewCache.delete(oldest);
		}
	}
</script>

<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { goto, refreshAll } from '$app/navigation';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { TmdbMediaItem } from '#lib/types/tmdb.js';
	import { tick, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import MediaCard from '#lib/components/tmdb/MediaCard.svelte';
	import MusicRowCard from '#lib/components/discover/MusicRowCard.svelte';
	import type { MusicRowItem } from '#lib/components/discover/music-row-item.js';
	import FilterDrawer from '#lib/components/filters/FilterDrawer.svelte';
	import SectionRow from '#lib/components/discover/SectionRow.svelte';
	import { createDiscoverSearch } from '#lib/components/discover/discover-search.svelte.js';
	import DiscoverSearchBox from '#lib/components/discover/DiscoverSearchBox.svelte';
	import { MobileSearch } from '#lib/components/ui/search/mobile-search.svelte.js';
	import MobileSearchToggle from '#lib/components/ui/search/MobileSearchToggle.svelte';
	import MobileSearchPanel from '#lib/components/ui/search/MobileSearchPanel.svelte';
	import SelectionActionBar from '#lib/components/discover/SelectionActionBar.svelte';
	import BulkAddToLibraryModal from '#lib/components/discover/BulkAddToLibraryModal.svelte';
	import PlaylistImportModal from '#lib/components/music/PlaylistImportModal.svelte';
	import AddToLibraryModal from '#lib/components/library/AddToLibraryModal.svelte';
	import TmdbConfigRequired from '#lib/components/ui/TmdbConfigRequired.svelte';
	import DiscoverSkeleton from '#lib/components/discover/DiscoverSkeleton.svelte';
	import { UI } from '#lib/config/constants.js';
	import {
		activeFilters,
		applyFacetChange,
		applyKindChange,
		applyReset,
		hasActiveFilters as selectionHasFilters,
		readSelection,
		type ActiveFilterView,
		type FacetSelection,
		type FacetValue
	} from '#lib/filters/index.js';
	import { MEDIA_KINDS, isKindId, type KindFilter } from '#lib/media-kinds/registry.js';
	import {
		discoverSelectionKey,
		toDiscoverSelectionEntry,
		type DiscoverSelectionEntry
	} from '#lib/utils/discoverSelection.js';
	import { Search, Eye, EyeOff, Bug, CheckSquare, XSquare, ListMusic } from '@lucide/svelte';
	import { getMediaTypeLabel } from '#lib/types/tmdb-guards.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { getDiscover, getDiscoverUnfiltered } from '#lib/api/index.js';

	/** Music rows arrive as loose fetch JSON; their media_type field is untyped there. */
	function isMusicRow(item: { media_type?: unknown }): boolean {
		return item.media_type === 'music';
	}

	/** A music shelf is identified, not labelled, by the server, so the heading
	 *  is translated here and a genre can prefix it. */
	function shelfLabel(id: string): string {
		if (id === 'topArtists') return m.music_topArtists();
		if (id === 'topTracks') return m.music_topTracks();
		return m.music_topAlbums();
	}

	let { data } = $props();

	/**
	 * The load streams its TMDB work (see +page.server.ts), so the header,
	 * tabs and search render on the click and the content arrives into
	 * `view`. While a new filter or tab is loading, the previous view stays
	 * on screen, dimmed, rather than blanking the page.
	 */
	type DiscoverView = Awaited<typeof data.discover>;
	const initialKey = page.url.search;
	let view = $state.raw<DiscoverView | null>(
		(viewCache.get(initialKey) as DiscoverView | undefined) ?? null
	);
	/** The query string `view` belongs to; dimmed while it is not the current one. */
	let viewKey = $state(initialKey);
	let viewPending = $state(true);
	let viewFailed = $state(false);
	const viewIsStale = $derived(view !== null && viewPending && viewKey !== page.url.search);

	let belowFoldReady = $state(false);
	$effect(() => {
		if (belowFoldReady || view?.viewType !== 'dashboard') return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const frame = requestAnimationFrame(() => {
			timer = setTimeout(() => (belowFoldReady = true), 0);
		});
		return () => {
			cancelAnimationFrame(frame);
			if (timer) clearTimeout(timer);
		};
	});
	$effect(() => {
		const pending = data.discover;
		const key = page.url.search;
		let current = true;
		viewPending = true;
		const cached = viewCache.get(key) as DiscoverView | undefined;
		if (cached) {
			view = cached;
			viewKey = key;
		}
		pending.then(
			(resolved) => {
				if (!current) return;
				rememberView(key, resolved);
				view = resolved;
				viewKey = key;
				viewPending = false;
				viewFailed = false;
			},
			() => {
				if (!current) return;
				viewPending = false;
				viewFailed = true;
			}
		);
		return () => {
			current = false;
		};
	});

	/** Opened from the music view; a paste is a one-time import, not a smart list. */
	let importOpen = $state(false);

	/** The music landing payload, narrowed once: it exists only on the music
	 *  view, and this page's data type is a union of every view. */
	type MusicShelfView = { id: string; rows: MusicRowItem[] };
	const musicShelves = $derived((view?.shelves ?? []) as MusicShelfView[]);
	const activeGenreName = $derived((view?.activeGenreName ?? null) as string | null);

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

	// Search state: debounced, newest-answer-wins title search (see discover-search).
	const search = createDiscoverSearch(page.url.searchParams.get('q') ?? '', {
		type: () => type,
		excludeInLibrary: () => excludeInLibrary,
		// Keep q in URL so browser back restores search state.
		// Use native replaceState to avoid updating page.url reactively, which would
		// re-trigger derived filter values and loop back into the search.
		onQuery: (query) => {
			const url = new URL(window.location.href);
			if (query) url.searchParams.set('q', query);
			else url.searchParams.delete('q');
			history.replaceState(history.state, '', url.pathname + url.search);
		},
		onError: (e) => {
			toasts.error(m.discover_searchFailed(), {
				description: e instanceof Error ? e.message : m.discover_searchFailed()
			});
		}
	});
	const searchQuery = $derived(search.query);
	// On phones the search row only shows when opened or while a query is active.
	const mobileSearch = new MobileSearch('discover-mobile-search', () => searchQuery !== '');
	const searchResults = $derived(search.results);
	const searchPagination = $derived(search.pagination);
	const isSearching = $derived(search.searching);
	let searchLoadMoreTrigger = $state<HTMLElement>();

	const normalizedSearchQuery = $derived(searchQuery.trim());
	// Computed: are we in search mode?
	let isSearchMode = $derived(normalizedSearchQuery.length > 0);

	function handleSearchInput(e: Event) {
		const target = e.target as HTMLInputElement;
		search.input(target.value.replace(/^\s+/, ''));
	}

	function handleSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') search.clear();
		else if (e.key === 'Enter') void search.run();
	}

	function clearSearch() {
		search.clear();
	}

	// Re-run search when type or excludeInLibrary filter changes (and once on
	// load for a q from the URL). Only the filters are tracked: typing goes
	// through the debounce, never through this effect.
	$effect(() => {
		void type;
		void excludeInLibrary;
		untrack(() => {
			if (search.query.trim()) void search.run();
		});
	});

	$effect(() => () => search.dispose());

	// Infinite scroll for search results
	$effect(() => {
		if (!searchLoadMoreTrigger || !isSearchMode) return;

		const observer = new IntersectionObserver(
			async (entries) => {
				if (entries[0].isIntersecting && !isSearching) {
					await search.loadMore();
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
	const kind: KindFilter = $derived(isKindId(type) ? type : 'all');

	/**
	 * The whole filter state, read through the same codec the server uses.
	 * Nothing below knows a parameter name: a filter is a declaration, and the
	 * panel renders whatever the current tab declares.
	 */
	const filters: FacetSelection = $derived(readSelection(page.url.searchParams, kind));
	const facetGroups = $derived(view?.facetGroups ?? []);
	const activeFilterChips = $derived(activeFilters(facetGroups));

	/** Badge copy: bespoke wording when the facet declares it, otherwise its value. */
	function filterBadge(chip: ActiveFilterView): string {
		if (chip.badgeKey) {
			const catalogue = m as unknown as Record<
				string,
				((args: { count: number }) => string) | undefined
			>;
			const text = catalogue[chip.badgeKey]?.({ count: chip.count ?? 0 });
			if (text) return text;
		}
		return chip.text ?? `${chip.count ?? 0} ${chip.label}`;
	}
	let excludeInLibrary = $derived(page.url.searchParams.get('exclude_in_library') === 'true');
	const capabilities = $derived.by(() => {
		const ids = kind === 'all' ? (['movie', 'tv'] as const) : [kind];
		const supports = (bit: 'libraryExclusion' | 'bulkAdd' | 'contentFiltering') =>
			ids.every((id) => MEDIA_KINDS.get(id)?.capabilities[bit] === true);
		return {
			libraryExclusion: supports('libraryExclusion'),
			bulkAdd: supports('bulkAdd'),
			contentFiltering: supports('contentFiltering')
		};
	});

	let isFilteredTrending = $derived(
		(page.url.searchParams.get('trending') === 'day' ||
			page.url.searchParams.get('trending') === 'week') &&
			(type !== 'all' || sortBy !== 'popularity.desc' || selectionHasFilters(filters))
	);

	/** Apply one facet value and rewrite every facet parameter from the result. */
	function setFacet(facetId: string, value: FacetValue | null) {
		const url = new URL(page.url.href);
		applyFacetChange(url.searchParams, filters, facetGroups, facetId, value);
		url.searchParams.set('page', '1');
		goto(resolvePath(url.pathname + url.search), { reset: false });
	}

	/**
	 * Switching tabs keeps every facet the target kind understands and drops
	 * the rest — the rule lives in the declarations, not in a list of deletes.
	 */
	function handleTypeChange(nextType: string) {
		const url = new URL(page.url.href);
		if (nextType === 'all') url.searchParams.delete('type');
		else url.searchParams.set('type', nextType);
		const nextKind: KindFilter = isKindId(nextType) ? nextType : 'all';
		applyKindChange(url.searchParams, filters, nextKind);
		url.searchParams.set('page', '1');
		goto(resolvePath(url.pathname + url.search), { reset: false });
	}

	function resetFilters() {
		const url = new URL(page.url.href);
		applyReset(url.searchParams, facetGroups);
		url.searchParams.delete('page');
		goto(resolvePath(url.pathname + url.search), { reset: false });
	}

	function toggleExcludeInLibrary() {
		const url = new URL(page.url.href);
		if (excludeInLibrary) url.searchParams.delete('exclude_in_library');
		else url.searchParams.set('exclude_in_library', 'true');
		url.searchParams.set('page', '1');
		goto(resolvePath(url.pathname + url.search), { reset: false });
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
		const current = view;
		if (!current) return;
		if (current.results) {
			// Reset when filters change (page resets to 1) or on initial load
			if (current.pagination?.page === 1 || allResults.length === 0) {
				allResults = current.results as ResultsType;
				currentPage = current.pagination?.page ?? 1;
			}
		} else if (current.viewType === 'dashboard' && current.sections) {
			// Collect all unique items across dashboard sections so debug mode
			// has a populated ID set to diff against.
			const seen = new SvelteSet<number>();
			const combined: ResultsType = [];
			for (const section of [
				current.sections.trendingWeek,
				current.sections.popularMovies,
				current.sections.popularTV,
				current.sections.topRatedMovies,
				current.sections.topRatedTV,
				current.sections.nowPlaying
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
		const pagination = view?.pagination;
		if (isLoadingMore || !pagination || currentPage >= pagination.total_pages) return;

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
		if (!loadMoreTrigger || view?.viewType !== 'grid') return;

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
							currentPage < (view?.pagination?.total_pages ?? 0)
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
				<DiscoverSearchBox
					query={searchQuery}
					searching={isSearching}
					oninput={handleSearchInput}
					onkeydown={handleSearchKeydown}
					onclear={clearSearch}
				/>
			</div>

			<div class="flex flex-1 items-center justify-end gap-3">
				<!-- Multi-select: only kinds whose rows the bulk-add path understands. -->
				{#if isAdminUser && capabilities.bulkAdd}
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

				{#if capabilities.libraryExclusion}
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
				{/if}

				{#if capabilities.contentFiltering}
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
				{/if}

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
				{#each [{ value: 'all', label: m.common_all() }, { value: 'movie', label: m.common_movies() }, { value: 'tv', label: m.common_tvShows() }, { value: 'music', label: m.nav_music() }] as tab (tab.value)}
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

			<MobileSearchToggle
				search={mobileSearch}
				class="btn btn-circle border border-base-300 btn-ghost btn-sm"
			/>

			<div class="hidden flex-wrap items-center justify-end gap-2 md:flex">
				{#each activeFilterChips as chip (chip.id)}
					<div class="badge badge-outline badge-sm">{filterBadge(chip)}</div>
				{/each}
				{#if activeFilterChips.length > 0}
					<button class="btn btn-ghost text-error btn-xs" onclick={resetFilters}
						>{m.action_clear()}</button
					>
				{/if}
			</div>
		</div>

		<!-- Search (mobile): behind the search icon beside the type tabs -->
		<MobileSearchPanel search={mobileSearch}>
			<DiscoverSearchBox
				query={searchQuery}
				searching={isSearching}
				oninput={handleSearchInput}
				onkeydown={handleSearchKeydown}
				onclear={clearSearch}
			/>
		</MobileSearchPanel>
	</div>

	<!-- Main Content -->
	<main
		class="w-full space-y-12 px-4 py-8 transition-opacity lg:px-8"
		class:opacity-60={viewIsStale}
		aria-busy={viewPending}
	>
		{#if !view && viewFailed}
			<div role="alert" class="alert alert-error">
				<span>{m.discover_loadFailed()}</span>
				<button class="btn btn-sm" onclick={() => refreshAll()}>{m.discover_retry()}</button>
			</div>
		{:else if !view}
			<DiscoverSkeleton />
		{:else if view.viewType === 'not_configured'}
			<div class="mx-auto max-w-2xl py-12">
				<TmdbConfigRequired message={m.discover_tmdbConfigMessage()} />
				<div class="mt-8 text-center">
					<p class="text-base-content/60">
						{m.discover_tmdbConfigDescription()}
					</p>
				</div>
			</div>
		{:else if view.error}
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
				<span>{view.error}</span>
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
						{#if isMusicRow(item)}
							<!-- Music search rows carry their MusicBrainz ids; the card links or resolves. -->
							<MusicRowCard item={item as unknown as MusicRowItem} onAdded={() => refreshAll()} />
						{:else}
							<MediaCard
								item={item as unknown as TmdbMediaItem}
								onAddToLibrary={addHandler}
								selectable={selectMode}
								selected={isItemSelected(item)}
								onToggleSelect={() => toggleItemSelect(item)}
							/>
						{/if}
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
		{:else if view.viewType === 'music'}
			<!-- Music View: one chart request per selected genre feeds three shelves.
			     Genres are a facet in the drawer, not a control row on the page. -->
			<div class="animate-in fade-in space-y-10 duration-500">
				<div class="flex items-center justify-end">
					<button class="btn gap-2 btn-outline btn-sm" onclick={() => (importOpen = true)}>
						<ListMusic class="h-4 w-4" />
						{m.music_importPlaylist()}
					</button>
				</div>
				{#each musicShelves as shelf (shelf.id)}
					<section class="space-y-4">
						<h2 class="text-lg font-bold">
							{activeGenreName
								? `${activeGenreName} · ${shelfLabel(shelf.id)}`
								: shelfLabel(shelf.id)}
						</h2>
						<div class="grid grid-cols-3 gap-2 sm:gap-4 lg:grid-cols-9">
							{#each shelf.rows as item (item.id)}
								<MusicRowCard {item} onAdded={() => refreshAll()} />
							{/each}
						</div>
					</section>
				{/each}
			</div>
		{:else if view.viewType === 'dashboard' && view.sections}
			<!-- Dashboard View -->
			<div class="animate-in fade-in space-y-12 duration-500">
				<SectionRow
					title={m.common_inTheaters()}
					items={view.sections.nowPlaying}
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
					items={view.sections.trendingWeek}
					link="/discover?trending=week{excludeInLibrary ? '&exclude_in_library=true' : ''}"
					endpoint="trending/all/week"
					onAddToLibrary={addHandler}
					{excludeInLibrary}
					selectable={selectMode}
					isSelected={isItemSelected}
					onToggleSelect={toggleItemSelect}
				/>
				<!-- Rows below the first two are drawn a frame later: building all of
				     them at once (~400 elements each) held the first paint back, also
				     when the view came from the cache. Placeholders keep the height so
				     scroll restoration on back/forward still lands. -->
				{#if belowFoldReady}
					{#if view.sections.topAlbums.length > 0}
						<SectionRow
							title={m.music_topAlbums()}
							items={view.sections.topAlbums}
							link="/discover?type=music"
							onAddToLibrary={addHandler}
						>
							{#snippet cardSnippet(item)}
								<MusicRowCard {item} onAdded={() => refreshAll()} />
							{/snippet}
						</SectionRow>
					{/if}
					<SectionRow
						title={m.discover_popularMovies()}
						items={view.sections.popularMovies}
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
						items={view.sections.popularTV}
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
						items={view.sections.topRatedMovies}
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
						items={view.sections.topRatedTV}
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
				{:else}
					<DiscoverSkeleton rows={4} />
				{/if}
			</div>
		{:else if view.viewType === 'grid' && view.results}
			<!-- Grid View -->
			<div class="animate-in fade-in slide-in-from-bottom-4 duration-500">
				<div class="mb-6 flex items-center justify-between">
					<div>
						<h2 class="text-xl font-bold opacity-70">
							{#if isFilteredTrending}
								Popular & Matching
							{:else}
								{m.discover_resultsCount({ count: view.pagination.total_results.toLocaleString() })}
							{/if}
						</h2>
						{#if isFilteredTrending}
							<p class="text-sm text-base-content/50">
								{m.discover_resultsCount({ count: view.pagination.total_results.toLocaleString() })}
							</p>
						{/if}
					</div>
				</div>

				<div class="grid grid-cols-3 gap-2 sm:gap-4 lg:grid-cols-9">
					{#each allResults as item (`${item.id}-${item.media_type ?? ''}`)}
						{#if isMusicRow(item)}
							<!-- Rows arrive as loose fetch JSON; the card owns the typed shape. -->
							<MusicRowCard item={item as unknown as MusicRowItem} />
						{:else}
							<MediaCard
								{item}
								onAddToLibrary={addHandler}
								selectable={selectMode}
								selected={isItemSelected(item)}
								onToggleSelect={() => toggleItemSelect(item)}
							/>
						{/if}
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
					{:else if currentPage >= view.pagination.total_pages && allResults.length > 0}
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

	<!-- Filter Drawer: one panel, built from whatever facets the current tab declares. -->
	<FilterDrawer
		bind:isOpen={isFilterOpen}
		groups={facetGroups}
		onchange={setFacet}
		onReset={resetFilters}
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
	{#if isAdminUser && capabilities.bulkAdd}
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

	<!-- A playlist paste adds albums straight to the library; the shelves refresh behind it. -->
	<PlaylistImportModal
		open={importOpen}
		onClose={() => (importOpen = false)}
		onDone={() => refreshAll()}
	/>
</div>

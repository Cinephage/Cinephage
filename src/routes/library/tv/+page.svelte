<script lang="ts">
	import { page } from '$app/state';
	import { goto, beforeNavigate, afterNavigate, refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { resolvePath } from '#lib/utils/routing.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { seriesCardView, seriesRowView } from '#lib/components/library/media-view.js';
	import LibraryListHeader from '#lib/components/library/list/LibraryListHeader.svelte';
	import LibraryListEmptyState from '#lib/components/library/list/LibraryListEmptyState.svelte';
	import LibraryListBody from '#lib/components/library/list/LibraryListBody.svelte';
	import LibraryBulkActions from '#lib/components/library/list/LibraryBulkActions.svelte';
	import { createListSelection } from '#lib/components/library/list/list-selection.svelte.js';
	import LibraryDrawer from '#lib/components/library/LibraryDrawer.svelte';
	import { MediaSearchModal } from '#lib/components/search/index.js';
	import { Tv, CheckSquare, XSquare, Eye, EyeOff, ChevronDown } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { viewPreferences } from '#lib/stores/view-preferences.svelte.js';
	import { enhance } from '$app/forms';
	import {
		batchSeries,
		batchDeleteSeriesFiles,
		updateSeries,
		deleteSeries
	} from '#lib/api/library.js';
	import { ApiError } from '#lib/api/client.js';
	import { createSearchProgress } from '#lib/stores/searchProgress.svelte.js';
	import { getPrimaryAutoSearchIssue } from '#lib/utils/autoSearchIssues.js';
	import { createProgressiveRenderer } from '#lib/utils/progressive-render.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import { seriesStatusFilterOptions } from '#lib/utils/format-status.js';

	let { data } = $props();

	// Viewer accounts browse a read-only library; admin controls stay hidden.
	const isAdminUser = $derived(data.user?.role === 'admin');

	/** The table shows the profile's name, not its id — same rule the movie list uses. */
	const profileNameMap = $derived(
		new Map((data.qualityProfiles ?? []).map((entry) => [entry.id, entry.name]))
	);
	function profileNameFor(series: (typeof data.series)[number]): string | null {
		const id = series.scoringProfileId;
		if (!id) return profileNameMap.get('balanced') ?? 'Default';
		return profileNameMap.get(id) ?? id;
	}

	const SCROLL_KEY = 'cinephage:library:tv:scrollY';

	beforeNavigate(({ to, shallow, type }) => {
		if (shallow && type === 'goto') return;

		try {
			if (to?.url.pathname.startsWith('/library/tv/')) {
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
			if (from?.url.pathname.startsWith('/library/tv/')) {
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

	// Selection state — the same implementation the movie and music lists use.
	const selection = createListSelection();
	const selectedSeries = selection.ids;
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

	let drawerOpen = $state(false);

	const filteredSeries = $derived(
		searchQuery.trim()
			? data.series.filter((s) => s.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))
			: data.series
	);

	// Progressive rendering: only render a screenful + buffer at a time
	const renderer = createProgressiveRenderer(() => filteredSeries);
	let bulkLoading = $state(false);
	let currentBulkAction = $state<
		'monitor' | 'unmonitor' | 'quality' | 'delete' | 'language' | null
	>(null);
	let isLanguageModalOpen = $state(false);

	async function handleBulkLanguageApplied(updated: number) {
		selectedSeries.clear();
		toasts.success(m.toast_library_tv_qualityUpdatedCount({ count: updated }));
		await refreshAll();
	}
	let isQualityModalOpen = $state(false);
	let isDeleteModalOpen = $state(false);
	let pendingDeleteSeriesId = $state<string | null>(null);
	let isSearchModalOpen = $state(false);
	let selectedSeriesForSearch = $state<(typeof data.series)[number] | null>(null);
	let autoSearchingIds = new SvelteSet<string>();
	const searchProgress = createSearchProgress();

	const selectedCount = $derived(selection.count);

	async function handleBulkMonitor(monitored: boolean) {
		bulkLoading = true;
		currentBulkAction = monitored ? 'monitor' : 'unmonitor';
		try {
			const result = await batchSeries([...selectedSeries], { monitored });
			if (result.success) {
				data = {
					...data,
					series: data.series.map((show) =>
						selectedSeries.has(show.id) ? { ...show, monitored } : show
					)
				};
				toasts.success(
					monitored
						? m.toast_library_tv_monitoringCount({ count: result.updatedCount })
						: m.toast_library_tv_unmonitoredCount({ count: result.updatedCount })
				);
			} else {
				toasts.error(result.error || m.toast_library_tv_failedToUpdate());
			}
		} catch (error) {
			toasts.error(error instanceof ApiError ? error.message : m.toast_library_tv_failedToUpdate());
		} finally {
			bulkLoading = false;
			currentBulkAction = null;
		}
	}

	async function handleBulkQualityChange(profileId: string | null) {
		bulkLoading = true;
		currentBulkAction = 'quality';
		try {
			const result = await batchSeries([...selectedSeries], { scoringProfileId: profileId });
			if (result.success) {
				data = {
					...data,
					series: data.series.map((show) =>
						selectedSeries.has(show.id) ? { ...show, scoringProfileId: profileId } : show
					)
				};
				toasts.success(m.toast_library_tv_qualityUpdatedCount({ count: result.updatedCount }));
			} else {
				toasts.error(result.error || m.toast_library_tv_failedToUpdate());
			}
		} catch (error) {
			toasts.error(error instanceof ApiError ? error.message : m.toast_library_tv_failedToUpdate());
		} finally {
			bulkLoading = false;
			currentBulkAction = null;
		}
	}

	async function handleBulkDelete(deleteFiles: boolean, removeFromLibrary: boolean) {
		bulkLoading = true;
		currentBulkAction = 'delete';
		try {
			const result = await batchDeleteSeriesFiles(
				[...selectedSeries],
				deleteFiles,
				removeFromLibrary
			);
			if (result.success || result.deletedCount > 0 || result.removedCount > 0) {
				if (removeFromLibrary && result.removedCount > 0) {
					const updatedSeries = data.series.filter((show) => !selectedSeries.has(show.id));
					data = { ...data, series: updatedSeries };
					toasts.success(m.toast_library_tv_removedCount({ count: result.removedCount }));
				} else {
					const updatedSeries = data.series.map((show) =>
						selectedSeries.has(show.id)
							? { ...show, episodeFileCount: 0, percentComplete: 0 }
							: show
					);
					data = { ...data, series: updatedSeries };
					toasts.success(m.toast_library_tv_deletedFilesCount({ count: result.deletedCount }));
				}
				selection.clear();
				isDeleteModalOpen = false;
			} else {
				toasts.error(result.error || m.toast_library_tv_failedToDelete());
			}
		} catch (error) {
			toasts.error(error instanceof ApiError ? error.message : m.toast_library_tv_failedToDelete());
		} finally {
			bulkLoading = false;
			currentBulkAction = null;
		}
	}

	// Table action handlers
	async function handleMonitorToggle(seriesId: string, monitored: boolean) {
		const show = data.series.find((s) => s.id === seriesId);
		if (!show) return;

		try {
			const result = await updateSeries(seriesId, { monitored });
			if (result.success) {
				data = {
					...data,
					series: data.series.map((s) => (s.id === seriesId ? { ...s, monitored } : s))
				};
				toasts.success(
					m.toast_library_tv_monitorToggle({
						title: show.title,
						status: monitored ? m.common_monitored() : m.common_unmonitored()
					})
				);
			} else {
				toasts.error(result.error || m.toast_library_tv_failedToUpdateSingle());
			}
		} catch {
			toasts.error(m.toast_library_tv_failedToUpdateSeries());
		}
	}

	async function handleDeleteSeries(seriesId: string) {
		pendingDeleteSeriesId = seriesId;
		isDeleteModalOpen = true;
	}

	async function handleAutoGrab(seriesId: string) {
		const show = data.series.find((s) => s.id === seriesId);
		if (!show || autoSearchingIds.has(seriesId)) return;

		autoSearchingIds.add(seriesId);

		try {
			await searchProgress.startSearch(`/api/library/series/${seriesId}/auto-search`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'missing' })
			});

			if (searchProgress.results) {
				const summary = searchProgress.results.summary;
				const issue = getPrimaryAutoSearchIssue(searchProgress.results);
				if (summary && summary.grabbed > 0) {
					toasts.success(
						m.toast_library_tv_autoGrabbedCount({ count: summary.grabbed, title: show.title })
					);
				} else if (issue) {
					toasts.error(issue.message, { description: issue.description });
				} else if (summary && summary.found > 0) {
					toasts.info(m.toast_library_tv_foundNoMatch({ count: summary.found, title: show.title }));
				} else {
					toasts.info(m.toast_library_tv_noReleases({ title: show.title }));
				}
			}
		} catch (error) {
			toasts.error(
				error instanceof Error
					? error.message
					: m.toast_library_tv_failedAutoGrab({ title: show.title })
			);
		} finally {
			autoSearchingIds.delete(seriesId);
			searchProgress.reset();
		}
	}

	function handleManualGrab(seriesId: string) {
		const show = data.series.find((s) => s.id === seriesId);
		if (!show) return;
		selectedSeriesForSearch = show;
		isSearchModalOpen = true;
	}

	async function handleDeleteConfirm(deleteFiles: boolean, removeFromLibrary: boolean) {
		if (pendingDeleteSeriesId) {
			// Single item delete from list view
			const seriesId = pendingDeleteSeriesId;
			const show = data.series.find((s) => s.id === seriesId);
			if (!show) return;

			bulkLoading = true;
			currentBulkAction = 'delete';
			try {
				const result = await deleteSeries(seriesId, deleteFiles, removeFromLibrary);
				if (result.success) {
					if (removeFromLibrary) {
						data = { ...data, series: data.series.filter((s) => s.id !== seriesId) };
						toasts.success(m.toast_library_tv_removedFromLibrary({ title: show.title }));
					} else {
						data = {
							...data,
							series: data.series.map((s) =>
								s.id === seriesId ? { ...s, episodeFileCount: 0, percentComplete: 0 } : s
							)
						};
						toasts.success(
							deleteFiles
								? m.toast_library_tv_filesDeleted({ title: show.title })
								: m.toast_library_tv_unmatched({ title: show.title })
						);
					}
					isDeleteModalOpen = false;
					pendingDeleteSeriesId = null;
				} else {
					toasts.error(result.error || m.toast_library_tv_failedToDelete());
				}
			} catch {
				toasts.error(m.toast_library_tv_failedToDeleteSeries());
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
		{ value: 'title-asc', label: m.library_tv_sortTitleAsc() },
		{ value: 'title-desc', label: m.library_tv_sortTitleDesc() },
		{ value: 'added-desc', label: m.library_tv_sortAddedDesc() },
		{ value: 'added-asc', label: m.library_tv_sortAddedAsc() },
		{ value: 'progress-desc', label: m.library_tv_sortProgressDesc() },
		{ value: 'progress-asc', label: m.library_tv_sortProgressAsc() },
		{ value: 'missing-desc', label: m.library_tv_sortMissingDesc() },
		{ value: 'missing-asc', label: m.library_tv_sortMissingAsc() },
		{ value: 'missingPercent-desc', label: m.library_tv_sortMissingPercentDesc() },
		{ value: 'missingPercent-asc', label: m.library_tv_sortMissingPercentAsc() },
		{ value: 'year-desc', label: m.library_tv_sortYearDesc() },
		{ value: 'year-asc', label: m.library_tv_sortYearAsc() },
		{ value: 'size-desc', label: m.library_tv_sortSizeDesc() },
		{ value: 'size-asc', label: m.library_tv_sortSizeAsc() }
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
						label: m.library_tv_filterLibrary(),
						options: (data.libraryScope?.options ?? []).map((library) => ({
							value: library.slug,
							label: library.name
						}))
					}
				]
			: []),
		{
			key: 'monitored',
			label: m.library_tv_filterMonitored(),
			options: [
				{ value: 'all', label: m.library_tv_filterAll() },
				{ value: 'monitored', label: m.library_tv_filterMonitoredOnly() },
				{ value: 'partial', label: m.library_tv_filterPartiallyMonitored() },
				{ value: 'unmonitored', label: m.library_tv_filterNotMonitored() }
			]
		},
		{
			key: 'status',
			label: m.library_tv_filterShowStatus(),
			options: seriesStatusFilterOptions()
		},
		{
			key: 'progress',
			label: m.library_tv_filterProgress(),
			options: [
				{ value: 'all', label: m.library_tv_filterAll() },
				{ value: 'complete', label: m.library_tv_filterComplete() },
				{ value: 'inProgress', label: m.library_tv_filterInProgress() },
				{ value: 'notStarted', label: m.library_tv_filterNotStarted() }
			]
		},
		{
			key: 'missing',
			label: m.library_tv_filterMissing(),
			options: [
				{ value: 'all', label: m.library_tv_filterAll() },
				{ value: 'missing', label: m.library_tv_filterHasMissing() }
			]
		},
		{
			key: 'qualityProfile',
			label: m.library_tv_filterQualityProfile(),
			options: [
				{ value: 'all', label: m.library_tv_filterAll() },
				...data.qualityProfiles.map((p) => ({
					value: p.id,
					label: p.isDefault ? m.library_tv_profileDefault({ name: p.name }) : p.name
				}))
			]
		},
		...(data.uniqueResolutions.length > 0
			? [
					{
						key: 'resolution',
						label: m.library_tv_filterResolution(),
						options: [
							{ value: 'all', label: m.library_tv_filterAll() },
							...data.uniqueResolutions.map((r) => ({ value: r, label: r }))
						]
					}
				]
			: []),
		...(data.uniqueCodecs.length > 0
			? [
					{
						key: 'videoCodec',
						label: m.library_tv_filterVideoCodec(),
						options: [
							{ value: 'all', label: m.library_tv_filterAll() },
							...data.uniqueCodecs.map((c) => ({ value: c, label: c }))
						]
					}
				]
			: []),
		...(data.uniqueHdrFormats.length > 0
			? [
					{
						key: 'hdrFormat',
						label: m.library_tv_filterHdr(),
						options: [
							{ value: 'all', label: m.library_tv_filterAll() },
							{ value: 'sdr', label: m.library_tv_filterSdr() },
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
		const url = new URL(resolve('library/tv'), page.url.origin);
		if (data.libraryScope?.isSubLibraryScope && data.libraryScope?.selected?.slug) {
			url.searchParams.set('library', data.libraryScope.selected.slug);
		}
		url.searchParams.delete('q');
		goto(resolvePath(url.pathname + url.search), { reset: false });
	}

	function handleMonitorAll() {
		(document.getElementById('tv-monitor-all') as HTMLFormElement)?.requestSubmit();
	}

	function handleUnmonitorAll() {
		(document.getElementById('tv-unmonitor-all') as HTMLFormElement)?.requestSubmit();
	}

	const currentFilters = $derived({
		library: data.filters.library,
		monitored: data.filters.monitored,
		status: data.filters.status,
		progress: data.filters.progress,
		missing: data.filters.missing,
		qualityProfile: data.filters.qualityProfile,
		resolution: data.filters.resolution,
		videoCodec: data.filters.videoCodec,
		hdrFormat: data.filters.hdrFormat
	});
	const activeFilterCount = $derived(
		Object.entries(currentFilters).filter(([key, value]) => key !== 'library' && value !== 'all')
			.length
	);
	const downloadingSeriesIdSet = $derived(new Set(data.downloadingSeriesIds));
	const pendingDeleteSeries = $derived(
		pendingDeleteSeriesId ? data.series.find((s) => s.id === pendingDeleteSeriesId) : null
	);
</script>

<svelte:head><title>{m.library_tv_pageTitle()}</title></svelte:head>
<svelte:window onkeydown={selection.handleKeydown} />

<div class="min-h-screen bg-base-100 pb-20">
	<LibraryListHeader
		title={m.library_tv_heading()}
		total={data.total}
		totalUnfiltered={data.totalUnfiltered}
		ofTotalLabel={m.library_tv_ofTotal({ total: data.totalUnfiltered })}
		searchPlaceholder={m.library_tv_searchPlaceholder()}
		clearSearchLabel={m.library_tv_clearSearch()}
		bind:searchQuery
		searchMatches={filteredSeries.length}
		searchSource={data.series.length}
		viewMode={viewPreferences.viewMode}
		switchToGridLabel={m.library_tv_switchToGrid()}
		switchToListLabel={m.library_tv_switchToList()}
		onToggleView={() => viewPreferences.toggleViewMode()}
		{activeFilterCount}
		filterLabel={m.library_drawer_title()}
		onOpenFilters={() => (drawerOpen = true)}
	>
		{#snippet actions()}
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
								{m.library_tv_monitorAll()}
							</button>
						</li>
						<li>
							<button onclick={handleUnmonitorAll}>
								<EyeOff class="h-4 w-4" />
								{m.library_tv_unmonitorAll()}
							</button>
						</li>
					</ul>
				{/if}
			</div>

			{#if isAdminUser}
				<button
					class="btn gap-1.5 btn-ghost btn-xs sm:btn-sm {selection.mode ? 'btn-primary' : ''}"
					onclick={() => selection.cycle(filteredSeries)}
				>
					{#if !selection.mode}
						<CheckSquare class="h-4 w-4" />
						<span class="hidden sm:inline">{m.library_tv_select()}</span>
					{:else if !selection.allSelected(filteredSeries)}
						<CheckSquare class="h-4 w-4" />
						<span class="hidden sm:inline">{m.library_tv_selectAll()}</span>
					{:else}
						<XSquare class="h-4 w-4" />
						<span class="hidden sm:inline">{m.library_tv_done()}</span>
					{/if}
				</button>
			{/if}
		{/snippet}
	</LibraryListHeader>

	<!-- Main Content -->
	<main class="w-full px-4 py-8 lg:px-8">
		<LibraryListEmptyState
			error={data.error}
			{searchQuery}
			filteredCount={filteredSeries.length}
			sourceCount={data.series.length}
			totalUnfiltered={data.totalUnfiltered}
			discoverHref={resolvePath('/discover?type=tv')}
			discoverLabel={m.library_tv_discoverTvShows()}
			searchDiscoverHref={resolvePath(`/discover?type=tv&q=${encodeURIComponent(searchQuery)}`)}
			searchDiscoverLabel="Search in Discover"
			noSearchTitle={m.library_tv_noSearchMatch({ query: searchQuery })}
			noSearchHint={m.library_tv_tryDifferentSearch()}
			clearSearchLabel={m.library_tv_clearSearchBtn()}
			emptyTitle={m.library_tv_emptyLibrary()}
			emptyHint={m.library_tv_emptyLibraryHint()}
			noMatchTitle={m.library_tv_noFilterMatch()}
			noMatchHint={m.library_tv_noFilterMatchHint()}
			clearFiltersLabel={m.library_tv_clearFilters()}
			onClearSearch={() => (searchQuery = '')}
			onClearFilters={clearFilters}
		>
			{#snippet icon()}
				<Tv class="mb-4 h-20 w-20" />
			{/snippet}

			<!-- Defer until the client resolves the view preference to avoid a grid flash -->
			{#if viewPreferences.isReady}
				<div class="animate-in fade-in slide-in-from-bottom-4 duration-500">
					<LibraryListBody
						cards={renderer.visible.map((show) =>
							seriesCardView(show, data.preferOriginalTitleDefault)
						)}
						rows={renderer.visible.map((show) =>
							seriesRowView(show, data.preferOriginalTitleDefault, profileNameFor(show))
						)}
						kind="tv"
						viewMode={viewPreferences.viewMode}
						selectable={selection.mode}
						selectedIds={selectedSeries}
						onSelectChange={selection.toggle}
						downloadingIds={downloadingSeriesIdSet}
						{autoSearchingIds}
						onMonitorToggle={isAdminUser ? handleMonitorToggle : undefined}
						onDelete={isAdminUser ? handleDeleteSeries : undefined}
						onAutoGrab={isAdminUser ? handleAutoGrab : undefined}
						onManualGrab={isAdminUser ? handleManualGrab : undefined}
					/>

					<!-- Progressive rendering sentinel -->
					{#if renderer.hasMore}
						<div bind:this={renderer.sentinel} class="flex justify-center py-8">
							<span class="loading loading-md loading-dots text-base-content/30"></span>
						</div>
					{/if}
				</div>
			{/if}
		</LibraryListEmptyState>
	</main>

	<!-- Hidden forms for monitor actions -->
	<form
		id="tv-monitor-all"
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
		id="tv-unmonitor-all"
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

<LibraryBulkActions
	show={isAdminUser}
	{selectedCount}
	selectedIds={[...selectedSeries]}
	mediaType="tv"
	qualityProfiles={data.qualityProfiles}
	loading={bulkLoading}
	currentAction={currentBulkAction}
	downloadingIds={downloadingSeriesIdSet}
	pendingItem={pendingDeleteSeries
		? {
				id: pendingDeleteSeries.id,
				title: pendingDeleteSeries.title,
				hasFile: (pendingDeleteSeries.episodeFileCount ?? 0) > 0
			}
		: null}
	qualityOpen={isQualityModalOpen}
	languageOpen={isLanguageModalOpen}
	deleteOpen={isDeleteModalOpen}
	onMonitor={() => handleBulkMonitor(true)}
	onUnmonitor={() => handleBulkMonitor(false)}
	onChangeQuality={() => (isQualityModalOpen = true)}
	onQualitySave={handleBulkQualityChange}
	onQualityCancel={() => (isQualityModalOpen = false)}
	onLanguage={() => (isLanguageModalOpen = true)}
	onLanguageClose={() => (isLanguageModalOpen = false)}
	onLanguageApplied={handleBulkLanguageApplied}
	onDelete={() => (isDeleteModalOpen = true)}
	onDeleteConfirm={handleDeleteConfirm}
	onDeleteCancel={() => {
		isDeleteModalOpen = false;
		pendingDeleteSeriesId = null;
	}}
	onClear={selection.clear}
	deleteTitle={m.library_tv_deleteSeriesTitle()}
/>

<!-- Interactive Search Modal -->
{#if selectedSeriesForSearch}
	<MediaSearchModal
		open={isSearchModalOpen}
		seriesId={selectedSeriesForSearch.id}
		onClose={() => {
			isSearchModalOpen = false;
			selectedSeriesForSearch = null;
		}}
	/>
{/if}

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
	import BulkLanguageProfileModal from '#lib/components/library/BulkLanguageProfileModal.svelte';
	import BulkQualityProfileModal from '#lib/components/library/BulkQualityProfileModal.svelte';
	import BulkDeleteModal from '#lib/components/library/BulkDeleteModal.svelte';
	import DeleteConfirmationModal from '#lib/components/ui/modal/DeleteConfirmationModal.svelte';
	import { MediaSearchModal } from '#lib/components/search/index.js';
	import {
		Tv,
		X,
		LayoutGrid,
		List,
		Search,
		SlidersHorizontal,
		CheckSquare,
		XSquare,
		Eye,
		EyeOff,
		ChevronDown
	} from '@lucide/svelte';
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

	// Selection state
	let selectedSeries = new SvelteSet<string>();
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

	const selectedCount = $derived(selectedSeries.size);

	function toggleSelectionMode() {
		showCheckboxes = !showCheckboxes;
		if (!showCheckboxes) {
			selectedSeries.clear();
		}
	}

	function handleItemSelectChange(id: string, selected: boolean) {
		if (selected) {
			selectedSeries.add(id);
		} else {
			selectedSeries.delete(id);
		}
	}

	function selectAll() {
		for (const show of filteredSeries) {
			selectedSeries.add(show.id);
		}
	}

	function clearSelection() {
		selectedSeries.clear();
	}

	const allSelected = $derived(
		showCheckboxes && selectedSeries.size > 0 && selectedSeries.size === filteredSeries.length
	);

	function handleSelectToggle() {
		if (!showCheckboxes) {
			showCheckboxes = true;
		} else if (!allSelected) {
			selectAll();
		} else {
			showCheckboxes = false;
			selectedSeries.clear();
		}
	}

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
				selectedSeries.clear();
				showCheckboxes = false;
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

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && showCheckboxes) {
			toggleSelectionMode();
		}
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
						toasts.success(m.toast_library_tv_filesDeleted({ title: show.title }));
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
	const deleteModalCount = $derived(pendingDeleteSeriesId ? 1 : selectedCount);
	const pendingDeleteSeries = $derived(
		pendingDeleteSeriesId ? data.series.find((s) => s.id === pendingDeleteSeriesId) : null
	);
	const pendingDeleteSeriesTitle = $derived(pendingDeleteSeries?.title ?? '');
	const pendingDeleteSeriesHasFiles = $derived((pendingDeleteSeries?.episodeFileCount ?? 0) > 0);
	const pendingDeleteSeriesHasActiveDownload = $derived(
		pendingDeleteSeriesId ? downloadingSeriesIdSet.has(pendingDeleteSeriesId) : false
	);
	const bulkActiveDownloadCount = $derived(
		pendingDeleteSeriesId
			? 0
			: [...selectedSeries].filter((seriesId) => downloadingSeriesIdSet.has(seriesId)).length
	);
	const bulkHasActiveDownloads = $derived(bulkActiveDownloadCount > 0);
</script>

<svelte:head><title>{m.library_tv_pageTitle()}</title></svelte:head>
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
					{m.library_tv_heading()}
				</h1>
				<span class="badge badge-ghost badge-sm sm:badge-lg">{data.total}</span>
				{#if data.total !== data.totalUnfiltered}
					<span class="hidden text-sm text-base-content/50 sm:inline">
						{m.library_tv_ofTotal({ total: data.totalUnfiltered })}
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
						placeholder={m.library_tv_searchPlaceholder()}
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						bind:value={searchQuery}
					/>
					{#if searchQuery}
						<button
							class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
							onclick={() => (searchQuery = '')}
							aria-label={m.library_tv_clearSearch()}
						>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
				{#if searchQuery && filteredSeries.length !== data.series.length}
					<span class="shrink-0 text-xs text-base-content/50">
						{filteredSeries.length}/{data.series.length}
					</span>
				{/if}
			</div>

			<!-- Right: Quick Actions -->
			<div class="flex shrink-0 items-center gap-1.5">
				{#if isAdminUser}
					<div class="dropdown dropdown-end">
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
								<button onclick={handleMonitorAll}
									><Eye class="h-4 w-4" />{m.library_tv_monitorAll()}</button
								>
							</li>

							<li>
								<button onclick={handleUnmonitorAll}>
									<EyeOff class="h-4 w-4" />
									{m.library_tv_unmonitorAll()}
								</button>
							</li>
						</ul>
					</div>

					<button
						class="btn gap-1.5 btn-ghost btn-xs sm:btn-sm {showCheckboxes ? 'btn-primary' : ''}"
						onclick={handleSelectToggle}
					>
						{#if !showCheckboxes}
							<CheckSquare class="h-4 w-4" />
							<span class="hidden sm:inline">{m.library_tv_select()}</span>
						{:else if !allSelected}
							<CheckSquare class="h-4 w-4" />
							<span class="hidden sm:inline">{m.library_tv_selectAll()}</span>
						{:else}
							<XSquare class="h-4 w-4" />
							<span class="hidden sm:inline">{m.library_tv_done()}</span>
						{/if}
					</button>
				{/if}

				<!-- View Toggle -->
				<button
					class="btn btn-ghost btn-sm"
					onclick={() => viewPreferences.toggleViewMode()}
					aria-label={viewPreferences.viewMode === 'grid'
						? m.library_tv_switchToList()
						: m.library_tv_switchToGrid()}
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
					placeholder={m.library_tv_searchPlaceholder()}
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					bind:value={searchQuery}
				/>
				{#if searchQuery}
					<button
						class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
						onclick={() => (searchQuery = '')}
						aria-label={m.library_tv_clearSearch()}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
			{#if searchQuery && filteredSeries.length !== data.series.length}
				<span class="shrink-0 text-xs text-base-content/50">
					{filteredSeries.length}/{data.series.length}
				</span>
			{/if}
		</div>
	</div>

	<!-- Main Content -->
	<main class="w-full px-4 py-8 lg:px-8">
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
		{:else if filteredSeries.length === 0 && searchQuery}
			<!-- Search Empty State -->
			<div class="flex flex-col items-center justify-center py-20 text-center">
				<div class="opacity-50">
					<Search class="mx-auto mb-4 h-16 w-16" />
					<p class="text-2xl font-bold">{m.library_tv_noSearchMatch({ query: searchQuery })}</p>
					<p class="mt-2">{m.library_tv_tryDifferentSearch()}</p>
				</div>
				<div class="mt-6 flex gap-3">
					<button class="btn btn-ghost" onclick={() => (searchQuery = '')}
						>{m.library_tv_clearSearchBtn()}</button
					>

					<a
						href={resolvePath(`/discover?type=tv&q=${encodeURIComponent(searchQuery)}`)}
						class="btn btn-primary"
					>
						Search in Discover
					</a>
				</div>
			</div>
		{:else if data.series.length === 0}
			<!-- Empty State -->
			<div class="flex flex-col items-center justify-center py-20 text-center opacity-50">
				<Tv class="mb-4 h-20 w-20" />
				{#if data.totalUnfiltered === 0}
					<p class="text-2xl font-bold">{m.library_tv_emptyLibrary()}</p>
					<p class="mt-2">{m.library_tv_emptyLibraryHint()}</p>
					<a href={resolvePath('/discover?type=tv')} class="btn mt-6 btn-primary">
						{m.library_tv_discoverTvShows()}
					</a>
				{:else}
					<p class="text-2xl font-bold">{m.library_tv_noFilterMatch()}</p>
					<p class="mt-2">{m.library_tv_noFilterMatchHint()}</p>
					<button class="btn mt-6 btn-primary" onclick={clearFilters}
						>{m.library_tv_clearFilters()}</button
					>
				{/if}
			</div>
		{:else}
			<!-- Series Grid or List -->
			{#if !viewPreferences.isReady}
				<!-- Defer until client resolves view preference to avoid grid flash -->
			{:else}
				<div class="animate-in fade-in slide-in-from-bottom-4 duration-500">
					{#if viewPreferences.viewMode === 'grid'}
						<div
							class="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9"
						>
							{#each renderer.visible as show (show.id)}
								<LibraryMediaCard
									item={show}
									selectable={showCheckboxes}
									selected={selectedSeries.has(show.id)}
									onSelectChange={handleItemSelectChange}
									preferOriginalTitleDefault={data.preferOriginalTitleDefault}
								/>
							{/each}
						</div>
					{:else}
						<LibraryMediaTable
							items={renderer.visible}
							mediaType="tv"
							selectedItems={selectedSeries}
							selectable={showCheckboxes}
							qualityProfiles={data.qualityProfiles}
							downloadingIds={downloadingSeriesIdSet}
							{autoSearchingIds}
							onSelectChange={handleItemSelectChange}
							onMonitorToggle={isAdminUser ? handleMonitorToggle : undefined}
							onDelete={isAdminUser ? handleDeleteSeries : undefined}
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
				</div>
			{/if}
		{/if}
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

<!-- Bulk Action Bar (admin only) -->
{#if isAdminUser}
	<LibraryBulkActionBar
		{selectedCount}
		loading={bulkLoading}
		currentAction={currentBulkAction}
		mediaType="tv"
		onMonitor={() => handleBulkMonitor(true)}
		onUnmonitor={() => handleBulkMonitor(false)}
		onChangeQuality={() => (isQualityModalOpen = true)}
		onLanguage={() => (isLanguageModalOpen = true)}
		onDelete={() => (isDeleteModalOpen = true)}
		onClear={clearSelection}
	/>
{/if}

<!-- Bulk Language Profile Modal -->
<BulkLanguageProfileModal
	open={isLanguageModalOpen}
	mediaType="series"
	selectedIds={[...selectedSeries]}
	onClose={() => (isLanguageModalOpen = false)}
	onApplied={handleBulkLanguageApplied}
/>

<!-- Bulk Quality Profile Modal -->
<BulkQualityProfileModal
	open={isQualityModalOpen}
	{selectedCount}
	qualityProfiles={data.qualityProfiles}
	saving={bulkLoading && currentBulkAction === 'quality'}
	mediaType="tv"
	onSave={handleBulkQualityChange}
	onCancel={() => (isQualityModalOpen = false)}
/>

<!-- Single Item Delete Modal -->
<DeleteConfirmationModal
	open={isDeleteModalOpen && pendingDeleteSeriesId !== null}
	title={m.library_tv_deleteSeriesTitle()}
	itemName={pendingDeleteSeriesTitle}
	hasFiles={pendingDeleteSeriesHasFiles || pendingDeleteSeriesHasActiveDownload}
	hasActiveDownload={pendingDeleteSeriesHasActiveDownload}
	loading={bulkLoading && currentBulkAction === 'delete'}
	onConfirm={handleDeleteConfirm}
	onCancel={() => {
		isDeleteModalOpen = false;
		pendingDeleteSeriesId = null;
	}}
/>

<!-- Bulk Delete Modal -->
<BulkDeleteModal
	open={isDeleteModalOpen && pendingDeleteSeriesId === null}
	selectedCount={deleteModalCount}
	mediaType="tv"
	hasActiveDownloads={bulkHasActiveDownloads}
	activeDownloadCount={bulkActiveDownloadCount}
	loading={bulkLoading && currentBulkAction === 'delete'}
	onConfirm={handleDeleteConfirm}
	onCancel={() => {
		isDeleteModalOpen = false;
	}}
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

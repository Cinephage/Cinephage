<script lang="ts">
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { refreshAll } from '$app/navigation';
	import { goto } from '$app/navigation';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { formatDisplayDateShort } from '#lib/utils/format.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import ModalHeader from '#lib/components/ui/modal/ModalHeader.svelte';
	import {
		ArrowLeft,
		RefreshCw,
		Edit,
		Film,
		Tv,
		Search,
		X,
		Plus,
		Ban,
		Check,
		Loader2,
		Star,
		CalendarDays,
		Library,
		Globe,
		Database
	} from '@lucide/svelte';
	import type { PageData } from './$types';
	import * as m from '#lib/paraglide/messages.js';
	import { refreshSmartList, addSmartListItems } from '#lib/api/index.js';

	let { data }: { data: PageData } = $props();

	let refreshing = $state(false);
	let addingIds = $state<Set<number>>(new Set());
	let excludingIds = $state<Set<number>>(new Set());
	let bulkAdding = $state(false);
	let activeMobileActionCardId = $state<string | null>(null);
	let itemDetailOpen = $state(false);
	let selectedItem = $state<(typeof data.items)[number] | null>(null);

	let filterInLibrary = $state<'all' | 'in' | 'out'>('all');
	let showExcluded = $state(false);
	let searchQuery = $state('');

	type AddToLibraryResponse = {
		added: number;
		failed: number;
		alreadyInLibrary: number;
		errors?: Array<{ tmdbId: number; title: string; error: string }>;
		error?: string;
	};

	$effect(() => {
		filterInLibrary =
			data.filters.inLibrary === 'in' || data.filters.inLibrary === 'out'
				? data.filters.inLibrary
				: 'all';
		showExcluded = data.filters.showExcluded;
		searchQuery = data.filters.query ?? '';
		activeMobileActionCardId = null;
	});

	function isCompactActionMode(): boolean {
		if (typeof window === 'undefined') return false;
		return window.matchMedia('(max-width: 767px), (hover: none), (pointer: coarse)').matches;
	}

	function openItemDetails(item: (typeof data.items)[number]): void {
		selectedItem = item;
		itemDetailOpen = true;
		activeMobileActionCardId = null;
	}

	function closeItemDetails(): void {
		itemDetailOpen = false;
		selectedItem = null;
	}

	function formatReleaseDate(date: string | null | undefined): string | null {
		if (!date) return null;
		const parsed = new Date(date);
		if (Number.isNaN(parsed.getTime())) return date;
		return formatDisplayDateShort(date);
	}

	function handleCardActivate(item: (typeof data.items)[number]): void {
		if (isCompactActionMode()) {
			if (activeMobileActionCardId === item.id) {
				openItemDetails(item);
			} else {
				activeMobileActionCardId = item.id;
			}
			return;
		}
		openItemDetails(item);
	}

	async function refreshList() {
		refreshing = true;
		try {
			const result = (await refreshSmartList(data.list.id)) as {
				error?: string;
				errorMessage?: string;
				status?: string;
			};

			if (result?.status === 'failed') {
				throw new Error(result?.errorMessage ?? result?.error ?? 'Smart list refresh failed');
			}

			await refreshAll();
		} catch (error) {
			const message = error instanceof Error ? error.message : m.smartlists_detail_refreshFailed();
			toasts.error(m.smartlists_detail_refreshFailed(), { description: message });
		} finally {
			refreshing = false;
		}
	}

	function navigateToEdit() {
		goto(`/smartlists/${data.list.id}/edit`);
	}

	async function addToLibrary(tmdbId: number, title: string) {
		addingIds.add(tmdbId);
		addingIds = addingIds;
		try {
			const result = (await addSmartListItems(data.list.id, {
				action: 'addToLibrary',
				tmdbIds: [tmdbId]
			})) as unknown as AddToLibraryResponse | null;

			if (!result) {
				throw new Error(m.smartlists_detail_invalidAddResponse());
			}

			if (result.failed > 0) {
				throw new Error(result.errors?.[0]?.error ?? m.smartlists_detail_failedToAddToLibrary());
			}

			toasts.success(m.smartlists_detail_addedToLibrary({ title }));
			closeItemDetails();
			await refreshAll();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : m.smartlists_detail_failedToAddToLibrary();
			toasts.error(m.smartlists_detail_failedToAddToLibrary(), { description: message });
		} finally {
			addingIds.delete(tmdbId);
			addingIds = addingIds;
			activeMobileActionCardId = null;
		}
	}

	async function excludeItem(tmdbId: number, title: string) {
		excludingIds.add(tmdbId);
		excludingIds = excludingIds;
		try {
			await addSmartListItems(data.list.id, {
				action: 'exclude',
				tmdbIds: [tmdbId]
			});
			toasts.success(m.smartlists_detail_excludedFromList({ title }));
			closeItemDetails();
			await refreshAll();
		} finally {
			excludingIds.delete(tmdbId);
			excludingIds = excludingIds;
			activeMobileActionCardId = null;
		}
	}

	async function includeItem(tmdbId: number, title: string) {
		excludingIds.add(tmdbId);
		excludingIds = excludingIds;
		try {
			await addSmartListItems(data.list.id, {
				action: 'include',
				tmdbIds: [tmdbId]
			});
			toasts.success(m.smartlists_detail_includedInList({ title }));
			closeItemDetails();
			await refreshAll();
		} finally {
			excludingIds.delete(tmdbId);
			excludingIds = excludingIds;
			activeMobileActionCardId = null;
		}
	}

	async function addAllToLibrary() {
		if (!confirm(m.smartlists_detail_addAllConfirm())) return;
		const tmdbIds = data.items
			.filter((i: (typeof data.items)[0]) => !i.inLibrary && !i.isExcluded)
			.map((i: (typeof data.items)[0]) => i.tmdbId);

		if (tmdbIds.length === 0) {
			toasts.info(m.smartlists_detail_noEligibleItems());
			return;
		}

		bulkAdding = true;
		try {
			const result = (await addSmartListItems(data.list.id, {
				action: 'addToLibrary',
				tmdbIds
			})) as unknown as AddToLibraryResponse | null;

			if (!result) {
				throw new Error(m.smartlists_detail_invalidAddResponse());
			}

			if (result.failed > 0) {
				const firstError = result.errors?.[0]?.error;
				toasts.warning(
					m.smartlists_detail_addedBulkPartial({ added: result.added, failed: result.failed }),
					{
						description: firstError
					}
				);
			}

			await refreshAll();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : m.smartlists_detail_failedToAddItems();
			toasts.error(m.smartlists_detail_failedToAddItems(), { description: message });
		} finally {
			bulkAdding = false;
		}
	}

	function applyFilters(options?: { keepFocus?: boolean; replaceState?: boolean }) {
		const params = new SvelteURLSearchParams();
		if (filterInLibrary === 'in') params.set('inLibrary', 'true');
		else if (filterInLibrary === 'out') params.set('inLibrary', 'false');
		if (showExcluded) params.set('includeExcluded', 'true');
		const trimmedQuery = searchQuery.trim();
		if (trimmedQuery) params.set('q', trimmedQuery);

		const queryString = params.toString();
		if (typeof window !== 'undefined') {
			const current = new URLSearchParams(window.location.search).toString();
			if (current === queryString) return;
		}
		goto(`/smartlists/${data.list.id}${queryString ? '?' + queryString : ''}`, {
			refreshAll: true,
			reset: !(options?.keepFocus ?? false),
			replace: options?.replaceState ?? false
		});
	}

	let searchDebounceTimeout: ReturnType<typeof setTimeout> | null = null;

	function onSearchInput() {
		if (searchDebounceTimeout) {
			clearTimeout(searchDebounceTimeout);
		}
		searchDebounceTimeout = setTimeout(() => {
			searchDebounceTimeout = null;
			applyFilters({ keepFocus: true, replaceState: true });
		}, 250);
	}

	function goToPage(page: number) {
		const params = new SvelteURLSearchParams(window.location.search);
		params.set('page', String(page));
		goto(`/smartlists/${data.list.id}?${params.toString()}`, { refreshAll: true });
	}

	const filteredItems = $derived(
		data.items.filter((item: (typeof data.items)[0]) => {
			if (!showExcluded && item.isExcluded) return false;
			return true;
		})
	);
</script>

<div class="w-full p-4">
	<div class="mb-6">
		<a href="/smartlists" class="btn gap-1 btn-ghost btn-sm">
			<ArrowLeft class="h-4 w-4" />
			{m.smartlists_detail_backToSmartLists()}
		</a>
	</div>

	<ModalWrapper open={itemDetailOpen} onClose={closeItemDetails} maxWidth="2xl">
		<ModalHeader
			title={selectedItem ? selectedItem.title : m.smartlists_detail_itemDetailsTitle()}
			onClose={closeItemDetails}
		/>

		{#if selectedItem}
			<div class="space-y-4">
				<div class="flex flex-col gap-4 sm:flex-row">
					<div class="mx-auto w-32 shrink-0 sm:mx-0">
						<div class="aspect-2/3 overflow-hidden rounded-lg bg-base-200 shadow-sm">
							{#if selectedItem.posterPath}
								<img
									src="https://image.tmdb.org/t/p/w342{selectedItem.posterPath}"
									alt={selectedItem.title}
									class="h-full w-full object-cover"
									loading="lazy"
								/>
							{:else}
								<div class="flex h-full w-full items-center justify-center">
									{#if selectedItem.mediaType === 'movie'}
										<Film class="h-8 w-8 text-base-content/30" />
									{:else}
										<Tv class="h-8 w-8 text-base-content/30" />
									{/if}
								</div>
							{/if}
						</div>
					</div>

					<div class="min-w-0 flex-1 space-y-3">
						<div class="flex flex-wrap items-center gap-2">
							<div
								class="badge {selectedItem.mediaType === 'movie'
									? 'badge-primary'
									: 'badge-secondary'}"
							>
								{selectedItem.mediaType === 'movie'
									? m.smartlists_detail_badgeMovie()
									: m.smartlists_detail_badgeTvShow()}
							</div>
							{#if selectedItem.inLibrary}
								<div class="badge badge-success">{m.smartlists_detail_badgeInLibrary()}</div>
							{/if}
							{#if selectedItem.isExcluded}
								<div class="badge badge-error">{m.smartlists_detail_badgeExcluded()}</div>
							{/if}
							{#if selectedItem.year}
								<div class="badge badge-ghost">{selectedItem.year}</div>
							{/if}
						</div>

						<div class="flex flex-wrap gap-4 text-sm text-base-content/70">
							{#if selectedItem.voteAverage}
								<div class="flex items-center gap-1">
									<Star class="h-4 w-4 fill-warning text-warning" />
									<span>{parseFloat(selectedItem.voteAverage).toFixed(1)}</span>
								</div>
							{/if}
							{#if selectedItem.releaseDate}
								<div class="flex items-center gap-1">
									<CalendarDays class="h-4 w-4" />
									<span>{formatReleaseDate(selectedItem.releaseDate)}</span>
								</div>
							{/if}
						</div>

						{#if selectedItem.overview}
							<p class="text-sm leading-relaxed text-base-content/80">{selectedItem.overview}</p>
						{:else}
							<p class="text-sm text-base-content/60">{m.smartlists_detail_noSynopsis()}</p>
						{/if}
					</div>
				</div>

				<div class="flex flex-wrap justify-end gap-2 border-t border-base-300 pt-3">
					{#if selectedItem.isExcluded}
						<button
							type="button"
							class="btn btn-sm btn-success"
							onclick={() => includeItem(selectedItem!.tmdbId, selectedItem!.title)}
							disabled={excludingIds.has(selectedItem!.tmdbId)}
						>
							{#if excludingIds.has(selectedItem!.tmdbId)}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<Check class="h-4 w-4" />
							{/if}
							{m.smartlists_detail_includeButton()}
						</button>
					{:else}
						{#if !selectedItem.inLibrary}
							<button
								type="button"
								class="btn btn-primary btn-sm"
								onclick={() => addToLibrary(selectedItem!.tmdbId, selectedItem!.title)}
								disabled={addingIds.has(selectedItem!.tmdbId)}
							>
								{#if addingIds.has(selectedItem!.tmdbId)}
									<Loader2 class="h-4 w-4 animate-spin" />
								{:else}
									<Plus class="h-4 w-4" />
								{/if}
								{m.smartlists_detail_addToLibrary()}
							</button>
						{/if}
						<button
							type="button"
							class="btn btn-error btn-sm"
							onclick={() => excludeItem(selectedItem!.tmdbId, selectedItem!.title)}
							disabled={excludingIds.has(selectedItem!.tmdbId)}
						>
							{#if excludingIds.has(selectedItem!.tmdbId)}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<Ban class="h-4 w-4" />
							{/if}
							{m.smartlists_detail_excludeButton()}
						</button>
					{/if}
				</div>
			</div>
		{/if}
	</ModalWrapper>

	<div class="mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
		<div class="min-w-0">
			<div class="flex min-w-0 items-center gap-3">
				{#if data.list.mediaType === 'movie'}
					<Film class="h-8 w-8 shrink-0 text-primary" />
				{:else}
					<Tv class="h-8 w-8 shrink-0 text-secondary" />
				{/if}
				<h1 class="truncate text-2xl font-bold">{data.list.name}</h1>
			</div>

			{#if data.list.description}
				<p class="mt-2 text-sm text-base-content/70 sm:text-base">{data.list.description}</p>
			{/if}

			<div class="mt-2 flex flex-wrap gap-2">
				<div class="badge badge-ghost">
					{m.smartlists_itemsBadge({ count: data.pagination.totalItems })}
				</div>
				<div class="badge badge-ghost">
					{m.smartlists_inLibraryBadge({ count: data.list.itemsInLibrary ?? 0 })}
				</div>
				{#if data.list.autoAddBehavior !== 'disabled'}
					<div class="badge badge-outline badge-info">{m.smartlists_detail_autoAddEnabled()}</div>
				{/if}
				{#if data.list.listSourceType === 'external-json'}
					<div class="badge flex items-center gap-1 badge-outline badge-secondary">
						<Globe class="h-3 w-3" />
						{m.smartlists_source_externalJson()}
					</div>
				{:else if data.list.listSourceType === 'trakt-list'}
					<div class="badge badge-outline badge-accent">{m.smartlists_source_traktList()}</div>
				{:else if data.list.listSourceType === 'custom-manual'}
					<div class="badge badge-outline badge-warning">{m.common_custom()}</div>
				{:else}
					<div class="badge flex items-center gap-1 badge-outline badge-primary">
						<Database class="h-3 w-3" />
						{m.smartlists_source_tmdbDiscover()}
					</div>
				{/if}
			</div>
		</div>
		<div class="flex w-full gap-2 sm:w-auto">
			<button class="btn btn-outline btn-sm" onclick={refreshList} disabled={refreshing}>
				<RefreshCw class="h-4 w-4 {refreshing ? 'animate-spin' : ''}" />
				{#if data.list.listSourceType === 'external-json'}
					{m.smartlists_detail_syncButton()}
				{:else}
					{m.smartlists_detail_refreshButton()}
				{/if}
			</button>
			<button class="btn btn-outline btn-sm" onclick={navigateToEdit}>
				<Edit class="h-4 w-4" />
				{m.smartlists_detail_editButton()}
			</button>
			<button class="btn btn-primary btn-sm" onclick={addAllToLibrary} disabled={bulkAdding}>
				{#if bulkAdding}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Plus class="h-4 w-4" />
				{/if}
				{m.smartlists_detail_addAllButton()}
			</button>
		</div>
	</div>

	<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
		<div class="flex items-center gap-2 overflow-x-auto">
			<div class="join shrink-0">
				<button
					class="btn join-item btn-xs sm:btn-sm {filterInLibrary === 'all' ? 'btn-active' : ''}"
					onclick={() => {
						filterInLibrary = 'all';
						applyFilters();
					}}
				>
					{m.smartlists_detail_filterAll()}
				</button>
				<button
					class="btn join-item btn-xs sm:btn-sm {filterInLibrary === 'out' ? 'btn-active' : ''}"
					onclick={() => {
						filterInLibrary = 'out';
						applyFilters();
					}}
				>
					{m.smartlists_detail_filterNotInLibrary()}
				</button>
				<button
					class="btn join-item btn-xs sm:btn-sm {filterInLibrary === 'in' ? 'btn-active' : ''}"
					onclick={() => {
						filterInLibrary = 'in';
						applyFilters();
					}}
				>
					{m.smartlists_detail_filterInLibrary()}
				</button>
			</div>
			<label class="label shrink-0 cursor-pointer gap-1.5 py-0 whitespace-nowrap sm:gap-2">
				<input
					type="checkbox"
					class="checkbox checkbox-sm checkbox-primary"
					bind:checked={showExcluded}
					onchange={() => applyFilters()}
				/>
				<span class="label-text">{m.smartlists_detail_showExcluded()}</span>
			</label>
		</div>
		<div class="group relative w-full sm:ml-auto sm:w-72">
			<Search
				class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-base-content/40 transition-colors group-focus-within:text-primary"
			/>
			<input
				type="text"
				placeholder={m.smartlists_detail_searchPlaceholder()}
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				bind:value={searchQuery}
				oninput={onSearchInput}
			/>
			{#if searchQuery.trim()}
				<button
					type="button"
					class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
					onclick={() => {
						if (searchDebounceTimeout) {
							clearTimeout(searchDebounceTimeout);
							searchDebounceTimeout = null;
						}
						searchQuery = '';
						applyFilters({ keepFocus: true, replaceState: true });
					}}
					aria-label="Clear search"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
	</div>

	{#if filteredItems.length === 0}
		<div class="card bg-base-100 shadow-xl">
			<div class="card-body items-center text-center">
				<Library class="h-16 w-16 text-base-content/30" />
				<h2 class="card-title">{m.smartlists_detail_noItemsTitle()}</h2>
				<p class="text-base-content/70">
					{#if data.pagination.totalItems === 0}
						{m.smartlists_detail_noItemsNotRefreshed()}
					{:else if data.filters.query}
						{m.smartlists_detail_noItemsMatchSearch()}
					{:else}
						{m.smartlists_detail_noItemsMatchFilters()}
					{/if}
				</p>
				{#if data.pagination.totalItems === 0}
					<button class="btn mt-4 btn-primary" onclick={refreshList} disabled={refreshing}>
						<RefreshCw class="h-4 w-4 {refreshing ? 'animate-spin' : ''}" />
						{m.smartlists_detail_refreshNow()}
					</button>
				{/if}
			</div>
		</div>
	{:else}
		<div
			class="grid grid-cols-3 gap-3 sm:grid-cols-5 sm:gap-4 md:grid-cols-6 lg:grid-cols-9 xl:grid-cols-9"
		>
			{#each filteredItems as item (item.id)}
				<div class="group relative {item.isExcluded ? 'opacity-50' : ''}">
					<div
						class="relative aspect-2/3 overflow-hidden rounded-lg bg-base-300 shadow-sm"
						role="button"
						tabindex="0"
						aria-label={`Open details for ${item.title}`}
						onpointerup={() => handleCardActivate(item)}
						onkeydown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								handleCardActivate(item);
							}
						}}
					>
						{#if item.posterPath}
							<img
								src="https://image.tmdb.org/t/p/w185{item.posterPath}"
								alt={item.title}
								class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
								loading="lazy"
							/>
						{:else}
							<div class="flex h-full w-full items-center justify-center">
								{#if data.list.mediaType === 'movie'}
									<Film class="h-8 w-8 text-base-content/30" />
								{:else}
									<Tv class="h-8 w-8 text-base-content/30" />
								{/if}
							</div>
						{/if}

						<!-- Rating badge -->
						{#if item.voteAverage}
							<div
								class="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white shadow-sm backdrop-blur-sm"
							>
								<Star class="h-2.5 w-2.5 fill-warning text-warning" />
								{parseFloat(item.voteAverage).toFixed(1)}
							</div>
						{/if}

						<!-- In library badge -->
						{#if item.inLibrary}
							<div class="absolute top-2 left-2 z-10">
								<div
									class="flex h-6 w-6 items-center justify-center rounded-full bg-success/90 text-success-content shadow-md backdrop-blur-sm"
									title={m.smartlists_detail_badgeInLibrary()}
								>
									<Check class="h-4 w-4" strokeWidth={3} />
								</div>
							</div>
						{/if}

						<!-- Excluded badge -->
						{#if item.isExcluded}
							<div class="absolute top-2 z-10 {item.inLibrary ? 'left-10' : 'left-2'}">
								<div
									class="flex h-6 w-6 items-center justify-center rounded-full bg-error/90 text-error-content shadow-md backdrop-blur-sm"
									title={m.smartlists_detail_badgeExcluded()}
								>
									<Ban class="h-3.5 w-3.5" />
								</div>
							</div>
						{/if}

						<!-- Card actions -->
						<div
							class="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-base-100/90 p-1.5 shadow-lg ring-1 ring-black/5 backdrop-blur-sm transition-opacity md:pointer-events-auto md:opacity-0 md:group-hover:opacity-100 {activeMobileActionCardId ===
							item.id
								? 'pointer-events-auto opacity-100'
								: 'pointer-events-none opacity-0'}"
						>
							{#if item.isExcluded}
								<button
									type="button"
									class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-success/95 text-success-content shadow-sm transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
									onpointerup={(event) => event.stopPropagation()}
									onclick={() => includeItem(item.tmdbId, item.title)}
									disabled={excludingIds.has(item.tmdbId)}
									title={m.smartlists_detail_includeButton()}
									aria-label={m.smartlists_detail_includeButton()}
								>
									{#if excludingIds.has(item.tmdbId)}
										<Loader2 class="h-3 w-3 animate-spin" />
									{:else}
										<Check class="h-4 w-4" />
									{/if}
								</button>
							{:else}
								{#if !item.inLibrary}
									<button
										type="button"
										class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-content shadow-sm transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
										onpointerup={(event) => event.stopPropagation()}
										onclick={() => addToLibrary(item.tmdbId, item.title)}
										disabled={addingIds.has(item.tmdbId)}
										title={m.smartlists_detail_addToLibrary()}
										aria-label={m.smartlists_detail_addToLibrary()}
									>
										{#if addingIds.has(item.tmdbId)}
											<Loader2 class="h-3 w-3 animate-spin" />
										{:else}
											<Plus class="h-4 w-4" />
										{/if}
									</button>
								{/if}
								<button
									type="button"
									class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-error/95 text-error-content shadow-sm transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
									onpointerup={(event) => event.stopPropagation()}
									onclick={() => excludeItem(item.tmdbId, item.title)}
									disabled={excludingIds.has(item.tmdbId)}
									title={m.smartlists_detail_excludeButton()}
									aria-label={m.smartlists_detail_excludeButton()}
								>
									{#if excludingIds.has(item.tmdbId)}
										<Loader2 class="h-3 w-3 animate-spin" />
									{:else}
										<Ban class="h-4 w-4" />
									{/if}
								</button>
							{/if}
						</div>
					</div>

					<!-- Title -->
					<div class="mt-1">
						<button
							type="button"
							class="line-clamp-1 w-full cursor-pointer text-left text-xs font-medium hover:underline"
							title={`Open details for ${item.title}`}
							onclick={() => openItemDetails(item)}
						>
							{item.title}
						</button>
						{#if item.year}
							<p class="text-[10px] text-base-content/60">{item.year}</p>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		{#if data.pagination.totalPages > 1}
			<div class="mt-6 flex justify-center">
				<div class="join">
					<button
						class="btn join-item btn-sm"
						disabled={data.pagination.page <= 1}
						onclick={() => goToPage(data.pagination.page - 1)}
					>
						{m.smartlists_detail_paginationPrevious()}
					</button>
					<button class="btn join-item btn-sm">
						{m.smartlists_detail_paginationPageOf({
							page: data.pagination.page,
							totalPages: data.pagination.totalPages
						})}
					</button>
					<button
						class="btn join-item btn-sm"
						disabled={data.pagination.page >= data.pagination.totalPages}
						onclick={() => goToPage(data.pagination.page + 1)}
					>
						{m.smartlists_detail_paginationNext()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

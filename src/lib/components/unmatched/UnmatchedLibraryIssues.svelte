<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import {
		AlertCircle,
		AlertTriangle,
		ChevronDown,
		ChevronRight,
		Link,
		Loader2
	} from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import type { LibraryIssue, RootFolderOption } from '#lib/types/unmatched.js';
	import { getUnmatchedIssues, updateMovie, updateSeries } from '#lib/api/library.js';

	interface Props {
		unmatchedFileCount?: number;
	}

	let { unmatchedFileCount = 0 }: Props = $props();

	let libraryItems = $state<LibraryIssue[]>([]);
	let rootFolders = $state<RootFolderOption[]>([]);
	let loading = $state(false);
	let libraryIssuesOpen = $state(false);
	let libraryIssuesFilter = $state<'movie' | 'tv'>('movie');
	let selectedIssues = $state<string[]>([]);
	let selectedRootFolders = $state<Record<string, string>>({});
	let bulkMovieRootFolder = $state('');
	let bulkTvRootFolder = $state('');
	let bulkSavingMovie = $state(false);
	let bulkSavingTv = $state(false);
	const savingIssues = new SvelteMap<string, boolean>();

	const selectedIssueSet = $derived.by(() => new Set(selectedIssues));
	const issueCounts = $derived.by(() => {
		const selectedSet = new Set(selectedIssues);
		let movieCount = 0;
		let tvCount = 0;
		let missingCount = 0;
		let invalidCount = 0;
		let selectedMovie = 0;
		let selectedTv = 0;

		for (const item of libraryItems) {
			if (item.mediaType === 'movie') {
				movieCount += 1;
			} else {
				tvCount += 1;
			}

			if (item.issue === 'invalid_root_folder') {
				invalidCount += 1;
			} else {
				missingCount += 1;
			}

			if (selectedSet.has(item.id)) {
				if (item.mediaType === 'movie') {
					selectedMovie += 1;
				} else {
					selectedTv += 1;
				}
			}
		}

		return {
			movieCount,
			tvCount,
			missingCount,
			invalidCount,
			selectedMovie,
			selectedTv
		};
	});
	const movieIssueCount = $derived(issueCounts.movieCount);
	const tvIssueCount = $derived(issueCounts.tvCount);
	const missingIssueCount = $derived(issueCounts.missingCount);
	const invalidIssueCount = $derived(issueCounts.invalidCount);
	const selectedMovieCount = $derived(issueCounts.selectedMovie);
	const selectedTvCount = $derived(issueCounts.selectedTv);
	const selectedFilteredCount = $derived(
		libraryIssuesFilter === 'movie' ? selectedMovieCount : selectedTvCount
	);
	const movieFolders = $derived(rootFolders.filter((folder) => folder.mediaType === 'movie'));
	const tvFolders = $derived(rootFolders.filter((folder) => folder.mediaType === 'tv'));
	const filteredLibraryItems = $derived(
		libraryItems.filter((item) => item.mediaType === libraryIssuesFilter)
	);
	const issueSummaryLabel = $derived.by(() => {
		if (missingIssueCount > 0 && invalidIssueCount > 0)
			return m.unmatched_libraryIssues_missingOrInvalidRoot();
		if (invalidIssueCount > 0) return m.unmatched_libraryIssues_invalidRootAssignment();
		return m.unmatched_libraryIssues_missingRoot();
	});
	const issueDetailLabel = $derived.by(() => {
		if (missingIssueCount > 0 && invalidIssueCount > 0) {
			return m.unmatched_libraryIssues_missingOrInvalidDescription();
		}
		if (invalidIssueCount > 0) {
			return m.unmatched_libraryIssues_invalidDescription();
		}
		return m.unmatched_libraryIssues_missingDescription();
	});

	onMount(() => {
		void loadIssues();
	});

	$effect(() => {
		if (movieIssueCount > 0 && tvIssueCount === 0 && libraryIssuesFilter !== 'movie') {
			libraryIssuesFilter = 'movie';
		} else if (tvIssueCount > 0 && movieIssueCount === 0 && libraryIssuesFilter !== 'tv') {
			libraryIssuesFilter = 'tv';
		}
	});

	$effect(() => {
		// Keep the issues panel collapsed whenever unmatched files exist.
		if (unmatchedFileCount > 0) {
			libraryIssuesOpen = false;
		}
	});

	function getSelectedRootFolder(itemId: string): string {
		return selectedRootFolders[itemId] ?? '';
	}

	function setSelectedRootFolder(itemId: string, rootFolderId: string): void {
		selectedRootFolders = { ...selectedRootFolders, [itemId]: rootFolderId };
	}

	function clearSelectedRootFolder(itemId: string): void {
		if (!(itemId in selectedRootFolders)) return;
		const { [itemId]: _removed, ...rest } = selectedRootFolders;
		selectedRootFolders = rest;
	}

	function clearSelectionsForIds(ids: string[]): void {
		selectedIssues = selectedIssues.filter((id) => !ids.includes(id));
		for (const id of ids) {
			clearSelectedRootFolder(id);
		}
	}

	async function loadIssues(): Promise<void> {
		loading = true;
		try {
			const result = (await getUnmatchedIssues()) as unknown as {
				success: boolean;
				data: {
					libraryItems?: LibraryIssue[];
					rootFolders?: RootFolderOption[];
					total?: number;
				};
				error?: string;
			};

			if (result.success) {
				libraryItems = result.data.libraryItems ?? [];
				rootFolders = result.data.rootFolders ?? [];
				if ((result.data.total ?? 0) > 0) {
					libraryIssuesOpen = unmatchedFileCount === 0;
				}
			} else {
				toasts.error(m.unmatched_libraryIssues_failedToLoad(), {
					description: result.error || 'Please try again'
				});
			}
		} catch {
			toasts.error(m.unmatched_libraryIssues_failedToLoad());
		} finally {
			loading = false;
		}
	}

	async function assignRootFolder(item: LibraryIssue, rootFolderId: string): Promise<boolean> {
		try {
			if (item.mediaType === 'movie') {
				await updateMovie(item.id, { rootFolderId });
			} else {
				await updateSeries(item.id, { rootFolderId });
			}
			return true;
		} catch {
			return false;
		}
	}

	async function updateRootFolder(item: LibraryIssue): Promise<void> {
		const rootFolderId = getSelectedRootFolder(item.id);
		if (!rootFolderId) {
			toasts.info(m.unmatched_libraryIssues_selectRootFolderFirst());
			return;
		}

		savingIssues.set(item.id, true);
		try {
			const success = await assignRootFolder(item, rootFolderId);
			if (success) {
				libraryItems = libraryItems.filter((libraryItem) => libraryItem.id !== item.id);
				clearSelectionsForIds([item.id]);
				toasts.success(m.unmatched_libraryIssues_rootFolderUpdated());
			} else {
				toasts.error(m.unmatched_libraryIssues_rootFolderUpdateFailed());
			}
		} catch {
			toasts.error(m.unmatched_libraryIssues_rootFolderUpdateFailed());
		} finally {
			savingIssues.delete(item.id);
		}
	}

	function toggleIssueSelection(itemId: string): void {
		if (selectedIssueSet.has(itemId)) {
			selectedIssues = selectedIssues.filter((id) => id !== itemId);
			return;
		}
		selectedIssues = [...selectedIssues, itemId];
	}

	function selectAllIssues(mediaType: 'movie' | 'tv'): void {
		selectedIssues = libraryItems
			.filter((item) => item.mediaType === mediaType)
			.map((item) => item.id);
	}

	function clearIssueSelection(): void {
		selectedIssues = [];
	}

	function getIssueLabel(issue: LibraryIssue['issue']): string {
		return issue === 'invalid_root_folder'
			? m.unmatched_libraryIssues_invalidRootFolder()
			: m.unmatched_libraryIssues_rootFolderNotSet();
	}

	function getIssueTextClass(issue: LibraryIssue['issue']): string {
		return issue === 'invalid_root_folder' ? 'text-error' : 'text-warning';
	}

	async function bulkAssignRootFolder(mediaType: 'movie' | 'tv'): Promise<void> {
		const rootFolderId = mediaType === 'movie' ? bulkMovieRootFolder : bulkTvRootFolder;
		if (!rootFolderId) {
			toasts.info(m.unmatched_libraryIssues_selectRootFolderFirst());
			return;
		}

		const selectedItems = libraryItems.filter(
			(item) => item.mediaType === mediaType && selectedIssueSet.has(item.id)
		);
		if (selectedItems.length === 0) {
			toasts.info(m.unmatched_libraryIssues_selectItemsFirst());
			return;
		}

		if (mediaType === 'movie') {
			bulkSavingMovie = true;
		} else {
			bulkSavingTv = true;
		}
		for (const item of selectedItems) {
			savingIssues.set(item.id, true);
		}

		try {
			const results = await Promise.all(
				selectedItems.map(async (item) => {
					try {
						return await assignRootFolder(item, rootFolderId);
					} catch {
						return false;
					}
				})
			);

			const successIds = selectedItems.filter((_, index) => results[index]).map((item) => item.id);
			const failedCount = selectedItems.length - successIds.length;

			if (successIds.length > 0) {
				libraryItems = libraryItems.filter((item) => !successIds.includes(item.id));
				clearSelectionsForIds(successIds);
			}

			if (failedCount === 0) {
				toasts.success(m.unmatched_libraryIssues_bulkUpdateSuccess());
			} else if (successIds.length > 0) {
				toasts.warning(m.unmatched_libraryIssues_bulkUpdatePartial());
			} else {
				toasts.error(m.unmatched_libraryIssues_bulkUpdateFailed());
			}
		} finally {
			for (const item of selectedItems) {
				savingIssues.delete(item.id);
			}
			if (mediaType === 'movie') {
				bulkSavingMovie = false;
			} else {
				bulkSavingTv = false;
			}
		}
	}
</script>

{#if loading}
	<div class="card bg-base-200">
		<div class="card-body items-center py-6">
			<span class="loading loading-md loading-spinner"></span>
			<p class="text-sm text-base-content/70">{m.unmatched_libraryIssues_loading()}</p>
		</div>
	</div>
{:else if libraryItems.length > 0}
	<div class="card bg-base-200">
		<button
			class="card-body flex-row items-center justify-between gap-3 p-4 text-left"
			onclick={() => (libraryIssuesOpen = !libraryIssuesOpen)}
		>
			<div class="flex items-center gap-2">
				<AlertCircle class="h-5 w-5 text-warning" />
				<div>
					<div class="font-semibold">{m.unmatched_libraryIssues_title()}</div>
					<div class="text-xs text-base-content/60">
						{issueSummaryLabel} on {libraryItems.length} item{libraryItems.length !== 1 ? 's' : ''}
					</div>
				</div>
			</div>
			{#if libraryIssuesOpen}
				<ChevronDown class="h-4 w-4 text-base-content/60" />
			{:else}
				<ChevronRight class="h-4 w-4 text-base-content/60" />
			{/if}
		</button>

		{#if libraryIssuesOpen}
			<div class="border-t border-base-300 px-4 pb-4">
				<p class="pt-3 text-xs text-base-content/60">{issueDetailLabel}</p>

				<div class="mt-3 flex flex-wrap gap-2">
					<button
						class="btn btn-xs {libraryIssuesFilter === 'movie' ? 'btn-primary' : 'btn-ghost'}"
						onclick={() => (libraryIssuesFilter = 'movie')}
						disabled={movieIssueCount === 0}
					>
						{m.unmatched_libraryIssues_movies()} ({movieIssueCount})
					</button>
					<button
						class="btn btn-xs {libraryIssuesFilter === 'tv' ? 'btn-primary' : 'btn-ghost'}"
						onclick={() => (libraryIssuesFilter = 'tv')}
						disabled={tvIssueCount === 0}
					>
						{m.unmatched_libraryIssues_tvShows()} ({tvIssueCount})
					</button>
				</div>

				<div class="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
					<div class="flex flex-wrap items-center gap-2 text-xs text-base-content/60">
						<span>{m.unmatched_libraryIssues_selectedCount({ count: selectedFilteredCount })}</span>
						{#if libraryIssuesFilter === 'movie'}
							<button class="btn btn-ghost btn-xs" onclick={() => selectAllIssues('movie')}>
								{m.unmatched_libraryIssues_selectAllMovies()}
							</button>
						{:else}
							<button class="btn btn-ghost btn-xs" onclick={() => selectAllIssues('tv')}>
								{m.unmatched_libraryIssues_selectAllTv()}
							</button>
						{/if}
						<button class="btn btn-ghost btn-xs" onclick={clearIssueSelection}
							>{m.unmatched_libraryIssues_clear()}</button
						>
					</div>

					{#if libraryIssuesFilter === 'movie'}
						<div class="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
							{#if movieFolders.length > 0}
								<select
									class="select-bordered select w-full select-sm sm:w-72"
									bind:value={bulkMovieRootFolder}
									disabled={bulkSavingMovie}
								>
									<option value="">{m.unmatched_libraryIssues_selectRootFolder()}</option>
									{#each movieFolders as folder (folder.id)}
										<option value={folder.id}>{folder.name} - {folder.path}</option>
									{/each}
								</select>
								<button
									class="btn btn-outline btn-xs"
									disabled={!bulkMovieRootFolder || bulkSavingMovie || selectedMovieCount === 0}
									onclick={() => bulkAssignRootFolder('movie')}
								>
									{#if bulkSavingMovie}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{/if}
									{m.unmatched_libraryIssues_applyToSelected()}
								</button>
							{:else}
								<span class="text-xs text-warning">
									{m.unmatched_libraryIssues_noMovieFolders()}
									<a class="ml-1 link" href="/settings/library/root-folders"
										>{m.unmatched_libraryIssues_addRootFolder()}</a
									>
								</span>
							{/if}
						</div>
					{:else}
						<div class="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
							{#if tvFolders.length > 0}
								<select
									class="select-bordered select w-full select-sm sm:w-72"
									bind:value={bulkTvRootFolder}
									disabled={bulkSavingTv}
								>
									<option value="">{m.unmatched_libraryIssues_selectRootFolder()}</option>
									{#each tvFolders as folder (folder.id)}
										<option value={folder.id}>{folder.name} - {folder.path}</option>
									{/each}
								</select>
								<button
									class="btn btn-outline btn-xs"
									disabled={!bulkTvRootFolder || bulkSavingTv || selectedTvCount === 0}
									onclick={() => bulkAssignRootFolder('tv')}
								>
									{#if bulkSavingTv}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{/if}
									{m.unmatched_libraryIssues_applyToSelected()}
								</button>
							{:else}
								<span class="text-xs text-warning">
									{m.unmatched_libraryIssues_noTvFolders()}
									<a class="ml-1 link" href="/settings/library/root-folders"
										>{m.unmatched_libraryIssues_addRootFolder()}</a
									>
								</span>
							{/if}
						</div>
					{/if}
				</div>

				<div class="mt-4 space-y-2">
					{#each filteredLibraryItems as item (item.id)}
						<div class="rounded-lg bg-base-100 p-3">
							<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
								<div class="flex min-w-0 items-center gap-3">
									<input
										type="checkbox"
										class="checkbox checkbox-sm checkbox-primary"
										checked={selectedIssueSet.has(item.id)}
										onchange={() => toggleIssueSelection(item.id)}
									/>
									<div
										class="badge badge-sm {item.mediaType === 'movie'
											? 'badge-primary'
											: 'badge-secondary'}"
									>
										{item.mediaType === 'movie'
											? m.unmatched_libraryIssues_movie()
											: m.unmatched_libraryIssues_tv()}
									</div>
									<div class="min-w-0">
										<div class="truncate font-medium">
											{item.title}
											{#if item.year}
												<span class="text-base-content/70">({item.year})</span>
											{/if}
										</div>
										<div
											class="mt-0.5 flex items-center gap-1 text-xs {getIssueTextClass(item.issue)}"
										>
											{#if item.issue === 'invalid_root_folder'}
												<AlertCircle class="h-3.5 w-3.5" />
											{:else}
												<AlertTriangle class="h-3.5 w-3.5" />
											{/if}
											{getIssueLabel(item.issue)}
										</div>
									</div>
								</div>

								<div class="flex w-full items-center gap-2 sm:w-auto">
									<select
										class="select-bordered select w-full select-sm sm:w-72"
										value={getSelectedRootFolder(item.id)}
										disabled={savingIssues.get(item.id)}
										onchange={(event) =>
											setSelectedRootFolder(
												item.id,
												(event.currentTarget as HTMLSelectElement).value
											)}
									>
										<option value="">{m.unmatched_libraryIssues_selectRootFolder()}</option>
										{#if item.mediaType === 'movie'}
											{#each movieFolders as folder (folder.id)}
												<option value={folder.id}>{folder.name} - {folder.path}</option>
											{/each}
										{:else}
											{#each tvFolders as folder (folder.id)}
												<option value={folder.id}>{folder.name} - {folder.path}</option>
											{/each}
										{/if}
									</select>
									<button
										class="btn btn-ghost btn-sm"
										title={m.unmatched_libraryIssues_applyRootFolder()}
										disabled={!getSelectedRootFolder(item.id) || savingIssues.get(item.id)}
										onclick={() => updateRootFolder(item)}
									>
										{#if savingIssues.get(item.id)}
											<Loader2 class="h-4 w-4 animate-spin" />
										{:else}
											<Link class="h-4 w-4" />
										{/if}
									</button>
								</div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}

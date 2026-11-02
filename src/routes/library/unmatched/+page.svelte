<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { unmatchedFilesStore } from '#lib/stores/unmatched-files.svelte.js';
	import {
		UnmatchedFileCard,
		UnmatchedFolderCard,
		UnmatchedFilters,
		UnmatchedBulkActions,
		UnmatchedEmptyState,
		UnmatchedPagination,
		UnmatchedLibraryIssues,
		UnmatchedDeleteModal
	} from '#lib/components/unmatched/index.js';
	import MatchFileModal from '#lib/components/library/MatchFileModal.svelte';
	import MatchFolderModal from '#lib/components/library/MatchFolderModal.svelte';
	import BatchMatchModal from '#lib/components/library/BatchMatchModal.svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import type { UnmatchedFile, UnmatchedFolder } from '#lib/types/unmatched.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getFileName } from '#lib/utils/format.js';
	import { forceMatchUnmatched, forceMatchAllUnmatched } from '#lib/api/library.js';

	// Modal states
	let showMatchModal = $state(false);
	let showFolderMatchModal = $state(false);
	let showBatchMatchModal = $state(false);
	let showDeleteModal = $state(false);

	// Selected items for modals
	let selectedFile = $state<UnmatchedFile | null>(null);
	let selectedFolder = $state<UnmatchedFolder | null>(null);
	let fileToDelete = $state<UnmatchedFile | null>(null);
	let folderToDelete = $state<UnmatchedFolder | null>(null);
	let isDeleting = $state(false);
	let isBulkDelete = $state(false);

	// Local checkbox state
	let showCheckboxes = $state(false);

	// Force-match loading state per file ID
	const forceMatchLoadingIds = new SvelteSet<string>();
	let forceMatchAllLoading = $state(false);

	// Track expanded folders
	const expandedFolders = new SvelteSet<string>();

	// Load data on mount
	onMount(() => {
		unmatchedFilesStore.loadFiles();
	});

	// Handle file selection
	function toggleFileSelection(fileId: string) {
		unmatchedFilesStore.toggleFileSelection(fileId);
	}

	// Handle file match
	function handleMatchFile(file: UnmatchedFile) {
		selectedFile = file;
		showMatchModal = true;
	}

	// Handle folder match
	function handleMatchFolder(folder: UnmatchedFolder) {
		selectedFolder = folder;
		showFolderMatchModal = true;
	}

	// Handle batch match
	function handleBatchMatch() {
		if (unmatchedFilesStore.selectedCount === 0) {
			toasts.info(m.toast_library_unmatched_selectFirst());
			return;
		}
		showBatchMatchModal = true;
	}

	// Toggle folder expansion
	function toggleFolder(folderPath: string) {
		if (expandedFolders.has(folderPath)) {
			expandedFolders.delete(folderPath);
		} else {
			expandedFolders.add(folderPath);
		}
	}

	// Expand all folders
	function expandAllFolders() {
		for (const folder of filteredFolders) {
			expandedFolders.add(folder.folderPath);
		}
	}

	// Collapse all folders
	function collapseAllFolders() {
		expandedFolders.clear();
	}

	// Handle single file delete
	function handleDeleteFile(file: UnmatchedFile) {
		isBulkDelete = false;
		fileToDelete = file;
		showDeleteModal = true;
	}

	// Handle folder delete (all files in folder)
	function handleDeleteFolder(folder: UnmatchedFolder) {
		isBulkDelete = true;
		folderToDelete = folder;
		// Pre-select all files in folder so performDelete picks them up
		unmatchedFilesStore.clearSelection();
		for (const f of folder.files) {
			unmatchedFilesStore.toggleFileSelection(f.id);
		}
		fileToDelete = null;
		showDeleteModal = true;
	}

	// Handle bulk delete
	function handleBulkDelete() {
		isBulkDelete = true;
		fileToDelete = null;
		folderToDelete = null;
		showDeleteModal = true;
	}

	// Perform delete (single or bulk)
	async function performDelete(deleteFromDisk: boolean) {
		isDeleting = true;
		try {
			if (isBulkDelete) {
				const ids = [...unmatchedFilesStore.selectedFiles];
				await unmatchedFilesStore.deleteFiles(ids, deleteFromDisk);
				toasts.success(
					deleteFromDisk
						? m.toast_library_unmatched_fileDeletedFromDisk()
						: m.toast_library_unmatched_fileRemovedFromList()
				);
				unmatchedFilesStore.clearSelection();
				folderToDelete = null;
			} else {
				if (!fileToDelete) return;
				await unmatchedFilesStore.deleteFiles([fileToDelete.id], deleteFromDisk);
				toasts.success(
					deleteFromDisk
						? m.toast_library_unmatched_fileDeletedFromDisk()
						: m.toast_library_unmatched_fileRemovedFromList()
				);
				fileToDelete = null;
			}
			showDeleteModal = false;
		} catch (_err) {
			toasts.error(m.toast_library_unmatched_failedToDelete());
		} finally {
			isDeleting = false;
		}
	}

	// Force-match loading state per folder path
	const forceMatchFolderLoadingPaths = new SvelteSet<string>();

	// Handle force match on a folder (all files matched to same TMDB entry using parsed S/E)
	async function handleFolderForceMatch(
		folder: UnmatchedFolder,
		tmdbId: number,
		mediaType: 'movie' | 'tv'
	) {
		forceMatchFolderLoadingPaths.add(folder.folderPath);
		try {
			// Force-match each file in the folder individually
			const results = await Promise.allSettled(
				folder.files.map((f) => forceMatchUnmatched(f.id, tmdbId, mediaType))
			);
			const succeeded = results.filter(
				(r) => r.status === 'fulfilled' && (r.value as { success: boolean }).success
			).length;
			if (succeeded > 0) {
				toasts.success(
					m.toast_library_unmatched_folderForceMatched({
						matched: succeeded,
						total: folder.files.length
					})
				);
				unmatchedFilesStore.loadFiles();
			} else {
				toasts.error(m.toast_library_unmatched_forceMatchFailed());
			}
		} catch {
			toasts.error(m.toast_library_unmatched_forceMatchFailed());
		} finally {
			forceMatchFolderLoadingPaths.delete(folder.folderPath);
		}
	}

	// Handle force match on a single file
	async function handleForceMatch(file: UnmatchedFile, tmdbId: number, mediaType: 'movie' | 'tv') {
		forceMatchLoadingIds.add(file.id);
		try {
			const res = await forceMatchUnmatched(file.id, tmdbId, mediaType);
			if (res.success) {
				toasts.success(m.toast_library_unmatched_forceMatched());
				unmatchedFilesStore.loadFiles();
			} else {
				toasts.error(m.toast_library_unmatched_forceMatchFailed());
			}
		} catch {
			toasts.error(m.toast_library_unmatched_forceMatchFailed());
		} finally {
			forceMatchLoadingIds.delete(file.id);
		}
	}

	// Force match all eligible files >= 90% confidence
	async function handleForceMatchAll() {
		forceMatchAllLoading = true;
		try {
			const res = await forceMatchAllUnmatched(0.9);
			if (res.success && res.data) {
				const { matched, failed, eligible } = res.data as {
					matched: number;
					failed: number;
					eligible: number;
				};
				toasts.success(
					m.toast_library_unmatched_forceMatchAllComplete({ matched, failed, eligible })
				);
				unmatchedFilesStore.loadFiles();
			} else {
				toasts.error(m.toast_library_unmatched_forceMatchFailed());
			}
		} catch {
			toasts.error(m.toast_library_unmatched_forceMatchFailed());
		} finally {
			forceMatchAllLoading = false;
		}
	}

	// Handle match success
	function handleMatchSuccess() {
		showMatchModal = false;
		selectedFile = null;
		unmatchedFilesStore.loadFiles();
		toasts.success(m.toast_library_unmatched_fileMatched());
	}

	// Handle folder match success
	function handleFolderMatchSuccess() {
		showFolderMatchModal = false;
		selectedFolder = null;
		unmatchedFilesStore.loadFiles();
		toasts.success(m.toast_library_unmatched_folderMatched());
	}

	// Handle batch match success
	function handleBatchMatchSuccess() {
		showBatchMatchModal = false;
		showCheckboxes = false;
		unmatchedFilesStore.clearSelection();
		unmatchedFilesStore.loadFiles();
		toasts.success(m.toast_library_unmatched_filesMatched());
	}

	// Derived values
	const files = $derived(unmatchedFilesStore.files);
	const folders = $derived(unmatchedFilesStore.folders);
	const viewMode = $derived(unmatchedFilesStore.viewMode);
	const loading = $derived(unmatchedFilesStore.loading);
	const pagination = $derived(unmatchedFilesStore.pagination);
	const selectedCount = $derived(unmatchedFilesStore.selectedCount);
	// Check for data based on current view mode
	const hasData = $derived(viewMode === 'folder' ? folders.length > 0 : files.length > 0);
	// True when any data exists at all (used to avoid spinner flash on view-mode switches)
	const hasAnyData = $derived(files.length > 0 || folders.length > 0);
	const filteredFiles = $derived(unmatchedFilesStore.filteredFiles);
	const filteredFolders = $derived(unmatchedFilesStore.filteredFolders);
	const allFoldersExpanded = $derived(
		filteredFolders.length > 0 && filteredFolders.every((f) => expandedFolders.has(f.folderPath))
	);

	// Reset expanded folders when filters change to avoid stale state
	$effect(() => {
		// This effect runs when filteredFolders changes
		const validPaths = new Set(filteredFolders.map((f) => f.folderPath));
		for (const path of expandedFolders) {
			if (!validPaths.has(path)) {
				expandedFolders.delete(path);
			}
		}
	});
</script>

<svelte:head>
	<title>{m.library_unmatched_pageTitle()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div>
			<h1 class="text-3xl font-bold">{m.library_unmatched_heading()}</h1>
			<p class={pagination.total === 0 ? 'text-success' : 'text-warning'}>
				{m.library_unmatched_filesNeedAttention({ count: pagination.total })}
			</p>
		</div>
	</div>

	<!-- Filters -->
	<UnmatchedFilters
		onToggleCheckboxes={(showing) => {
			showCheckboxes = showing;
		}}
		onForceMatchAll={handleForceMatchAll}
		{forceMatchAllLoading}
	/>

	<!-- Bulk Actions (sticky, shown alongside list when items selected) -->
	{#if showCheckboxes && selectedCount > 0}
		<UnmatchedBulkActions onMatch={handleBatchMatch} onDelete={handleBulkDelete} />
	{/if}

	<!-- Library issues panel (missing/invalid root folders) -->
	<UnmatchedLibraryIssues unmatchedFileCount={pagination.total} />

	<!-- Loading State: full spinner only on initial load when nothing is cached yet -->
	{#if loading && !hasAnyData}
		<div class="flex items-center justify-center py-12">
			<span class="loading loading-lg loading-spinner"></span>
		</div>

		<!-- Empty State -->
	{:else if !hasData && !loading}
		<UnmatchedEmptyState />

		<!-- Folder View -->
	{:else if viewMode === 'folder'}
		<div class="space-y-4">
			<div class="flex items-center justify-between">
				<div>
					<h2 class="text-xl font-semibold">{m.library_unmatched_foldersHeading()}</h2>
					{#if !loading || folders.length > 0}
						<p class="text-sm text-base-content/70">
							{m.library_unmatched_folderCount({ count: filteredFolders.length })}
						</p>
					{/if}
				</div>
				{#if filteredFolders.length > 0}
					<button
						class="btn btn-ghost btn-sm"
						onclick={allFoldersExpanded ? collapseAllFolders : expandAllFolders}
					>
						{allFoldersExpanded
							? m.library_unmatched_collapseAll()
							: m.library_unmatched_expandAll()}
					</button>
				{/if}
			</div>

			{#if loading && folders.length === 0}
				<div class="flex items-center justify-center py-8">
					<span class="loading loading-md loading-spinner"></span>
				</div>
			{:else}
				<div class="space-y-3">
					{#each filteredFolders as folder (folder.folderPath)}
						<UnmatchedFolderCard
							{folder}
							expanded={expandedFolders.has(folder.folderPath)}
							onToggle={() => toggleFolder(folder.folderPath)}
							onMatch={() => handleMatchFolder(folder)}
							onDelete={() => handleDeleteFolder(folder)}
							onForceMatch={(tmdbId, mediaType) =>
								handleFolderForceMatch(folder, tmdbId, mediaType)}
							forceMatchLoading={forceMatchFolderLoadingPaths.has(folder.folderPath)}
						/>
					{/each}
				</div>
			{/if}
		</div>

		<!-- List View -->
	{:else}
		{#if loading && files.length === 0}
			<div class="flex items-center justify-center py-8">
				<span class="loading loading-md loading-spinner"></span>
			</div>
		{:else}
			<div class="space-y-3">
				{#each filteredFiles as file (file.id)}
					<UnmatchedFileCard
						{file}
						selected={unmatchedFilesStore.selectedFiles.has(file.id)}
						{showCheckboxes}
						forceMatchLoading={forceMatchLoadingIds.has(file.id)}
						onSelect={() => toggleFileSelection(file.id)}
						onMatch={() => handleMatchFile(file)}
						onForceMatch={(tmdbId, mediaType) => handleForceMatch(file, tmdbId, mediaType)}
						onDelete={() => handleDeleteFile(file)}
					/>
				{/each}
			</div>
		{/if}
	{/if}

	<!-- Pagination -->
	{#if viewMode === 'list' && files.length > 0}
		<UnmatchedPagination />
	{/if}
</div>

<!-- Match File Modal -->
{#if selectedFile && showMatchModal}
	<MatchFileModal
		open={showMatchModal}
		file={selectedFile}
		onClose={() => {
			showMatchModal = false;
			selectedFile = null;
		}}
		onSuccess={handleMatchSuccess}
	/>
{/if}

<!-- Match Folder Modal -->
{#if selectedFolder && showFolderMatchModal}
	<MatchFolderModal
		open={showFolderMatchModal}
		folder={selectedFolder}
		onClose={() => {
			showFolderMatchModal = false;
			selectedFolder = null;
		}}
		onSuccess={handleFolderMatchSuccess}
	/>
{/if}

<!-- Batch Match Modal -->
{#if showBatchMatchModal}
	<BatchMatchModal
		open={showBatchMatchModal}
		selectedFileIds={[...unmatchedFilesStore.selectedFiles]}
		allFiles={files}
		onClose={() => {
			showBatchMatchModal = false;
		}}
		onSuccess={handleBatchMatchSuccess}
	/>
{/if}

<!-- Delete Confirmation Modal -->
<UnmatchedDeleteModal
	open={showDeleteModal}
	itemName={isBulkDelete && !folderToDelete
		? `${selectedCount} selected files`
		: fileToDelete
			? getFileName(fileToDelete.path)
			: 'Unknown'}
	isBulk={isBulkDelete && !folderToDelete}
	folderName={folderToDelete?.folderName}
	folderFileCount={folderToDelete?.fileCount}
	loading={isDeleting}
	onConfirm={performDelete}
	onCancel={() => {
		showDeleteModal = false;
		fileToDelete = null;
		folderToDelete = null;
		isBulkDelete = false;
	}}
/>

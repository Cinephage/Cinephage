<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Clapperboard,
		Tv,
		Folder,
		List,
		Square,
		SquareCheck,
		RefreshCw,
		Zap
	} from '@lucide/svelte';
	import { unmatchedFilesStore } from '#lib/stores/unmatched-files.svelte.js';
	import { toasts } from '#lib/stores/toast.svelte.js';

	let filter = $derived(unmatchedFilesStore.filters.mediaType || 'all');
	let viewMode = $derived(unmatchedFilesStore.viewMode);
	let showCheckboxes = $state(false);
	let isProcessing = $state(false);

	function setFilter(value: 'all' | 'movie' | 'tv') {
		if (value === 'all') {
			unmatchedFilesStore.setFilter('mediaType', undefined);
		} else {
			unmatchedFilesStore.setFilter('mediaType', value);
		}
	}

	function setViewMode(mode: 'list' | 'folder') {
		unmatchedFilesStore.setViewMode(mode);
	}

	interface Props {
		onToggleCheckboxes?: (showing: boolean) => void;
		onForceMatchAll?: () => Promise<void>;
		forceMatchAllLoading?: boolean;
	}

	let { onToggleCheckboxes, onForceMatchAll, forceMatchAllLoading = false }: Props = $props();

	// True when at least one file has a top candidate >= 90% - works in both list and folder view
	const hasEligibleForForceMatch = $derived(
		viewMode === 'folder'
			? unmatchedFilesStore.folders.some((folder) =>
					folder.files.some((f) => {
						const top = f.suggestedMatches?.[0];
						return top !== undefined && top.confidence >= 0.9;
					})
				)
			: unmatchedFilesStore.files.some((f) => {
					if (f.reason !== 'multiple_matches') return false;
					const top = f.suggestedMatches?.[0];
					return top !== undefined && top.confidence >= 0.9;
				})
	);

	function toggleCheckboxes() {
		showCheckboxes = !showCheckboxes;
		onToggleCheckboxes?.(showCheckboxes);
		if (!showCheckboxes) {
			unmatchedFilesStore.clearSelection();
		}
	}

	async function reprocessAll() {
		if (unmatchedFilesStore.pagination.total === 0) return;
		isProcessing = true;
		try {
			const result = await unmatchedFilesStore.processAll();
			if (result?.queued) {
				toasts.success(m.unmatched_filters_reprocessQueued());
			}
		} finally {
			isProcessing = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<!-- Filters -->
		<div class="flex gap-2">
			<button
				class="btn btn-sm {filter === 'all' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => setFilter('all')}
			>
				{m.unmatched_filters_all()}
			</button>
			<button
				class="btn btn-sm {filter === 'movie' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => setFilter('movie')}
			>
				<Clapperboard class="h-4 w-4" />
				{m.unmatched_filters_movies()}
			</button>
			<button
				class="btn btn-sm {filter === 'tv' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => setFilter('tv')}
			>
				<Tv class="h-4 w-4" />
				{m.unmatched_filters_tvShows()}
			</button>
		</div>

		<div class="flex gap-2">
			<!-- View Mode + Selection Toggle -->
			<div class="flex gap-1 rounded-lg bg-base-200 p-1">
				<button
					class="btn btn-sm {viewMode === 'list' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => setViewMode('list')}
					title={m.unmatched_filters_listView()}
				>
					<List class="h-4 w-4" />
				</button>
				<button
					class="btn btn-sm {viewMode === 'folder' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => setViewMode('folder')}
					title={m.unmatched_filters_folderView()}
				>
					<Folder class="h-4 w-4" />
				</button>
				{#if viewMode === 'list'}
					<div class="mx-0.5 w-px self-stretch bg-base-content/10"></div>
					<button
						class="btn btn-sm {showCheckboxes ? 'btn-primary' : 'btn-ghost'}"
						onclick={toggleCheckboxes}
						disabled={unmatchedFilesStore.files.length === 0}
						title={m.unmatched_filters_selectFiles()}
					>
						{#if showCheckboxes}
							<SquareCheck class="h-4 w-4" />
						{:else}
							<Square class="h-4 w-4" />
						{/if}
					</button>
				{/if}
			</div>
		</div>
	</div>

	<!-- Action buttons row -->
	<div class="flex justify-end gap-2">
		<button
			class="btn btn-outline btn-sm"
			onclick={reprocessAll}
			disabled={isProcessing || unmatchedFilesStore.pagination.total === 0}
		>
			<RefreshCw class="h-4 w-4 {isProcessing ? 'animate-spin' : ''}" />
			{m.unmatched_filters_reprocessFiles()}
		</button>
		<button
			class="btn btn-primary btn-sm"
			onclick={onForceMatchAll}
			disabled={forceMatchAllLoading || !hasEligibleForForceMatch}
		>
			{#if forceMatchAllLoading}
				<span class="loading loading-xs loading-spinner"></span>
			{:else}
				<Zap class="h-4 w-4" />
			{/if}
			{m.unmatched_file_forceMatchAll({ threshold: 90 })}
		</button>
	</div>
</div>

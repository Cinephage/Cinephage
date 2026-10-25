<script lang="ts">
	import {
		ChevronUp,
		ChevronDown,
		Database,
		GripVertical,
		FlaskConical,
		Loader2,
		Lock,
		RotateCcw,
		Search,
		Zap,
		ToggleLeft,
		ToggleRight,
		Settings,
		Trash2
	} from '@lucide/svelte';
	import IndexerStatusBadge from './IndexerStatusBadge.svelte';
	import IndexerRow from './IndexerRow.svelte';
	import type { IndexerWithStatus, IndexerSort } from '#lib/types/indexer.js';

	interface Props {
		indexers: IndexerWithStatus[];
		selectedIds: Set<string>;
		sort: IndexerSort;
		canReorder: boolean;
		testingIds: Set<string>;
		togglingIds: Set<string>;
		prowlarrBaseUrl?: string | null;
		jackettBaseUrl?: string | null;
		onSelect: (id: string, selected: boolean) => void;
		onSelectAll: (selected: boolean) => void;
		onSort: (column: IndexerSort['column']) => void;
		onPrioritySortForReorder: () => void;
		onEdit: (indexer: IndexerWithStatus) => void;
		onDelete: (indexer: IndexerWithStatus) => void;
		onTest: (indexer: IndexerWithStatus) => void;
		onToggle: (indexer: IndexerWithStatus) => void;
		onReorder?: (indexerIds: string[]) => void;
	}

	let {
		indexers,
		selectedIds,
		sort,
		canReorder,
		testingIds,
		togglingIds,
		prowlarrBaseUrl = null,
		jackettBaseUrl = null,
		onSelect,
		onSelectAll,
		onSort,
		onPrioritySortForReorder,
		onEdit,
		onDelete,
		onTest,
		onToggle,
		onReorder
	}: Props = $props();

	let draggedIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);
	let reorderMode = $state(false);

	const allSelected = $derived(indexers.length > 0 && indexers.every((i) => selectedIds.has(i.id)));
	const someSelected = $derived(indexers.some((i) => selectedIds.has(i.id)) && !allSelected);
	const reorderDisabledReason = $derived(
		canReorder ? '' : 'Clear filters to reorder all indexers by priority'
	);

	function isProwlarrIndexer(indexer: IndexerWithStatus): boolean {
		if (!prowlarrBaseUrl || indexer.definitionId !== 'prowlarr') return false;
		if (indexer.settings?.aggregate === 'true') return true;
		const base = prowlarrBaseUrl.replace(/\/+$/, '');
		if (!indexer.baseUrl.startsWith(base + '/')) return false;
		const suffix = indexer.baseUrl.slice(base.length + 1).replace(/\/+$/, '');
		return /^\d+$/.test(suffix);
	}

	function isJackettIndexer(indexer: IndexerWithStatus): boolean {
		if (!jackettBaseUrl) return false;
		const base = jackettBaseUrl.replace(/\/+$/, '');
		return (
			indexer.baseUrl.startsWith(base + '/api/v2.0/indexers/') &&
			indexer.baseUrl.includes('/results/torznab')
		);
	}

	function isSortedBy(column: IndexerSort['column']): boolean {
		return sort.column === column;
	}

	function isAscending(): boolean {
		return sort.direction === 'asc';
	}

	function toggleReorderMode() {
		if (!reorderMode && !canReorder) return;

		reorderMode = !reorderMode;
		draggedIndex = null;
		dragOverIndex = null;

		if (reorderMode) {
			onPrioritySortForReorder();
		}
	}

	function handleDragStart(event: DragEvent, index: number) {
		if (!reorderMode) return;
		draggedIndex = index;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', String(index));
		}
	}

	function handleDragOver(event: DragEvent, index: number) {
		if (!reorderMode || draggedIndex === null) return;
		event.preventDefault();
		dragOverIndex = index;
	}

	function handleDragLeave() {
		dragOverIndex = null;
	}

	function handleDrop(event: DragEvent, dropIndex: number) {
		if (!reorderMode || draggedIndex === null || !onReorder) return;
		event.preventDefault();

		if (draggedIndex !== dropIndex) {
			const reordered = [...indexers];
			const [moved] = reordered.splice(draggedIndex, 1);
			reordered.splice(dropIndex, 0, moved);
			onReorder(reordered.map((i) => i.id));
		}

		draggedIndex = null;
		dragOverIndex = null;
	}

	function handleDragEnd() {
		draggedIndex = null;
		dragOverIndex = null;
	}

	function moveIndexer(fromIndex: number, toIndex: number) {
		if (!onReorder || !reorderMode) return;
		if (toIndex < 0 || toIndex >= indexers.length || fromIndex === toIndex) return;

		const reordered = [...indexers];
		const [moved] = reordered.splice(fromIndex, 1);
		reordered.splice(toIndex, 0, moved);
		onReorder(reordered.map((i) => i.id));
	}

	$effect(() => {
		if (!canReorder && reorderMode) {
			reorderMode = false;
			draggedIndex = null;
			dragOverIndex = null;
		}
	});
</script>

{#if indexers.length === 0}
	<div class="flex flex-col items-center justify-center py-12 text-base-content/50">
		<Database class="mb-4 h-12 w-12" />
		<p class="text-lg font-medium">No indexers configured</p>
		<p class="text-sm">Add an indexer to start searching for content</p>
	</div>
{:else}
	<div class="space-y-3 overflow-x-hidden sm:hidden">
		<div class="rounded-lg border border-base-300/80 bg-base-100 px-3 py-2 shadow-sm">
			<div class="flex items-center justify-between gap-2">
				<label class="flex items-center gap-2 text-xs font-medium">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						checked={allSelected}
						indeterminate={someSelected}
						onchange={(e) => onSelectAll(e.currentTarget.checked)}
					/>
					Select all
				</label>
				<span class="text-xs text-base-content/60">{selectedIds.size} selected</span>
			</div>

			{#if onReorder}
				<div class="mt-2 border-t border-base-300/70 pt-2">
					<div class="flex items-center justify-between gap-2">
						<div
							class="text-xs font-medium {reorderMode ? 'text-primary' : 'text-base-content/70'}"
						>
							{reorderMode ? 'Reorder mode is active' : 'Priority reordering'}
						</div>
						<button
							class="btn gap-1 btn-xs {reorderMode ? 'btn-primary' : 'btn-ghost'}"
							onclick={toggleReorderMode}
							disabled={!canReorder}
							title={reorderDisabledReason}
						>
							<GripVertical class="h-3.5 w-3.5" />
							{reorderMode ? 'Done' : 'Reorder'}
						</button>
					</div>
					<p class="mt-1 text-xs text-base-content/60">
						{#if canReorder}
							{reorderMode
								? 'Drag cards or use the up/down arrows to change priority.'
								: 'Enable reorder mode to change Indexer priority.'}
						{:else}
							Clear filters to reorder priorities.
						{/if}
					</p>
				</div>
			{/if}
		</div>

		{#each indexers as indexer, index (indexer.id)}
			<div
				role="listitem"
				class="rounded-xl border bg-base-100 p-3 transition-all duration-150 {selectedIds.has(
					indexer.id
				)
					? 'border-primary/50 ring-1 ring-primary/30'
					: 'border-base-300/80'} {dragOverIndex === index
					? 'border-primary/70 bg-primary/5'
					: ''} {draggedIndex === index ? 'opacity-60' : ''} min-w-0"
				draggable={reorderMode}
				ondragstart={(e) => handleDragStart(e, index)}
				ondragover={(e) => handleDragOver(e, index)}
				ondragleave={handleDragLeave}
				ondrop={(e) => handleDrop(e, index)}
				ondragend={handleDragEnd}
			>
				<div class="mb-2 flex items-start justify-between gap-2">
					<div class="flex min-w-0 items-start gap-2.5">
						{#if reorderMode}
							<div class="mt-0.5 flex h-5 w-5 items-center justify-center">
								<GripVertical class="h-4 w-4 text-base-content/50" />
							</div>
						{:else}
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={selectedIds.has(indexer.id)}
								onchange={(e) => onSelect(indexer.id, e.currentTarget.checked)}
							/>
						{/if}
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<button class="link text-sm font-bold link-hover" onclick={() => onEdit(indexer)}>
									{indexer.name}
								</button>
								<IndexerStatusBadge
									enabled={indexer.enabled}
									consecutiveFailures={indexer.status?.consecutiveFailures ?? 0}
									lastFailure={indexer.status?.lastFailure}
									disabledUntil={indexer.status?.disabledUntil}
									jackettManaged={isJackettIndexer(indexer)}
								/>
							</div>
							<div class="mt-0.5 flex flex-wrap items-center gap-1">
								<span class="text-xs text-base-content/60">
									{indexer.definitionName ?? indexer.definitionId}
								</span>
								{#if isProwlarrIndexer(indexer)}
									<span class="badge badge-xs badge-primary">Prowlarr</span>
									{#if indexer.orphaned}
										<span class="badge badge-xs badge-error">Deleted</span>
									{:else if indexer.upstreamEnabled === false}
										<span class="badge badge-xs badge-warning">Disabled in Prowlarr</span>
									{/if}
								{:else if isJackettIndexer(indexer)}
									<span class="badge badge-xs badge-secondary">Jackett</span>
									{#if indexer.orphaned}
										<span class="badge badge-xs badge-error">Deleted</span>
									{/if}
								{/if}
							</div>
						</div>
					</div>
					<div class="flex shrink-0 items-center gap-1">
						{#if reorderMode}
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => moveIndexer(index, index - 1)}
								disabled={index === 0}
								title="Move up"
								aria-label="Move up"
							>
								<ChevronUp class="h-3.5 w-3.5" />
							</button>
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => moveIndexer(index, index + 1)}
								disabled={index === indexers.length - 1}
								title="Move down"
								aria-label="Move down"
							>
								<ChevronDown class="h-3.5 w-3.5" />
							</button>
						{/if}
						<span class="badge shrink-0 badge-outline badge-sm">{indexer.priority}</span>
					</div>
				</div>

				<div class="mb-3 flex items-center gap-2">
					<span class="badge badge-outline badge-sm capitalize">{indexer.protocol}</span>
					<div class="flex shrink-0 items-center gap-1.5 text-xs text-base-content/60">
						<Zap
							class="h-3.5 w-3.5 {indexer.enableAutomaticSearch
								? 'text-success'
								: 'text-base-content/30'}"
						/>
						<Search
							class="h-3.5 w-3.5 {indexer.enableInteractiveSearch
								? 'text-success'
								: 'text-base-content/30'}"
						/>
					</div>
					<span
						class="min-w-0 flex-1 truncate font-mono text-xs text-base-content/60"
						title={indexer.baseUrl}
					>
						{indexer.baseUrl}
					</span>
				</div>

				<div class="grid grid-cols-4 gap-1.5">
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onTest(indexer)}
						disabled={testingIds.has(indexer.id) || reorderMode}
						title="Test connection"
						aria-label="Test connection"
					>
						{#if testingIds.has(indexer.id)}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<FlaskConical class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onToggle(indexer)}
						disabled={testingIds.has(indexer.id) ||
							togglingIds.has(indexer.id) ||
							reorderMode ||
							(indexer.upstreamEnabled === false && !indexer.orphaned)}
						title={indexer.orphaned
							? 'Deleted from upstream - tap to test connection and restore'
							: indexer.upstreamEnabled === false
								? 'Disabled in Prowlarr - enable it there first'
								: indexer.enabled
									? 'Disable'
									: 'Enable'}
						aria-label={indexer.orphaned
							? 'Deleted - tap to restore'
							: indexer.upstreamEnabled === false
								? 'Locked - disabled in Prowlarr'
								: indexer.enabled
									? 'Disable indexer'
									: 'Enable indexer'}
					>
						{#if togglingIds.has(indexer.id)}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else if indexer.orphaned}
							<RotateCcw class="h-4 w-4 text-error" />
						{:else if indexer.upstreamEnabled === false}
							<Lock class="h-4 w-4 text-warning" />
						{:else if indexer.enabled}
							<ToggleRight class="h-4 w-4 text-success" />
						{:else}
							<ToggleLeft class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onEdit(indexer)}
						disabled={reorderMode}
						title="Edit indexer"
						aria-label="Edit indexer"
					>
						<Settings class="h-4 w-4" />
					</button>
					<button
						class="btn btn-ghost text-error btn-xs"
						onclick={() => onDelete(indexer)}
						disabled={reorderMode}
						title="Delete indexer"
						aria-label="Delete indexer"
					>
						<Trash2 class="h-4 w-4" />
					</button>
				</div>
			</div>
		{/each}
	</div>

	<div class="hidden overflow-x-auto sm:block">
		{#if onReorder}
			<div class="flex items-center justify-end border-b border-base-300 px-4 py-2">
				<button
					class="btn btn-sm {reorderMode ? 'btn-primary' : 'btn-ghost'}"
					onclick={toggleReorderMode}
					disabled={!canReorder}
					title={reorderDisabledReason}
				>
					<GripVertical class="h-4 w-4" />
					{reorderMode ? 'Done Reordering' : 'Reorder Priorities'}
				</button>
			</div>
		{/if}

		{#if reorderMode}
			<div class="flex items-center gap-2 bg-info/10 px-4 py-2 text-sm text-info">
				<GripVertical class="h-4 w-4" />
				Drag indexers to reorder. Lower priority numbers are searched first.
			</div>
		{/if}

		<table class="table table-sm">
			<thead>
				<tr>
					<th class="w-10">
						{#if reorderMode}
							<GripVertical class="mx-auto h-4 w-4 text-base-content/50" />
						{:else}
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={allSelected}
								indeterminate={someSelected}
								onchange={(e) => onSelectAll(e.currentTarget.checked)}
							/>
						{/if}
					</th>
					<th class="w-24">
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('enabled')}
							disabled={reorderMode}
						>
							Status
							{#if isSortedBy('enabled') && !reorderMode}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th>
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('name')}
							disabled={reorderMode}
						>
							Name
							{#if isSortedBy('name') && !reorderMode}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th>Definition</th>
					<th>
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('protocol')}
							disabled={reorderMode}
						>
							Protocol
							{#if isSortedBy('protocol') && !reorderMode}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th class="text-center">Search</th>
					<th class="text-center">
						<button
							class="mx-auto flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('priority')}
							disabled={reorderMode}
						>
							Priority
							{#if isSortedBy('priority') && !reorderMode}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th>URL</th>
					<th class="pl-4! text-start">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each indexers as indexer, index (indexer.id)}
					<IndexerRow
						{indexer}
						selected={selectedIds.has(indexer.id)}
						testing={testingIds.has(indexer.id)}
						toggling={togglingIds.has(indexer.id)}
						{reorderMode}
						isDragOver={dragOverIndex === index}
						isDragging={draggedIndex === index}
						{prowlarrBaseUrl}
						{jackettBaseUrl}
						{onSelect}
						{onEdit}
						{onDelete}
						{onTest}
						{onToggle}
						onDragStart={(e) => handleDragStart(e, index)}
						onDragOver={(e) => handleDragOver(e, index)}
						onDragLeave={handleDragLeave}
						onDrop={(e) => handleDrop(e, index)}
						onDragEnd={handleDragEnd}
					/>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

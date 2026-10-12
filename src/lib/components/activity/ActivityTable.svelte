<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import * as m from '#lib/paraglide/messages.js';
	import { isImportFailedActivity, type UnifiedActivity } from '#lib/types/activity.js';
	import { Loader2, Minus } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { createProgressiveRenderer } from '#lib/utils/progressive-render.svelte.js';
	import { DeleteConfirmationModal } from '#lib/components/ui/modal/index.js';
	import ActivityTableHeader from './ActivityTableHeader.svelte';
	import ActivityRow from './ActivityRow.svelte';
	import ActivityMobileCard from './ActivityMobileCard.svelte';

	interface Props {
		activities: UnifiedActivity[];
		sortField?: string;
		sortDirection?: 'asc' | 'desc';
		onSort?: (field: string) => void;
		onRowClick?: (activity: UnifiedActivity) => void;
		onPause?: (id: string) => Promise<void>;
		onResume?: (id: string) => Promise<void>;
		onRemove?: (
			id: string,
			options: { deleteFiles: boolean; removeFromLibrary: boolean }
		) => Promise<void>;
		onRetry?: (id: string) => Promise<void>;
		compact?: boolean;
		selectionMode?: boolean;
		selectedIds?: Set<string>;
		isSelectable?: (activity: UnifiedActivity) => boolean;
		onToggleSelection?: (activityId: string, selected: boolean) => void;
		onToggleSelectionAll?: (activityIds: string[], selected: boolean) => void;
		hasMore?: boolean;
		isLoadingMore?: boolean;
		onLoadMore?: () => void;
	}

	let {
		activities,
		sortField = 'time',
		sortDirection = 'desc',
		onSort,
		onRowClick,
		onPause,
		onResume,
		onRemove,
		onRetry,
		compact = false,
		selectionMode = false,
		selectedIds = new Set<string>(),
		isSelectable = () => false,
		onToggleSelection,
		onToggleSelectionAll,
		hasMore = false,
		isLoadingMore = false,
		onLoadMore
	}: Props = $props();

	const renderer = createProgressiveRenderer(() => activities, { batchSize: 24 });

	$effect(() => {
		if (!renderer.hasMore && hasMore && !isLoadingMore) {
			onLoadMore?.();
		}
	});

	let isMobile = $state(false);
	$effect(() => {
		if (typeof window === 'undefined') return;

		const mq = window.matchMedia('(max-width: 1023px)');
		isMobile = mq.matches;
		const handler = (e: MediaQueryListEvent) => {
			isMobile = e.matches;
		};
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	});

	let expandedRows = new SvelteSet<string>();
	let failedReasonExpandedRows = new SvelteSet<string>();
	let queueActionLoadingRows = new SvelteSet<string>();

	// Inline remove opens the same delete-files confirmation as the detail
	// modal and always deletes from disk (#579).
	let pendingRemoveActivity = $state<UnifiedActivity | null>(null);
	let removeConfirmOpen = $state(false);
	let removeConfirmLoading = $state(false);

	const selectableIds = $derived.by(() =>
		selectionMode
			? activities.filter((activity) => isSelectable(activity)).map((activity) => activity.id)
			: []
	);
	const allSelectableSelected = $derived.by(
		() => selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id))
	);
	const someSelectableSelected = $derived.by(
		() => selectableIds.some((id) => selectedIds.has(id)) && !allSelectableSelected
	);

	function toggleRow(id: string) {
		if (expandedRows.has(id)) {
			expandedRows.delete(id);
		} else {
			expandedRows.add(id);
		}
	}

	function toggleFailedReason(id: string) {
		if (failedReasonExpandedRows.has(id)) {
			failedReasonExpandedRows.delete(id);
		} else {
			failedReasonExpandedRows.add(id);
		}
	}

	async function runQueueAction(
		activity: UnifiedActivity,
		action: 'pause' | 'resume' | 'remove' | 'retry'
	): Promise<void> {
		if (!activity.queueItemId) return;
		if (queueActionLoadingRows.has(activity.id)) return;

		if (action === 'remove') {
			if (!onRemove || removeConfirmOpen || removeConfirmLoading) return;
			pendingRemoveActivity = activity;
			removeConfirmOpen = true;
			return;
		}

		const handler = action === 'pause' ? onPause : action === 'resume' ? onResume : onRetry;
		if (!handler) return;

		queueActionLoadingRows.add(activity.id);
		try {
			await handler(activity.queueItemId);
			if (action === 'pause') toasts.success(m.activity_detail_downloadPaused());
			if (action === 'resume') toasts.success(m.activity_detail_downloadResumed());
			if (action === 'retry') {
				toasts.success(
					activity.status === 'failed' && isImportFailedActivity(activity)
						? m.activity_detail_importRetryInitiated()
						: m.activity_detail_downloadRetryInitiated()
				);
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : m.activity_table_failedToAction({ action });
			toasts.error(message);
		} finally {
			queueActionLoadingRows.delete(activity.id);
		}
	}

	function isRowSelected(activityId: string): boolean {
		return selectedIds.has(activityId);
	}

	function toggleSelection(activity: UnifiedActivity, selected: boolean): void {
		if (!selectionMode || !isSelectable(activity)) {
			return;
		}
		onToggleSelection?.(activity.id, selected);
	}

	function toggleSelectionAll(selected: boolean): void {
		if (!selectionMode || selectableIds.length === 0) {
			return;
		}
		onToggleSelectionAll?.(selectableIds, selected);
	}

	function cancelInlineRemove(): void {
		if (removeConfirmLoading) return;
		removeConfirmOpen = false;
		pendingRemoveActivity = null;
	}

	async function confirmInlineRemove(
		deleteFiles: boolean,
		removeFromLibrary: boolean
	): Promise<void> {
		const activity = pendingRemoveActivity;
		if (!activity?.queueItemId || !onRemove || removeConfirmLoading) return;
		removeConfirmLoading = true;
		queueActionLoadingRows.add(activity.id);
		try {
			await onRemove(activity.queueItemId, { deleteFiles, removeFromLibrary });
			toasts.success(
				removeFromLibrary
					? m.toast_library_movieDetail_movieRemoved()
					: m.activity_detail_downloadRemoved()
			);
			removeConfirmOpen = false;
			pendingRemoveActivity = null;
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: m.activity_table_failedToAction({ action: 'remove' });
			toasts.error(message);
		} finally {
			queueActionLoadingRows.delete(activity.id);
			removeConfirmLoading = false;
		}
	}
</script>

{#if activities.length === 0}
	<div class="py-12 text-center text-base-content/60">
		<Minus class="mx-auto mb-4 h-12 w-12 opacity-40" />
		<p class="text-lg font-medium">{m.activity_table_noActivity()}</p>
		<p class="mt-1 text-sm">{m.activity_table_noActivityHint()}</p>
	</div>
{:else if isMobile}
	<div class="space-y-3">
		{#each renderer.visible as activity (activity.id)}
			<ActivityMobileCard
				{activity}
				{compact}
				{selectionMode}
				isSelected={isRowSelected(activity.id)}
				isSelectable={isSelectable(activity)}
				isExpanded={expandedRows.has(activity.id)}
				isFailedReasonExpanded={failedReasonExpandedRows.has(activity.id)}
				isQueueActionLoading={queueActionLoadingRows.has(activity.id)}
				onToggle={() => toggleRow(activity.id)}
				onToggleFailedReason={() => toggleFailedReason(activity.id)}
				onQueueAction={(action) => runQueueAction(activity, action)}
				onToggleSelection={(selected) => toggleSelection(activity, selected)}
			/>
		{/each}
	</div>

	{#if renderer.hasMore || hasMore}
		<div bind:this={renderer.sentinel} class="flex justify-center py-4">
			{#if isLoadingMore}
				<Loader2 class="h-5 w-5 animate-spin text-base-content/40" />
			{/if}
		</div>
	{/if}
{:else}
	<div class="overflow-x-auto">
		<table class="table table-sm">
			<thead>
				<ActivityTableHeader
					{compact}
					{selectionMode}
					{sortField}
					{sortDirection}
					{onSort}
					{allSelectableSelected}
					{someSelectableSelected}
					selectableCount={selectableIds.length}
					onToggleSelectionAll={toggleSelectionAll}
				/>
			</thead>
			<tbody>
				{#each renderer.visible as activity (activity.id)}
					<ActivityRow
						{activity}
						{compact}
						{selectionMode}
						isSelected={isRowSelected(activity.id)}
						isSelectable={isSelectable(activity)}
						isExpanded={expandedRows.has(activity.id)}
						onToggle={() => toggleRow(activity.id)}
						{onRowClick}
						onToggleSelection={(selected) => toggleSelection(activity, selected)}
					/>
				{/each}
			</tbody>
		</table>
	</div>

	{#if renderer.hasMore || hasMore}
		<div bind:this={renderer.sentinel} class="flex justify-center py-4">
			{#if isLoadingMore}
				<Loader2 class="h-5 w-5 animate-spin text-base-content/40" />
			{/if}
		</div>
	{/if}
{/if}

<DeleteConfirmationModal
	open={removeConfirmOpen}
	title={m.activity_detail_removeConfirmTitle()}
	itemName={pendingRemoveActivity?.releaseTitle || pendingRemoveActivity?.mediaTitle || ''}
	allowRemoveFromLibrary={pendingRemoveActivity?.mediaType === 'movie' &&
		!!pendingRemoveActivity?.mediaId}
	hasFiles
	defaultDeleteFiles
	loading={removeConfirmLoading}
	onConfirm={(deleteFiles, removeFromLibrary) =>
		void confirmInlineRemove(deleteFiles, removeFromLibrary)}
	onCancel={cancelInlineRemove}
/>

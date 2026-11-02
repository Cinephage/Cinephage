<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import * as m from '#lib/paraglide/messages.js';
	import { isImportFailedActivity, type UnifiedActivity } from '#lib/types/activity.js';
	import { Minus } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import RemoveDownloadConfirmModal from './RemoveDownloadConfirmModal.svelte';
	import ActivityTableHeader from './ActivityTableHeader.svelte';
	import ActivityRow from './ActivityRow.svelte';

	interface Props {
		activities: UnifiedActivity[];
		sortField?: string;
		sortDirection?: 'asc' | 'desc';
		onSort?: (field: string) => void;
		onPause?: (id: string) => Promise<void>;
		onResume?: (id: string) => Promise<void>;
		onRemove?: (
			id: string,
			options?: { deleteFiles?: boolean; blocklist?: boolean }
		) => Promise<void>;
		onRetry?: (id: string) => Promise<void>;
		onBlocklistHistory?: (historyId: string) => Promise<void>;
		selectedIds?: Set<string>;
		isSelectable?: (activity: UnifiedActivity) => boolean;
		onToggleSelection?: (activityId: string, selected: boolean) => void;
		onToggleSelectionAll?: (activityIds: string[], selected: boolean) => void;
		currentPage?: number;
		totalPages?: number;
		onPageChange?: (page: number) => void;
	}

	let {
		activities,
		sortField = 'time',
		sortDirection = 'desc',
		onSort,
		onPause,
		onResume,
		onRemove,
		onRetry,
		onBlocklistHistory,
		selectedIds = new Set<string>(),
		isSelectable = () => false,
		onToggleSelection,
		onToggleSelectionAll,
		currentPage = 1,
		totalPages = 1,
		onPageChange
	}: Props = $props();

	let expandedId = $state<string | null>(null);
	let queueActionLoadingRows = new SvelteSet<string>();
	let blocklistLoadingRows = new SvelteSet<string>();

	const selectableIds = $derived.by(() =>
		activities.filter((activity) => isSelectable(activity)).map((activity) => activity.id)
	);
	const allSelectableSelected = $derived.by(
		() => selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id))
	);
	const someSelectableSelected = $derived.by(
		() => selectableIds.some((id) => selectedIds.has(id)) && !allSelectableSelected
	);

	function toggleRow(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	// Remove needs a confirmation step first (parity with the detail modal's
	// remove flow) rather than running immediately like pause/resume/retry -
	// see requestRemove/confirmRemove/cancelRemoveConfirm below.
	let removeConfirmActivity = $state<UnifiedActivity | null>(null);

	async function runQueueAction(
		activity: UnifiedActivity,
		action: 'pause' | 'resume' | 'remove' | 'retry'
	): Promise<void> {
		if (!activity.queueItemId) return;
		if (queueActionLoadingRows.has(activity.id)) return;

		if (action === 'remove') {
			if (!onRemove) return;
			removeConfirmActivity = activity;
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

	async function runBlocklistHistory(activity: UnifiedActivity): Promise<void> {
		if (!activity.downloadHistoryId || !onBlocklistHistory) return;
		if (blocklistLoadingRows.has(activity.id)) return;

		blocklistLoadingRows.add(activity.id);
		try {
			await onBlocklistHistory(activity.downloadHistoryId);
			toasts.success(m.activity_detail_blocklisted());
		} catch (error) {
			const message =
				error instanceof Error ? error.message : m.activity_detail_failedToBlocklist();
			toasts.error(message);
		} finally {
			blocklistLoadingRows.delete(activity.id);
		}
	}

	function cancelRemoveConfirm(): void {
		if (removeConfirmActivity && queueActionLoadingRows.has(removeConfirmActivity.id)) return;
		removeConfirmActivity = null;
	}

	async function confirmRemove(options: { blocklist: boolean }): Promise<void> {
		const activity = removeConfirmActivity;
		if (!activity?.queueItemId || !onRemove) return;

		queueActionLoadingRows.add(activity.id);
		try {
			// Removing a download - whether mid-download or failed - implies the
			// user wants it fully gone, partial/completed files included, so no
			// orphaned data survives on disk (Issue #579).
			await onRemove(activity.queueItemId, { deleteFiles: true, blocklist: options.blocklist });
			toasts.success(m.activity_detail_downloadRemoved());
			removeConfirmActivity = null;
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: m.activity_table_failedToAction({ action: 'remove' });
			toasts.error(message);
		} finally {
			queueActionLoadingRows.delete(activity.id);
		}
	}

	function isRowSelected(activityId: string): boolean {
		return selectedIds.has(activityId);
	}

	function toggleSelection(activity: UnifiedActivity, selected: boolean): void {
		if (!isSelectable(activity)) {
			return;
		}
		onToggleSelection?.(activity.id, selected);
	}

	function toggleSelectionAll(selected: boolean): void {
		if (selectableIds.length === 0) {
			return;
		}
		onToggleSelectionAll?.(selectableIds, selected);
	}
</script>

{#if activities.length === 0}
	<div class="py-12 text-center text-base-content/60">
		<Minus class="mx-auto mb-4 h-12 w-12 opacity-40" />
		<p class="text-lg font-medium">{m.activity_table_noActivity()}</p>
		<p class="mt-1 text-sm">{m.activity_table_noActivityHint()}</p>
	</div>
{:else}
	<div class="overflow-x-auto rounded-lg border border-base-content/12 bg-base-100 shadow-sm">
		<table class="table w-full table-sm">
			<thead>
				<ActivityTableHeader
					{sortField}
					{sortDirection}
					{onSort}
					{allSelectableSelected}
					{someSelectableSelected}
					selectableCount={selectableIds.length}
					onToggleSelectionAll={toggleSelectionAll}
				/>
			</thead>
			<tbody class="divide-y divide-base-content/8">
				{#each activities as activity (activity.id)}
					<ActivityRow
						{activity}
						isSelected={isRowSelected(activity.id)}
						isSelectable={isSelectable(activity)}
						isExpanded={expandedId === activity.id}
						isQueueActionLoading={queueActionLoadingRows.has(activity.id)}
						isBlocklistLoading={blocklistLoadingRows.has(activity.id)}
						onToggle={() => toggleRow(activity.id)}
						onToggleSelection={(selected) => toggleSelection(activity, selected)}
						onQueueAction={(action) => runQueueAction(activity, action)}
						onBlocklistHistory={onBlocklistHistory
							? () => runBlocklistHistory(activity)
							: undefined}
					/>
				{/each}
			</tbody>
			{#if totalPages > 1}
				<tfoot>
					<tr>
						<td colspan={9} class="border-t border-base-content/8 py-2">
							<div class="flex items-center justify-center gap-2">
								<button
									class="btn btn-ghost btn-xs"
									disabled={currentPage <= 1}
									onclick={() => onPageChange?.(currentPage - 1)}
								>
									{m.reports_pagination_prev()}
								</button>
								<span class="text-xs text-base-content/60">{currentPage} / {totalPages}</span>
								<button
									class="btn btn-ghost btn-xs"
									disabled={currentPage >= totalPages}
									onclick={() => onPageChange?.(currentPage + 1)}
								>
									{m.reports_pagination_next()}
								</button>
							</div>
						</td>
					</tr>
				</tfoot>
			{/if}
		</table>
	</div>
{/if}

<RemoveDownloadConfirmModal
	open={removeConfirmActivity !== null}
	isBlocklisted={removeConfirmActivity?.isBlocklisted}
	loading={removeConfirmActivity ? queueActionLoadingRows.has(removeConfirmActivity.id) : false}
	onConfirm={confirmRemove}
	onCancel={cancelRemoveConfirm}
/>

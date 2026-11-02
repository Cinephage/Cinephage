<script lang="ts">
	import { ChevronDown, ChevronRight, MessageSquare } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { UnifiedTask } from '#lib/server/tasks/UnifiedTaskRegistry.js';
	import type { TaskHistoryEntry } from '#lib/types/task.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { formatDateRange, formatDisplayDate } from '#lib/utils/format.js';

	interface Props {
		task: UnifiedTask;
		history: TaskHistoryEntry[];
		onClose: () => void;
	}

	let { task, history, onClose }: Props = $props();
	let expandedResultErrors = $state<Record<string, boolean>>({});

	function formatDuration(startedAt: string, completedAt: string | null): string {
		if (!completedAt) return '—';
		return formatDateRange(new Date(startedAt), new Date(completedAt));
	}

	function getStatusColor(status: string): string {
		switch (status) {
			case 'completed':
				return 'badge-success';
			case 'failed':
				return 'badge-error';
			case 'cancelled':
				return 'badge-warning';
			case 'running':
				return 'badge-primary';
			default:
				return 'badge-ghost';
		}
	}

	function getSummarySource(
		results: Record<string, unknown> | null
	): Record<string, unknown> | null {
		if (!results) return null;
		if (typeof results.result === 'object' && results.result !== null) {
			return results.result as Record<string, unknown>;
		}
		return results;
	}

	function asNumber(value: unknown): number | null {
		return typeof value === 'number' ? value : null;
	}

	function getErrorCount(summary: Record<string, unknown> | null): number | null {
		if (!summary) return null;
		const errors = summary.errors;
		if (typeof errors === 'number') return errors;
		if (Array.isArray(errors)) return errors.length;
		return null;
	}

	function getResultErrorItems(
		summary: Record<string, unknown> | null
	): Array<{ error: string; path?: string }> {
		if (!summary || !Array.isArray(summary.errors)) return [];
		const items: Array<{ error: string; path?: string }> = [];

		for (const entry of summary.errors) {
			if (typeof entry === 'string') {
				items.push({ error: entry });
				continue;
			}
			if (!entry || typeof entry !== 'object') continue;

			const maybeError = 'error' in entry ? entry.error : undefined;
			const maybePath = 'path' in entry ? entry.path : undefined;
			const error = typeof maybeError === 'string' ? maybeError : 'Unknown error';
			const path = typeof maybePath === 'string' ? maybePath : undefined;
			items.push({ error, path });
		}

		return items;
	}

	function toggleResultErrors(entryId: string): void {
		expandedResultErrors = {
			...expandedResultErrors,
			[entryId]: !expandedResultErrors[entryId]
		};
	}
</script>

<ModalWrapper open={true} {onClose} maxWidth="4xl" labelledBy="task-history-modal-title">
	<div>
		<div class="mb-4 flex items-center justify-between">
			<div>
				<h3 id="task-history-modal-title" class="text-lg font-bold">
					{task.name} - {m.task_card_history()}
				</h3>
				<p class="text-sm text-base-content/60">{task.description}</p>
			</div>
			<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>✕</button>
		</div>

		{#if history.length === 0}
			<div class="py-8 text-center text-base-content/60">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="48"
					height="48"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="mx-auto mb-3 opacity-30"
				>
					<polyline points="9 11 12 14 22 4" />
					<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
				</svg>
				<p>{m.task_historyModal_noHistory()}</p>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="table-compact table w-full table-zebra">
					<thead>
						<tr>
							<th>{m.task_historyModal_status()}</th>
							<th>{m.task_historyModal_started()}</th>
							<th>{m.task_historyModal_duration()}</th>
							<th>{m.task_historyModal_details()}</th>
						</tr>
					</thead>
					<tbody>
						{#each history as entry (entry.id)}
							{@const summary = getSummarySource(entry.results)}
							{@const itemsProcessed = asNumber(summary?.itemsProcessed)}
							{@const itemsGrabbed = asNumber(summary?.itemsGrabbed)}
							{@const updatedFiles = asNumber(summary?.updatedFiles ?? summary?.updated)}
							{@const filesScanned = asNumber(summary?.filesScanned)}
							{@const filesAdded = asNumber(summary?.filesAdded)}
							{@const filesUpdated = asNumber(summary?.filesUpdated)}
							{@const filesRemoved = asNumber(summary?.filesRemoved)}
							{@const unmatchedFiles = asNumber(summary?.unmatchedFiles)}
							{@const probeFallbackUsed = asNumber(summary?.probeFallbackUsed)}
							{@const errorCount = getErrorCount(summary)}
							{@const resultErrorItems = getResultErrorItems(summary)}
							{@const showResultErrors = !!expandedResultErrors[entry.id]}
							<tr>
								<td>
									<span class="badge badge-sm {getStatusColor(entry.status)}">
										{entry.status}
									</span>
								</td>
								<td class="text-sm whitespace-nowrap">{formatDisplayDate(entry.startedAt)}</td>
								<td class="text-sm">
									{formatDuration(entry.startedAt, entry.completedAt)}
								</td>
								<td class="text-sm">
									{#if entry.results}
										<div class="space-y-0.5 text-xs">
											{#if itemsProcessed !== null}
												<div>{m.task_historyModal_processed({ count: itemsProcessed })}</div>
											{/if}
											{#if itemsGrabbed !== null}
												<div>{m.task_historyModal_grabbed({ count: itemsGrabbed })}</div>
											{/if}
											{#if updatedFiles !== null}
												<div>{m.task_historyModal_updated({ count: updatedFiles })}</div>
											{/if}
											{#if filesScanned !== null}
												<div>{m.task_historyModal_scanned({ count: filesScanned })}</div>
											{/if}
											{#if filesAdded !== null && filesAdded > 0}
												<div>{m.task_historyModal_added({ count: filesAdded })}</div>
											{/if}
											{#if filesUpdated !== null && filesUpdated > 0}
												<div>{m.task_historyModal_updatedFiles({ count: filesUpdated })}</div>
											{/if}
											{#if filesRemoved !== null && filesRemoved > 0}
												<div>{m.task_historyModal_removed({ count: filesRemoved })}</div>
											{/if}
											{#if unmatchedFiles !== null && unmatchedFiles > 0}
												<div>{m.task_historyModal_unmatched({ count: unmatchedFiles })}</div>
											{/if}
											{#if probeFallbackUsed !== null && probeFallbackUsed > 0}
												<div>{m.task_historyModal_fallback({ count: probeFallbackUsed })}</div>
											{/if}
											{#if errorCount !== null && errorCount > 0}
												<div class="text-error">
													{m.task_historyModal_errors({ count: errorCount })}
												</div>
											{/if}
											{#if resultErrorItems.length > 0}
												<button
													type="button"
													class="btn mt-1 h-6 min-h-0 gap-1 btn-ghost px-1.5 btn-xs"
													onclick={() => toggleResultErrors(entry.id)}
												>
													{#if showResultErrors}
														<ChevronDown class="h-3 w-3" />
													{:else}
														<ChevronRight class="h-3 w-3" />
													{/if}
													<MessageSquare class="h-3 w-3" />
													{m.task_historyModal_viewFailedItems()}
												</button>
											{/if}
										</div>
									{:else}
										<span class="text-base-content/40">—</span>
									{/if}
								</td>
							</tr>
							{#if resultErrorItems.length > 0 && showResultErrors}
								<tr class="bg-base-200/40">
									<td colspan="4" class="text-sm">
										<div class="max-h-56 space-y-2 overflow-y-auto pr-1">
											{#each resultErrorItems as item, index (`${entry.id}-${index}-${item.path ?? item.error}`)}
												<div class="rounded bg-base-100 p-2 text-xs">
													<div class="font-medium text-error">{item.error}</div>
													{#if item.path}
														<div class="mt-1 font-mono break-all text-base-content/60">
															{item.path}
														</div>
													{/if}
												</div>
											{/each}
										</div>
									</td>
								</tr>
							{/if}
							{#if entry.errors && Array.isArray(entry.errors) && entry.errors.length > 0}
								<tr class="bg-error/5">
									<td colspan="4" class="text-sm">
										<div class="mb-1 font-medium text-error">
											{m.task_historyModal_errorsSection()}
										</div>
										<ul class="list-inside list-disc space-y-0.5 text-xs">
											{#each entry.errors as error (error)}
												<li>{error}</li>
											{/each}
										</ul>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<div class="modal-action">
			<button class="btn btn-primary" onclick={onClose}>{m.task_historyModal_close()}</button>
		</div>
	</div>
</ModalWrapper>

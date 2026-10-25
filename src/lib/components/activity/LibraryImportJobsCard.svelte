<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getImportBatchSummary,
		getImportBatchJobs,
		retryImportBatch,
		dismissImportBatch,
		cancelImportBatch
	} from '#lib/api/index.js';
	import { formatDuration } from '#lib/utils/format.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { RotateCw, X, ChevronDown, ChevronUp, Ban } from '@lucide/svelte';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';

	interface Batch {
		key: string;
		total: number;
		completed: number;
		failed: number;
		active: boolean;
		createdAt: string;
		itemName: string | null;
		acknowledged: boolean;
	}

	interface FailedItem {
		id: string;
		itemName: string;
		errorMessage: string | null;
	}

	let { batches: initialBatches = [] as Batch[] }: { batches?: Batch[] } = $props();

	// Deliberately a one-time snapshot, not a live mirror of the prop — this
	// component manages `batches` itself from here on (polling, dismiss,
	// retry, cancel), and re-fetches fresh data on mount anyway (see the
	// refresh() effect below), so it doesn't need to track prop changes.
	let batches = $state<Batch[]>(untrack(() => initialBatches));
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let busyKey = $state<string | null>(null);
	let expandedKey = $state<string | null>(null);
	let confirmCancelKey = $state<string | null>(null);
	let failedItemsByKey = $state<Record<string, FailedItem[]>>({});
	let loadingDetailsKey = $state<string | null>(null);

	// Only worth showing while something is actually running, or there's a
	// failure the user hasn't already dismissed — a card full of past
	// successes (or things the user already dealt with) is just noise.
	const activeBatches = $derived(batches.filter((b) => b.active));
	const actionableBatches = $derived(
		batches.filter((b) => !b.active && b.failed > 0 && !b.acknowledged).slice(0, 8)
	);

	function batchLabel(batch: Batch): string {
		if (batch.total === 1) return batch.itemName ?? m.activity_importJobsCardSingleImport();
		return m.activity_importJobsCardBatchOf({ count: batch.total });
	}

	function elapsedLabel(createdAt: string): string {
		const diffMs = Date.now() - new Date(createdAt).getTime();
		if (diffMs < 0 || diffMs < 60000) return 'just now';
		return `${formatDuration(diffMs)} ago`;
	}

	async function refresh() {
		try {
			const response = await getImportBatchSummary();
			const rows = (response as { batches?: Batch[] } | undefined)?.batches;
			if (rows) batches = rows;
		} catch {
			// Transient poll errors — keep the last known state, try again next tick.
		}
	}

	async function toggleDetails(key: string) {
		if (expandedKey === key) {
			expandedKey = null;
			return;
		}
		expandedKey = key;
		if (failedItemsByKey[key]) return;

		loadingDetailsKey = key;
		try {
			const response = await getImportBatchJobs(key);
			const jobs =
				(
					response as
						| {
								jobs?: Array<{
									id: string;
									status: string;
									errorMessage?: string | null;
									metadata?: { groupName?: string } | null;
								}>;
						  }
						| undefined
				)?.jobs ?? [];
			failedItemsByKey[key] = jobs
				.filter((j) => j.status === 'failed' || j.status === 'cancelled')
				.map((j) => ({
					id: j.id,
					itemName: j.metadata?.groupName ?? m.activity_importJobsCardSingleImport(),
					errorMessage: j.errorMessage ?? null
				}));
		} catch {
			toasts.error('Failed to load import details');
			expandedKey = null;
		} finally {
			loadingDetailsKey = null;
		}
	}

	async function retryBatch(key: string) {
		if (busyKey) return;
		busyKey = key;
		try {
			await retryImportBatch(key);
			toasts.info(m.activity_importJobsCardRetryStarted());
			const { [key]: _removed, ...rest } = failedItemsByKey;
			failedItemsByKey = rest;
			expandedKey = null;
			await refresh();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to retry import batch');
		} finally {
			busyKey = null;
		}
	}

	async function dismissBatch(key: string) {
		if (busyKey) return;
		busyKey = key;
		try {
			await dismissImportBatch(key);
			batches = batches.map((b) => (b.key === key ? { ...b, acknowledged: true } : b));
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to dismiss import batch');
		} finally {
			busyKey = null;
		}
	}

	function requestCancelBatch(key: string) {
		confirmCancelKey = key;
	}

	async function confirmCancelBatch() {
		const key = confirmCancelKey;
		if (!key || busyKey) return;
		busyKey = key;
		confirmCancelKey = null;
		try {
			await cancelImportBatch(key);
			toasts.info(m.activity_importJobsCardCancelStarted());
			await refresh();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to cancel import batch');
		} finally {
			busyKey = null;
		}
	}

	// The initial `batches` prop is whatever the page's server load saw at
	// that request — SvelteKit's client-side router can reuse that same load
	// result across a soft navigation away and back, so a dismiss/retry done
	// in a previous mount of this component wouldn't otherwise show up until
	// a hard refresh forced the load to rerun. Always get the live state once
	// this component actually mounts, instead of trusting the prop forever.
	$effect(() => {
		refresh();
	});

	$effect(() => {
		if (activeBatches.length > 0) {
			if (!pollTimer) {
				pollTimer = setInterval(refresh, 5000);
			}
		} else if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		return () => {
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
		};
	});
</script>

{#if activeBatches.length > 0 || actionableBatches.length > 0}
	<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
		<h3 class="font-semibold">{m.activity_importJobsCardTitle()}</h3>

		{#if activeBatches.length > 0}
			<div class="mt-3 space-y-2">
				<div class="text-xs font-medium text-base-content/60">
					{m.activity_importJobsCardActive()}
				</div>
				{#each activeBatches as batch (batch.key)}
					{@const progressPct =
						batch.total > 0 ? (batch.completed + batch.failed) / batch.total : 0}
					<div class="rounded-lg border border-primary/30 bg-base-200 p-3">
						<div class="mb-1.5 flex items-center justify-between gap-2 text-sm">
							<span class="flex min-w-0 items-center gap-2 truncate font-medium">
								<span class="loading loading-xs loading-spinner text-primary"></span>
								<span class="truncate">{batchLabel(batch)}</span>
							</span>
							<span class="flex shrink-0 items-center gap-2 text-xs text-base-content/60">
								{m.activity_importJobsCardProgress({
									completed: batch.completed,
									total: batch.total
								})}
								<button
									type="button"
									class="btn gap-1 btn-error btn-xs"
									disabled={busyKey === batch.key}
									onclick={() => requestCancelBatch(batch.key)}
								>
									<Ban class="h-3 w-3" />
									{m.activity_importJobsCardCancel()}
								</button>
							</span>
						</div>
						{#if batch.total > 1 && batch.itemName}
							<div class="mb-1.5 truncate text-xs text-base-content/60">
								{m.activity_importJobsCardCurrentItem({ name: batch.itemName })}
							</div>
						{/if}
						<progress class="progress w-full progress-primary" value={progressPct * 100} max={100}
						></progress>
						{#if batch.failed > 0}
							<div class="mt-1 text-xs text-error">
								{m.activity_importJobsCardFailedCount({ count: batch.failed })}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#if actionableBatches.length > 0}
			<div class="mt-3 space-y-2">
				<div class="text-xs font-medium text-base-content/60">
					{m.activity_importJobsCardNeedsAttention()}
				</div>
				{#each actionableBatches as batch (batch.key)}
					<div class="rounded-lg border border-warning/30 bg-base-200 p-3">
						<div class="flex items-center justify-between gap-2">
							<div class="flex min-w-0 items-center gap-2">
								{#if batch.completed === 0}
									<span class="badge badge-sm badge-error">{m.status_failed()}</span>
								{:else}
									<span class="badge badge-sm badge-warning"
										>{m.activity_importJobsCardFailedCount({ count: batch.failed })}</span
									>
								{/if}
								<span class="truncate text-sm font-medium">{batchLabel(batch)}</span>
							</div>
							<span class="shrink-0 text-xs text-base-content/50"
								>{elapsedLabel(batch.createdAt)}</span
							>
						</div>

						<div class="mt-2 flex items-center gap-1.5">
							<button
								type="button"
								class="btn gap-1 btn-ghost btn-xs"
								onclick={() => toggleDetails(batch.key)}
							>
								{#if expandedKey === batch.key}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
								{m.activity_importJobsCardShowDetails()}
							</button>
							<button
								type="button"
								class="btn gap-1 btn-ghost btn-xs"
								disabled={busyKey === batch.key}
								onclick={() => retryBatch(batch.key)}
							>
								{#if busyKey === batch.key}
									<span class="loading loading-xs loading-spinner"></span>
								{:else}
									<RotateCw class="h-3 w-3" />
								{/if}
								{m.activity_importJobsCardRetry()}
							</button>
							<button
								type="button"
								class="btn gap-1 btn-ghost btn-xs"
								disabled={busyKey === batch.key}
								onclick={() => dismissBatch(batch.key)}
							>
								<X class="h-3 w-3" />
								{m.activity_importJobsCardDismiss()}
							</button>
						</div>

						{#if expandedKey === batch.key}
							<div class="mt-2 max-h-48 overflow-y-auto rounded-lg bg-base-100 p-2">
								{#if loadingDetailsKey === batch.key}
									<div class="flex items-center gap-2 p-2 text-xs text-base-content/60">
										<span class="loading loading-xs loading-spinner"></span>
										{m.activity_importJobsCardLoadingDetails()}
									</div>
								{:else}
									{#each failedItemsByKey[batch.key] ?? [] as item (item.id)}
										<div class="border-b border-base-300 p-1.5 last:border-0">
											<div class="truncate text-xs font-medium">{item.itemName}</div>
											<div class="truncate text-xs text-error">
												{item.errorMessage ?? m.activity_importJobsCardUnknownError()}
											</div>
										</div>
									{/each}
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<ConfirmationModal
	open={confirmCancelKey !== null}
	title={m.activity_importJobsCardCancel()}
	message={m.activity_importJobsCardCancelConfirm()}
	confirmLabel={m.activity_importJobsCardCancel()}
	confirmVariant="error"
	onConfirm={confirmCancelBatch}
	onCancel={() => (confirmCancelKey = null)}
/>

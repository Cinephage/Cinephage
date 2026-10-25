<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { createSSE } from '#lib/sse/index.js';
	import { layoutState, deriveMobileSseStatus } from '#lib/layout.svelte.js';

	type InsightsUpdatedPayload = { triggeredBy?: string; timestamp?: string };

	let { children } = $props();

	// Scan SSE for the connection status indicator only. Toast notifications,
	// state management, and progress updates are handled by the root layout's
	// global SSE so they fire from any page. This connection drives the mobile
	// SSE status chip that is specific to this sub-tree.
	const scanSse = createSSE<{
		status: Record<string, unknown>;
		progress: Record<string, unknown>;
		scanStart: Record<string, unknown>;
		scanComplete: Record<string, unknown>;
		scanError: Record<string, unknown>;
	}>('/api/library/scan/status', {
		status: () => {},
		progress: () => {},
		scanStart: () => {},
		scanComplete: () => {},
		scanError: () => {}
	});

	const insightSse = createSSE<{
		'storage:insight-dismissed': { insightId: string; dismissedAt: string };
		'storage:insight-undismissed': { insightId: string };
		'storage:insights-updated': InsightsUpdatedPayload;
	}>('/api/storage/insights/stream', {
		'storage:insight-dismissed': () => {
			// Local state already handles dismiss - no server reload needed.
		},
		'storage:insight-undismissed': () => {
			// Local state already handles undismiss - no server reload needed.
		},
		'storage:insights-updated': (payload) => {
			if (payload?.timestamp) {
				layoutState.markInsightsUpdated(payload.timestamp);
			}
			void refreshAll();
		}
	});

	$effect(() => {
		layoutState.setMobileSseStatus(deriveMobileSseStatus(scanSse));
		return () => layoutState.clearMobileSseStatus();
	});

	// On mount: invalidate to catch mutations that happened while the user was
	// outside the /status/* area (and thus not listening to the SSE streams
	// above). Cheap relative to the cost of showing stale data.
	onMount(() => {
		void refreshAll();
	});

	$effect(() => {
		// Touch SSE status to keep reactivity subscription alive.
		void scanSse.status;
		void insightSse.status;
	});
</script>

{#snippet scanProgressBar()}
	{#if layoutState.scanInProgress && layoutState.scanProgress}
		<div class="card mb-4 bg-base-200 p-4">
			<div class="mb-2 flex items-center justify-between text-sm">
				<span class="truncate">{layoutState.scanProgress.rootFolderPath ?? 'Scanning...'}</span>
				<span class="text-base-content/60"
					>{layoutState.scanProgress.filesProcessed} / {layoutState.scanProgress.filesFound}</span
				>
			</div>
			<progress
				class="progress w-full progress-primary"
				value={layoutState.scanProgress.filesProcessed}
				max={layoutState.scanProgress.filesFound || 1}
			></progress>
		</div>
	{:else if layoutState.scanInProgress}
		<div class="card mb-4 bg-base-200 p-4">
			<div class="flex items-center gap-2 text-sm text-base-content/70">
				<span class="loading loading-sm loading-spinner"></span>
				<span>Starting scan...</span>
			</div>
		</div>
	{/if}
{/snippet}

{#if layoutState.scanInProgress}
	<div class="px-1 pt-4">
		{@render scanProgressBar()}
	</div>
{/if}

{@render children()}

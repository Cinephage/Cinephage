<script lang="ts">
	import { X, ChevronRight } from '@lucide/svelte';
	import { severityBadgeClass, insightTypeLabel, dismissInsight, formatBytes } from './utils.js';
	import type { Insight } from './utils.js';

	interface Props {
		insight: Insight;
		onOpen: () => void;
		onDismissed?: () => void;
	}

	let { insight, onOpen, onDismissed }: Props = $props();

	let dismissing = $state(false);

	async function handleDismiss(e: Event) {
		e.stopPropagation();
		dismissing = true;
		const success = await dismissInsight(insight.id);
		dismissing = false;
		if (success && onDismissed) {
			onDismissed();
		}
	}
</script>

<div
	role="button"
	tabindex="0"
	onclick={onOpen}
	onkeydown={(e) => {
		if (e.key === 'Enter') onOpen();
	}}
	class={`w-full rounded-lg border p-4 text-left ${severityBadgeClass(insight.severity)} cursor-pointer transition-colors hover:bg-base-300/30`}
>
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2">
				<span class="badge border-none badge-sm {severityBadgeClass(insight.severity)}">
					{insightTypeLabel(insight.insightType)}
				</span>
				{#if insight.reclaimableBytes}
					<span class="text-xs text-base-content/50">
						{formatBytes(insight.reclaimableBytes)} reclaimable
					</span>
				{/if}
			</div>
			<h4 class="mt-1 font-semibold text-base-content">{insight.title}</h4>
			{#if insight.summary}
				<p class="mt-1 text-sm text-base-content/70">{insight.summary}</p>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<button
				type="button"
				class="btn btn-ghost btn-xs"
				onclick={handleDismiss}
				disabled={dismissing}
				title="Dismiss"
			>
				{#if dismissing}
					<span class="loading loading-sm loading-spinner"></span>
				{:else}
					<X class="h-4 w-4" />
				{/if}
			</button>
			<ChevronRight class="h-4 w-4 shrink-0 text-base-content/30" />
		</div>
	</div>
</div>

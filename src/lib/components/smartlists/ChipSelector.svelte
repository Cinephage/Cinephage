<script lang="ts">
	import { Loader2 } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		loading: boolean;
		loadingMessage: string;
		labelText: string;
		selectedCount: number;
		selectedBadgeClass: string;
		children: Snippet;
	}

	let { loading, loadingMessage, labelText, selectedCount, selectedBadgeClass, children }: Props =
		$props();
</script>

<div class="form-control">
	<div class="label py-1">
		<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase">
			{labelText}
		</span>
		{#if selectedCount > 0}
			<span class="badge badge-sm {selectedBadgeClass}">{selectedCount}</span>
		{/if}
	</div>
	{#if loading}
		<div class="flex items-center gap-2 py-2">
			<Loader2 class="h-4 w-4 animate-spin" />
			<span class="text-sm text-base-content/60">{loadingMessage}</span>
		</div>
	{:else}
		{@render children()}
	{/if}
</div>

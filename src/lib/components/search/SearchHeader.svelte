<script lang="ts">
	import { Loader2, Package, RefreshCw, X } from '@lucide/svelte';

	type SearchMode = 'all' | 'multiSeasonPack';

	interface Props {
		title: string;
		searchMode: SearchMode;
		searching: boolean;
		onRefresh: () => void;
		onClose: () => void;
	}

	let { title, searchMode, searching, onRefresh, onClose }: Props = $props();
</script>

<div class="mb-1 flex items-start justify-between gap-2 sm:mb-3">
	<div class="min-w-0 flex-1">
		<h3
			id="interactive-search-modal-title"
			class="flex items-center gap-2 text-base font-bold sm:text-lg"
		>
			{#if searchMode === 'multiSeasonPack'}
				<Package size={18} class="shrink-0 text-primary" />
				<span class="truncate">Multi-Season Pack Search</span>
			{:else}
				Interactive Search
			{/if}
		</h3>
		<p class="truncate text-xs text-base-content/60 sm:text-sm">
			{title}
			{#if searchMode === 'multiSeasonPack'}
				<span class="ml-1 badge badge-xs badge-primary sm:badge-sm"
					>Complete Series / Multi-Season Only</span
				>
			{/if}
		</p>
	</div>
	<div class="flex shrink-0 items-center gap-1">
		<button class="btn btn-ghost btn-sm" onclick={onRefresh} disabled={searching}>
			{#if searching}
				<Loader2 size={16} class="animate-spin" />
			{:else}
				<RefreshCw size={16} />
			{/if}
			<span class="hidden sm:inline">Refresh</span>
		</button>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X size={16} />
		</button>
	</div>
</div>

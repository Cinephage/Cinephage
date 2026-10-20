<script lang="ts">
	import { X, CheckSquare, LibraryBig, Loader2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		selectedCount: number;
		loading: boolean;
		onSelectAll: () => void;
		onAdd: () => void;
		onClear: () => void;
	}

	let { selectedCount, loading, onSelectAll, onAdd, onClear }: Props = $props();
</script>

{#if selectedCount > 0}
	<div
		class="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-50 mx-auto max-w-fit"
	>
		<div
			class="flex items-center gap-2 rounded-full border border-base-content/10 bg-base-300 px-3 py-2 shadow-xl sm:gap-3 sm:px-4 sm:py-2.5"
		>
			<span class="shrink-0 text-sm font-medium whitespace-nowrap">
				{m.common_selected({ count: selectedCount })}
			</span>

			<div class="h-4 w-px bg-base-content/20"></div>

			<button
				class="btn gap-1.5 btn-ghost btn-sm"
				onclick={onSelectAll}
				disabled={loading}
				title={m.action_selectAll()}
			>
				<CheckSquare size={16} />
				<span class="hidden sm:inline">{m.action_selectAll()}</span>
			</button>

			<button class="btn gap-1.5 btn-primary btn-sm" onclick={onAdd} disabled={loading}>
				{#if loading}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<LibraryBig size={16} />
				{/if}
				<span class="hidden sm:inline">{m.tmdb_addToLibrary()}</span>
			</button>

			<div class="h-4 w-px bg-base-content/20"></div>

			<button
				class="btn btn-circle btn-ghost btn-sm"
				onclick={onClear}
				disabled={loading}
				title={m.action_clearSelection()}
				aria-label={m.action_clearSelection()}
			>
				<X size={16} />
			</button>
		</div>
	</div>
{/if}

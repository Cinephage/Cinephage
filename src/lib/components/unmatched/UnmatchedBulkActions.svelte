<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { X, Link, Trash2 } from '@lucide/svelte';
	import { unmatchedFilesStore } from '#lib/stores/unmatched-files.svelte.js';

	interface Props {
		onMatch?: () => void;
		onDelete?: () => void;
	}

	let { onMatch, onDelete }: Props = $props();

	let selectedCount = $derived(unmatchedFilesStore.selectedCount);

	function selectAll() {
		unmatchedFilesStore.selectAllFiles();
	}

	function clearSelection() {
		unmatchedFilesStore.clearSelection();
	}
</script>

{#if selectedCount > 0}
	<div
		class="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-50 mx-auto max-w-fit"
	>
		<div
			class="flex items-center gap-2 rounded-full border border-base-content/10 bg-base-300 px-3 py-2 shadow-xl sm:gap-3 sm:px-4 sm:py-2.5"
		>
			<span class="shrink-0 text-sm font-medium whitespace-nowrap">
				{m.unmatched_bulkActions_selectedCount({ count: selectedCount })}
			</span>

			<div class="h-4 w-px bg-base-content/20"></div>

			<div class="flex items-center gap-1">
				<button class="btn gap-1.5 btn-ghost btn-sm" onclick={selectAll}>
					{m.unmatched_bulkActions_selectAll()}
				</button>

				<button class="btn gap-1.5 btn-ghost btn-sm" onclick={onMatch}>
					<Link size={16} />
					<span class="hidden sm:inline">{m.unmatched_bulkActions_matchSelected()}</span>
				</button>

				<button
					class="btn gap-1.5 btn-ghost text-error btn-sm hover:bg-error/10"
					onclick={onDelete}
				>
					<Trash2 size={16} />
					<span class="hidden sm:inline">{m.unmatched_bulkActions_delete()}</span>
				</button>
			</div>

			<div class="h-4 w-px bg-base-content/20"></div>

			<button
				class="btn btn-circle btn-ghost btn-sm"
				onclick={clearSelection}
				title="Clear selection"
			>
				<X size={16} />
			</button>
		</div>
	</div>
{/if}

<script lang="ts">
	import { Library, Pencil } from '@lucide/svelte';
	import { formatBytes } from '#lib/utils/format.js';
	import type { LibraryBreakdownItem } from './utils.js';

	interface Props {
		libraries: LibraryBreakdownItem[];
		onEditLibrary?: (libraryId: string) => void;
	}

	let { libraries, onEditLibrary }: Props = $props();
</script>

<div class="card bg-base-200">
	<div class="flex items-center gap-2 border-b border-base-300 p-4">
		<Library class="h-4 w-4" />
		<h3 class="font-semibold">Libraries</h3>
		<span class="ml-auto text-sm text-base-content/50">{libraries.length} total</span>
	</div>
	{#if libraries.length === 0}
		<div class="p-4 text-sm text-base-content/50">No libraries configured.</div>
	{:else}
		<div class="divide-y divide-base-300">
			{#each libraries as lib (lib.id)}
				<button
					type="button"
					class="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-base-300/30"
					onclick={() => onEditLibrary?.(lib.id)}
				>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span class="font-medium text-base-content">{lib.name}</span>
							{#if lib.isDefault}
								<span class="badge badge-ghost badge-xs">default</span>
							{/if}
							{#if !lib.hasRootFolder}
								<span class="badge border-error/30 bg-error/10 badge-xs text-error">
									no folder
								</span>
							{/if}
							{#if lib.needsScan}
								<span class="badge border-warning/30 bg-warning/10 badge-xs text-warning">
									needs scan
								</span>
							{/if}
							{#if lib.scanMode}
								<span class="badge badge-outline badge-xs text-base-content/60">
									{lib.scanMode === 'watch'
										? 'watching'
										: lib.scanMode === 'scheduled_daily'
											? 'daily'
											: lib.scanMode === 'manual'
												? 'manual'
												: 'auto'}
								</span>
							{/if}
						</div>
						<div class="mt-0.5 text-xs text-base-content/50">
							{lib.itemCount} items &middot; {lib.mediaType}
							{#if lib.unmatchedCount}
								&middot; {lib.unmatchedCount} unmatched
							{/if}
						</div>
					</div>
					<div class="shrink-0 text-right">
						<div class="text-sm font-medium text-base-content">{formatBytes(lib.usedBytes)}</div>
					</div>
					<Pencil class="h-4 w-4 shrink-0 text-base-content/40" />
				</button>
			{/each}
		</div>
	{/if}
</div>

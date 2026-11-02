<script lang="ts">
	import { HardDrive, Pencil, RefreshCw } from '@lucide/svelte';
	import { formatBytes } from '#lib/utils/format.js';
	import { getRootFolderScanLabel, getRootFolderScanBadgeClass } from './utils.js';
	import type { RootFolderBreakdownItem } from './utils.js';

	interface Props {
		rootFolders: RootFolderBreakdownItem[];
		onEditRootFolder?: (folderId: string) => void;
		onScanRootFolder?: (folderId: string) => void;
	}

	let { rootFolders, onEditRootFolder, onScanRootFolder }: Props = $props();
</script>

<div class="card bg-base-200">
	<div class="flex items-center gap-2 border-b border-base-300 p-4">
		<HardDrive class="h-4 w-4" />
		<h3 class="font-semibold">Root Folders</h3>
		<span class="ml-auto text-sm text-base-content/50">{rootFolders.length} total</span>
	</div>
	{#if rootFolders.length === 0}
		<div class="p-4 text-sm text-base-content/50">No root folders configured.</div>
	{:else}
		<div class="divide-y divide-base-300">
			{#each rootFolders as folder (folder.id)}
				<div class="p-4">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="font-medium text-base-content">{folder.name}</span>
								{#if folder.accessible === false}
									<span class="badge border-error/30 bg-error/10 badge-xs text-error">
										inaccessible
									</span>
								{/if}
								{#if folder.readOnly}
									<span class="badge border-info/30 bg-info/10 badge-xs text-info">
										read-only
									</span>
								{/if}
								<span class={`badge badge-xs ${getRootFolderScanBadgeClass(folder)}`}>
									{getRootFolderScanLabel(folder)}
								</span>
							</div>
							<div class="mt-0.5 truncate text-xs text-base-content/50">{folder.path}</div>
						</div>
						<div class="flex shrink-0 gap-1">
							{#if onScanRootFolder}
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									onclick={() => onScanRootFolder(folder.id)}
									title="Scan folder"
								>
									<RefreshCw class="h-3.5 w-3.5" />
								</button>
							{/if}
							{#if onEditRootFolder}
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									onclick={() => onEditRootFolder(folder.id)}
									title="Edit folder"
								>
									<Pencil class="h-3.5 w-3.5" />
								</button>
							{/if}
						</div>
					</div>
					<div class="mt-2 flex items-center gap-3 text-xs">
						<span class="text-base-content/60">{formatBytes(folder.usedBytes)} used</span>
						{#if folder.freeSpaceBytes !== null && folder.freeSpaceBytes !== undefined}
							<span class="text-base-content/40">{formatBytes(folder.freeSpaceBytes)} free</span>
						{/if}
						{#if folder.unmatchedCount}
							<span class="text-warning">{folder.unmatchedCount} unmatched</span>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

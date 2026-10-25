<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Folder, ChevronUp, Loader2, Home, Check } from '@lucide/svelte';
	import { browseFilesystem } from '#lib/api/filesystem.js';

	interface DirectoryEntry {
		name: string;
		path: string;
		isDirectory: boolean;
	}

	interface Props {
		value: string;
		onSelect: (path: string) => void;
		onCancel: () => void;
	}

	let { value, onSelect, onCancel }: Props = $props();

	// Initialize with defaults, effect syncs from props
	let currentPath = $state('/');
	let entries = $state<DirectoryEntry[]>([]);
	let parentPath = $state<string | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	async function browse(path: string) {
		loading = true;
		error = null;

		try {
			const payload = await browseFilesystem(path);

			if (!payload || typeof payload !== 'object') {
				error = 'Invalid response from filesystem browser';
				return;
			}

			if (payload.error) {
				error = payload.error;
			}

			currentPath = payload.currentPath ?? path;
			parentPath = payload.parentPath ?? null;
			entries = payload.entries ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to browse directory';
		} finally {
			loading = false;
		}
	}

	function handleSelect() {
		onSelect(currentPath);
	}

	function navigateTo(path: string) {
		browse(path);
	}

	function goUp() {
		if (parentPath) {
			browse(parentPath);
		}
	}

	function goHome() {
		browse('/');
	}

	// Initial load
	$effect(() => {
		browse(value || '/');
	});
</script>

<div class="flex h-96 flex-col rounded-lg border border-base-300 bg-base-100">
	<!-- Header with current path -->
	<div class="flex items-center gap-2 border-b border-base-300 bg-base-200 p-3">
		<button
			type="button"
			class="btn btn-square btn-ghost btn-sm"
			onclick={goHome}
			title={m.library_folderBrowser_goToRoot()}
		>
			<Home class="h-4 w-4" />
		</button>
		<button
			type="button"
			class="btn btn-square btn-ghost btn-sm"
			onclick={goUp}
			disabled={!parentPath}
			title={m.library_folderBrowser_goUp()}
		>
			<ChevronUp class="h-4 w-4" />
		</button>
		<div class="flex-1 truncate rounded bg-base-100 px-2 py-1 font-mono text-sm">
			{currentPath}
		</div>
	</div>

	<!-- Directory listing -->
	<div class="flex-1 overflow-y-auto p-2">
		{#if loading}
			<div class="flex h-full items-center justify-center">
				<Loader2 class="h-6 w-6 animate-spin text-base-content/50" />
			</div>
		{:else if error}
			<div class="alert text-sm alert-error">
				<span>{error}</span>
			</div>
		{:else if entries.length === 0}
			<div class="flex h-full items-center justify-center text-base-content/50">
				<span>{m.library_folderBrowser_noSubdirectories()}</span>
			</div>
		{:else}
			<div class="space-y-1">
				{#each entries as entry (entry.path)}
					<button
						type="button"
						class="flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors hover:bg-base-200"
						ondblclick={() => navigateTo(entry.path)}
						onclick={() => navigateTo(entry.path)}
					>
						<Folder class="h-4 w-4 shrink-0 text-warning" />
						<span class="truncate">{entry.name}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Footer with actions -->
	<div class="flex flex-col gap-2 border-t border-base-300 bg-base-200 p-3">
		<div class="text-sm text-base-content/60">
			{m.library_folderBrowser_hint()}
		</div>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn btn-ghost btn-sm" onclick={onCancel}>
				{m.action_cancel()}
			</button>
			<button type="button" class="btn gap-1 btn-primary btn-sm" onclick={handleSelect}>
				<Check class="h-4 w-4" />
				{m.library_folderBrowser_selectFolder()}
			</button>
		</div>
	</div>
</div>

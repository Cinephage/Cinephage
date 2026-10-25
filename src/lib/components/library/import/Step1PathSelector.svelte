<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import * as m from '#lib/paraglide/messages.js';
	import {
		ArrowUp,
		Check,
		ChevronRight,
		FileVideo,
		Folder,
		Home,
		Loader2,
		Search,
		Sparkles,
		X
	} from '@lucide/svelte';

	type MediaType = 'movie' | 'tv';

	interface BrowseEntry {
		name: string;
		path: string;
		isDirectory: boolean;
		size?: number;
	}

	let {
		preferredMediaType = $bindable('auto'),
		sourcePath = $bindable('/'),
		browserPath = '/',
		browserParentPath = null,
		browserEntries = [],
		browserLoading = false,
		browserError = null,
		detecting = false,
		isMediaTypeLockedByContext = false,
		isFileOnlyContext = false,
		onBrowse = (_path?: string) => {},
		onDetect = (_paths?: string[]) => {}
	}: {
		preferredMediaType: 'auto' | MediaType;
		sourcePath: string;
		browserPath: string;
		browserParentPath: string | null;
		browserEntries: BrowseEntry[];
		browserLoading: boolean;
		browserError: string | null;
		detecting: boolean;
		isMediaTypeLockedByContext: boolean;
		isFileOnlyContext: boolean;
		onBrowse: (path?: string) => void;
		onDetect: (paths?: string[]) => void;
	} = $props();

	let selectedPaths = new SvelteSet<string>();
	let browserFilter = $state('');

	const filteredEntries = $derived(
		browserFilter.trim()
			? browserEntries.filter((e) =>
					e.name.toLowerCase().includes(browserFilter.trim().toLowerCase())
				)
			: browserEntries
	);
	const allVisiblePaths = $derived(filteredEntries.map((e) => e.path));
	const allSelected = $derived(
		allVisiblePaths.length > 0 && allVisiblePaths.every((p) => selectedPaths.has(p))
	);

	function togglePath(path: string) {
		if (selectedPaths.has(path)) {
			selectedPaths.delete(path);
		} else {
			selectedPaths.add(path);
		}
	}

	function toggleSelectAll() {
		if (allSelected) {
			selectedPaths.clear();
		} else {
			selectedPaths.clear();
			allVisiblePaths.forEach((p) => selectedPaths.add(p));
		}
	}

	function clearSelection() {
		selectedPaths.clear();
	}

	function handleBrowse(path?: string) {
		browserFilter = '';
		onBrowse(path);
	}

	function handleDetect() {
		if (selectedPaths.size > 0) {
			onDetect([...selectedPaths]);
		} else {
			onDetect();
		}
	}

	function formatSize(bytes?: number) {
		if (!bytes) return '';
		const gb = bytes / (1024 * 1024 * 1024);
		if (gb >= 1) {
			return `${gb.toFixed(2)} GB`;
		}
		const mb = bytes / (1024 * 1024);
		return `${mb.toFixed(1)} MB`;
	}
</script>

<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
	<div class="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-start">
		<label class="form-control">
			<span class="label-text text-sm font-medium">{m.library_import_mediaTypeLabel()}</span>
			<select
				class="select-bordered select w-full"
				bind:value={preferredMediaType}
				disabled={isMediaTypeLockedByContext}
			>
				<option value="auto">{m.library_import_autoDetect()}</option>
				<option value="movie">{m.common_movie()}</option>
				<option value="tv">{m.ui_mediaType_tv()}</option>
			</select>
		</label>

		<label class="form-control">
			<span class="label-text text-sm font-medium">{m.library_import_sourcePathLabel()}</span>
			<span class="text-xs text-base-content/60 md:col-span-2 md:col-start-2">
				{#if isFileOnlyContext}
					{m.library_import_sourcePathHintFile()}
				{:else}
					{m.library_import_sourcePathHintGeneral()}
				{/if}</span
			>
			<input
				class="input-bordered input w-full"
				placeholder={m.library_import_sourcePathPlaceholder()}
				bind:value={sourcePath}
			/>
		</label>

		<div class="md:self-end">
			<span class="label-text invisible hidden text-sm font-medium md:block"
				>{m.library_import_detectMedia()}</span
			>
			<button
				type="button"
				class="btn w-full btn-primary md:w-auto"
				onclick={handleDetect}
				disabled={detecting}
			>
				{#if detecting}
					<Loader2 class="h-4 w-4 animate-spin" />
					{m.library_import_detecting()}
				{:else if selectedPaths.size > 0}
					<Sparkles class="h-4 w-4" />
					{m.library_import_detectSelected({ count: selectedPaths.size })}
				{:else}
					<Sparkles class="h-4 w-4" />
					{m.library_import_detectMedia()}
				{/if}
			</button>
		</div>
	</div>

	<div class="mt-4 overflow-hidden rounded-lg border border-base-300">
		<div class="flex items-center gap-2 border-b border-base-300 bg-base-200 p-3">
			<button
				type="button"
				class="btn btn-square btn-ghost btn-sm"
				onclick={() => handleBrowse('/')}
				title={m.library_import_goToRoot()}
			>
				<Home class="h-4 w-4" />
			</button>
			<button
				class="btn btn-square btn-ghost btn-sm"
				disabled={!browserParentPath}
				onclick={() => browserParentPath && handleBrowse(browserParentPath)}
			>
				<ArrowUp class="h-4 w-4" />
			</button>
			<div class="min-w-0 flex-1 truncate rounded bg-base-100 px-2 py-1 font-mono text-sm">
				{browserPath}
			</div>
			{#if !isFileOnlyContext}
				<button class="btn btn-outline btn-xs" onclick={() => (sourcePath = browserPath)}>
					{m.library_import_useFolder()}
				</button>
			{/if}
			{#if selectedPaths.size > 0}
				<span class="badge shrink-0 badge-sm badge-primary">
					{m.library_import_selectedCount({ count: selectedPaths.size })}
				</span>
				<button class="btn shrink-0 btn-ghost btn-xs" onclick={clearSelection}>
					{m.library_import_clearSelection()}
				</button>
			{/if}
		</div>

		{#if !browserLoading && !browserError && browserEntries.length > 0}
			<div class="border-b border-base-300 px-3 py-2">
				<div class="group relative">
					<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
						<Search
							class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
						/>
					</div>
					<input
						type="text"
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						placeholder="Filter…"
						bind:value={browserFilter}
					/>
					{#if browserFilter}
						<button
							class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
							onclick={() => (browserFilter = '')}
							type="button"
						>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
			</div>
		{/if}

		<div class="max-h-80 overflow-y-auto p-2">
			{#if browserLoading}
				<div class="flex items-center justify-center py-8">
					<Loader2 class="h-5 w-5 animate-spin text-base-content/60" />
				</div>
			{:else if browserError}
				<div class="alert text-sm alert-error">
					<span>{browserError}</span>
				</div>
			{:else if browserEntries.length === 0}
				<div class="py-6 text-center text-sm text-base-content/60">
					{m.library_import_noFoldersOrFiles()}
				</div>
			{:else if filteredEntries.length === 0}
				<div class="py-6 text-center text-sm text-base-content/60">
					No entries match "{browserFilter}"
				</div>
			{:else}
				<div class="space-y-1">
					<div class="mb-1 flex items-center gap-2 border-b border-base-300/50 px-2 pb-1">
						<input
							type="checkbox"
							class="checkbox shrink-0 checkbox-xs checkbox-primary"
							checked={allSelected}
							onchange={toggleSelectAll}
							title="Select all"
						/>
						<span class="text-xs text-base-content/50 select-none">Select all</span>
					</div>
					{#each filteredEntries as entry (entry.path)}
						<div
							class="flex w-full items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-base-200 {selectedPaths.has(
								entry.path
							)
								? 'bg-primary/5 ring-1 ring-primary/20'
								: ''}"
						>
							<input
								type="checkbox"
								class="checkbox shrink-0 checkbox-sm checkbox-primary"
								checked={selectedPaths.has(entry.path)}
								onclick={(e) => {
									e.stopPropagation();
									togglePath(entry.path);
								}}
							/>
							<button
								type="button"
								class="flex min-w-0 flex-1 items-center gap-2 text-left"
								onclick={() =>
									entry.isDirectory ? handleBrowse(entry.path) : (sourcePath = entry.path)}
							>
								{#if entry.isDirectory}
									<Folder class="h-4 w-4 shrink-0 text-warning" />
								{:else}
									<FileVideo class="h-4 w-4 shrink-0 text-info" />
								{/if}
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm font-medium">{entry.name}</div>
									{#if !entry.isDirectory}
										<div class="text-xs text-base-content/60">{formatSize(entry.size)}</div>
									{/if}
								</div>
								{#if sourcePath === entry.path && !selectedPaths.has(entry.path)}
									<Check class="h-4 w-4 shrink-0 text-success" />
								{/if}
								{#if entry.isDirectory}
									<ChevronRight class="h-4 w-4 shrink-0 text-base-content/40" />
								{/if}
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

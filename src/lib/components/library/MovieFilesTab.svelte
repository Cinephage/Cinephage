<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { MovieFile } from '#lib/types/library.js';
	import FileCard from './FileCard.svelte';
	import { FileX, Search } from '@lucide/svelte';
	import { formatBytes } from '#lib/utils/format.js';
	import type { SubtitleRequirementProgress } from '#lib/utils/subtitle-status-display.js';

	interface Subtitle {
		id: string;
		language: string;
		isForced?: boolean;
		isHearingImpaired?: boolean;
		format?: string;
		wasSynced?: boolean;
		syncOffset?: number | null;
	}

	interface Props {
		files: MovieFile[];
		subtitles?: Subtitle[];
		/** Requirement-aware subtitle progress from the movie loader. */
		subtitleProgress?: SubtitleRequirementProgress | null;
		isStreamerProfile?: boolean;
		/** Viewer mode: hide per-file acquisition and delete controls. */
		readOnly?: boolean;
		onDeleteFile?: (fileId: string) => void;
		onSearch?: () => void;
		onSubtitleSearch?: () => void;
		onSubtitleAutoSearch?: () => void;
		subtitleAutoSearching?: boolean;
	}

	let {
		files,
		subtitles = [],
		subtitleProgress = null,
		isStreamerProfile = false,
		readOnly = false,
		onDeleteFile,
		onSearch,
		onSubtitleSearch,
		onSubtitleAutoSearch,
		subtitleAutoSearching = false
	}: Props = $props();

	// Calculate total size for display
	const totalSize = $derived(files.reduce((sum, f) => sum + (f.size || 0), 0));
</script>

<div class="space-y-4">
	{#if files.length === 0}
		<!-- Empty state -->
		<div
			class="flex flex-col items-center justify-center rounded-lg border border-dashed border-base-300 bg-base-100 py-12"
		>
			<FileX size={48} class="text-base-content/30" />
			<h3 class="mt-4 text-lg font-medium">{m.library_movieFilesTab_noFilesFound()}</h3>
			<p class="mt-1 text-sm text-base-content/60">{m.library_movieFilesTab_notDownloaded()}</p>
			{#if !readOnly && onSearch}
				<button class="btn mt-4 gap-2 btn-primary btn-sm" onclick={onSearch}>
					<Search size={16} />
					{m.library_movieFilesTab_searchDownloads()}
				</button>
			{/if}
		</div>
	{:else}
		<!-- File list -->
		<div class="space-y-3">
			{#each files as file (file.id)}
				<FileCard
					{file}
					{subtitles}
					{subtitleProgress}
					{isStreamerProfile}
					{readOnly}
					onDelete={onDeleteFile}
					{onSubtitleSearch}
					{onSubtitleAutoSearch}
					autoSearching={subtitleAutoSearching}
				/>
			{/each}
		</div>

		<!-- Summary -->
		<div class="rounded-lg bg-base-200 p-3 text-sm text-base-content/70">
			{m.library_movieFilesTab_fileCount({ count: files.length })} •
			{#if totalSize > 0}
				{formatBytes(totalSize)} {m.common_size().toLowerCase()}
			{:else}
				{m.library_movieFilesTab_unknownTotalSize()}
			{/if}
		</div>
	{/if}
</div>

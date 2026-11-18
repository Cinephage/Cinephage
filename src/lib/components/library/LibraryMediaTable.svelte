<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { Clapperboard, Tv, Disc3, Mic2 } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolvePath } from '#lib/utils/routing.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { LibraryKind, MediaRowView } from './media-view.js';
	import LibraryMediaMobileCard from './LibraryMediaMobileCard.svelte';
	import LibraryMediaTableRow from './LibraryMediaTableRow.svelte';
	import LibraryMediaTableHeader from './LibraryMediaTableHeader.svelte';

	interface Props {
		/** Rows already adapted by the page's kind (`media-view.ts`). */
		rows: MediaRowView[];
		kind: LibraryKind;
		selectedItems: SvelteSet<string>;
		selectable: boolean;
		sortField?: string;
		sortDirection?: 'asc' | 'desc';
		onSort?: (field: string) => void;
		onSelectChange?: (id: string, selected: boolean) => void;
		onMonitorToggle?: (id: string, monitored: boolean) => void;
		onAutoGrab?: (id: string) => void;
		onManualGrab?: (id: string) => void;
		onDelete?: (id: string) => void;
		downloadingIds?: Set<string>;
		autoSearchingIds?: Set<string>;
		/** Column labels that differ by kind (an album's size is its track count). */
		columnLabels?: { quality?: string; size?: string; progress?: string };
	}

	let {
		rows,
		kind,
		selectedItems,
		selectable,
		sortField = 'title',
		sortDirection = 'asc',
		onSort,
		onSelectChange,
		onMonitorToggle,
		onAutoGrab,
		onManualGrab,
		onDelete,
		downloadingIds = new Set(),
		autoSearchingIds = new Set(),
		columnLabels = {}
	}: Props = $props();

	let actionLoadingRows = new SvelteSet<string>();

	const showProgress = $derived(kind === 'tv' || kind === 'artist');
	const labels = $derived({
		quality: columnLabels.quality ?? m.library_libraryMediaTable_qualityColumn(),
		size: columnLabels.size ?? m.library_libraryMediaTable_sizeColumn(),
		progress: columnLabels.progress ?? m.library_libraryMediaTable_progressColumn()
	});

	const EMPTY_ICON: Record<LibraryKind, typeof Clapperboard> = {
		movie: Clapperboard,
		tv: Tv,
		album: Disc3,
		artist: Mic2
	};
	const EmptyIcon = $derived(EMPTY_ICON[kind]);

	function handleSelectChange(id: string, checked: boolean) {
		onSelectChange?.(id, checked);
	}

	function handleSelectAll(checked: boolean) {
		rows.forEach((row) => handleSelectChange(row.id, checked));
	}

	async function runRowAction(
		id: string,
		action?: (id: string) => void | Promise<void>
	) {
		if (!action || actionLoadingRows.has(id)) return;
		actionLoadingRows.add(id);
		try {
			await action(id);
		} finally {
			actionLoadingRows.delete(id);
		}
	}

	function navigateTo(row: MediaRowView) {
		goto(resolvePath(row.href));
	}
</script>

{#if rows.length === 0}
	<div class="py-12 text-center text-base-content/60">
		<EmptyIcon class="mx-auto mb-4 h-12 w-12 opacity-40" />
		<p class="text-lg font-medium">No items found</p>
	</div>
{:else}
	<div class="space-y-3 lg:hidden">
		{#each rows as row (row.id)}
			<LibraryMediaMobileCard
				{row}
				selected={selectedItems.has(row.id)}
				{selectable}
				isLoading={actionLoadingRows.has(row.id) || autoSearchingIds.has(row.id)}
				{downloadingIds}
				onSelectChange={handleSelectChange}
				onMonitorToggle={onMonitorToggle ? (id, monitored) => runRowAction(id, () => onMonitorToggle(id, monitored)) : undefined}
				onAutoGrab={onAutoGrab ? (id) => runRowAction(id, onAutoGrab) : undefined}
				onManualGrab={onManualGrab ? (id) => runRowAction(id, onManualGrab) : undefined}
				onDelete={onDelete ? (id) => runRowAction(id, onDelete) : undefined}
				onNavigate={() => navigateTo(row)}
			/>
		{/each}
	</div>

	<div class="hidden overflow-visible lg:block">
		<table class="table table-sm">
			<thead>
				<LibraryMediaTableHeader
					ids={rows.map((row) => row.id)}
					{selectable}
					{showProgress}
					{selectedItems}
					{sortField}
					{sortDirection}
					hasSort={!!onSort}
					{labels}
					onSort={(field) => onSort?.(field)}
					onSelectAll={handleSelectAll}
				/>
			</thead>
			<tbody>
				{#each rows as row, idx (row.id)}
					<LibraryMediaTableRow
						{row}
						selected={selectedItems.has(row.id)}
						{selectable}
						{idx}
						isLoading={actionLoadingRows.has(row.id) || autoSearchingIds.has(row.id)}
						{downloadingIds}
						{showProgress}
						onSelectChange={handleSelectChange}
						onMonitorToggle={onMonitorToggle ? (id, monitored) => runRowAction(id, () => onMonitorToggle(id, monitored)) : undefined}
						onAutoGrab={onAutoGrab ? (id) => runRowAction(id, onAutoGrab) : undefined}
						onManualGrab={onManualGrab ? (id) => runRowAction(id, onManualGrab) : undefined}
						onDelete={onDelete ? (id) => runRowAction(id, onDelete) : undefined}
						onNavigate={() => navigateTo(row)}
					/>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import type { LibraryMovie, LibrarySeries } from '#lib/types/library.js';
	import { Clapperboard, Tv } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { MediaType } from '#lib/utils/media-type.js';
	import LibraryMediaMobileCard from './LibraryMediaMobileCard.svelte';
	import LibraryMediaTableRow from './LibraryMediaTableRow.svelte';
	import LibraryMediaTableHeader from './LibraryMediaTableHeader.svelte';

	interface QualityProfile {
		id: string;
		name: string;
	}

	interface Props {
		items: (LibraryMovie | LibrarySeries)[];
		mediaType: MediaType;
		selectedItems: SvelteSet<string>;
		selectable: boolean;
		qualityProfiles?: QualityProfile[];
		sortField?: string;
		sortDirection?: 'asc' | 'desc';
		onSort?: (field: string) => void;
		onSelectChange?: (id: string, selected: boolean) => void;
		onMonitorToggle?: (id: string, monitored: boolean) => void;
		onDelete?: (id: string) => void;
		onAutoGrab?: (id: string) => void;
		onManualGrab?: (id: string) => void;
		downloadingIds?: Set<string>;
		autoSearchingIds?: Set<string>;
		/** Instance default for items with no explicit prefer-original flag. */
		preferOriginalTitleDefault?: boolean | null;
	}

	let {
		items,
		mediaType,
		selectedItems,
		selectable,
		qualityProfiles = [],
		sortField = 'title',
		sortDirection = 'asc',
		onSort,
		onSelectChange,
		onMonitorToggle,
		onDelete,
		onAutoGrab,
		onManualGrab,
		downloadingIds = new Set(),
		autoSearchingIds = new Set(),
		preferOriginalTitleDefault = false
	}: Props = $props();

	let actionLoadingRows = new SvelteSet<string>();

	const isTv = $derived(mediaType === 'tv');

	const profileNameMap = $derived(new Map(qualityProfiles.map((p) => [p.id, p.name])));

	function getProfileName(item: LibraryMovie | LibrarySeries): string | null {
		const id = item.scoringProfileId;
		if (!id) return profileNameMap.get('balanced') ?? 'Default';
		return profileNameMap.get(id) ?? id;
	}

	function hasStreamerProfile(item: LibraryMovie | LibrarySeries): boolean {
		const profileId = item.scoringProfileId?.toLowerCase();
		const profileName = getProfileName(item)?.toLowerCase();
		return profileId === 'streamer' || profileName === 'streamer';
	}

	function handleSort(field: string) {
		if (onSort) {
			onSort(field);
		}
	}

	function handleSelectChange(id: string, checked: boolean) {
		if (onSelectChange) {
			onSelectChange(id, checked);
		}
	}

	function handleSelectAll(checked: boolean) {
		items.forEach((i) => handleSelectChange(i.id, checked));
	}

	async function handleMonitorToggle(id: string, currentMonitored: boolean) {
		if (!onMonitorToggle || actionLoadingRows.has(id)) return;
		actionLoadingRows.add(id);
		try {
			await onMonitorToggle(id, !currentMonitored);
		} finally {
			actionLoadingRows.delete(id);
		}
	}

	async function handleDelete(id: string) {
		if (!onDelete || actionLoadingRows.has(id)) return;
		actionLoadingRows.add(id);
		try {
			await onDelete(id);
		} finally {
			actionLoadingRows.delete(id);
		}
	}

	async function handleAutoGrab(id: string) {
		if (!onAutoGrab || actionLoadingRows.has(id)) return;
		actionLoadingRows.add(id);
		try {
			await onAutoGrab(id);
		} finally {
			actionLoadingRows.delete(id);
		}
	}

	async function handleManualGrab(id: string) {
		if (!onManualGrab || actionLoadingRows.has(id)) return;
		actionLoadingRows.add(id);
		try {
			await onManualGrab(id);
		} finally {
			actionLoadingRows.delete(id);
		}
	}

	function navigateToItem(id: string) {
		goto(resolvePath(`/library/${mediaType}/${id}`));
	}
</script>

{#if items.length === 0}
	<div class="py-12 text-center text-base-content/60">
		{#if mediaType === 'movie'}
			<Clapperboard class="mx-auto mb-4 h-12 w-12 opacity-40" />
		{:else}
			<Tv class="mx-auto mb-4 h-12 w-12 opacity-40" />
		{/if}
		<p class="text-lg font-medium">No items found</p>
	</div>
{:else}
	<div class="space-y-3 lg:hidden">
		{#each items as item (item.id)}
			<LibraryMediaMobileCard
				{item}
				selected={selectedItems.has(item.id)}
				{selectable}
				isLoading={actionLoadingRows.has(item.id) || autoSearchingIds.has(item.id)}
				{downloadingIds}
				hasStreamerProfile={hasStreamerProfile(item)}
				onSelectChange={handleSelectChange}
				onMonitorToggle={onMonitorToggle
					? (id) => handleMonitorToggle(id, item.monitored ?? false)
					: undefined}
				onAutoGrab={onAutoGrab ? handleAutoGrab : undefined}
				onManualGrab={onManualGrab ? handleManualGrab : undefined}
				onDelete={onDelete ? handleDelete : undefined}
				onNavigate={() => navigateToItem(item.id)}
				{preferOriginalTitleDefault}
			/>
		{/each}
	</div>

	<div class="hidden overflow-visible lg:block">
		<table class="table table-sm">
			<thead>
				<LibraryMediaTableHeader
					{items}
					{selectable}
					{isTv}
					{selectedItems}
					{sortField}
					{sortDirection}
					hasSort={!!onSort}
					onSort={handleSort}
					onSelectAll={handleSelectAll}
				/>
			</thead>
			<tbody>
				{#each items as item, idx (item.id)}
					<LibraryMediaTableRow
						{item}
						{mediaType}
						selected={selectedItems.has(item.id)}
						{selectable}
						{idx}
						isLoading={actionLoadingRows.has(item.id) || autoSearchingIds.has(item.id)}
						{downloadingIds}
						hasStreamerProfile={hasStreamerProfile(item)}
						profileName={getProfileName(item)}
						{isTv}
						onSelectChange={handleSelectChange}
						onMonitorToggle={onMonitorToggle
							? (id) => handleMonitorToggle(id, item.monitored ?? false)
							: undefined}
						onAutoGrab={onAutoGrab ? handleAutoGrab : undefined}
						onManualGrab={onManualGrab ? handleManualGrab : undefined}
						onDelete={onDelete ? handleDelete : undefined}
						onNavigate={() => navigateToItem(item.id)}
						{preferOriginalTitleDefault}
					/>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

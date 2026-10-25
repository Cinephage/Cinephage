<script lang="ts">
	import type { LibraryMovie, LibrarySeries } from '#lib/types/library.js';
	import { ArrowUpDown, ArrowUp, ArrowDown } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		items: (LibraryMovie | LibrarySeries)[];
		selectable: boolean;
		isTv: boolean;
		selectedItems: Set<string>;
		sortField: string;
		sortDirection: 'asc' | 'desc';
		hasSort: boolean;
		onSort: (field: string) => void;
		onSelectAll: (checked: boolean) => void;
	}

	let {
		items,
		selectable,
		isTv,
		selectedItems,
		sortField,
		sortDirection,
		hasSort,
		onSort,
		onSelectAll
	}: Props = $props();

	const allSelected = $derived(items.every((i) => selectedItems.has(i.id)));
	const someSelected = $derived(items.some((i) => selectedItems.has(i.id)) && !allSelected);

	function getSortIcon(field: string) {
		if (sortField !== field) return ArrowUpDown;
		return sortDirection === 'asc' ? ArrowUp : ArrowDown;
	}
</script>

<tr>
	{#if selectable}
		<th class="w-10">
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				checked={allSelected}
				indeterminate={someSelected}
				onchange={(e) => onSelectAll(e.currentTarget.checked)}
			/>
		</th>
	{/if}
	<th class="w-14 text-base">{m.library_libraryMediaTable_posterColumn()}</th>
	<th
		class="cursor-pointer text-base select-none hover:bg-base-200"
		onclick={() => onSort('title')}
	>
		<span class="flex items-center gap-1">
			{m.library_libraryMediaTable_titleColumn()}
			{#if hasSort}
				{@const Icon = getSortIcon('title')}
				<Icon class="h-4 w-4 opacity-50" />
			{/if}
		</span>
	</th>
	<th class="cursor-pointer text-base select-none hover:bg-base-200" onclick={() => onSort('year')}>
		<span class="flex items-center gap-1">
			{m.library_libraryMediaTable_yearColumn()}
			{#if hasSort}
				{@const Icon = getSortIcon('year')}
				<Icon class="h-4 w-4 opacity-50" />
			{/if}
		</span>
	</th>
	<th class="text-base">{m.library_libraryMediaTable_statusColumn()}</th>
	<th class="text-base">{m.library_libraryMediaTable_qualityColumn()}</th>
	<th class="cursor-pointer text-base select-none hover:bg-base-200" onclick={() => onSort('size')}>
		<span class="flex items-center gap-1">
			{m.library_libraryMediaTable_sizeColumn()}
			{#if hasSort}
				{@const Icon = getSortIcon('size')}
				<Icon class="h-4 w-4 opacity-50" />
			{/if}
		</span>
	</th>
	{#if isTv}
		<th class="text-base">{m.library_libraryMediaTable_progressColumn()}</th>
	{/if}
	<th
		class="cursor-pointer text-base select-none hover:bg-base-200"
		onclick={() => onSort('added')}
	>
		<span class="flex items-center gap-1">
			{m.library_libraryMediaTable_addedColumn()}
			{#if hasSort}
				{@const Icon = getSortIcon('added')}
				<Icon class="h-4 w-4 opacity-50" />
			{/if}
		</span>
	</th>
	<th class="w-10"></th>
</tr>

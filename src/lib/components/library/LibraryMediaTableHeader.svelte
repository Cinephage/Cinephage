<script lang="ts">
	import { ArrowUpDown, ArrowUp, ArrowDown } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		ids: string[];
		selectable: boolean;
		showProgress: boolean;
		selectedItems: Set<string>;
		sortField: string;
		sortDirection: 'asc' | 'desc';
		hasSort: boolean;
		labels: { quality: string; size: string; progress: string };
		onSort: (field: string) => void;
		onSelectAll: (checked: boolean) => void;
	}

	let {
		ids,
		selectable,
		showProgress,
		selectedItems,
		sortField,
		sortDirection,
		hasSort,
		labels,
		onSort,
		onSelectAll
	}: Props = $props();

	const allSelected = $derived(ids.length > 0 && ids.every((id) => selectedItems.has(id)));
	const someSelected = $derived(ids.some((id) => selectedItems.has(id)) && !allSelected);

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
	<th class="text-base">{labels.quality}</th>
	<th class="text-base">{labels.size}</th>
	{#if showProgress}
		<th class="text-base">{labels.progress}</th>
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

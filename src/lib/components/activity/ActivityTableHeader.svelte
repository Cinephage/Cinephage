<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { ArrowUpDown, ArrowUp, ArrowDown } from '@lucide/svelte';

	interface Props {
		sortField: string;
		sortDirection: 'asc' | 'desc';
		onSort?: (field: string) => void;
		allSelectableSelected: boolean;
		someSelectableSelected: boolean;
		selectableCount: number;
		onToggleSelectionAll: (selected: boolean) => void;
	}

	let {
		sortField,
		sortDirection,
		onSort,
		allSelectableSelected,
		someSelectableSelected,
		selectableCount,
		onToggleSelectionAll
	}: Props = $props();

	let selectAllCheckbox = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (selectAllCheckbox) {
			selectAllCheckbox.indeterminate = someSelectableSelected;
		}
	});

	function handleSort(field: string) {
		onSort?.(field);
	}

	function getSortIcon(field: string) {
		if (sortField !== field) return ArrowUpDown;
		return sortDirection === 'asc' ? ArrowUp : ArrowDown;
	}

	function handleToggleAll() {
		onToggleSelectionAll(!allSelectableSelected);
	}
</script>

<tr
	class="border-b border-base-content/10 bg-base-200 text-[11px] font-semibold tracking-widest text-base-content/50 uppercase"
>
	<th class="w-10 px-2">
		{#if selectableCount > 0}
			<input
				bind:this={selectAllCheckbox}
				type="checkbox"
				class="checkbox checkbox-xs checkbox-primary"
				checked={allSelectableSelected}
				aria-label={m.activity_table_selectAllVisible()}
				onclick={(e) => {
					e.stopPropagation();
					handleToggleAll();
				}}
			/>
		{/if}
	</th>
	<th
		class="cursor-pointer px-2 select-none hover:bg-base-300/40"
		onclick={() => handleSort('status')}
	>
		<span class="flex items-center gap-1">
			{m.common_status()}
			{#if onSort}
				{@const Icon = getSortIcon('status')}
				<Icon class="h-3 w-3 opacity-50" />
			{/if}
		</span>
	</th>
	<th
		class="cursor-pointer px-2 select-none hover:bg-base-300/40"
		onclick={() => handleSort('media')}
	>
		<span class="flex items-center gap-1">
			{m.activity_table_media()}
			{#if onSort}
				{@const Icon = getSortIcon('media')}
				<Icon class="h-3 w-3 opacity-50" />
			{/if}
		</span>
	</th>
	<th
		class="hidden cursor-pointer select-none hover:bg-base-300/40 lg:table-cell"
		onclick={() => handleSort('release')}
	>
		<span class="flex items-center gap-1">
			{m.activity_table_release()}
			{#if onSort}
				{@const Icon = getSortIcon('release')}
				<Icon class="h-3 w-3 opacity-50" />
			{/if}
		</span>
	</th>
	<th class="hidden lg:table-cell">{m.activity_table_quality()}</th>
	<th class="hidden lg:table-cell">{m.activity_table_group()}</th>
	<th
		class="hidden cursor-pointer select-none hover:bg-base-300/40 lg:table-cell"
		onclick={() => handleSort('size')}
	>
		<span class="flex items-center gap-1">
			{m.common_size()}
			{#if onSort}
				{@const Icon = getSortIcon('size')}
				<Icon class="h-3 w-3 opacity-50" />
			{/if}
		</span>
	</th>
	<th class="hidden lg:table-cell">{m.activity_table_source()}</th>
	<th
		class="cursor-pointer px-2 select-none hover:bg-base-300/40"
		onclick={() => handleSort('time')}
	>
		<span class="flex items-center gap-1">
			{m.activity_table_time()}
			{#if onSort}
				{@const Icon = getSortIcon('time')}
				<Icon class="h-3 w-3 opacity-50" />
			{/if}
		</span>
	</th>
</tr>

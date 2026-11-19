<script lang="ts">
	/**
	 * The grid or table a library list renders, with the kind's view models and
	 * row actions passed straight through. The page builds `cards` and `rows` via
	 * `media-view.ts`; this component only chooses the layout.
	 */
	import type { SvelteSet } from 'svelte/reactivity';
	import LibraryMediaCard from '#lib/components/library/LibraryMediaCard.svelte';
	import LibraryMediaTable from '#lib/components/library/LibraryMediaTable.svelte';
	import type { LibraryKind, MediaCardView, MediaRowView } from '#lib/components/library/media-view.js';

	interface Props {
		cards: MediaCardView[];
		rows: MediaRowView[];
		kind: LibraryKind;
		viewMode: 'grid' | 'list';
		selectable: boolean;
		selectedIds: SvelteSet<string>;
		onSelectChange: (id: string, selected: boolean) => void;
		downloadingIds?: Set<string>;
		autoSearchingIds?: Set<string>;
		onMonitorToggle?: (id: string, monitored: boolean) => void;
		onDelete?: (id: string) => void;
		onAutoGrab?: (id: string) => void;
		onManualGrab?: (id: string) => void;
		/** Album rows label their columns differently from movies. */
		columnLabels?: { quality?: string; size?: string; progress?: string };
	}

	let {
		cards,
		rows,
		kind,
		viewMode,
		selectable,
		selectedIds,
		onSelectChange,
		downloadingIds = new Set(),
		autoSearchingIds = new Set(),
		onMonitorToggle,
		onDelete,
		onAutoGrab,
		onManualGrab,
		columnLabels = {}
	}: Props = $props();
</script>

{#if viewMode === 'grid'}
	<div
		class="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9"
	>
		{#each cards as card (card.id)}
			<LibraryMediaCard
				view={card}
				{selectable}
				selected={selectedIds.has(card.id)}
				{onSelectChange}
			/>
		{/each}
	</div>
{:else}
	<LibraryMediaTable
		{rows}
		{kind}
		selectedItems={selectedIds}
		{selectable}
		{downloadingIds}
		{autoSearchingIds}
		{onSelectChange}
		{onMonitorToggle}
		{onDelete}
		{onAutoGrab}
		{onManualGrab}
		{columnLabels}
	/>
{/if}

<script lang="ts">
	import ChannelCategorySection from './ChannelCategorySection.svelte';
	import type {
		ChannelLineupItemWithDetails,
		ChannelCategory,
		EpgProgram,
		EpgProgramWithProgress
	} from '#lib/types/livetv.js';

	interface NowNextEntry {
		now: EpgProgramWithProgress | null;
		next: EpgProgram | null;
	}

	interface Props {
		lineup: ChannelLineupItemWithDetails[];
		categories: ChannelCategory[];
		groupedChannels: Map<string | null, ChannelLineupItemWithDetails[]>;
		orderedCategories: ChannelCategory[];
		selectedIds: Set<string>;
		expandedCategories: Set<string | null>;
		draggedItemId: string | null;
		dragOverCategoryId: string | null;
		isDragging: boolean;
		epgData?: Map<string, NowNextEntry>;
		onSelect: (id: string, selected: boolean) => void;
		onSelectAll: (categoryId: string | null, selected: boolean) => void;
		onToggleExpand: (categoryId: string | null) => void;
		onDragStart: (e: DragEvent, itemId: string) => void;
		onDragOverCategory: (e: DragEvent, categoryId: string | null) => void;
		onDragLeaveCategory: () => void;
		onDropOnCategory: (e: DragEvent, categoryId: string | null) => void;
		onReorder: (categoryId: string | null, itemIds: string[]) => void;
		onDragEnd: () => void;
		onEdit: (item: ChannelLineupItemWithDetails) => void;
		onRemove: (item: ChannelLineupItemWithDetails) => void;
		onInlineEdit: (
			id: string,
			field: 'channelNumber' | 'customName',
			value: number | string | null
		) => Promise<boolean>;
		onShowSchedule?: (channel: ChannelLineupItemWithDetails) => void;
	}

	let {
		lineup: _lineup,
		categories: _categories,
		groupedChannels,
		orderedCategories,
		selectedIds,
		expandedCategories,
		draggedItemId,
		dragOverCategoryId,
		isDragging,
		epgData = new Map(),
		onSelect,
		onSelectAll,
		onToggleExpand,
		onDragStart,
		onDragOverCategory,
		onDragLeaveCategory,
		onDropOnCategory,
		onReorder,
		onDragEnd,
		onEdit,
		onRemove,
		onInlineEdit,
		onShowSchedule
	}: Props = $props();

	// Get uncategorized channels
	const uncategorizedChannels = $derived(groupedChannels.get(null) || []);
</script>

<div class="divide-y divide-base-300">
	<!-- Render each category section -->
	{#each orderedCategories as category (category.id)}
		{@const channels = groupedChannels.get(category.id) || []}
		<ChannelCategorySection
			{category}
			{channels}
			{selectedIds}
			isExpanded={expandedCategories.has(category.id)}
			isDropTarget={isDragging && dragOverCategoryId === category.id}
			{isDragging}
			{draggedItemId}
			{epgData}
			{onSelect}
			onSelectAll={(selected) => onSelectAll(category.id, selected)}
			onToggle={() => onToggleExpand(category.id)}
			{onDragStart}
			onDragOver={(e) => onDragOverCategory(e, category.id)}
			onDragLeave={onDragLeaveCategory}
			onDrop={(e) => onDropOnCategory(e, category.id)}
			onReorder={(itemIds) => onReorder(category.id, itemIds)}
			{onDragEnd}
			{onEdit}
			{onRemove}
			{onInlineEdit}
			{onShowSchedule}
		/>
	{/each}

	<!-- Uncategorized section (always last) -->
	{#if uncategorizedChannels.length > 0 || isDragging}
		<ChannelCategorySection
			category={null}
			channels={uncategorizedChannels}
			{selectedIds}
			isExpanded={expandedCategories.has(null)}
			isDropTarget={isDragging && dragOverCategoryId === null}
			{isDragging}
			{draggedItemId}
			{epgData}
			{onSelect}
			onSelectAll={(selected) => onSelectAll(null, selected)}
			onToggle={() => onToggleExpand(null)}
			{onDragStart}
			onDragOver={(e) => onDragOverCategory(e, null)}
			onDragLeave={onDragLeaveCategory}
			onDrop={(e) => onDropOnCategory(e, null)}
			onReorder={(itemIds) => onReorder(null, itemIds)}
			{onDragEnd}
			{onEdit}
			{onRemove}
			{onInlineEdit}
			{onShowSchedule}
		/>
	{/if}
</div>

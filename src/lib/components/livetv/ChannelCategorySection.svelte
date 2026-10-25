<script lang="ts">
	import {
		ChevronRight,
		ChevronDown,
		FolderOpen,
		GripVertical,
		Info,
		Pencil,
		Trash2,
		Tv
	} from '@lucide/svelte';
	import ChannelLineupRow from './ChannelLineupRow.svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type {
		ChannelLineupItemWithDetails,
		ChannelCategory,
		EpgProgram,
		EpgProgramWithProgress
	} from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';

	interface NowNextEntry {
		now: EpgProgramWithProgress | null;
		next: EpgProgram | null;
	}

	interface Props {
		category: ChannelCategory | null;
		channels: ChannelLineupItemWithDetails[];
		selectedIds: Set<string>;
		isExpanded: boolean;
		isDropTarget: boolean;
		isDragging: boolean;
		draggedItemId: string | null;
		epgData?: Map<string, NowNextEntry>;
		onSelect: (id: string, selected: boolean) => void;
		onSelectAll: (selected: boolean) => void;
		onToggle: () => void;
		onDragStart: (e: DragEvent, itemId: string) => void;
		onDragOver: (e: DragEvent) => void;
		onDragLeave: () => void;
		onDrop: (e: DragEvent) => void;
		onReorder: (itemIds: string[]) => void;
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
		category,
		channels,
		selectedIds,
		isExpanded,
		isDropTarget,
		isDragging,
		draggedItemId,
		epgData = new Map(),
		onSelect,
		onSelectAll,
		onToggle,
		onDragStart,
		onDragOver,
		onDragLeave,
		onDrop,
		onReorder,
		onDragEnd,
		onEdit,
		onRemove,
		onInlineEdit,
		onShowSchedule
	}: Props = $props();

	// Logo broken-image fallback, keyed by channel id (multiple logos render
	// in the same #each, so a single ref/state pair can't track them all).
	// onerror as a prop renders as a literal inline HTML attribute during SSR
	// (Svelte replays the pre-hydration event that way), which a strict CSP
	// blocks without 'unsafe-hashes'; a use: action attaches imperatively
	// instead, avoiding that path.
	const failedLogoIds = new SvelteSet<string>();
	function trackLogoError(node: HTMLImageElement, channelId: string) {
		const handleError = () => {
			failedLogoIds.add(channelId);
		};
		node.addEventListener('error', handleError);
		return {
			destroy() {
				node.removeEventListener('error', handleError);
			}
		};
	}

	// Derived: Check if all channels in this category are selected
	const allSelected = $derived(channels.length > 0 && channels.every((c) => selectedIds.has(c.id)));
	const someSelected = $derived(
		channels.length > 0 && channels.some((c) => selectedIds.has(c.id)) && !allSelected
	);

	// Drag reorder state within this section
	let dragOverIndex = $state<number | null>(null);

	function handleSelectAllClick() {
		onSelectAll(!allSelected);
	}

	// Row drag handlers for reordering within section
	function handleRowDragOver(e: DragEvent, index: number) {
		// Only allow reorder within same category
		const item = channels.find((c) => c.id === draggedItemId);
		if (item) {
			e.preventDefault();
			dragOverIndex = index;
		}
	}

	function handleRowDragLeave() {
		dragOverIndex = null;
	}

	function handleRowDrop(e: DragEvent, dropIndex: number) {
		if (!draggedItemId) return;

		const draggedIndex = channels.findIndex((c) => c.id === draggedItemId);
		if (draggedIndex === -1 || draggedIndex === dropIndex) {
			dragOverIndex = null;
			return;
		}

		// Create new order
		const newOrder = [...channels];
		const [removed] = newOrder.splice(draggedIndex, 1);
		newOrder.splice(dropIndex, 0, removed);

		onReorder(newOrder.map((c) => c.id));
		dragOverIndex = null;
	}

	// Category header drop zone
	function handleHeaderDragOver(e: DragEvent) {
		if (isDragging) {
			e.preventDefault();
			onDragOver(e);
		}
	}

	function handleHeaderDrop(e: DragEvent) {
		e.preventDefault();
		onDrop(e);
	}
</script>

<div class="overflow-hidden">
	<!-- Category Header / Drop Zone -->
	<button
		class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-base-300/50
			{isDropTarget ? 'ring-dashed bg-primary/10 ring-2 ring-primary ring-inset' : ''}"
		onclick={onToggle}
		ondragover={handleHeaderDragOver}
		ondragleave={onDragLeave}
		ondrop={handleHeaderDrop}
	>
		<!-- Expand/Collapse -->
		{#if isExpanded}
			<ChevronDown class="h-4 w-4 text-base-content/50" />
		{:else}
			<ChevronRight class="h-4 w-4 text-base-content/50" />
		{/if}

		<!-- Select All Checkbox -->
		{#if channels.length > 0}
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				checked={allSelected}
				indeterminate={someSelected}
				onclick={(e) => {
					e.stopPropagation();
					handleSelectAllClick();
				}}
			/>
		{/if}

		<!-- Category Icon & Name -->
		{#if category}
			{#if category.color}
				<span class="h-3 w-3 rounded-full" style="background-color: {category.color}"></span>
			{:else}
				<FolderOpen class="h-4 w-4 text-base-content/50" />
			{/if}
			<span class="font-medium">{category.name}</span>
		{:else}
			<FolderOpen class="h-4 w-4 text-base-content/50" />
			<span class="font-medium text-base-content/70"
				>{m.livetv_channelCategorySection_uncategorized()}</span
			>
		{/if}

		<!-- Channel Count -->
		<span class="text-sm text-base-content/50">({channels.length})</span>

		<!-- Drop hint when dragging -->
		{#if isDropTarget}
			<span class="ml-auto text-sm text-primary">{m.livetv_channelCategorySection_dropHere()}</span>
		{/if}
	</button>

	<!-- Channel Rows -->
	{#if isExpanded && channels.length > 0}
		<!-- Mobile cards -->
		<div class="space-y-3 sm:hidden">
			{#each channels as channel, index (channel.id)}
				{@const nowNext = epgData.get(channel.channelId)}
				<div
					class="rounded-xl bg-base-200 p-3 transition-colors
						{isDragging && draggedItemId === channel.id ? 'bg-base-300/70' : ''}
						{dragOverIndex === index && draggedItemId !== channel.id ? 'bg-primary/10' : ''}
						{selectedIds.has(channel.id) ? 'bg-base-300/50' : ''}"
					role="listitem"
					draggable="true"
					ondragstart={(e) => onDragStart(e, channel.id)}
					ondragover={(e) => handleRowDragOver(e, index)}
					ondragleave={handleRowDragLeave}
					ondrop={(e) => handleRowDrop(e, index)}
					ondragend={onDragEnd}
				>
					<div class="flex items-start gap-3">
						<input
							type="checkbox"
							class="checkbox mt-1 checkbox-sm checkbox-primary"
							checked={selectedIds.has(channel.id)}
							onchange={(e) => onSelect(channel.id, e.currentTarget.checked)}
						/>
						<div
							class="mt-1 flex h-10 w-4 cursor-grab items-center justify-center text-base-content/30"
						>
							<GripVertical class="h-4 w-4" />
						</div>
						{#if channel.displayLogo && !failedLogoIds.has(channel.id)}
							<img
								use:trackLogoError={channel.id}
								src={channel.displayLogo}
								alt={channel.displayName}
								class="h-10 w-10 rounded bg-base-100 object-contain"
							/>
						{:else}
							<div class="flex h-10 w-10 items-center justify-center rounded bg-base-300">
								<Tv class="h-4 w-4 text-base-content/30" />
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="flex items-start justify-between gap-2">
								<div class="min-w-0">
									<div class="truncate font-medium" title={channel.displayName}>
										{channel.displayName}
									</div>
									<div class="mt-0.5 text-xs text-base-content/60">
										#{channel.channelNumber ?? channel.position}
										<span class="text-base-content/40">•</span>
										{channel.accountName}
									</div>
								</div>
								<div class="flex items-center gap-1">
									<button class="btn btn-ghost btn-xs" onclick={() => onEdit(channel)}>
										<Pencil class="h-3.5 w-3.5" />
									</button>
									<button
										class="btn btn-ghost text-error btn-xs hover:bg-error/10"
										onclick={() => onRemove(channel)}
									>
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								</div>
							</div>

							{#if nowNext?.now}
								<button
									type="button"
									class="mt-2 flex w-full flex-col gap-0.5 rounded px-1 py-1 text-left transition-colors hover:bg-base-300"
									onclick={() => onShowSchedule?.(channel)}
								>
									<span class="truncate text-xs font-medium" title={nowNext.now.title}>
										{nowNext.now.title}
									</span>
									<div class="flex items-center gap-2">
										<progress
											class="progress h-1.5 w-20 progress-primary"
											value={nowNext.now.progress * 100}
											max="100"
										></progress>
										<span class="text-xs text-base-content/50">
											{m.livetv_channelCategorySection_remainingMinutes({
												count: nowNext.now.remainingMinutes
											})}
										</span>
									</div>
								</button>
							{:else}
								<div class="mt-2 flex items-center gap-1 text-xs text-base-content/50">
									<Info class="h-3 w-3" />
									{m.livetv_channelCategorySection_noEpg()}
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>

		<!-- Desktop table -->
		<div class="hidden overflow-x-auto sm:block">
			<table class="table table-sm">
				<thead>
					<tr class="text-xs text-base-content/50">
						<th class="w-10"></th>
						<th class="w-10"></th>
						<th class="w-16 text-center">{m.livetv_channelCategorySection_columnNumber()}</th>
						<th class="w-12"></th>
						<th>{m.livetv_channelCategorySection_columnName()}</th>
						<th class="hidden md:table-cell">{m.livetv_channelCategorySection_columnSource()}</th>
						<th class="hidden lg:table-cell"
							>{m.livetv_channelCategorySection_columnNowPlaying()}</th
						>
						<th class="w-24">{m.livetv_channelCategorySection_columnActions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each channels as channel, index (channel.id)}
						<ChannelLineupRow
							item={channel}
							{index}
							selected={selectedIds.has(channel.id)}
							isDragging={draggedItemId === channel.id}
							isDropTarget={dragOverIndex === index && draggedItemId !== channel.id}
							epgNow={epgData.get(channel.channelId)}
							onSelect={(selected) => onSelect(channel.id, selected)}
							onDragStart={(e) => onDragStart(e, channel.id)}
							onDragOver={(e) => handleRowDragOver(e, index)}
							onDragLeave={handleRowDragLeave}
							onDrop={(e) => handleRowDrop(e, index)}
							{onDragEnd}
							onEdit={() => onEdit(channel)}
							onRemove={() => onRemove(channel)}
							{onInlineEdit}
							{onShowSchedule}
						/>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<!-- Empty category message -->
	{#if isExpanded && channels.length === 0 && category !== null}
		<div class="px-4 py-6 text-center text-sm text-base-content/50">
			{m.livetv_channelCategorySection_noChannels()}
			{#if isDragging}
				<span class="block text-primary">{m.livetv_channelCategorySection_dropToAdd()}</span>
			{/if}
		</div>
	{/if}
</div>

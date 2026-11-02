<script lang="ts">
	import { Loader2, Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		total: number;
		selectedCount: number;
		selectableChannelCount: number;
		showAdded: boolean;
		selectedAccountId: string;
		selectedCategoryId: string;
		selectedCategoryName: string | undefined;
		selectedCategoryCount: number;
		loading: boolean;
		addingCategory: boolean;
		bulkAdding: boolean;
		onToggleAdded: () => void;
		onAddCategory: () => void;
		onAddSelected: () => void;
		onClearSelection: () => void;
		onToggleAllVisible: () => void;
	}

	let {
		total,
		selectedCount,
		selectableChannelCount,
		showAdded,
		selectedAccountId,
		selectedCategoryId,
		selectedCategoryName,
		selectedCategoryCount,
		loading,
		addingCategory,
		bulkAdding,
		onToggleAdded,
		onAddCategory,
		onAddSelected,
		onClearSelection,
		onToggleAllVisible
	}: Props = $props();
</script>

<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
	<span class="text-sm text-base-content/60">
		{m.livetv_channelBrowserModal_resultsCount({ count: total })}
		{#if selectedCount > 0}
			<span class="text-primary"
				>{m.livetv_channelBrowserModal_selectedCount({ count: selectedCount })}</span
			>
		{/if}
	</span>

	<label class="flex items-center gap-2 text-xs text-base-content/60">
		<input
			type="checkbox"
			class="checkbox checkbox-xs checkbox-primary"
			checked={showAdded}
			onchange={onToggleAdded}
		/>
		{m.livetv_channelBrowserModal_showAlreadyAdded()}
	</label>

	{#if selectedAccountId && selectedCategoryId}
		<button
			class="btn btn-outline btn-sm"
			onclick={onAddCategory}
			disabled={addingCategory || loading}
			title="Add all channels in this provider category"
		>
			{#if addingCategory}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Plus class="h-4 w-4" />
			{/if}
			{m.livetv_channelBrowserModal_addEntireCategory()}
			{#if selectedCategoryName}({selectedCategoryCount}){/if}
		</button>
	{/if}

	{#if selectedCount > 0}
		<div class="flex gap-2">
			<button class="btn btn-ghost btn-xs" onclick={onClearSelection}
				>{m.livetv_channelBrowserModal_clear()}</button
			>
			<button class="btn btn-primary btn-sm" onclick={onAddSelected} disabled={bulkAdding}>
				{#if bulkAdding}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Plus class="h-4 w-4" />
				{/if}
				{m.livetv_channelBrowserModal_addSelected({ count: selectedCount })}
			</button>
		</div>
	{:else if selectableChannelCount > 0}
		<button class="btn btn-ghost btn-xs" onclick={onToggleAllVisible}>
			{m.livetv_channelBrowserModal_selectAllVisible()}
		</button>
	{/if}
</div>

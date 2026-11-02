<script lang="ts">
	import { X, Plus, GripVertical, Pencil, Trash2, Check, Loader2 } from '@lucide/svelte';
	import type { ChannelCategory, ChannelLineupItemWithDetails } from '#lib/types/livetv.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		updateChannelCategory,
		deleteChannelCategory,
		createChannelCategory,
		reorderChannelCategories
	} from '#lib/api/livetv.js';

	interface Props {
		open: boolean;
		categories: ChannelCategory[];
		groupedChannels: Map<string | null, ChannelLineupItemWithDetails[]>;
		onClose: () => void;
		onChange: () => void;
	}

	let { open, categories, groupedChannels, onClose, onChange }: Props = $props();

	// Local state for editing
	let localCategories = $state<ChannelCategory[]>([]);
	let editingId = $state<string | null>(null);
	let editingName = $state('');
	let editingColor = $state('');

	// New category form
	let newName = $state('');
	let newColor = $state('');
	let isAdding = $state(false);

	// Loading states
	let savingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let reordering = $state(false);

	// Delete confirmation state
	let deleteConfirmOpen = $state(false);
	let categoryToDelete = $state<ChannelCategory | null>(null);

	// Drag state
	let draggedIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);

	// Preset colors
	const presetColors = [
		'#ef4444', // red
		'#f97316', // orange
		'#eab308', // yellow
		'#22c55e', // green
		'#14b8a6', // teal
		'#3b82f6', // blue
		'#8b5cf6', // violet
		'#ec4899', // pink
		'#6b7280' // gray
	];

	// Initialize local state when modal opens
	$effect(() => {
		if (open) {
			localCategories = [...categories].sort((a, b) => a.position - b.position);
			editingId = null;
			newName = '';
			newColor = '';
			isAdding = false;
		}
	});

	// Get channel count for a category
	function getChannelCount(categoryId: string): number {
		return (groupedChannels.get(categoryId) || []).length;
	}

	// Start editing a category
	function startEdit(cat: ChannelCategory) {
		editingId = cat.id;
		editingName = cat.name;
		editingColor = cat.color || '';
	}

	// Cancel editing
	function cancelEdit() {
		editingId = null;
		editingName = '';
		editingColor = '';
	}

	// Save edited category
	async function saveEdit() {
		if (!editingId || !editingName.trim()) return;

		savingId = editingId;
		try {
			await updateChannelCategory(editingId, {
				name: editingName.trim(),
				color: editingColor || undefined
			});

			onChange();
			cancelEdit();
		} catch (e) {
			toasts.error(
				e instanceof Error ? e.message : m.livetv_channelCategoryManagerModal_failedToUpdate()
			);
		} finally {
			savingId = null;
		}
	}

	function requestDeleteCategory(cat: ChannelCategory) {
		categoryToDelete = cat;
		deleteConfirmOpen = true;
	}

	function closeDeleteConfirm(force = false) {
		if (!force && deletingId) return;
		deleteConfirmOpen = false;
		categoryToDelete = null;
	}

	const deleteCategoryMessage = $derived.by(() => {
		if (!categoryToDelete) return '';
		const count = getChannelCount(categoryToDelete.id);
		return count > 0
			? m.livetv_channelCategoryManagerModal_deleteCategoryWithChannels({
					name: categoryToDelete.name,
					count
				})
			: m.livetv_channelCategoryManagerModal_deleteCategoryEmpty({ name: categoryToDelete.name });
	});

	// Delete category
	async function deleteCategory() {
		if (!categoryToDelete) return;

		deletingId = categoryToDelete.id;
		try {
			await deleteChannelCategory(categoryToDelete.id);

			onChange();
			closeDeleteConfirm(true);
		} catch (e) {
			toasts.error(
				e instanceof Error ? e.message : m.livetv_channelCategoryManagerModal_failedToDelete()
			);
		} finally {
			deletingId = null;
		}
	}

	// Add new category
	async function addCategory() {
		if (!newName.trim()) return;

		isAdding = true;
		try {
			await createChannelCategory({
				name: newName.trim(),
				color: newColor || undefined
			});

			onChange();
			newName = '';
			newColor = '';
		} catch (e) {
			toasts.error(
				e instanceof Error ? e.message : m.livetv_channelCategoryManagerModal_failedToCreate()
			);
		} finally {
			isAdding = false;
		}
	}

	// Drag handlers for reordering
	function handleDragStart(e: DragEvent, index: number) {
		draggedIndex = index;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(index));
		}
	}

	function handleDragOver(e: DragEvent, index: number) {
		if (draggedIndex === null) return;
		e.preventDefault();
		dragOverIndex = index;
	}

	function handleDragLeave() {
		dragOverIndex = null;
	}

	async function handleDrop(e: DragEvent, dropIndex: number) {
		if (draggedIndex === null || draggedIndex === dropIndex) {
			resetDragState();
			return;
		}

		// Reorder locally
		const newOrder = [...localCategories];
		const [removed] = newOrder.splice(draggedIndex, 1);
		newOrder.splice(dropIndex, 0, removed);
		localCategories = newOrder;

		resetDragState();

		reordering = true;
		try {
			await reorderChannelCategories(newOrder.map((c) => c.id));

			onChange();
		} catch (e) {
			toasts.error(
				e instanceof Error ? e.message : m.livetv_channelCategoryManagerModal_failedToReorder()
			);
		} finally {
			reordering = false;
		}
	}

	function handleDragEnd() {
		resetDragState();
	}

	function resetDragState() {
		draggedIndex = null;
		dragOverIndex = null;
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="lg" labelledBy="channel-category-manager-modal-title">
	<!-- Header -->
	<div class="mb-4 flex items-center justify-between">
		<h3 id="channel-category-manager-modal-title" class="text-lg font-bold">
			{m.livetv_channelCategoryManagerModal_title()}
		</h3>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<!-- Add New Category -->
	<div class="mb-4 rounded-lg bg-base-200 p-3">
		<p class="mb-2 text-sm font-medium">{m.livetv_channelCategoryManagerModal_addNew()}</p>
		<div class="flex gap-2">
			<input
				type="text"
				class="input-bordered input flex-1 input-sm"
				placeholder={m.livetv_channelCategoryManagerModal_categoryNamePlaceholder()}
				bind:value={newName}
				onkeydown={(e) => e.key === 'Enter' && addCategory()}
			/>
			<div class="flex items-center gap-1">
				{#each presetColors.slice(0, 5) as color (color)}
					<button
						type="button"
						class="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110
									{newColor === color ? 'border-white ring-2 ring-primary' : 'border-transparent'}"
						style="background-color: {color}"
						onclick={() => (newColor = newColor === color ? '' : color)}
						title="Select {color}"
					></button>
				{/each}
			</div>
			<button
				class="btn btn-primary btn-sm"
				onclick={addCategory}
				disabled={!newName.trim() || isAdding}
			>
				{#if isAdding}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Plus class="h-4 w-4" />
				{/if}
			</button>
		</div>
	</div>

	<!-- Category List -->
	{#if localCategories.length === 0}
		<div class="py-8 text-center text-base-content/50">
			<p>{m.livetv_channelCategoryManagerModal_noCategories()}</p>
			<p class="text-sm">{m.livetv_channelCategoryManagerModal_createCategoriesHint()}</p>
		</div>
	{:else}
		<div class="space-y-1">
			{#each localCategories as cat, index (cat.id)}
				<div
					class="flex items-center gap-2 rounded-lg px-2 py-2 transition-colors
								{draggedIndex === index ? 'bg-base-200 opacity-50' : ''}
								{dragOverIndex === index && draggedIndex !== index ? 'bg-primary/10' : ''}
								{editingId === cat.id ? 'bg-base-200' : 'hover:bg-base-200/50'}"
					role="listitem"
					draggable={editingId !== cat.id}
					ondragstart={(e) => handleDragStart(e, index)}
					ondragover={(e) => handleDragOver(e, index)}
					ondragleave={handleDragLeave}
					ondrop={(e) => handleDrop(e, index)}
					ondragend={handleDragEnd}
				>
					<!-- Drag Handle -->
					{#if editingId !== cat.id}
						<div class="cursor-grab">
							<GripVertical class="h-4 w-4 text-base-content/30" />
						</div>
					{:else}
						<div class="w-4"></div>
					{/if}

					{#if editingId === cat.id}
						<!-- Edit Mode -->
						<div class="flex flex-1 items-center gap-2">
							<input
								type="text"
								class="input-bordered input flex-1 input-sm"
								bind:value={editingName}
								onkeydown={(e) => {
									if (e.key === 'Enter') saveEdit();
									if (e.key === 'Escape') cancelEdit();
								}}
							/>
							<div class="flex items-center gap-1">
								{#each presetColors.slice(0, 5) as color (color)}
									<button
										type="button"
										class="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110
													{editingColor === color ? 'border-white ring-2 ring-primary' : 'border-transparent'}"
										style="background-color: {color}"
										onclick={() => (editingColor = editingColor === color ? '' : color)}
										title={m.livetv_channelCategoryManagerModal_selectColor({ color })}
									></button>
								{/each}
							</div>
							<button
								class="btn btn-ghost btn-xs"
								onclick={cancelEdit}
								disabled={savingId === cat.id}
							>
								<X class="h-3.5 w-3.5" />
							</button>
							<button
								class="btn btn-primary btn-xs"
								onclick={saveEdit}
								disabled={!editingName.trim() || savingId === cat.id}
							>
								{#if savingId === cat.id}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else}
									<Check class="h-3.5 w-3.5" />
								{/if}
							</button>
						</div>
					{:else}
						<!-- Display Mode -->
						{#if cat.color}
							<span class="h-3 w-3 rounded-full" style="background-color: {cat.color}"></span>
						{:else}
							<span class="h-3 w-3 rounded-full bg-base-content/20"></span>
						{/if}

						<span class="flex-1 font-medium">{cat.name}</span>

						<span class="text-sm text-base-content/50">
							{m.livetv_channelCategoryManagerModal_channelCount({
								count: getChannelCount(cat.id)
							})}
						</span>

						<button
							class="btn btn-ghost btn-xs"
							onclick={() => startEdit(cat)}
							disabled={deletingId === cat.id}
						>
							<Pencil class="h-3.5 w-3.5" />
						</button>

						<button
							class="btn btn-ghost text-error btn-xs hover:bg-error/10"
							onclick={() => requestDeleteCategory(cat)}
							disabled={deletingId === cat.id}
						>
							{#if deletingId === cat.id}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
							{:else}
								<Trash2 class="h-3.5 w-3.5" />
							{/if}
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<!-- Reordering indicator -->
	{#if reordering}
		<div class="mt-2 flex items-center justify-center gap-2 text-sm text-base-content/50">
			<Loader2 class="h-4 w-4 animate-spin" />
			{m.livetv_channelCategoryManagerModal_savingOrder()}
		</div>
	{/if}

	<!-- Actions -->
	<div class="modal-action">
		<button class="btn" onclick={onClose}>{m.livetv_channelCategoryManagerModal_done()}</button>
	</div>
</ModalWrapper>

<ConfirmationModal
	open={deleteConfirmOpen}
	title={m.livetv_channelCategoryManagerModal_deleteCategory()}
	message={deleteCategoryMessage}
	confirmLabel="Delete"
	confirmVariant="error"
	loading={!!deletingId}
	onConfirm={deleteCategory}
	onCancel={closeDeleteConfirm}
/>

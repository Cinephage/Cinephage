<script lang="ts">
	import { X, Loader2, AlertTriangle, Trash2, Download } from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { mediaTypeCountLabel, type MediaType } from '#lib/utils/media-type.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		selectedCount: number;
		mediaType: MediaType;
		hasActiveDownloads?: boolean;
		activeDownloadCount?: number;
		loading: boolean;
		onConfirm: (deleteFiles: boolean, removeFromLibrary: boolean) => void;
		onCancel: () => void;
	}

	let {
		open,
		selectedCount,
		mediaType,
		hasActiveDownloads = false,
		activeDownloadCount = 0,
		loading,
		onConfirm,
		onCancel
	}: Props = $props();

	let deleteFiles = $state(false);
	let removeFromLibrary = $state(false);

	type ActionMode = 'unmatch' | 'delete_files' | 'remove_only' | 'remove_and_delete';

	// Reset when modal closes
	$effect(() => {
		if (!open) {
			deleteFiles = false;
			removeFromLibrary = false;
		}
	});

	const itemLabel = $derived(mediaTypeCountLabel(mediaType, selectedCount));
	const actionMode = $derived.by<ActionMode>(() => {
		if (removeFromLibrary && deleteFiles) return 'remove_and_delete';
		if (removeFromLibrary) return 'remove_only';
		if (deleteFiles) return 'delete_files';
		return 'unmatch';
	});
	const titleText = $derived.by(() => {
		switch (actionMode) {
			case 'remove_and_delete':
				return m.library_bulkDelete_titleRemoveAndDelete();
			case 'remove_only':
				return m.library_bulkDelete_titleRemoveOnly();
			case 'delete_files':
				return m.library_bulkDelete_titleDeleteFiles();
			default:
				return m.library_bulkDelete_titleUnmatchFiles();
		}
	});
	const confirmLabel = $derived.by(() => {
		switch (actionMode) {
			case 'remove_and_delete':
				return m.library_bulkDelete_confirmRemoveAndDelete({ count: selectedCount });
			case 'remove_only':
				return m.library_bulkDelete_confirmRemoveOnly({ count: selectedCount });
			case 'delete_files':
				return m.library_bulkDelete_confirmDeleteFiles({ count: selectedCount });
			default:
				return m.library_bulkDelete_confirmUnmatchFiles({ count: selectedCount });
		}
	});

	function handleConfirm() {
		onConfirm(deleteFiles, removeFromLibrary);
	}

	function handleClose() {
		deleteFiles = false;
		removeFromLibrary = false;
		onCancel();
	}
</script>

<ModalWrapper {open} onClose={handleClose} maxWidth="md" labelledBy="bulk-delete-modal-title">
	<div class="mb-4 flex items-center justify-between">
		<h3 id="bulk-delete-modal-title" class="text-lg font-bold">{titleText}</h3>
		<button
			type="button"
			class="btn btn-circle btn-ghost btn-sm"
			onclick={handleClose}
			aria-label={m.action_close()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<p class="py-2">
		{#if actionMode === 'remove_and_delete'}
			{m.library_bulkDelete_messageRemoveAndDelete({ count: selectedCount })}
		{:else if actionMode === 'remove_only'}
			{m.library_bulkDelete_messageRemoveOnly({ count: selectedCount })}
		{:else if actionMode === 'delete_files'}
			{m.library_bulkDelete_messageDeleteFiles({ count: selectedCount })}
		{:else}
			{m.library_bulkDelete_messageUnmatchFiles({ count: selectedCount })}
		{/if}
	</p>

	<label class="mt-4 flex cursor-pointer items-center gap-3 py-2">
		<input type="checkbox" class="checkbox shrink-0 checkbox-error" bind:checked={deleteFiles} />
		<span class="text-sm">{m.library_bulkDelete_checkboxDeleteFiles()}</span>
	</label>

	<label class="flex cursor-pointer items-center gap-3 py-2">
		<input
			type="checkbox"
			class="checkbox shrink-0 checkbox-error"
			bind:checked={removeFromLibrary}
		/>
		<span class="text-sm">{m.library_bulkDelete_checkboxRemoveLibrary()}</span>
	</label>

	{#if hasActiveDownloads && (actionMode === 'remove_only' || actionMode === 'remove_and_delete')}
		<div class="mt-3 alert alert-warning">
			<Download class="h-4 w-4" />
			<span class="text-sm"
				>{m.library_bulkDelete_activeDownloadsWarning({ count: activeDownloadCount })}</span
			>
		</div>
	{/if}

	{#if actionMode === 'remove_and_delete'}
		<div class="mt-3 alert alert-error">
			<Trash2 class="h-4 w-4" />
			<span class="text-sm"
				>{m.library_bulkDelete_alertRemoveAndDelete({
					count: selectedCount,
					items: itemLabel
				})}</span
			>
		</div>
	{:else if actionMode === 'remove_only'}
		<div class="mt-3 alert alert-error">
			<Trash2 class="h-4 w-4" />
			<span class="text-sm"
				>{m.library_bulkDelete_alertRemoveOnly({ count: selectedCount, items: itemLabel })}</span
			>
		</div>
	{:else if actionMode === 'delete_files'}
		<div class="mt-3 alert alert-warning">
			<AlertTriangle class="h-4 w-4" />
			<span class="text-sm">{m.library_bulkDelete_alertDeleteFiles({ count: selectedCount })}</span>
		</div>
	{:else}
		<div class="mt-3 alert alert-info">
			<span class="text-sm">{m.library_bulkDelete_alertUnmatchFiles()}</span>
		</div>
	{/if}

	<div class="modal-action">
		<button type="button" class="btn btn-ghost" onclick={handleClose} disabled={loading}>
			{m.action_cancel()}
		</button>
		<button type="button" class="btn btn-error" onclick={handleConfirm} disabled={loading}>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{/if}
			{confirmLabel}
		</button>
	</div>
</ModalWrapper>

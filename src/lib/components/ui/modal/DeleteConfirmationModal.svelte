<script lang="ts">
	import { X, Loader2, AlertTriangle, Trash2, Download } from '@lucide/svelte';
	import ModalWrapper from './ModalWrapper.svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		title?: string;
		itemName: string;
		allowRemoveFromLibrary?: boolean;
		hasFiles?: boolean;
		hasActiveDownload?: boolean;
		loading?: boolean;
		onConfirm: (deleteFiles: boolean, removeFromLibrary: boolean) => void;
		onCancel: () => void;
	}

	let {
		open,
		title = 'Delete',
		itemName,
		allowRemoveFromLibrary = true,
		hasFiles = true,
		hasActiveDownload = false,
		loading = false,
		onConfirm,
		onCancel
	}: Props = $props();

	let deleteFiles = $state(false);
	let removeFromLibrary = $state(false);

	type ActionMode = 'unmatch' | 'delete_files' | 'remove_only' | 'remove_and_delete';

	const actionMode = $derived.by<ActionMode>(() => {
		if (allowRemoveFromLibrary && removeFromLibrary && deleteFiles) return 'remove_and_delete';
		if (allowRemoveFromLibrary && removeFromLibrary) return 'remove_only';
		if (deleteFiles) return 'delete_files';
		return 'unmatch';
	});

	const confirmLabel = $derived.by(() => {
		switch (actionMode) {
			case 'remove_and_delete':
				return m.ui_deleteModal_removeAndDeleteFiles();
			case 'remove_only':
				return m.ui_deleteModal_removeFromLibrary();
			case 'delete_files':
				return m.ui_deleteModal_deleteFiles();
			default:
				return m.ui_deleteModal_unmatchFiles();
		}
	});

	// Reset state when modal closes
	$effect(() => {
		if (!open) {
			deleteFiles = false;
			removeFromLibrary = false;
		}
	});

	$effect(() => {
		if (!allowRemoveFromLibrary) {
			removeFromLibrary = false;
		}
	});

	$effect(() => {
		if (!hasFiles) {
			deleteFiles = false;
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

<ModalWrapper {open} onClose={handleClose} maxWidth="md" labelledBy="delete-modal-title">
	<div class="mb-4 flex items-center justify-between">
		<h3 id="delete-modal-title" class="text-lg font-bold">{title}</h3>
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
			{m.ui_deleteModal_confirmRemoveAndDelete_prefix()} <strong>{itemName}</strong>
			{m.ui_deleteModal_confirmRemoveAndDelete_suffix()}
		{:else if actionMode === 'remove_only'}
			{m.ui_deleteModal_confirmRemoveOnly_prefix()} <strong>{itemName}</strong>
			{m.ui_deleteModal_confirmRemoveOnly_suffix()}
		{:else if actionMode === 'delete_files'}
			{m.ui_deleteModal_confirmDeleteFiles_prefix()} <strong>{itemName}</strong>
			{m.ui_deleteModal_confirmDeleteFiles_suffix()}
		{:else}
			{m.ui_deleteModal_confirmUnmatch_prefix()} <strong>{itemName}</strong>
			{m.ui_deleteModal_confirmUnmatch_suffix()}
		{/if}
	</p>

	<label
		class="mt-4 flex items-center gap-3 py-2"
		class:cursor-pointer={hasFiles}
		class:opacity-50={!hasFiles}
	>
		<input
			type="checkbox"
			class="checkbox shrink-0 checkbox-error"
			bind:checked={deleteFiles}
			disabled={!hasFiles}
		/>
		<span class="text-sm"
			>{m.ui_deleteModal_deleteFilesFromDisk()}{#if !hasFiles}
				<span class="text-base-content/50">&nbsp({m.ui_deleteModal_noFilesOnDisk()})</span
				>{/if}</span
		>
	</label>

	{#if allowRemoveFromLibrary}
		<label class="flex cursor-pointer items-center gap-3 py-2">
			<input
				type="checkbox"
				class="checkbox shrink-0 checkbox-error"
				bind:checked={removeFromLibrary}
			/>
			<span class="text-sm">{m.ui_deleteModal_removeFromLibraryEntirely()}</span>
		</label>
	{/if}

	{#if hasActiveDownload && (actionMode === 'remove_only' || actionMode === 'remove_and_delete')}
		<div class="mt-3 alert alert-warning">
			<Download class="h-4 w-4" />
			<span class="text-sm">{m.ui_deleteModal_activeDownloadWarning()} </span>
		</div>
	{/if}

	{#if actionMode === 'remove_and_delete'}
		<div class="mt-3 alert alert-error">
			<Trash2 class="h-4 w-4" />
			<span class="text-sm">{m.ui_deleteModal_warningRemoveAndDelete()}</span>
		</div>
	{:else if actionMode === 'remove_only'}
		<div class="mt-3 alert alert-error">
			<Trash2 class="h-4 w-4" />
			<span class="text-sm">{m.ui_deleteModal_warningRemoveOnly()}</span>
		</div>
	{:else if actionMode === 'delete_files'}
		<div class="mt-3 alert alert-warning">
			<AlertTriangle class="h-4 w-4" />
			<span class="text-sm">{m.ui_deleteModal_warningDeleteFiles()}</span>
		</div>
	{:else}
		<div class="mt-3 alert alert-info">
			<span class="text-sm">{m.ui_deleteModal_warningUnmatch()}</span>
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

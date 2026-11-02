<script lang="ts">
	import { X, Loader2, AlertTriangle } from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		itemName: string;
		isBulk?: boolean;
		folderName?: string;
		folderFileCount?: number;
		loading?: boolean;
		onConfirm: (deleteFromDisk: boolean) => void;
		onCancel: () => void;
	}

	let {
		open,
		itemName,
		isBulk = false,
		folderName,
		folderFileCount,
		loading = false,
		onConfirm,
		onCancel
	}: Props = $props();

	const isFolder = $derived(!!folderName);

	let deleteFromDisk = $state(false);

	$effect(() => {
		if (!open) deleteFromDisk = false;
	});
</script>

<ModalWrapper {open} onClose={onCancel} maxWidth="md" labelledBy="unmatched-delete-title">
	<div class="mb-4 flex items-center justify-between">
		<h3 id="unmatched-delete-title" class="text-lg font-bold">
			{#if isFolder}
				{m.unmatched_delete_titleFolder({ name: folderName! })}
			{:else if isBulk}
				{m.unmatched_delete_titleFolder({ name: itemName })}
			{:else}
				{m.unmatched_delete_titleSingle()}
			{/if}
		</h3>
		<button
			type="button"
			class="btn btn-circle btn-ghost btn-sm"
			onclick={onCancel}
			aria-label={m.action_close()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<p class="py-2 text-sm text-base-content/70">
		{#if isFolder}
			<strong class="text-base-content"
				>{folderFileCount}
				{folderFileCount === 1 ? m.common_file() : m.common_files()} in {folderName}</strong
			>
			{m.unmatched_delete_bodyRemovedNote()}
			{m.unmatched_delete_bodyFilesNote()}
		{:else if isBulk}
			<strong class="text-base-content">{itemName}</strong> {m.unmatched_delete_bodyRemovedNote()}
		{:else}
			<strong class="text-base-content">{itemName}</strong>
			{m.unmatched_delete_bodyRemovedNote()}
			{m.unmatched_delete_bodyFileNote()}
		{/if}
	</p>

	<label class="mt-3 flex cursor-pointer items-center gap-3 py-2">
		<input type="checkbox" class="checkbox shrink-0 checkbox-error" bind:checked={deleteFromDisk} />
		<span class="text-sm"
			>{isBulk || isFolder
				? m.unmatched_delete_alsoDeleteFiles()
				: m.unmatched_delete_alsoDeleteFile()}</span
		>
	</label>

	{#if deleteFromDisk}
		<div class="mt-3 alert alert-warning">
			<AlertTriangle class="h-4 w-4 shrink-0" />
			<span class="text-sm">
				{isBulk || isFolder ? m.unmatched_delete_warningFiles() : m.unmatched_delete_warningFile()}
			</span>
		</div>
	{/if}

	<div class="modal-action">
		<button type="button" class="btn btn-ghost" onclick={onCancel} disabled={loading}>
			{m.action_cancel()}
		</button>
		<button
			type="button"
			class="btn {deleteFromDisk ? 'btn-error' : 'btn-primary'}"
			onclick={() => onConfirm(deleteFromDisk)}
			disabled={loading}
		>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{/if}
			{deleteFromDisk
				? isBulk || isFolder
					? m.unmatched_delete_confirmDeleteFiles()
					: m.unmatched_delete_confirmDeleteFile()
				: m.unmatched_delete_confirmRemove()}
		</button>
	</div>
</ModalWrapper>

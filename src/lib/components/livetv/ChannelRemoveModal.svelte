<script lang="ts">
	import { X, Loader2, AlertTriangle } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';

	interface Props {
		open: boolean;
		loading: boolean;
		selectedCount: number;
		channelName?: string | null;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { open, loading, selectedCount, channelName = null, onConfirm, onCancel }: Props = $props();

	const channelLabel = $derived(
		selectedCount === 1
			? m.livetv_channelRemoveModal_channel()
			: m.livetv_channelRemoveModal_channels({ count: selectedCount })
	);

	function handleClose() {
		if (loading) return;
		onCancel();
	}
</script>

<ModalWrapper {open} onClose={handleClose} maxWidth="md" labelledBy="channel-remove-modal-title">
	<div class="mb-4 flex items-center justify-between">
		<h3 id="channel-remove-modal-title" class="text-lg font-bold">
			{m.livetv_channelRemoveModal_title()}
		</h3>
		<button
			type="button"
			class="btn btn-circle btn-ghost btn-sm"
			onclick={handleClose}
			aria-label={m.action_close()}
			disabled={loading}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<p class="py-2">
		{#if selectedCount === 1 && channelName}
			{m.livetv_channelRemoveModal_removeSingle({ name: channelName })}
		{:else}
			{m.livetv_channelRemoveModal_removeMultiple({
				count: selectedCount
			})}
		{/if}
	</p>

	<div class="mt-3 alert alert-info">
		<AlertTriangle class="h-4 w-4" />
		<span class="text-sm">
			{m.livetv_channelRemoveModal_infoMessage()}
		</span>
	</div>

	<div class="modal-action">
		<button type="button" class="btn btn-ghost" onclick={handleClose} disabled={loading}>
			{m.action_cancel()}
		</button>
		<button type="button" class="btn btn-error" onclick={onConfirm} disabled={loading}>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{/if}
			{m.action_remove()}
			{selectedCount}
			{channelLabel}
		</button>
	</div>
</ModalWrapper>

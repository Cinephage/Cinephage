<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';

	/**
	 * Shared "remove download" confirmation, used by both the Activity
	 * detail modal and the mobile inline remove action.
	 */
	interface Props {
		open: boolean;
		/** Hides the "also blocklist" checkbox once the release already is. */
		isBlocklisted?: boolean;
		loading?: boolean;
		onConfirm: (options: { blocklist: boolean }) => void | Promise<void>;
		onCancel: () => void;
	}

	let { open, isBlocklisted = false, loading = false, onConfirm, onCancel }: Props = $props();

	let blocklistOnRemove = $state(false);

	$effect(() => {
		if (open) {
			blocklistOnRemove = false;
		}
	});

	function handleConfirm(): void {
		onConfirm({ blocklist: blocklistOnRemove });
	}
</script>

<ConfirmationModal
	{open}
	title={m.activity_detail_removeConfirmTitle()}
	message={m.activity_detail_removeFromClientWarning()}
	confirmLabel={m.activity_detail_removeAndDeleteFiles()}
	confirmVariant="error"
	{loading}
	onConfirm={handleConfirm}
	{onCancel}
>
	{#if !isBlocklisted}
		<label class="label cursor-pointer justify-start gap-2 py-1">
			<input type="checkbox" class="checkbox checkbox-sm" bind:checked={blocklistOnRemove} />
			<span class="label-text text-sm">{m.activity_detail_alsoBlocklist()}</span>
		</label>
	{/if}
</ConfirmationModal>

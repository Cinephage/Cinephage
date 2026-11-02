<script lang="ts">
	import { Loader2, Save, Trash2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		onCancel: () => void;
		onSave?: () => void;
		onDelete?: () => void;
		saving?: boolean;
		deleting?: boolean;
		saveDisabled?: boolean;
		saveLabel?: string;
		cancelLabel?: string;
		deleteLabel?: string;
		showDelete?: boolean;
		readonly?: boolean;
	}

	let {
		onCancel,
		onSave,
		onDelete,
		saving = false,
		deleting = false,
		saveDisabled = false,
		saveLabel = m.action_save(),
		cancelLabel = m.action_cancel(),
		deleteLabel = m.action_delete(),
		showDelete = false,
		readonly = false
	}: Props = $props();
</script>

<div class="modal-action mt-6 flex-wrap gap-2 border-t border-base-300 pt-4">
	{#if showDelete && onDelete}
		<button
			class="btn mr-auto btn-ghost text-error"
			onclick={onDelete}
			disabled={deleting || saving}
		>
			{#if deleting}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Trash2 class="h-4 w-4" />
			{/if}
			{deleteLabel}
		</button>
	{/if}

	<button class="btn btn-ghost" onclick={onCancel}>
		{readonly ? m.action_close() : cancelLabel}
	</button>

	{#if !readonly && onSave}
		<button class="btn gap-2 btn-primary" onclick={onSave} disabled={saving || saveDisabled}>
			{#if saving}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Save class="h-4 w-4" />
			{/if}
			{saveLabel}
		</button>
	{/if}
</div>

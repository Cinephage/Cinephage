<script lang="ts">
	import { X, Loader2 } from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		releaseTitle: string;
		loading: boolean;
		onConfirm: (expiresInHours: number | null) => void;
		onCancel: () => void;
	}

	let { open, releaseTitle, loading = false, onConfirm, onCancel }: Props = $props();

	const durationOptions: { label: () => string; value: number | null }[] = [
		{ label: m.blocklist_duration_1hour, value: 1 },
		{ label: m.blocklist_duration_6hours, value: 6 },
		{ label: m.blocklist_duration_24hours, value: 24 },
		{ label: m.blocklist_duration_72hours, value: 72 },
		{ label: m.blocklist_duration_1week, value: 168 },
		{ label: m.blocklist_duration_permanent, value: null }
	];

	let selectedDuration = $state<number | null>(24);

	$effect(() => {
		if (open) {
			selectedDuration = 24;
		}
	});
</script>

<ModalWrapper {open} onClose={onCancel} maxWidth="sm" labelledBy="block-release-modal-title">
	<div class="mb-4 flex items-center justify-between">
		<h3 id="block-release-modal-title" class="text-lg font-bold">
			{m.blocklist_confirmBlockTitle()}
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

	<p class="mb-1 text-sm text-base-content/60">
		{m.blocklist_confirmBlockMessage()}
	</p>
	<p class="mb-4 truncate text-sm font-medium" title={releaseTitle}>
		{releaseTitle}
	</p>

	<div class="form-control mb-4">
		<label class="label pb-1" for="block-duration-select">
			<span class="label-text text-sm">{m.blocklist_tableExpires()}</span>
		</label>
		<select
			id="block-duration-select"
			class="select-bordered select w-full select-sm"
			bind:value={selectedDuration}
		>
			{#each durationOptions as option (option.value)}
				<option value={option.value}>
					{option.label()}
				</option>
			{/each}
		</select>
	</div>

	<div class="modal-action">
		<button type="button" class="btn btn-ghost" onclick={onCancel} disabled={loading}>
			{m.action_cancel()}
		</button>
		<button
			type="button"
			class="btn btn-error"
			onclick={() => onConfirm(selectedDuration)}
			disabled={loading}
		>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{/if}
			{m.blocklist_confirmBlockLabel()}
		</button>
	</div>
</ModalWrapper>

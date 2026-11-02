<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X, Loader2 } from '@lucide/svelte';
	import ModalWrapper from './ModalWrapper.svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		title?: string;
		message?: string;
		messagePrefix?: string;
		messageEmphasis?: string;
		messageSuffix?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		confirmVariant?: 'error' | 'warning' | 'primary';
		loading?: boolean;
		onConfirm: () => void;
		onCancel: () => void;
		children?: Snippet;
	}

	let {
		open,
		title = m.action_confirm(),
		message = '',
		messagePrefix,
		messageEmphasis,
		messageSuffix,
		confirmLabel = m.action_confirm(),
		cancelLabel = m.action_cancel(),
		confirmVariant = 'primary',
		loading = false,
		onConfirm,
		onCancel,
		children
	}: Props = $props();

	const buttonClass = $derived(
		confirmVariant === 'error'
			? 'btn-error'
			: confirmVariant === 'warning'
				? 'btn-warning'
				: 'btn-primary'
	);

	const hasEmphasisMessage = $derived(
		typeof messageEmphasis === 'string' &&
			(messagePrefix !== undefined || messageSuffix !== undefined)
	);
</script>

<ModalWrapper {open} onClose={onCancel} maxWidth="md" labelledBy="confirm-modal-title">
	<div class="mb-4 flex items-center justify-between">
		<h3 id="confirm-modal-title" class="text-lg font-bold">{title}</h3>
		<button
			type="button"
			class="btn btn-circle btn-ghost btn-sm"
			onclick={onCancel}
			aria-label={m.action_close()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	{#if hasEmphasisMessage}
		<p class="py-2">
			{messagePrefix ?? ''}<strong>{messageEmphasis}</strong>{messageSuffix ?? ''}
		</p>
	{:else}
		<p class="py-2">{message}</p>
	{/if}

	{#if children}
		{@render children()}
	{/if}

	<div class="modal-action">
		<button type="button" class="btn btn-ghost" onclick={onCancel} disabled={loading}>
			{cancelLabel}
		</button>
		<button type="button" class="btn {buttonClass}" onclick={onConfirm} disabled={loading}>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{/if}
			{confirmLabel}
		</button>
	</div>
</ModalWrapper>

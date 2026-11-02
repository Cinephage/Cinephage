<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { RotateCcw, Eye, Code } from '@lucide/svelte';

	interface Props {
		id: string;
		label: string;
		value: string;
		preview?: string | null;
		mode?: 'single' | 'multi';
		placeholder?: string;
		helpText?: string;
		onReset?: () => void;
		onFocus?: (id: string) => void;
	}

	let {
		id,
		label,
		value = $bindable(),
		preview = null,
		mode = 'single',
		placeholder,
		helpText,
		onReset,
		onFocus
	}: Props = $props();

	let isFocused = $state(false);
	let inputRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);
	const helpTextId = $derived(helpText ? `${id}-help` : undefined);
	const previewId = $derived(preview ? `${id}-preview` : undefined);
	const describedBy = $derived(
		[helpTextId, previewId].filter((value): value is string => Boolean(value)).join(' ') ||
			undefined
	);

	export function insertAtCursor(textToInsert: string) {
		if (!inputRef) return;

		const input = inputRef;
		const start = input.selectionStart || 0;
		const end = input.selectionEnd || 0;
		const currentValue = input.value;

		// Insert text at cursor position
		const newValue = currentValue.substring(0, start) + textToInsert + currentValue.substring(end);
		value = newValue;

		// Move cursor after inserted text
		const newCursorPos = start + textToInsert.length;
		requestAnimationFrame(() => {
			input.focus();
			input.setSelectionRange(newCursorPos, newCursorPos);
		});
	}

	function handleFocus() {
		isFocused = true;
		onFocus?.(id);
	}

	function handleBlur() {
		isFocused = false;
	}
</script>

<div
	class="group relative rounded-xl border border-base-300 bg-base-100 transition-all duration-200"
	class:border-primary={isFocused}
	class:shadow-sm={isFocused}
>
	<!-- Header -->
	<div class="flex items-center justify-between border-b border-base-200 px-4 py-3">
		<div class="flex items-center gap-2">
			<Code class="h-4 w-4 text-primary" />
			<span class="text-sm font-medium">{label}</span>
		</div>
		<button
			type="button"
			class="btn gap-1 btn-ghost opacity-100 transition-opacity btn-xs sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
			onclick={onReset}
			disabled={!onReset}
			aria-label={`Reset ${label}`}
		>
			<RotateCcw class="h-3 w-3" />
			{m.naming_reset()}
		</button>
	</div>

	<!-- Editor Area -->
	<div class="p-4">
		{#if mode === 'multi'}
			<textarea
				{id}
				bind:this={inputRef}
				class="textarea min-h-30 w-full resize-y textarea-ghost font-mono text-sm leading-relaxed [font-variant-ligatures:none] focus:bg-base-200/50"
				{placeholder}
				aria-label={label}
				aria-describedby={describedBy}
				bind:value
				onfocus={handleFocus}
				onblur={handleBlur}></textarea>
		{:else}
			<input
				{id}
				bind:this={inputRef}
				type="text"
				class="input w-full input-ghost font-mono text-sm [font-variant-ligatures:none] focus:bg-base-200/50"
				{placeholder}
				aria-label={label}
				aria-describedby={describedBy}
				bind:value
				onfocus={handleFocus}
				onblur={handleBlur}
			/>
		{/if}

		{#if helpText}
			<p id={helpTextId} class="mt-2 text-xs text-base-content/60">{helpText}</p>
		{/if}
	</div>

	<!-- Live Preview -->
	{#if preview}
		<div id={previewId} class="border-t border-base-200 bg-base-200/30 px-4 py-3">
			<div class="flex items-start gap-2">
				<Eye class="mt-0.5 h-4 w-4 shrink-0 text-success" />
				<div class="min-w-0 flex-1">
					<span class="mb-1 block text-xs font-medium text-base-content/50"
						>{m.naming_preview()}</span
					>
					<code class="font-mono text-sm break-all text-success">{preview}</code>
				</div>
			</div>
		</div>
	{/if}
</div>

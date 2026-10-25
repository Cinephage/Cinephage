<script lang="ts">
	import { Info } from '@lucide/svelte';

	interface Props {
		label: string;
		id: string;
		value: string | number | undefined;
		type?: 'text' | 'number' | 'password' | 'email' | 'url';
		placeholder?: string;
		helpText?: string;
		error?: string | null;
		tooltip?: string;
		disabled?: boolean;
		required?: boolean;
		size?: 'xs' | 'sm' | 'md' | 'lg';
		min?: number;
		max?: number;
		step?: number;
		onchange?: (value: string | number) => void;
	}

	let {
		label,
		id,
		value = $bindable(),
		type = 'text',
		placeholder,
		helpText,
		error = null,
		tooltip,
		disabled = false,
		required = false,
		size = 'sm',
		min,
		max,
		step,
		onchange
	}: Props = $props();

	function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		value = type === 'number' ? Number(target.value) : target.value;
		onchange?.(value);
	}
</script>

<div class="form-control">
	<label class="label py-1" for={id}>
		<span class="label-text">
			{label}
			{#if required}
				<span class="text-error">*</span>
			{/if}
		</span>
		{#if tooltip}
			<span class="label-text-alt">
				<div class="tooltip" data-tip={tooltip}>
					<Info class="h-4 w-4 text-base-content/50" />
				</div>
			</span>
		{/if}
	</label>

	<input
		{id}
		{type}
		class="input-bordered input input-{size} w-full"
		class:input-error={error}
		{placeholder}
		{disabled}
		{value}
		{min}
		{max}
		{step}
		oninput={handleInput}
	/>

	{#if error}
		<div class="label py-1">
			<span class="label-text-alt text-error">{error}</span>
		</div>
	{:else if helpText}
		<div class="label py-1">
			<span class="label-text-alt text-xs text-base-content/60">{helpText}</span>
		</div>
	{/if}
</div>

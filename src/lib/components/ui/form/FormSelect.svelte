<script lang="ts">
	import { Info } from '@lucide/svelte';

	interface SelectOption {
		value: string | number;
		label: string;
		disabled?: boolean;
	}

	interface Props {
		label: string;
		id: string;
		value: string | number | undefined;
		options: SelectOption[];
		helpText?: string;
		error?: string | null;
		tooltip?: string;
		disabled?: boolean;
		required?: boolean;
		size?: 'xs' | 'sm' | 'md' | 'lg';
		onchange?: (value: string | number) => void;
	}

	let {
		label,
		id,
		value = $bindable(),
		options,
		helpText,
		error = null,
		tooltip,
		disabled = false,
		required = false,
		size = 'sm',
		onchange
	}: Props = $props();

	let selectedValue = $state(value !== undefined ? String(value) : '');

	$effect(() => {
		selectedValue = value !== undefined ? String(value) : '';
	});

	function handleChange(e: Event) {
		const target = e.target as HTMLSelectElement;
		const newValue = target.value;
		selectedValue = newValue;
		// Preserve number type if original value was a number
		value = typeof options[0]?.value === 'number' ? Number(newValue) : newValue;
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

	<select
		{id}
		class="select-bordered select select-{size} w-full"
		class:select-error={error}
		{disabled}
		bind:value={selectedValue}
		onchange={handleChange}
	>
		{#each options as option (option.value)}
			<option value={option.value} disabled={option.disabled}>
				{option.label}
			</option>
		{/each}
	</select>

	{#if error}
		<div class="label py-1">
			<span class="label-text-alt text-error">{error}</span>
		</div>
	{:else if helpText}
		<div class="label py-1">
			<span class="label-text-alt text-xs whitespace-normal text-base-content/60">{helpText}</span>
		</div>
	{/if}
</div>

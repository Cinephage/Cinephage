<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Eye, EyeOff } from '@lucide/svelte';

	interface Props {
		monitored: boolean;
		partiallyMonitored?: boolean;
		disabled?: boolean;
		size?: 'sm' | 'md' | 'lg';
		onToggle?: (newValue: boolean) => void;
	}

	let {
		monitored,
		partiallyMonitored = false,
		disabled = false,
		size = 'md',
		onToggle
	}: Props = $props();

	const sizeClasses = {
		sm: 'btn-xs',
		md: 'btn-sm',
		lg: 'btn-md'
	};

	const iconSizes = {
		sm: 14,
		md: 16,
		lg: 20
	};

	function handleClick() {
		if (!disabled && onToggle) {
			onToggle(!monitored);
		}
	}

	const colorClass = $derived(
		monitored ? (partiallyMonitored ? 'text-warning' : 'text-success') : 'text-base-content/50'
	);

	const tooltip = $derived(
		monitored
			? partiallyMonitored
				? m.library_monitorToggle_partiallyMonitored()
				: m.library_monitorToggle_monitored()
			: m.library_monitorToggle_notMonitored()
	);
</script>

<button
	class="btn btn-ghost {sizeClasses[size]} {colorClass}"
	class:btn-disabled={disabled}
	onclick={handleClick}
	title={tooltip}
	{disabled}
>
	{#if monitored}
		<Eye size={iconSizes[size]} />
	{:else}
		<EyeOff size={iconSizes[size]} />
	{/if}
</button>

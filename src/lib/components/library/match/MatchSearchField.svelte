<script lang="ts">
	import { Search, Loader2 } from '@lucide/svelte';

	interface Props {
		value: string;
		placeholder: string;
		searching?: boolean;
		/** Immediate search; the caller owns the debounce (see createTmdbMatchSearch). */
		onEnter: () => void;
		/** Wrapper margin, because the dialogs place it differently. */
		class?: string;
	}

	let {
		value = $bindable(),
		placeholder,
		searching = false,
		onEnter,
		class: className = ''
	}: Props = $props();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') onEnter();
	}
</script>

<div class="group relative {className}">
	{#if searching}
		<Loader2
			class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 animate-spin text-base-content/40"
		/>
	{:else}
		<Search
			class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-base-content/40 transition-colors group-focus-within:text-primary"
		/>
	{/if}
	<input
		type="text"
		class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
		{placeholder}
		bind:value
		onkeydown={handleKeydown}
	/>
</div>

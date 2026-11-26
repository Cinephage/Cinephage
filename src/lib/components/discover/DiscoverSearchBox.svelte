<script lang="ts">
	import { Search, X, Loader2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		query: string;
		searching: boolean;
		oninput: (e: Event) => void;
		onkeydown: (e: KeyboardEvent) => void;
		onclear: () => void;
	}

	let { query, searching, oninput, onkeydown, onclear }: Props = $props();

	let inputEl = $state<HTMLInputElement>();

	// The clear button unmounts once the query is empty; move focus back into
	// the input now, inside the click (so mobile keeps the soft keyboard), or
	// it would fall back to <body>.
	function clear() {
		onclear();
		inputEl?.focus();
	}
</script>

<div class="group relative w-full">
	<div class="pointer-events-none absolute top-1/2 left-3.5 z-1 -translate-y-1/2">
		{#if searching}
			<Loader2
				class="h-4 w-4 animate-spin text-base-content/40 transition-colors group-focus-within:text-primary"
			/>
		{:else}
			<Search
				class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
			/>
		{/if}
	</div>
	<input
		bind:this={inputEl}
		type="text"
		placeholder={m.discover_searchPlaceholder()}
		class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
		value={query}
		{oninput}
		{onkeydown}
	/>
	{#if query}
		<!-- 32 px hit area around the small visible circle; mousedown is
		     cancelled so a tap never blurs the input first. -->
		<button
			type="button"
			class="group/clear absolute top-1/2 right-0.5 grid size-8 -translate-y-1/2 place-items-center rounded-full text-base-content/40 transition-colors hover:text-base-content focus-visible:outline-2 focus-visible:outline-primary"
			onmousedown={(e) => e.preventDefault()}
			onclick={clear}
			aria-label={m.discover_clearSearch()}
		>
			<span class="rounded-full p-0.5 transition-colors group-hover/clear:bg-base-300">
				<X class="h-3.5 w-3.5" />
			</span>
		</button>
	{/if}
</div>

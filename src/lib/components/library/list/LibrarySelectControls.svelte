<script lang="ts">
	/**
	 * The list header's select controls: the three-state toggle (select → select
	 * all → done) and, while selecting with not everything selected, a separate
	 * Done button.
	 *
	 * The toggle only leaves select mode once everything is selected, and Escape
	 * is the other way out. Phones have no Escape key, so without the Done button
	 * a phone user had to select everything just to get out again. Once
	 * everything is selected the toggle itself is the way out, so the Done button
	 * steps aside instead of showing a second, identical exit.
	 */
	import { CheckSquare, XSquare, X } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		/** Are checkboxes showing? */
		mode: boolean;
		/** Is everything in the list selected (the toggle's third state)? */
		allSelected: boolean;
		/** Header toggle: off → on → select all → off. */
		onCycle: () => void;
		/** Leave select mode and drop the selection. */
		onExit: () => void;
	}

	let { mode, allSelected, onCycle, onExit }: Props = $props();

	let toggle = $state<HTMLButtonElement>();

	function exit() {
		onExit();
		// The Done button disappears with select mode; keep focus on the toggle
		// instead of letting it fall back to the top of the document.
		toggle?.focus();
	}
</script>

<button
	bind:this={toggle}
	class="btn gap-1.5 btn-ghost btn-xs sm:btn-sm {mode ? 'btn-primary' : ''}"
	aria-label={!mode
		? m.library_selectToggle_start()
		: !allSelected
			? m.library_selectToggle_selectAll()
			: m.library_selectToggle_done()}
	onclick={onCycle}
>
	{#if !mode}
		<CheckSquare class="h-4 w-4" />
		<span class="hidden sm:inline">{m.library_movies_select()}</span>
	{:else if !allSelected}
		<CheckSquare class="h-4 w-4" />
		<span class="hidden sm:inline">{m.library_movies_selectAll()}</span>
	{:else}
		<XSquare class="h-4 w-4" />
		<span class="hidden sm:inline">{m.library_movies_done()}</span>
	{/if}
</button>

{#if mode && !allSelected}
	<!-- The visible "Done" is the accessible name (screen-reader-only on phones),
	     so voice control matches what is on screen; the title explains it. -->
	<button
		class="btn gap-1.5 btn-ghost btn-xs sm:btn-sm"
		title={m.library_selectToggle_done()}
		onclick={exit}
	>
		<X class="h-4 w-4" aria-hidden="true" />
		<span class="sr-only sm:not-sr-only">{m.library_movies_done()}</span>
	</button>
{/if}

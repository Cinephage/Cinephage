<script lang="ts">
	/**
	 * The list header's select controls: the three-state toggle (select → select
	 * all → done) and, while selecting, a separate Done button.
	 *
	 * The toggle only leaves select mode once everything is selected, and Escape
	 * is the other way out. Phones have no Escape key, so without the Done button
	 * a phone user had to select everything just to get out again.
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
</script>

<button
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

{#if mode}
	<button
		class="btn gap-1.5 btn-ghost btn-xs sm:btn-sm"
		aria-label={m.library_selectToggle_done()}
		title={m.library_selectToggle_done()}
		onclick={onExit}
	>
		<X class="h-4 w-4" />
		<span class="hidden sm:inline">{m.library_movies_done()}</span>
	</button>
{/if}

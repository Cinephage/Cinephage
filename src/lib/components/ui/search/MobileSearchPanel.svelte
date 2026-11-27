<script lang="ts">
	/**
	 * The phone-width search row under a page toolbar, opened by a
	 * `MobileSearchToggle`. Escape, the close button or a tap outside collapse
	 * it while the query is empty; an active query keeps it on screen.
	 */
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { MobileSearch } from './mobile-search.svelte.js';

	interface Props {
		search: MobileSearch;
		/** The search field itself (and anything beside it, like a match count). */
		children: Snippet;
	}

	let { search, children }: Props = $props();

	// Read in the capture phase, before the field's own Escape handler may
	// clear the query: Escape on a query clears it, Escape on an empty field
	// closes the row.
	function onkeydowncapture(event: KeyboardEvent) {
		if (event.key !== 'Escape' || search.active) return;
		event.stopPropagation();
		search.hide(true);
	}

	$effect(() => {
		if (!search.open) return;
		function onpointerdown(event: PointerEvent) {
			const target = event.target as Node;
			if (search.panel?.contains(target) || search.button?.contains(target)) return;
			search.hide();
		}
		document.addEventListener('pointerdown', onpointerdown);
		return () => document.removeEventListener('pointerdown', onpointerdown);
	});
</script>

<div
	bind:this={search.panel}
	id={search.id}
	class="flex items-center gap-2 border-t border-base-200/50 px-4 py-2 md:hidden"
	hidden={!search.expanded}
	role="search"
	onfocusin={() => (search.open = true)}
	{onkeydowncapture}
>
	{@render children()}
	{#if !search.active}
		<button
			type="button"
			class="btn btn-circle shrink-0 btn-ghost btn-sm"
			onclick={() => search.hide(true)}
			aria-label={m.action_closeSearch()}
		>
			<X class="h-4 w-4" />
		</button>
	{/if}
</div>

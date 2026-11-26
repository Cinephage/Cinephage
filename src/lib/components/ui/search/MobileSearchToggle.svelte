<script lang="ts">
	/** The search icon that opens a `MobileSearchPanel`; hidden from `md` up, where the field is inline. */
	import { Search } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { MobileSearch } from './mobile-search.svelte.js';

	interface Props {
		search: MobileSearch;
		/** Toolbar button classes, so the icon matches its neighbours. */
		class?: string;
	}

	let { search, class: className = 'btn btn-ghost btn-sm' }: Props = $props();
</script>

<button
	bind:this={search.button}
	type="button"
	class="{className} md:hidden {search.active ? 'text-primary' : ''}"
	onclick={() => search.toggle()}
	aria-label={m.action_search()}
	aria-expanded={search.expanded}
	aria-controls={search.id}
>
	<Search class="h-4 w-4" />
</button>

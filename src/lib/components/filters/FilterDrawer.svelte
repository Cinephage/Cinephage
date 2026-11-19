<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import FilterPanel from './FilterPanel.svelte';
	import type { FacetGroupView, FacetValue } from '#lib/filters/types.js';
	import * as m from '#lib/paraglide/messages.js';

	let {
		isOpen = $bindable(false),
		groups,
		onchange,
		onReset
	}: {
		isOpen: boolean;
		groups: FacetGroupView[];
		onchange: (facetId: string, value: FacetValue | null) => void;
		onReset: () => void;
	} = $props();

	function close() {
		isOpen = false;
	}
</script>

{#if isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
		transition:fade={{ duration: 200 }}
		onclick={close}
		role="button"
		tabindex="0"
		aria-label="Close filter drawer"
		onkeydown={(e) => {
			if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				close();
			}
		}}
	></div>

	<!-- Drawer -->
	<div
		class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-base-100 shadow-2xl"
		transition:fly={{ x: '100%', duration: 300, opacity: 1 }}
	>
		<!-- Header -->
		<div class="flex items-center justify-between border-b border-base-200 p-4">
			<h2 class="text-xl font-bold">{m.discover_filters()}</h2>
			<button
				class="btn btn-circle btn-ghost btn-sm"
				onclick={close}
				aria-label={m.discover_closeFilters()}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-6 w-6"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			</button>
		</div>

		<div class="flex-1 [scrollbar-width:none] overflow-y-auto p-4 [&::-webkit-scrollbar]:hidden">
			<FilterPanel {groups} {onchange} />
		</div>

		<!-- Footer. Filters apply as they are picked; this only closes the drawer. -->
		<div class="flex gap-3 border-t border-base-200 bg-base-100 p-4">
			<button class="btn flex-1 btn-outline" onclick={onReset}>{m.action_reset()}</button>
			<button class="btn flex-1 btn-primary" onclick={close}>{m.discover_applyFilters()}</button>
		</div>
	</div>
{/if}

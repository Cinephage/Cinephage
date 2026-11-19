<script lang="ts">
	import FacetField from './FacetField.svelte';
	import type { FacetGroupView, FacetValue } from '#lib/filters/types.js';

	/**
	 * Renders whatever facets the current tab declares. It knows the control
	 * vocabulary and nothing about media kinds: no `type === ...` lives here.
	 */
	let {
		groups,
		onchange
	}: {
		groups: FacetGroupView[];
		onchange: (facetId: string, value: FacetValue | null) => void;
	} = $props();
</script>

<div class="space-y-6">
	{#each groups as group (group.id)}
		<div class="space-y-4">
			{#if group.label}
				<h3 class="px-1 text-xs font-bold tracking-wider text-base-content/40 uppercase">
					{group.label}
				</h3>
			{/if}
			{#each group.facets as facet (facet.id)}
				<FacetField {facet} onchange={(value) => onchange(facet.id, value)} />
			{/each}
		</div>
	{/each}
</div>

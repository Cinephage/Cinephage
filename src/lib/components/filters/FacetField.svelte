<script lang="ts">
	import SelectControl from './controls/SelectControl.svelte';
	import LogoMultiControl from './controls/LogoMultiControl.svelte';
	import RangeControl from './controls/RangeControl.svelte';
	import SliderControl from './controls/SliderControl.svelte';
	import KeywordsControl from './controls/KeywordsControl.svelte';
	import type { FacetValue, FacetView } from '#lib/filters/types.js';

	let {
		facet,
		onchange
	}: { facet: FacetView; onchange: (value: FacetValue | null) => void } = $props();
</script>

<div class="space-y-1">
	{#if facet.hint}
		<span class="px-1 text-xs font-medium text-base-content/50">{facet.hint}</span>
	{/if}
	{#if facet.control === 'keywords'}
		<KeywordsControl {facet} {onchange} />
	{:else if facet.control === 'range'}
		<RangeControl {facet} {onchange} />
	{:else if facet.control === 'slider'}
		<SliderControl {facet} {onchange} />
	{:else if facet.control === 'logo-multi'}
		<LogoMultiControl {facet} {onchange} />
	{:else}
		<SelectControl {facet} {onchange} />
	{/if}
</div>

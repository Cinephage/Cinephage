<script lang="ts">
	import type { FacetValue, FacetView } from '#lib/filters/types.js';

	let { facet, onchange }: { facet: FacetView; onchange: (value: FacetValue | null) => void } =
		$props();

	const range = $derived(facet.range ?? { min: 0, max: 10, step: 0.5 });
	const value = $derived(facet.value?.kind === 'number' ? Number(facet.value.value) : 0);
	const marks = $derived([range.min, (range.min + range.max) / 2, range.max]);

	function commit(next: number) {
		onchange(next > 0 ? { kind: 'number', value: String(next) } : null);
	}
</script>

<div class="form-control">
	<label
		for={`facet-${facet.id}`}
		class="label text-sm font-bold tracking-wide text-base-content/70 uppercase"
	>
		<span>{facet.label}</span>
		<span class="badge font-bold badge-primary">{value}</span>
	</label>
	<input
		type="range"
		id={`facet-${facet.id}`}
		min={range.min}
		max={range.max}
		step={range.step}
		{value}
		class="range w-full range-primary range-sm"
		onchange={(event) => commit(parseFloat(event.currentTarget.value))}
	/>
	<div class="mt-2 flex w-full justify-between px-1 text-xs font-medium text-base-content/50">
		{#each marks as mark (mark)}
			<span>{mark}</span>
		{/each}
	</div>
</div>

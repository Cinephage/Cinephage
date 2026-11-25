<script lang="ts">
	import type { FacetValue, FacetView } from '#lib/filters/types.js';

	let { facet, onchange }: { facet: FacetView; onchange: (value: FacetValue | null) => void } =
		$props();

	const min = $derived(facet.value?.kind === 'range' ? facet.value.min : '');
	const max = $derived(facet.value?.kind === 'range' ? facet.value.max : '');

	function commit(nextMin: string, nextMax: string) {
		onchange(nextMin || nextMax ? { kind: 'range', min: nextMin, max: nextMax } : null);
	}
</script>

<div class="form-control">
	<span class="label text-sm font-bold tracking-wide text-base-content/70 uppercase"
		>{facet.label}</span
	>
	<div class="flex items-center gap-2">
		<input
			type="number"
			min={facet.range?.min}
			max={facet.range?.max}
			step={facet.range?.step ?? 1}
			placeholder={facet.range?.placeholderMin}
			class="input-bordered input w-full min-w-0 bg-base-200 transition-colors focus:bg-base-100"
			value={min}
			onchange={(event) => commit(event.currentTarget.value, max)}
		/>
		<span class="font-bold text-base-content/50">-</span>
		<input
			type="number"
			min={facet.range?.min}
			max={facet.range?.max}
			step={facet.range?.step ?? 1}
			placeholder={facet.range?.placeholderMax}
			class="input-bordered input w-full min-w-0 bg-base-200 transition-colors focus:bg-base-100"
			value={max}
			onchange={(event) => commit(min, event.currentTarget.value)}
		/>
	</div>
</div>

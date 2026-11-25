<script lang="ts">
	import LogoListSelect from '../LogoListSelect.svelte';
	import type { FacetValue, FacetView } from '#lib/filters/types.js';
	import { SvelteSet } from 'svelte/reactivity';

	let { facet, onchange }: { facet: FacetView; onchange: (value: FacetValue | null) => void } =
		$props();

	const items = $derived(
		facet.options.map((option) => ({
			id: Number(option.id),
			name: option.label,
			logoPath: option.logoPath ?? null
		}))
	);

	const selected = $derived(facet.value?.kind === 'ids' ? facet.value.ids.map(Number) : []);

	function toggle(id: number) {
		const next = new SvelteSet(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		onchange(next.size > 0 ? { kind: 'ids', ids: [...next].map(String) } : null);
	}
</script>

<div class="form-control">
	<span class="label text-sm font-bold tracking-wide text-base-content/70 uppercase">
		<span>{facet.label}</span>
		{#if selected.length > 0}
			<span class="badge badge-sm badge-primary">{selected.length}</span>
		{/if}
	</span>
	<LogoListSelect {items} {selected} onToggle={toggle} searchable={facet.searchable ?? false} />
</div>

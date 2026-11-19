<script lang="ts">
	import MultiSelectDropdown from '../MultiSelectDropdown.svelte';
	import type { FacetValue, FacetView } from '#lib/filters/types.js';

	let {
		facet,
		onchange
	}: { facet: FacetView; onchange: (value: FacetValue | null) => void } = $props();

	const selected = $derived.by(() => {
		const value = facet.value;
		if (value?.kind === 'ids') return value.ids;
		if (value?.kind === 'scalar') return [value.value];
		return [];
	});

	const options = $derived(
		facet.options.map((option) => ({
			id: option.id,
			label: option.label,
			title: option.title
		}))
	);

	/** Multi-select stacks; single-select (and a preset) toggles off when re-picked. */
	function toggle(id: string) {
		if (facet.control === 'multi') {
			const next = new Set(selected);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			onchange(next.size > 0 ? { kind: 'ids', ids: [...next] } : null);
			return;
		}
		onchange(selected[0] === id ? null : { kind: 'scalar', value: id });
	}
</script>

<MultiSelectDropdown
	id={facet.id}
	label={facet.label}
	{options}
	{selected}
	mode={facet.control === 'multi' ? 'multiple' : 'single'}
	searchable={facet.searchable ?? false}
	placeholder={facet.placeholder ?? ''}
	onToggle={toggle}
	onClear={() => onchange(null)}
/>

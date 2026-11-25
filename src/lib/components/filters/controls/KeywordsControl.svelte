<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import KeywordSelector from '#lib/components/smartlists/KeywordSelector.svelte';
	import { getKeyword } from '#lib/api/index.js';
	import type { FacetValue, FacetView } from '#lib/filters/types.js';

	let { facet, onchange }: { facet: FacetView; onchange: (value: FacetValue | null) => void } =
		$props();

	const include = $derived(facet.value?.kind === 'keywords' ? facet.value.include : []);
	const exclude = $derived(facet.value?.kind === 'keywords' ? facet.value.exclude : []);

	// A keyword that arrives by URL — a shared link, a seasonal preset — has no
	// label until something names it, so the chip would read as a bare id.
	const names = new SvelteMap<number, string>();
	// Ids already looked up or in flight. Deliberately not reactive: checking
	// `names` here would make the effect re-run on every resolved lookup and
	// fetch again each id that is still pending.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- must not be tracked
	const requested = new Set<number>();
	$effect(() => {
		for (const id of [...include, ...exclude]) {
			const numeric = Number(id);
			if (!Number.isFinite(numeric) || requested.has(numeric)) continue;
			requested.add(numeric);
			void getKeyword(numeric)
				.then((keyword) => {
					if (keyword) names.set(keyword.id, keyword.name);
				})
				// A failed lookup costs a label, not the filter; a later change may retry.
				.catch(() => {
					requested.delete(numeric);
				});
		}
	});

	const selectedKeywords = $derived([
		...include.map((id) => ({
			id: Number(id),
			name: names.get(Number(id)) ?? id,
			exclude: false
		})),
		...exclude.map((id) => ({
			id: Number(id),
			name: names.get(Number(id)) ?? id,
			exclude: true
		}))
	]);

	function commit(nextInclude: string[], nextExclude: string[]) {
		onchange(
			nextInclude.length > 0 || nextExclude.length > 0
				? { kind: 'keywords', include: nextInclude, exclude: nextExclude }
				: null
		);
	}

	function add(keyword: { id: number; name: string }, excluded: boolean) {
		names.set(keyword.id, keyword.name);
		requested.add(keyword.id);
		const id = String(keyword.id);
		commit(
			excluded ? include : [...include.filter((entry) => entry !== id), id],
			excluded ? [...exclude.filter((entry) => entry !== id), id] : exclude
		);
	}

	function remove(keywordId: number) {
		const id = String(keywordId);
		commit(
			include.filter((entry) => entry !== id),
			exclude.filter((entry) => entry !== id)
		);
	}
</script>

<div class="form-control">
	<span class="label text-sm font-bold tracking-wide text-base-content/70 uppercase">
		<span>{facet.label}</span>
		{#if selectedKeywords.length > 0}
			<span class="badge badge-sm badge-primary">{selectedKeywords.length}</span>
		{/if}
	</span>
	<KeywordSelector
		showLabel={false}
		{selectedKeywords}
		onAddKeyword={add}
		onRemoveKeyword={remove}
	/>
</div>

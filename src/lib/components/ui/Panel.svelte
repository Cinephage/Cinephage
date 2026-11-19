<script lang="ts">
	/**
	 * The card surface every detail page repeats: one rounded panel on `bg-base-200`
	 * with an optional plain heading. Panels whose heading row carries controls (a
	 * search box, a button group) keep that heading in the page; this covers the
	 * panels that only need a title.
	 *
	 * @example
	 * <Panel title={m.common_details()}>
	 *   <dl class="space-y-2 text-sm">…</dl>
	 * </Panel>
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		/** Panel heading. Omitted, the panel renders its children only. */
		title?: string;
		/** Padding/spacing classes — the standard page padding is the default. */
		class?: string;
		children: Snippet;
	}

	let { title, class: className = 'p-4 md:p-6', children }: Props = $props();
</script>

<div class="rounded-xl bg-base-200 {className}">
	{#if title}<h3 class="mb-3 font-semibold">{title}</h3>{/if}
	{@render children()}
</div>

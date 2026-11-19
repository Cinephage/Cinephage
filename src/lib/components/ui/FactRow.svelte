<script lang="ts">
	/**
	 * One label/value row of a detail sidebar — the `<dt>/<dd>` pair every detail
	 * page writes by hand. Render it inside `<dl class="space-y-2 text-sm">`.
	 *
	 * Plain text and external links are props; anything richer (a button that
	 * resolves a provider ref, a list of badges) passes a `children` snippet, so
	 * the row grammar stays here and the content stays with the page.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		/** Plain value. Ignored when `children` is given. */
		value?: string | number | null;
		/** Renders the value as an external link, opened in a new tab. */
		href?: string | null;
		/** `block` stacks a long value (a path) under its label, with a divider above. */
		variant?: 'inline' | 'block';
		/** Monospace value — ids and paths. */
		mono?: boolean;
		/** Tooltip for a value that can be clipped (a long id). */
		title?: string;
		children?: Snippet;
	}

	let { label, value, href, variant = 'inline', mono = false, title, children }: Props = $props();

	const valueClass = $derived(
		variant === 'block'
			? `mt-1 break-all ${mono ? 'font-mono text-xs' : ''}`.trim()
			: `sm:text-right ${mono ? 'font-mono text-xs' : ''}`.trim()
	);
</script>

{#if variant === 'block'}
	<div class="border-t border-base-content/10 pt-2">
		<dt class="text-base-content/60">{label}</dt>
		<dd class={valueClass}>
			{#if children}{@render children()}{:else}{value}{/if}
		</dd>
	</div>
{:else}
	<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
		<dt class="text-base-content/60">{label}</dt>
		<dd class={valueClass} {title}>
			{#if children}
				{@render children()}
			{:else if href}
				<a {href} target="_blank" rel="noopener noreferrer" class="link link-primary">{value}</a>
			{:else}
				{value}
			{/if}
		</dd>
	</div>
{/if}

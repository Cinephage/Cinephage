<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ArrowLeft } from '@lucide/svelte';
	import { resolvePath } from '#lib/utils/routing.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		/** Page title */
		title: string;
		/** Optional subtitle/description */
		subtitle?: string;
		/** Optional link back to a parent page, rendered above the title. */
		backHref?: string;
		/** Label for the back link's target (used in "Back to {name}"); defaults to the page title. */
		backLabel?: string;
		/** Optional action area (e.g. Add button) rendered right of the title */
		actions?: Snippet;
		/** Main page content */
		children: Snippet;
	}

	let { title, subtitle, backHref, backLabel, actions, children }: Props = $props();
</script>

<div class="w-full p-3 sm:p-4">
	{#if backHref}
		<a href={resolvePath(backHref)} class="btn mb-2 gap-1.5 btn-ghost text-base-content/60 btn-sm">
			<ArrowLeft class="h-4 w-4" />
			{m.library_backTo({ name: backLabel ?? title })}
		</a>
	{/if}
	<div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
		<div class="min-w-0">
			<h1 class="text-2xl font-bold">{title}</h1>
			{#if subtitle}
				<p class="mt-1 text-sm text-base-content/70">{subtitle}</p>
			{/if}
		</div>
		{#if actions}
			<div class="flex shrink-0 items-center gap-2">
				{@render actions()}
			</div>
		{/if}
	</div>

	<div class="space-y-6">
		{@render children()}
	</div>
</div>

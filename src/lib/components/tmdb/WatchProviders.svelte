<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import type { WatchProvidersResponse, WatchProvider } from '#lib/types/tmdb.js';
	import TmdbImage from './TmdbImage.svelte';
	import { page } from '$app/state';
	import { TMDB } from '#lib/config/constants.js';
	import * as m from '#lib/paraglide/messages.js';

	let {
		providers,
		countryCode,
		limit = 8
	}: {
		providers?: WatchProvidersResponse;
		countryCode?: string;
		limit?: number;
	} = $props();

	const effectiveCountryCode = $derived(
		countryCode || page.data.defaultRegion || TMDB.DEFAULT_REGION
	);
	const countryData = $derived(providers?.results?.[effectiveCountryCode]);

	// Flatten all providers, prioritizing streaming
	const allProviders = $derived.by(() => {
		const seen = new SvelteSet<number>();
		const result: WatchProvider[] = [];

		for (const list of [
			countryData?.flatrate,
			countryData?.free,
			countryData?.rent,
			countryData?.buy
		]) {
			if (list) {
				for (const p of list) {
					if (!seen.has(p.provider_id)) {
						seen.add(p.provider_id);
						result.push(p);
					}
				}
			}
		}
		return result;
	});
</script>

{#if allProviders.length > 0}
	<div class="flex flex-wrap items-center gap-1.5">
		{#each allProviders.slice(0, limit) as provider (provider.provider_id)}
			<div
				class="h-7 w-7 overflow-hidden rounded bg-base-300 transition-transform hover:scale-110"
				title={provider.provider_name}
			>
				{#if provider.logo_path}
					<TmdbImage
						path={provider.logo_path}
						size="w92"
						alt={provider.provider_name}
						class="h-full w-full object-cover"
					/>
				{:else}
					<div
						class="flex h-full w-full items-center justify-center text-[9px] text-base-content/60"
					>
						{provider.provider_name.slice(0, 2)}
					</div>
				{/if}
			</div>
		{/each}
		{#if allProviders.length > limit}
			<span class="text-xs text-base-content/50">+{allProviders.length - limit}</span>
		{/if}
	</div>
{:else}
	<span class="text-base-content/40">{m.tmdb_watchProviders_notAvailable()}</span>
{/if}

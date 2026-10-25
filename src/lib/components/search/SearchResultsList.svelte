<script lang="ts">
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import { Loader2, Package, Search } from '@lucide/svelte';
	import SearchResultRow, { type Release } from './SearchResultRow.svelte';

	type SearchMode = 'all' | 'multiSeasonPack';

	interface Props {
		searching: boolean;
		searchError: string | null;
		filteredReleases: Release[];
		rawReleaseCount: number;
		searchMode: SearchMode;
		getReleaseKey: (release: Release) => string;
		grabbingIds: SvelteSet<string>;
		grabbedIds: SvelteSet<string>;
		streamingIds: SvelteSet<string>;
		grabErrors: SvelteMap<string, string>;
		showUsenetStreamButton: boolean;
		canUsenetStream: boolean;
		usenetStreamUnavailableReason: string | null;
		onGrab: (release: Release, streaming?: boolean) => Promise<void>;
		onBlock?: (release: Release) => void;
		blockedIds?: SvelteSet<string>;
	}

	let {
		searching,
		searchError,
		filteredReleases,
		rawReleaseCount,
		searchMode,
		getReleaseKey,
		grabbingIds,
		grabbedIds,
		streamingIds,
		grabErrors,
		showUsenetStreamButton,
		canUsenetStream,
		usenetStreamUnavailableReason,
		onGrab,
		onBlock,
		blockedIds
	}: Props = $props();
</script>

<div class="min-h-0 flex-1 overflow-y-auto">
	{#if searching}
		<div class="flex flex-col items-center justify-center py-12">
			<Loader2 size={32} class="animate-spin text-primary" />
			<p class="mt-4 text-base-content/60">Searching indexers...</p>
		</div>
	{:else if searchError}
		<div class="alert alert-error">
			<span>{searchError}</span>
		</div>
	{:else if filteredReleases.length === 0}
		<div class="flex flex-col items-center justify-center py-12">
			{#if searchMode === 'multiSeasonPack'}
				{#if rawReleaseCount > 0}
					<div
						class="mb-4 max-w-xl rounded-lg border border-base-300 bg-base-200 p-3 text-center text-sm"
					>
						<p class="mt-1 text-base-content/60">
							{rawReleaseCount} releases matched the title, but none matched complete/multi-season rules.
						</p>
					</div>
				{/if}
				<Package size={48} class="text-base-content/30" />
				<p class="mt-4 text-base-content/60">No multi-season packs found</p>
				<p class="mt-2 text-sm text-base-content/40">Try searching by individual season instead</p>
			{:else}
				<Search size={48} class="text-base-content/30" />
				<p class="mt-4 text-base-content/60">No results found</p>
			{/if}
		</div>
	{:else}
		<div class="space-y-3">
			{#each filteredReleases as release (getReleaseKey(release))}
				{@const key = getReleaseKey(release)}
				<SearchResultRow
					{release}
					{onGrab}
					{onBlock}
					grabbing={grabbingIds.has(key)}
					grabbed={grabbedIds.has(key)}
					blocked={blockedIds?.has(key) ?? false}
					streaming={streamingIds.has(key)}
					error={grabErrors.get(key)}
					{showUsenetStreamButton}
					{canUsenetStream}
					{usenetStreamUnavailableReason}
				/>
			{/each}
		</div>
	{/if}
</div>

<script lang="ts">
	/**
	 * The four states a library list can be in before it has anything to show:
	 * a load error, no search match, an empty library, or no match for the active
	 * filters. Renders its children when there is something to list.
	 *
	 * The kind supplies its own icon and copy; this component owns the layout and
	 * the order of the states, which were identical in all three lists.
	 */
	import type { Snippet } from 'svelte';
	import { Search } from '@lucide/svelte';

	interface Props {
		error?: string | null;
		searchQuery: string;
		/** Items left after the client-side search. */
		filteredCount: number;
		/** Items the server returned (before the client-side search). */
		sourceCount: number;
		/** Items in the whole library, before any filter. */
		totalUnfiltered: number;
		icon: Snippet;
		/** Overrides the "discover" call to action on the empty library state. */
		emptyAction?: Snippet;

		/** Where "search in Discover" points for this kind. */
		discoverHref: string;
		discoverLabel: string;
		/** The search-empty state carries the query into Discover. */
		searchDiscoverHref?: string;
		searchDiscoverLabel?: string;
		noSearchTitle: string;
		noSearchHint: string;
		clearSearchLabel: string;
		emptyTitle: string;
		emptyHint: string;
		noMatchTitle: string;
		noMatchHint: string;
		clearFiltersLabel: string;

		onClearSearch: () => void;
		onClearFilters: () => void;
		children: Snippet;
	}

	let {
		error = null,
		searchQuery,
		filteredCount,
		sourceCount,
		totalUnfiltered,
		icon,
		emptyAction,
		discoverHref,
		discoverLabel,
		searchDiscoverHref = discoverHref,
		searchDiscoverLabel = discoverLabel,
		noSearchTitle,
		noSearchHint,
		clearSearchLabel,
		emptyTitle,
		emptyHint,
		noMatchTitle,
		noMatchHint,
		clearFiltersLabel,
		onClearSearch,
		onClearFilters,
		children
	}: Props = $props();
</script>

{#if error}
	<div role="alert" class="alert alert-error">
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class="h-6 w-6 shrink-0 stroke-current"
			fill="none"
			viewBox="0 0 24 24"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
			></path>
		</svg>
		<span>{error}</span>
	</div>
{:else if filteredCount === 0 && searchQuery}
	<!-- Search Empty State -->
	<div class="flex flex-col items-center justify-center py-20 text-center">
		<div class="opacity-50">
			<Search class="mx-auto mb-4 h-16 w-16" />
			<p class="text-2xl font-bold">{noSearchTitle}</p>
			<p class="mt-2">{noSearchHint}</p>
		</div>
		<div class="mt-6 flex gap-3">
			<button class="btn btn-ghost" onclick={onClearSearch}>{clearSearchLabel}</button>
			<a href={searchDiscoverHref} class="btn btn-primary">
				{searchDiscoverLabel}
			</a>
		</div>
	</div>
{:else if sourceCount === 0}
	<!-- Empty State -->
	<div class="flex flex-col items-center justify-center py-20 text-center opacity-50">
		{@render icon()}
		{#if totalUnfiltered === 0}
			<p class="text-2xl font-bold">{emptyTitle}</p>
			<p class="mt-2">{emptyHint}</p>
			{#if emptyAction}
				{@render emptyAction()}
			{:else}
				<a href={discoverHref} class="btn mt-6 btn-primary">{discoverLabel}</a>
			{/if}
		{:else}
			<p class="text-2xl font-bold">{noMatchTitle}</p>
			<p class="mt-2">{noMatchHint}</p>
			<button class="btn mt-6 btn-primary" onclick={onClearFilters}>{clearFiltersLabel}</button>
		{/if}
	</div>
{:else}
	{@render children()}
{/if}

<script lang="ts">
	/**
	 * The sticky toolbar every library list shares: title + count, the search box
	 * (desktop and mobile), the view toggle and the filter drawer button.
	 *
	 * Kind-specific controls — collections, add, browse, monitor, select — arrive
	 * through `actions`, so this component never grows a per-kind branch. The
	 * pages keep owning what those buttons do.
	 */
	import type { Snippet } from 'svelte';
	import { Search, X, LayoutGrid, List, SlidersHorizontal } from '@lucide/svelte';

	interface Props {
		title: string;
		/** Items after filtering — the number on the badge. */
		total: number;
		/** Items before filtering; shows the "x of y" hint when they differ. */
		totalUnfiltered: number;
		/** Pre-formatted "x of y" text (the kind owns the message key). */
		ofTotalLabel: string;
		/** Kind-specific warning next to the title (music: no root folder). */
		notice?: Snippet;

		searchPlaceholder: string;
		clearSearchLabel: string;
		/** Bound two-way: the page filters on it and keeps it in the URL. */
		searchQuery?: string;
		/** Matching / source counts shown beside the search while typing. */
		searchMatches?: number | null;
		searchSource?: number | null;

		viewMode: 'grid' | 'list';
		switchToGridLabel: string;
		switchToListLabel: string;
		onToggleView: () => void;

		activeFilterCount: number;
		filterLabel: string;
		onOpenFilters: () => void;

		/** Kind-specific toolbar buttons, rendered before the standard controls. */
		actions?: Snippet;
	}

	let {
		title,
		total,
		totalUnfiltered,
		ofTotalLabel,
		notice,
		searchPlaceholder,
		clearSearchLabel,
		searchQuery = $bindable(''),
		searchMatches = null,
		searchSource = null,
		viewMode,
		switchToGridLabel,
		switchToListLabel,
		onToggleView,
		activeFilterCount,
		filterLabel,
		onOpenFilters,
		actions
	}: Props = $props();
</script>

<div
	class="sticky top-16 z-30 -mx-4 border-b border-base-200 bg-base-100/80 backdrop-blur-md lg:top-0 lg:mx-0"
>
	<div class="flex h-16 items-center gap-3 px-4 lg:px-8">
		<!-- Left: Title -->
		<div class="flex min-w-0 items-center gap-2 sm:gap-3">
			<h1
				class="min-w-0 truncate bg-linear-to-r from-primary to-secondary bg-clip-text text-xl font-bold text-transparent sm:text-2xl"
			>
				{title}
			</h1>
			<span class="badge shrink-0 badge-ghost badge-sm sm:badge-lg">{total}</span>
			{#if total !== totalUnfiltered}
				<span class="hidden text-sm text-base-content/50 sm:inline">
					{ofTotalLabel}
				</span>
			{/if}
			{#if notice}{@render notice()}{/if}
		</div>

		<!-- Center: Search (desktop) -->
		<div class="hidden flex-1 items-center justify-center gap-2 md:flex">
			<div class="group relative w-full max-w-lg">
				<Search
					class="pointer-events-none absolute top-1/2 left-3.5 z-1 h-4 w-4 -translate-y-1/2 text-base-content/40 transition-colors group-focus-within:text-primary"
				/>
				<input
					type="text"
					placeholder={searchPlaceholder}
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					bind:value={searchQuery}
				/>
				{#if searchQuery}
					<button
						class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
						onclick={() => (searchQuery = '')}
						aria-label={clearSearchLabel}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
			{#if searchQuery && searchMatches !== null && searchSource !== null && searchMatches !== searchSource}
				<span class="shrink-0 text-xs text-base-content/50">
					{searchMatches}/{searchSource}
				</span>
			{/if}
		</div>

		<!-- Right: Quick Actions -->
		<!-- On phones the header holds up to six icon buttons next to the title: tighter padding
		     and gaps keep the title readable (it truncated to "Mo…" with the select-mode Done button). -->
		<div class="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1.5 max-sm:[&_.btn]:px-1.5">
			{#if actions}{@render actions()}{/if}

			<!-- View Toggle -->
			<button
				class="btn btn-ghost btn-sm"
				onclick={onToggleView}
				aria-label={viewMode === 'grid' ? switchToListLabel : switchToGridLabel}
			>
				{#if viewMode === 'grid'}
					<List class="h-4 w-4" />
				{:else}
					<LayoutGrid class="h-4 w-4" />
				{/if}
			</button>

			<!-- Options Drawer Button -->
			<button
				class="btn gap-1.5 btn-sm {activeFilterCount > 0 ? 'btn-primary' : 'btn-ghost'}"
				onclick={onOpenFilters}
				aria-label={filterLabel}
			>
				<SlidersHorizontal class="h-4 w-4" />
				{#if activeFilterCount > 0}
					<span class="badge badge-sm">{activeFilterCount}</span>
				{/if}
			</button>
		</div>
	</div>

	<!-- Search (mobile) -->
	<div class="flex items-center gap-2 border-t border-base-200/50 px-4 py-2 md:hidden">
		<div class="group relative w-full">
			<Search
				class="pointer-events-none absolute top-1/2 left-3.5 z-1 h-4 w-4 -translate-y-1/2 text-base-content/40 transition-colors group-focus-within:text-primary"
			/>
			<input
				type="text"
				placeholder={searchPlaceholder}
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				bind:value={searchQuery}
			/>
			{#if searchQuery}
				<button
					class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
					onclick={() => (searchQuery = '')}
					aria-label={clearSearchLabel}
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
		{#if searchQuery && searchMatches !== null && searchSource !== null && searchMatches !== searchSource}
			<span class="shrink-0 text-xs text-base-content/50">
				{searchMatches}/{searchSource}
			</span>
		{/if}
	</div>
</div>

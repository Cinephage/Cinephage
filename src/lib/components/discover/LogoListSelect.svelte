<script lang="ts">
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface ListItem {
		id: number;
		name: string;
		logoPath: string | null;
	}

	let {
		items,
		selected,
		onToggle,
		searchable = false
	}: {
		items: ListItem[];
		selected: number[];
		onToggle: (id: number) => void;
		searchable?: boolean;
	} = $props();

	let query = $state('');
	const normalizedQuery = $derived(query.trim().toLowerCase());
	const visibleItems = $derived(
		normalizedQuery
			? items.filter((item) => item.name.toLowerCase().includes(normalizedQuery))
			: items
	);
</script>

<div class="space-y-2">
	{#if searchable}
		<input
			type="search"
			placeholder={m.discover_filter_searchList()}
			class="input-bordered input w-full bg-base-200 transition-colors input-sm focus:bg-base-100"
			bind:value={query}
		/>
	{/if}

	{#if visibleItems.length === 0}
		<p class="py-4 text-center text-sm text-base-content/50">
			{items.length === 0 ? m.discover_noResultsFound() : m.discover_filter_noMatches()}
		</p>
	{:else}
		<ul class="max-h-72 space-y-1 overflow-y-auto pr-1">
			{#each visibleItems as item (item.id)}
				<li>
					<button
						type="button"
						class="flex w-full items-center gap-3 rounded-lg border px-2.5 py-1.5 text-left transition-colors duration-150 {selected.includes(
							item.id
						)
							? 'border-primary bg-primary/10'
							: 'border-transparent bg-base-200/50 hover:bg-base-200'}"
						onclick={() => onToggle(item.id)}
						title={item.name}
					>
						<span class="flex h-8 w-12 shrink-0 items-center justify-center">
							{#if item.logoPath}
								<TmdbImage
									path={item.logoPath}
									size="w92"
									fit="contain"
									alt={item.name}
									class="h-8 w-12"
								/>
							{:else}
								<span class="truncate text-xs font-bold text-base-content/50">{item.name}</span>
							{/if}
						</span>
						<span class="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
						{#if selected.includes(item.id)}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="3"
								class="h-4 w-4 shrink-0 text-primary"
								aria-hidden="true"
							>
								<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
							</svg>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

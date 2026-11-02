<script lang="ts">
	import { Search, Loader2, X } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { searchTmdb } from '#lib/api/discover.js';

	export interface TmdbSearchResult {
		id: number;
		poster_path: string | null;
		overview?: string | null;
		title?: string;
		name?: string;
		release_date?: string;
		first_air_date?: string;
		original_language?: string;
	}

	interface Props {
		mediaType: 'movie' | 'tv';
		onItemSelected: (item: TmdbSearchResult) => void;
	}

	let { mediaType, onItemSelected }: Props = $props();

	let query = $state('');
	let results = $state<TmdbSearchResult[]>([]);
	let isSearching = $state(false);
	let hoveredIndex = $state(-1);
	let debounceTimer = $state<ReturnType<typeof setTimeout> | null>(null);
	let containerEl = $state<HTMLElement | null>(null);

	async function search(val: string) {
		if (!val.trim()) {
			results = [];
			return;
		}

		isSearching = true;
		try {
			const data = (await searchTmdb({ query: val.trim(), type: mediaType })) as {
				results?: TmdbSearchResult[];
			};
			results = (data.results ?? []).slice(0, 10);
		} catch {
			results = [];
		} finally {
			isSearching = false;
		}
	}

	function onInput(value: string) {
		query = value;
		hoveredIndex = -1;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (!value.trim()) {
			results = [];
			return;
		}
		debounceTimer = setTimeout(() => search(value), 350);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (results.length === 0) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			hoveredIndex = Math.min(hoveredIndex + 1, results.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			hoveredIndex = Math.max(hoveredIndex - 1, 0);
		} else if (e.key === 'Enter' && hoveredIndex >= 0) {
			e.preventDefault();
			selectItem(results[hoveredIndex]);
		} else if (e.key === 'Escape') {
			results = [];
			hoveredIndex = -1;
		}
	}

	function selectItem(item: TmdbSearchResult) {
		onItemSelected(item);
		query = '';
		results = [];
		hoveredIndex = -1;
	}

	function clear() {
		query = '';
		results = [];
		hoveredIndex = -1;
		if (debounceTimer) clearTimeout(debounceTimer);
	}

	function formatYear(item: TmdbSearchResult): string {
		const date = item.release_date || item.first_air_date;
		return date ? new Date(date).getFullYear().toString() : '';
	}

	const dropdownOpen = $derived(results.length > 0 || isSearching);

	// Close dropdown on outside click
	$effect(() => {
		if (!dropdownOpen) return;
		function handleClick(e: MouseEvent) {
			if (containerEl && !containerEl.contains(e.target as Node)) {
				results = [];
				hoveredIndex = -1;
			}
		}
		document.addEventListener('click', handleClick);
		return () => document.removeEventListener('click', handleClick);
	});
</script>

<div class="relative w-full" bind:this={containerEl}>
	<label class="input-bordered input flex items-center gap-2">
		<Search class="h-4 w-4 shrink-0 text-base-content/50" />
		<input
			type="text"
			class="grow bg-transparent outline-none"
			placeholder={mediaType === 'movie' ? 'Search movies...' : 'Search TV shows...'}
			value={query}
			oninput={(e) => onInput(e.currentTarget.value)}
			onkeydown={handleKeydown}
		/>
		{#if query}
			<button class="btn btn-circle btn-ghost btn-xs" onclick={clear} aria-label="Clear search">
				<X class="h-3 w-3" />
			</button>
		{/if}
	</label>

	{#if dropdownOpen}
		<div
			class="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-base-300 bg-base-100 shadow-lg"
		>
			{#if isSearching}
				<div class="flex items-center justify-center gap-2 p-4 text-sm text-base-content/60">
					<Loader2 class="h-4 w-4 animate-spin" />
					<span>{m.common_searching()}...</span>
				</div>
			{:else}
				{#each results as item, i (item.id)}
					<button
						class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-base-200 {hoveredIndex ===
						i
							? 'bg-base-200'
							: ''}"
						onclick={() => selectItem(item)}
						onmouseenter={() => (hoveredIndex = i)}
						role="option"
						aria-selected={hoveredIndex === i}
					>
						{#if item.poster_path}
							<img
								src={`https://image.tmdb.org/t/p/w45${item.poster_path}`}
								alt={item.title || item.name || ''}
								class="h-16 w-10 shrink-0 rounded object-cover"
								loading="lazy"
							/>
						{:else}
							<div class="flex h-16 w-10 shrink-0 items-center justify-center rounded bg-base-300">
								<span class="text-xs text-base-content/20">N/A</span>
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium">
								{item.title || item.name || ''}
							</div>
							<div class="flex items-center gap-2 text-xs text-base-content/50">
								{#if formatYear(item)}
									<span>{formatYear(item)}</span>
								{/if}
								{#if item.original_language}
									<span class="badge badge-outline badge-xs"
										>{item.original_language.toUpperCase()}</span
									>
								{/if}
							</div>
						</div>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

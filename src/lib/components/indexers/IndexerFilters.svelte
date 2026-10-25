<script lang="ts">
	import { Search } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { IndexerFilters } from '#lib/types/indexer.js';

	interface Props {
		filters: IndexerFilters;
		onFilterChange: (filters: IndexerFilters) => void;
	}

	let { filters, onFilterChange }: Props = $props();

	function updateFilter<K extends keyof IndexerFilters>(key: K, value: IndexerFilters[K]) {
		onFilterChange({ ...filters, [key]: value });
	}
</script>

<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
	<!-- Search -->
	<div class="form-control relative w-full sm:w-56">
		<Search
			class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
		/>
		<input
			type="text"
			placeholder={m.settings_indexers_searchPlaceholder()}
			class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
			value={filters.search}
			oninput={(e) => updateFilter('search', e.currentTarget.value)}
		/>
	</div>

	<!-- Protocol Filter -->
	<div class="join w-full sm:w-auto">
		<button
			class="btn join-item flex-1 btn-sm sm:flex-none"
			class:btn-active={filters.protocol === 'all'}
			onclick={() => updateFilter('protocol', 'all')}
		>
			{m.common_all()}
		</button>
		<button
			class="btn join-item flex-1 btn-sm sm:flex-none"
			class:btn-active={filters.protocol === 'torrent'}
			onclick={() => updateFilter('protocol', 'torrent')}
		>
			{m.settings_indexers_protocolTorrent()}
		</button>
		<button
			class="btn join-item flex-1 btn-sm sm:flex-none"
			class:btn-active={filters.protocol === 'usenet'}
			onclick={() => updateFilter('protocol', 'usenet')}
		>
			{m.settings_indexers_protocolUsenet()}
		</button>
	</div>

	<!-- Status Filter -->
	<div class="join w-full sm:w-auto">
		<button
			class="btn join-item flex-1 btn-sm sm:flex-none"
			class:btn-active={filters.status === 'all'}
			onclick={() => updateFilter('status', 'all')}
		>
			{m.common_all()}
		</button>
		<button
			class="btn join-item flex-1 btn-sm sm:flex-none"
			class:btn-active={filters.status === 'enabled'}
			onclick={() => updateFilter('status', 'enabled')}
		>
			{m.common_enabled()}
		</button>
		<button
			class="btn join-item flex-1 btn-sm sm:flex-none"
			class:btn-active={filters.status === 'disabled'}
			onclick={() => updateFilter('status', 'disabled')}
		>
			{m.common_disabled()}
		</button>
	</div>
</div>

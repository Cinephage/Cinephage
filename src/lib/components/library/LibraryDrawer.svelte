<script lang="ts">
	import Drawer from '#lib/components/ui/Drawer.svelte';
	import { ArrowUpDown, Filter, X } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface SortOption {
		value: string;
		label: string;
	}

	interface FilterOption {
		key: string;
		label: string;
		options: { value: string; label: string }[];
	}

	interface Props {
		isOpen: boolean;
		sortOptions: SortOption[];
		filterOptions: FilterOption[];
		currentSort: string;
		currentFilters: Record<string, string>;
		hiddenActiveFilterKeys?: string[];
		onClose: () => void;
		onSortChange: (sort: string) => void;
		onFilterChange: (key: string, value: string) => void;
		onClearFilters: () => void;
	}

	let {
		isOpen,
		sortOptions,
		filterOptions,
		currentSort,
		currentFilters = {},
		hiddenActiveFilterKeys = [],
		onClose,
		onSortChange,
		onFilterChange,
		onClearFilters
	}: Props = $props();

	const visibleActiveFilterEntries = $derived(
		Object.entries(currentFilters).filter(
			([key, value]) => !hiddenActiveFilterKeys.includes(key) && value !== 'all'
		)
	);

	const hasActiveFilters = $derived(visibleActiveFilterEntries.length > 0);
</script>

<Drawer {isOpen} title={m.library_drawer_title()} {onClose}>
	<div class="space-y-6">
		<!-- Active Filters Summary -->
		{#if hasActiveFilters}
			<div>
				<div class="mb-2 flex items-center justify-between">
					<span class="text-sm font-medium text-base-content/60">
						{m.action_filter()}
					</span>
					<button class="btn btn-ghost text-error btn-xs" onclick={onClearFilters}>
						<X class="h-3 w-3" />
						{m.library_controls_clearAllFilters()}
					</button>
				</div>
				<div class="flex flex-wrap gap-1.5">
					{#each visibleActiveFilterEntries as [key, value] (key)}
						{@const option = filterOptions
							.find((f) => f.key === key)
							?.options.find((o) => o.value === value)}
						{#if option}
							<span class="badge badge-sm badge-primary">{option.label}</span>
						{/if}
					{/each}
				</div>
			</div>
		{/if}

		<!-- Sort -->
		<div>
			<h3 class="mb-2 flex items-center gap-2 text-sm font-medium text-base-content/60">
				<ArrowUpDown class="h-4 w-4" />
				{m.library_drawer_sortBy()}
			</h3>
			<div class="space-y-0.5">
				{#each sortOptions as option (option.value)}
					<button
						class="btn w-full justify-start btn-sm {currentSort === option.value
							? 'btn-primary'
							: 'btn-ghost'}"
						onclick={() => {
							onSortChange(option.value);
						}}
					>
						{option.label}
					</button>
				{/each}
			</div>
		</div>

		<!-- Filters -->
		{#if filterOptions.length > 0}
			<div>
				<h3 class="mb-2 flex items-center gap-2 text-sm font-medium text-base-content/60">
					<Filter class="h-4 w-4" />
					{m.action_filter()}
				</h3>
				<div class="space-y-3">
					{#each filterOptions as filter (filter.key)}
						<div>
							<label class="label" for="drawer-filter-{filter.key}">
								<span class="label-text font-medium">{filter.label}</span>
							</label>
							<select
								id="drawer-filter-{filter.key}"
								class="select-bordered select w-full select-sm"
								value={currentFilters[filter.key] || 'all'}
								onchange={(e) => onFilterChange(filter.key, e.currentTarget.value)}
							>
								{#each filter.options as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</Drawer>

<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';

	type SortField = 'score' | 'seeders' | 'size' | 'age';

	interface Props {
		filterQuery: string;
		showRejected: boolean;
		sortBy: SortField;
		sortDir: 'asc' | 'desc';
		onFilterChange: (value: string) => void;
		onShowRejectedChange: (value: boolean) => void;
		onSortByChange: (value: SortField) => void;
		onSortDirToggle: () => void;
	}

	let {
		filterQuery,
		showRejected,
		sortBy,
		sortDir,
		onFilterChange,
		onShowRejectedChange,
		onSortByChange,
		onSortDirToggle
	}: Props = $props();
</script>

<div class="mb-1 flex flex-wrap items-center gap-2 sm:mb-3 sm:gap-4">
	<div class="form-control w-full sm:w-auto">
		<input
			type="text"
			placeholder={m.search_placeholder_filterResults()}
			class="input w-full rounded-full border-base-content/20 bg-base-200/60 px-4 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none sm:w-48"
			value={filterQuery}
			oninput={(e) => onFilterChange(e.currentTarget.value)}
		/>
	</div>

	<label class="label cursor-pointer gap-2">
		<input
			type="checkbox"
			class="checkbox checkbox-sm checkbox-primary"
			checked={showRejected}
			onchange={(e) => onShowRejectedChange(e.currentTarget.checked)}
		/>
		<span class="label-text text-xs sm:text-sm">{m.search_label_showRejected()}</span>
	</label>

	<div class="ml-auto flex items-center gap-1 sm:hidden">
		<span class="text-xs text-base-content/60">{m.search_label_sort()}</span>
		<select
			class="select-bordered select select-xs"
			value={sortBy}
			onchange={(e) => onSortByChange(e.currentTarget.value as SortField)}
		>
			<option value="score">{m.search_sort_score()}</option>
			<option value="seeders">{m.search_sort_seeders()}</option>
			<option value="size">{m.search_sort_size()}</option>
			<option value="age">Age</option>
		</select>
		<button class="btn btn-ghost btn-xs" onclick={onSortDirToggle}>
			{sortDir === 'desc' ? '↓' : '↑'}
		</button>
	</div>

	<div class="ml-auto hidden items-center gap-2 sm:flex">
		<span class="text-xs text-base-content/60">{m.search_label_sort()}</span>
		<div class="join">
			<button
				class="btn join-item btn-xs {sortBy === 'score'
					? 'btn-primary'
					: 'border border-base-content/20 btn-ghost'}"
				onclick={() => onSortByChange('score')}
			>
				{m.search_sort_score()}
			</button>
			<button
				class="btn join-item btn-xs {sortBy === 'seeders'
					? 'btn-primary'
					: 'border border-base-content/20 btn-ghost'}"
				onclick={() => onSortByChange('seeders')}
			>
				{m.search_sort_seeders()}
			</button>
			<button
				class="btn join-item btn-xs {sortBy === 'size'
					? 'btn-primary'
					: 'border border-base-content/20 btn-ghost'}"
				onclick={() => onSortByChange('size')}
			>
				{m.search_sort_size()}
			</button>
			<button
				class="btn join-item btn-xs {sortBy === 'age'
					? 'btn-primary'
					: 'border border-base-content/20 btn-ghost'}"
				onclick={() => onSortByChange('age')}
			>
				Age
			</button>
		</div>
		<button
			class="btn btn-ghost btn-xs"
			onclick={onSortDirToggle}
			title={sortDir === 'desc'
				? 'Descending - click for ascending'
				: 'Ascending - click for descending'}
		>
			{sortDir === 'desc' ? '↓' : '↑'}
		</button>
	</div>
</div>

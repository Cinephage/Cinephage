<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { ActivityFilters, FilterOptions } from '#lib/types/activity.js';
	import {
		Filter,
		X,
		Calendar,
		HardDrive,
		Globe,
		Users,
		Monitor,
		ArrowUpCircle,
		Search,
		ChevronDown,
		ChevronUp
	} from '@lucide/svelte';
	import { toDateString } from '#lib/utils/format.js';

	interface Props {
		filters: ActivityFilters;
		filterOptions: FilterOptions;
		statusContext?: 'active' | 'history';
		onFiltersChange: (filters: ActivityFilters) => void;
		onClearFilters: () => void;
		showActiveFilters?: boolean;
		showHistoryControls?: boolean;
		activeFiltersContent?: Snippet;
		historyControlsContent?: Snippet;
	}

	let {
		filters,
		filterOptions,
		statusContext = 'history',
		onFiltersChange,
		onClearFilters,
		showActiveFilters = false,
		showHistoryControls = false,
		activeFiltersContent,
		historyControlsContent
	}: Props = $props();

	let isExpanded = $state(false);
	let hasActiveFilters = $derived(
		filters.status !== 'all' ||
			filters.mediaType !== 'all' ||
			filters.protocol !== 'all' ||
			filters.indexer ||
			filters.releaseGroup ||
			filters.resolution ||
			filters.isUpgrade ||
			filters.includeNoResults ||
			filters.startDate ||
			filters.endDate ||
			filters.search
	);

	// ── Debounced text inputs ────────────────────────────────────────────
	// Search and releaseGroup are text inputs that fire on every keystroke.
	// Debounce them so the expensive goto() + server re-fetch only fires
	// after the user stops typing for 300ms.
	const DEBOUNCE_MS = 300;
	let searchValue = $state('');
	let releaseGroupValue = $state('');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let releaseGroupTimer: ReturnType<typeof setTimeout> | undefined;

	// Track the last external filter value so we only reset local state
	// when the parent actually changes the filter (tab switch, clear, etc.),
	// not when our own debounced callback round-trips through props.
	let lastExternalSearch = $state('');
	let lastExternalReleaseGroup = $state('');

	$effect(() => {
		const incoming = filters.search || '';
		if (incoming !== lastExternalSearch) {
			lastExternalSearch = incoming;
			searchValue = incoming;
		}
	});
	$effect(() => {
		const incoming = filters.releaseGroup || '';
		if (incoming !== lastExternalReleaseGroup) {
			lastExternalReleaseGroup = incoming;
			releaseGroupValue = incoming;
		}
	});

	function onSearchInput(value: string) {
		searchValue = value;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			onFiltersChange({ ...filters, search: value || undefined });
		}, DEBOUNCE_MS);
	}

	function onReleaseGroupInput(value: string) {
		releaseGroupValue = value;
		clearTimeout(releaseGroupTimer);
		releaseGroupTimer = setTimeout(() => {
			onFiltersChange({ ...filters, releaseGroup: value || undefined });
		}, DEBOUNCE_MS);
	}

	onDestroy(() => {
		clearTimeout(searchTimer);
		clearTimeout(releaseGroupTimer);
	});

	// Quick date presets
	const datePresets = [
		{ label: m.activity_filters_today(), days: 0 },
		{ label: m.activity_filters_last7Days(), days: 7 },
		{ label: m.activity_filters_last30Days(), days: 30 },
		{ label: m.activity_filters_last90Days(), days: 90 }
	];

	const DAY_IN_MS = 24 * 60 * 60 * 1000;

	function toIsoDate(epochMs: number): string {
		return toDateString(new Date(epochMs));
	}

	function getDatePresetRange(days: number): { startDate: string; endDate: string } {
		const now = Date.now();

		return {
			startDate: toIsoDate(now - days * DAY_IN_MS),
			endDate: toIsoDate(now)
		};
	}

	function applyDatePreset(days: number) {
		const range = getDatePresetRange(days);
		onFiltersChange({
			...filters,
			startDate: range.startDate,
			endDate: range.endDate
		});
	}

	function isDatePresetActive(days: number): boolean {
		if (!filters.startDate || !filters.endDate) return false;
		const range = getDatePresetRange(days);
		return filters.startDate === range.startDate && filters.endDate === range.endDate;
	}

	function clearDateRange() {
		onFiltersChange({
			...filters,
			startDate: undefined,
			endDate: undefined
		});
	}

	function updateFilter(key: keyof ActivityFilters, value: unknown) {
		onFiltersChange({
			...filters,
			[key]: value
		});
	}

	const activeStatusOptions = [
		{ value: 'all', label: m.common_all() },
		{ value: 'downloading', label: m.status_downloading() },
		{ value: 'seeding', label: m.status_seeding() },
		{ value: 'paused', label: m.status_paused() }
	] as const;

	const historyStatusOptions = [
		{ value: 'all', label: m.common_all(), color: '' },
		{ value: 'success', label: m.status_success(), color: 'badge-success' },
		{ value: 'failed', label: m.status_failed(), color: 'badge-error' },
		{ value: 'search_error', label: m.status_searchError(), color: 'badge-warning' },
		{ value: 'removed', label: m.status_removed(), color: 'badge-ghost' },
		{ value: 'rejected', label: m.status_rejected(), color: 'badge-warning' },
		{ value: 'no_results', label: m.status_noResults(), color: 'badge-ghost' }
	] as const;

	const statusOptions = $derived(
		statusContext === 'active' ? activeStatusOptions : historyStatusOptions
	);

	// Protocol options
	const protocolOptions = [
		{ value: 'all', label: m.common_all() },
		{ value: 'torrent', label: m.activity_filters_torrent() },
		{ value: 'usenet', label: m.activity_filters_usenet() },
		{ value: 'streaming', label: m.activity_filters_streaming() }
	];

	// Resolution options
	const resolutionOptions = ['4K', '2160p', '1080p', '720p', '480p', 'SD'];
</script>

<div class="rounded-lg border border-base-content/12 bg-base-100 p-4 shadow-sm">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex flex-wrap items-center gap-2">
			<div class="form-control min-w-50 flex-1 sm:max-w-64">
				<div class="group relative">
					<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
						<Search
							class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
						/>
					</div>
					<input
						type="text"
						placeholder={m.activity_filters_searchPlaceholder()}
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						value={searchValue}
						oninput={(e) => onSearchInput(e.currentTarget.value)}
					/>
				</div>
			</div>

			<span class="h-4 w-px bg-base-content/15"></span>

			<div class="join">
				<button
					class="btn join-item btn-sm {filters.mediaType === 'all' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => updateFilter('mediaType', 'all')}
				>
					{m.common_all()}
				</button>
				<button
					class="btn join-item btn-sm {filters.mediaType === 'movie' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => updateFilter('mediaType', 'movie')}
				>
					{m.common_movies()}
				</button>
				<button
					class="btn join-item btn-sm {filters.mediaType === 'tv' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => updateFilter('mediaType', 'tv')}
				>
					{m.common_tvShows()}
				</button>
			</div>

			{#if statusContext === 'history'}
				<span class="h-4 w-px bg-base-content/15"></span>

				<div class="join">
					{#each datePresets as preset (preset.label)}
						<button
							class="btn join-item btn-sm {isDatePresetActive(preset.days)
								? 'btn-primary'
								: 'btn-ghost'}"
							onclick={() => applyDatePreset(preset.days)}
							title="Last {preset.days === 0 ? '24 hours' : preset.days + ' days'}"
							aria-pressed={isDatePresetActive(preset.days)}
						>
							{preset.label}
						</button>
					{/each}
					{#if filters.startDate || filters.endDate}
						<button class="btn join-item btn-ghost btn-error btn-sm" onclick={clearDateRange}>
							<X class="h-3 w-3" />
						</button>
					{/if}
				</div>
			{/if}
		</div>

		<div class="flex items-center gap-2">
			{#if hasActiveFilters}
				<button class="btn btn-ghost btn-xs" onclick={onClearFilters}>
					<X class="h-3 w-3" />
					{m.action_clear()}
				</button>
			{/if}
			<button
				class="btn gap-1.5 btn-ghost btn-sm"
				onclick={() => (isExpanded = !isExpanded)}
				aria-label={isExpanded ? 'Collapse filters' : 'Expand filters'}
			>
				<Filter class="h-4 w-4 text-base-content/50" />
				{#if isExpanded}
					<span>{m.activity_filters_lessFilters()}</span>
					<ChevronUp class="h-4 w-4" />
				{:else}
					<span>{m.activity_filters_moreFilters()}</span>
					<ChevronDown class="h-4 w-4" />
				{/if}
			</button>
		</div>
	</div>

	{#if isExpanded}
		<div class="mt-3 grid gap-4 border-t border-base-content/10 pt-4 md:grid-cols-2 lg:grid-cols-3">
			<!-- Status -->
			<div class="space-y-2">
				<label class="flex items-center gap-2 text-sm font-medium">
					<Monitor class="h-4 w-4" />
					{m.common_status()}
				</label>
				<select
					class="select-bordered select w-full select-sm"
					value={filters.status}
					onchange={(e) => updateFilter('status', e.currentTarget.value)}
				>
					{#each statusOptions as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</div>

			<!-- Protocol -->
			<div class="space-y-2">
				<label class="flex items-center gap-2 text-sm font-medium">
					<Globe class="h-4 w-4" />
					{m.activity_detail_protocol()}
				</label>
				<select
					class="select-bordered select w-full select-sm"
					value={filters.protocol || 'all'}
					onchange={(e) => updateFilter('protocol', e.currentTarget.value)}
				>
					{#each protocolOptions as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</div>

			<!-- Indexer -->
			<div class="space-y-2">
				<label class="flex items-center gap-2 text-sm font-medium">
					<HardDrive class="h-4 w-4" />
					{m.activity_detail_indexer()}
				</label>
				<select
					class="select-bordered select w-full select-sm"
					value={filters.indexer || ''}
					onchange={(e) => updateFilter('indexer', e.currentTarget.value || undefined)}
				>
					<option value="">{m.activity_filters_allIndexers()}</option>
					{#each filterOptions.indexers as indexer (indexer.id)}
						<option value={indexer.name}>{indexer.name}</option>
					{/each}
				</select>
			</div>

			<!-- Download Client -->
			<div class="space-y-2">
				<label class="flex items-center gap-2 text-sm font-medium">
					<Monitor class="h-4 w-4" />
					{m.activity_filters_downloadClient()}
				</label>
				<select
					class="select-bordered select w-full select-sm"
					value={filters.downloadClientId || ''}
					onchange={(e) => updateFilter('downloadClientId', e.currentTarget.value || undefined)}
				>
					<option value="">{m.activity_filters_allClients()}</option>
					{#each filterOptions.downloadClients as client (client.id)}
						<option value={client.id}>{client.name}</option>
					{/each}
				</select>
			</div>

			<!-- Resolution -->
			<div class="space-y-2">
				<label class="flex items-center gap-2 text-sm font-medium">
					<HardDrive class="h-4 w-4" />
					{m.activity_filters_resolution()}
				</label>
				<select
					class="select-bordered select w-full select-sm"
					value={filters.resolution || ''}
					onchange={(e) => updateFilter('resolution', e.currentTarget.value || undefined)}
				>
					<option value="">{m.activity_filters_allResolutions()}</option>
					{#each resolutionOptions as res (res)}
						<option value={res}>{res}</option>
					{/each}
				</select>
			</div>

			<!-- Release Group -->
			<div class="space-y-2">
				<label class="flex items-center gap-2 text-sm font-medium">
					<Users class="h-4 w-4" />
					{m.activity_detail_releaseGroup()}
				</label>
				<input
					type="text"
					placeholder={m.activity_filters_filterByGroup()}
					class="input-bordered input w-full input-sm"
					value={releaseGroupValue}
					oninput={(e) => onReleaseGroupInput(e.currentTarget.value)}
				/>
			</div>

			<!-- Date Range -->
			<div class="space-y-2 md:col-span-2 lg:col-span-3">
				<label class="flex items-center gap-2 text-sm font-medium">
					<Calendar class="h-4 w-4" />
					{m.activity_filters_dateRange()}
				</label>
				<div class="flex flex-wrap items-center gap-2">
					<input
						type="date"
						class="input-bordered input input-sm"
						value={filters.startDate || ''}
						onchange={(e) => updateFilter('startDate', e.currentTarget.value || undefined)}
					/>
					<span class="text-base-content/50">{m.activity_activeFilters_toSeparator()}</span>
					<input
						type="date"
						class="input-bordered input input-sm"
						value={filters.endDate || ''}
						onchange={(e) => updateFilter('endDate', e.currentTarget.value || undefined)}
					/>
					{#if filters.startDate || filters.endDate}
						<button class="btn btn-ghost btn-error btn-sm" onclick={clearDateRange}>
							<X class="h-4 w-4" />
						</button>
					{/if}
				</div>
			</div>

			<!-- Is Upgrade Toggle -->
			<div class="space-y-2">
				<label class="flex items-center gap-2 text-sm font-medium">
					<ArrowUpCircle class="h-4 w-4" />
					{m.activity_filters_upgradesOnly()}
				</label>
				<div class="form-control">
					<label class="label cursor-pointer justify-start gap-2">
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							checked={filters.isUpgrade || false}
							onchange={(e) => updateFilter('isUpgrade', e.currentTarget.checked || undefined)}
						/>
						<span class="label-text text-sm">{m.activity_filters_showOnlyUpgrades()}</span>
					</label>
				</div>
			</div>

			{#if statusContext === 'history'}
				<!-- Include No Results Toggle -->
				<div class="space-y-2">
					<label class="flex items-center gap-2 text-sm font-medium">
						<Search class="h-4 w-4" />
						{m.activity_filters_includeNoResults()}
					</label>
					<div class="form-control">
						<label class="label cursor-pointer justify-start gap-2">
							<input
								type="checkbox"
								class="toggle toggle-primary toggle-sm"
								checked={filters.includeNoResults || false}
								onchange={(e) =>
									updateFilter('includeNoResults', e.currentTarget.checked || undefined)}
							/>
							<span class="label-text text-sm">{m.activity_filters_showNoReleases()}</span>
						</label>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	{#if showActiveFilters && activeFiltersContent}
		<div class="mt-3 border-t border-base-content/10 pt-3">
			{@render activeFiltersContent()}
		</div>
	{/if}

	{#if showHistoryControls && historyControlsContent}
		<div class="mt-3">
			{@render historyControlsContent()}
		</div>
	{/if}
</div>

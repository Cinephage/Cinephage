<script lang="ts">
	import KeywordSelector from '#lib/components/smartlists/KeywordSelector.svelte';
	import LogoListSelect from './LogoListSelect.svelte';
	import { ChevronDown } from '@lucide/svelte';
	import type { TmdbNetwork, WatchProvider } from '#lib/types/tmdb.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		type: string;
		sortBy: string;
		selectedProviders: number[];
		providers: WatchProvider[];
		networks: TmdbNetwork[];
		selectedNetworks: number[];
		genres: { id: number; name: string }[];
		selectedGenres: number[];
		selectedLanguage: string;
		minYear: string;
		maxYear: string;
		minRating: number;
		certifications: { certification: string; meaning: string; order: number }[];
		selectedCertification: string;
		selectedKeywords: Array<{ id: number; name: string; exclude: boolean }>;
		selectedExcludedKeywords: Array<{ id: number; name: string; exclude: boolean }>;
		languages: { code: string; name: string }[];
		onKeywordAdd: (keyword: { id: number; name: string }, exclude: boolean) => void;
		onKeywordRemove: (keywordId: number, exclude: boolean) => void;
		onSortChange: (sort: string) => void;
		onProviderToggle: (id: number) => void;
		onNetworkToggle: (id: number) => void;
		onGenreToggle: (id: number) => void;
		onLanguageChange: (language: string) => void;
		onYearChange: (min: string, max: string) => void;
		onRatingChange: (rating: number) => void;
		onCertificationChange: (cert: string) => void;
	}

	let {
		type,
		sortBy,
		selectedProviders,
		providers,
		networks = [],
		selectedNetworks = [],
		genres,
		selectedGenres,
		selectedLanguage,
		minYear,
		maxYear,
		minRating,
		certifications,
		selectedCertification,
		selectedKeywords = [],
		selectedExcludedKeywords = [],
		languages = [],
		onKeywordAdd,
		onKeywordRemove,
		onSortChange,
		onProviderToggle,
		onNetworkToggle,
		onGenreToggle,
		onLanguageChange,
		onYearChange,
		onRatingChange,
		onCertificationChange
	}: Props = $props();

	let languageOptions = $derived([{ code: '', name: 'All Languages' }, ...languages]);
	let providerItems = $derived(
		providers.map((p) => ({ id: p.provider_id, name: p.provider_name, logoPath: p.logo_path }))
	);
	let networkItems = $derived(
		networks.map((n) => ({ id: n.id, name: n.name, logoPath: n.logo_path }))
	);
	// The drawer remounts the panel on every open, so seeding from the current
	// selections expands exactly the sections that already have something set.
	// Capturing the initial value is the point, hence the ignore comments.
	// svelte-ignore state_referenced_locally
	let networksOpen = $state(selectedNetworks.length > 0);
	// svelte-ignore state_referenced_locally
	let providersOpen = $state(selectedProviders.length > 0);
</script>

<div class="space-y-8">
	<!-- Sort -->
	<div class="form-control">
		<label
			for="sort-by"
			class="label text-sm font-bold tracking-wide text-base-content/70 uppercase"
			>{m.discover_filter_sortBy()}</label
		>
		<select
			id="sort-by"
			class="select-bordered select w-full bg-base-200 transition-colors focus:bg-base-100"
			value={sortBy}
			onchange={(e) => onSortChange(e.currentTarget.value)}
		>
			<option value="popularity.desc">{m.discover_sort_mostPopular()}</option>
			<option value="vote_average.desc">{m.discover_sort_highestRated()}</option>
			<option value="primary_release_date.desc">{m.discover_sort_newestReleases()}</option>
			{#if type !== 'tv'}
				<!-- TV has no revenue sort on TMDB (it is remapped to popularity) -->
				<option value="revenue.desc">{m.discover_sort_highestRevenue()}</option>
			{/if}
		</select>
	</div>

	<!-- Original Language -->
	<div class="form-control">
		<label
			for="original-language"
			class="label text-sm font-bold tracking-wide text-base-content/70 uppercase"
			>{m.discover_filter_originalLanguage()}</label
		>
		<select
			id="original-language"
			class="select-bordered select w-full bg-base-200 transition-colors focus:bg-base-100"
			value={selectedLanguage}
			onchange={(e) => onLanguageChange(e.currentTarget.value)}
		>
			{#each languageOptions as language (language.code)}
				<option value={language.code}>{language.name}</option>
			{/each}
		</select>
	</div>

	<!-- Release Year -->
	<div class="form-control">
		<span class="label text-sm font-bold tracking-wide text-base-content/70 uppercase"
			>{m.discover_filter_releaseYear()}</span
		>
		<div class="flex items-center gap-2">
			<input
				type="number"
				placeholder="1900"
				class="input-bordered input w-full min-w-0 bg-base-200 transition-colors focus:bg-base-100"
				value={minYear}
				onchange={(e) => onYearChange(e.currentTarget.value, maxYear)}
			/>
			<span class="font-bold text-base-content/50">-</span>
			<input
				type="number"
				placeholder={new Date().getFullYear().toString()}
				class="input-bordered input w-full min-w-0 bg-base-200 transition-colors focus:bg-base-100"
				value={maxYear}
				onchange={(e) => onYearChange(minYear, e.currentTarget.value)}
			/>
		</div>
	</div>

	<!-- Minimum Rating -->
	<div class="form-control">
		<label
			for="min-rating"
			class="label text-sm font-bold tracking-wide text-base-content/70 uppercase"
		>
			<span>{m.discover_filter_minRating()}</span>
			<span class="badge font-bold badge-primary">{minRating}</span>
		</label>
		<input
			type="range"
			min="0"
			max="10"
			step="0.5"
			value={minRating}
			id="min-rating"
			class="range range-primary range-sm"
			onchange={(e) => onRatingChange(parseFloat(e.currentTarget.value))}
		/>
		<div class="mt-2 flex w-full justify-between px-1 text-xs font-medium text-base-content/50">
			<span>0</span>
			<span>5</span>
			<span>10</span>
		</div>
	</div>

	<!-- Content Rating -->
	{#if certifications.length > 0 && type !== 'tv'}
		<div class="form-control">
			<span class="label text-sm font-bold tracking-wide text-base-content/70 uppercase">
				<span>{m.discover_filter_contentRating()}</span>
				{#if selectedCertification}
					<button
						class="badge cursor-pointer badge-ghost badge-sm"
						onclick={() => onCertificationChange('')}
					>
						&times;
					</button>
				{/if}
			</span>
			<div class="flex flex-wrap gap-2">
				{#each certifications as cert (cert.certification)}
					<button
						class="btn btn-sm {selectedCertification === cert.certification
							? 'btn-primary'
							: 'border-base-300 btn-outline hover:btn-primary'}"
						onclick={() =>
							onCertificationChange(
								selectedCertification === cert.certification ? '' : cert.certification
							)}
						title={cert.meaning}
					>
						{cert.certification}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Genres -->
	<div class="form-control">
		<span class="label text-sm font-bold tracking-wide text-base-content/70 uppercase">
			<span>{m.common_genres()}</span>
			{#if selectedGenres.length > 0}
				<span class="badge badge-sm badge-primary">{selectedGenres.length}</span>
			{/if}
		</span>
		<div class="flex flex-wrap gap-2">
			{#each genres as genre (genre.id)}
				<button
					class="btn btn-sm {selectedGenres.includes(genre.id)
						? 'btn-primary'
						: 'border-base-300 btn-outline hover:btn-primary'}"
					onclick={() => onGenreToggle(genre.id)}
				>
					{genre.name}
				</button>
			{/each}
		</div>
	</div>

	<!-- Keywords -->
	<div class="form-control">
		<span class="label text-sm font-bold tracking-wide text-base-content/70 uppercase">
			<span>Keywords</span>
			{#if selectedKeywords.length + selectedExcludedKeywords.length > 0}
				<span class="badge badge-sm badge-primary"
					>{selectedKeywords.length + selectedExcludedKeywords.length}</span
				>
			{/if}
		</span>
		<KeywordSelector
			selectedKeywords={[...selectedKeywords, ...selectedExcludedKeywords]}
			onAddKeyword={onKeywordAdd}
			onRemoveKeyword={onKeywordRemove}
		/>
	</div>

	<!-- Networks (TV only) -->
	{#if type !== 'movie'}
		<div class="form-control">
			<button
				type="button"
				class="flex w-full cursor-pointer items-center justify-between gap-2"
				aria-expanded={networksOpen}
				onclick={() => (networksOpen = !networksOpen)}
			>
				<span
					class="flex items-center gap-2 text-sm font-bold tracking-wide text-base-content/70 uppercase"
				>
					{m.discover_filter_networks()}
					{#if type === 'all'}
						<span class="text-xs text-base-content/50 normal-case"
							>{m.discover_filter_tvOnly()}</span
						>
					{/if}
					{#if selectedNetworks.length > 0}
						<span class="badge badge-sm badge-primary">{selectedNetworks.length}</span>
					{/if}
				</span>
				<ChevronDown
					class="h-4 w-4 shrink-0 text-base-content/50 transition-transform duration-200 {networksOpen
						? 'rotate-180'
						: ''}"
				/>
			</button>
			{#if networksOpen}
				<div class="mt-2">
					<LogoListSelect
						items={networkItems}
						selected={selectedNetworks}
						onToggle={onNetworkToggle}
						searchable
					/>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Watch Providers -->
	<div class="form-control">
		<button
			type="button"
			class="flex w-full cursor-pointer items-center justify-between gap-2"
			aria-expanded={providersOpen}
			onclick={() => (providersOpen = !providersOpen)}
		>
			<span
				class="flex items-center gap-2 text-sm font-bold tracking-wide text-base-content/70 uppercase"
			>
				{m.discover_filter_watchProviders()}
				{#if selectedProviders.length > 0}
					<span class="badge badge-sm badge-primary">{selectedProviders.length}</span>
				{/if}
			</span>
			<ChevronDown
				class="h-4 w-4 shrink-0 text-base-content/50 transition-transform duration-200 {providersOpen
					? 'rotate-180'
					: ''}"
			/>
		</button>
		{#if providersOpen}
			<div class="mt-2">
				<LogoListSelect
					items={providerItems}
					selected={selectedProviders}
					onToggle={onProviderToggle}
					searchable
				/>
			</div>
		{/if}
	</div>
</div>

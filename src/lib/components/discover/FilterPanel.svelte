<script lang="ts">
	import KeywordSelector from '#lib/components/smartlists/KeywordSelector.svelte';
	import { SEASONAL_PRESETS, type SeasonalPreset } from '#lib/config/seasonal.js';
	import MultiSelectDropdown from './MultiSelectDropdown.svelte';
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
		onGenreClear: () => void;
		onLanguageChange: (language: string) => void;
		onYearChange: (min: string, max: string) => void;
		onRatingChange: (rating: number) => void;
		onCertificationChange: (cert: string) => void;
		activeSeasonalId: string | null;
		onSeasonalChange: (id: string | null) => void;
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
		onGenreClear,
		onLanguageChange,
		onYearChange,
		onRatingChange,
		onCertificationChange,
		activeSeasonalId = null,
		onSeasonalChange
	}: Props = $props();

	// Labels live in the message catalogue, so the config module stays i18n-free.
	function seasonalLabel(seasonal: SeasonalPreset): string {
		const catalogue = m as unknown as Record<string, (() => string) | undefined>;
		return catalogue[seasonal.labelKey]?.() ?? seasonal.id;
	}

	// Every list filter is a dropdown now, so language and sort get the same
	// option shape. "No language filter" is the placeholder, not a list entry.
	let languageOptions = $derived(
		languages.map((language) => ({ id: language.code, label: language.name }))
	);
	let sortOptions = $derived([
		{ id: 'popularity.desc', label: m.discover_sort_mostPopular() },
		{ id: 'vote_average.desc', label: m.discover_sort_highestRated() },
		{ id: 'primary_release_date.desc', label: m.discover_sort_newestReleases() },
		// TV has no revenue sort on TMDB (it is remapped to popularity).
		...(type !== 'tv' ? [{ id: 'revenue.desc', label: m.discover_sort_highestRevenue() }] : [])
	]);
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
	// One category list: genres and seasons. The `genre:` / `season:` prefixes
	// keep the two filter params apart inside a single control.
	const GENRE_PREFIX = 'genre:';
	const SEASON_PREFIX = 'season:';
	// Seasons first: seven entries that fit without scrolling, where the genre
	// list behind them is long enough to need the search box.
	let genreSeasonOptions = $derived([
		...SEASONAL_PRESETS.map((preset) => ({
			id: `${SEASON_PREFIX}${preset.id}`,
			label: seasonalLabel(preset),
			group: m.discover_seasonal_title()
		})),
		...genres.map((genre) => ({
			id: `${GENRE_PREFIX}${genre.id}`,
			label: genre.name,
			group: m.common_genres()
		}))
	]);
	let genreSeasonSelection = $derived([
		...selectedGenres.map((id) => `${GENRE_PREFIX}${id}`),
		...(activeSeasonalId ? [`${SEASON_PREFIX}${activeSeasonalId}`] : [])
	]);

	/** Genres stack; a season replaces the season before it. */
	function toggleGenreSeason(id: string) {
		if (id.startsWith(SEASON_PREFIX)) {
			const seasonId = id.slice(SEASON_PREFIX.length);
			onSeasonalChange(seasonId === activeSeasonalId ? null : seasonId);
			return;
		}
		onGenreToggle(Number(id.slice(GENRE_PREFIX.length)));
	}
	let certificationOptions = $derived(
		certifications.map((cert) => ({
			id: cert.certification,
			label: cert.certification,
			title: cert.meaning
		}))
	);
</script>

<div class="space-y-6">
	<!-- Sort -->
	<MultiSelectDropdown
		id="sort"
		label={m.discover_filter_sortBy()}
		options={sortOptions}
		selected={[sortBy]}
		mode="single"
		onToggle={(id) => onSortChange(id)}
	/>

	<div class="space-y-4">
		<h3 class="px-1 text-xs font-bold tracking-wider text-base-content/40 uppercase">
			{m.discover_filter_groupContent()}
		</h3>
		<!-- Genres + Seasonal -->
		<MultiSelectDropdown
			id="genres"
			label={m.discover_filter_genresSeason()}
			options={genreSeasonOptions}
			selected={genreSeasonSelection}
			placeholder={m.discover_filter_anyGenre()}
			searchable
			onToggle={toggleGenreSeason}
			onClear={() => {
				onGenreClear();
				onSeasonalChange(null);
			}}
		/>

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
				showLabel={false}
				selectedKeywords={[...selectedKeywords, ...selectedExcludedKeywords]}
				onAddKeyword={onKeywordAdd}
				onRemoveKeyword={onKeywordRemove}
			/>
		</div>

		<!-- Original Language -->
		<MultiSelectDropdown
			id="original-language"
			label={m.discover_filter_originalLanguage()}
			options={languageOptions}
			selected={selectedLanguage ? [selectedLanguage] : []}
			placeholder={m.common_all()}
			mode="single"
			searchable
			onToggle={(code) => onLanguageChange(selectedLanguage === code ? '' : code)}
			onClear={() => onLanguageChange('')}
		/>

		<!-- Content Rating -->
		{#if certifications.length > 0 && type !== 'tv'}
			<MultiSelectDropdown
				id="content-rating"
				label={m.discover_filter_contentRating()}
				options={certificationOptions}
				selected={selectedCertification ? [selectedCertification] : []}
				placeholder={m.discover_filter_anyRating()}
				mode="single"
				onToggle={(certification) =>
					onCertificationChange(selectedCertification === certification ? '' : certification)}
				onClear={() => onCertificationChange('')}
			/>
		{/if}
	</div>

	<div class="space-y-4">
		<h3 class="px-1 text-xs font-bold tracking-wider text-base-content/40 uppercase">
			{m.discover_filter_groupRelease()}
		</h3>
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
	</div>

	<div class="space-y-4">
		<h3 class="px-1 text-xs font-bold tracking-wider text-base-content/40 uppercase">
			{m.discover_filter_groupAvailability()}
		</h3>
		<!-- Watch Providers -->
		<div class="form-control">
			<button
				type="button"
				class="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-base-200/60"
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

		<!-- Networks (TV only) -->
		{#if type !== 'movie'}
			<div class="form-control">
				<button
					type="button"
					class="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-base-200/60"
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
	</div>
</div>

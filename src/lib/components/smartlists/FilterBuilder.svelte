<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { SmartListFilters } from '#lib/server/db/schema.js';
	import { page } from '$app/state';
	import { TMDB } from '#lib/config/constants.js';
	import { getSmartListHelpers } from '#lib/api/smartlists.js';
	import GenreFilter from './GenreFilter.svelte';
	import ChipSelector from './ChipSelector.svelte';
	import NumericRangeFilter from './NumericRangeFilter.svelte';
	import PresetSelector from './PresetSelector.svelte';
	import FilterAccordion from './FilterAccordion.svelte';
	import PeopleSelector from './PeopleSelector.svelte';
	import KeywordSelector from './KeywordSelector.svelte';

	interface Props {
		mediaType: 'movie' | 'tv';
		filters: SmartListFilters;
		forceCloseSignal?: number;
		onSortByChange?: (data: { sortBy: string }) => void;
		onSectionOpen?: (data: { section: string }) => void;
	}

	let {
		mediaType,
		filters = $bindable(),
		forceCloseSignal = 0,
		onSortByChange,
		onSectionOpen
	}: Props = $props();

	$effect(() => {
		if (!filters.watchRegion) {
			filters.watchRegion = page.data.defaultRegion || TMDB.DEFAULT_REGION;
		}
	});

	let openSection = $state<string | null>('basic');

	let genres = $state<Array<{ id: number; name: string }>>([]);
	let loadingGenres = $state(false);
	let providers = $state<Array<{ provider_id: number; provider_name: string; logo_path: string }>>(
		[]
	);
	let loadingProviders = $state(false);
	let certifications = $state<Array<{ certification: string; meaning: string; order: number }>>([]);
	let loadingCertifications = $state(false);
	let languages = $state<Array<{ iso_639_1: string; english_name: string }>>([]);
	let loadingLanguages = $state(false);
	let countries = $state<Array<{ iso_3166_1: string; english_name: string }>>([]);
	let loadingCountries = $state(false);

	let selectedPeople = $state<Array<{ id: number; name: string; type: 'cast' | 'crew' }>>([]);
	let selectedKeywords = $state<Array<{ id: number; name: string; exclude: boolean }>>([]);

	interface FilterPreset {
		id: string;
		name: string;
		description: string;
		filters: Partial<SmartListFilters>;
		sortBy: string;
		appliesTo: ('movie' | 'tv')[];
	}

	const filterPresets: FilterPreset[] = [
		{
			id: 'popular',
			name: m.smartlists_filter_popular(),
			description: m.smartlists_filter_popularDesc(),
			filters: {},
			sortBy: 'popularity.desc',
			appliesTo: ['movie', 'tv']
		},
		{
			id: 'top-rated',
			name: m.smartlists_filter_topRated(),
			description: m.smartlists_filter_topRatedDesc(),
			filters: { voteCountMin: 100 },
			sortBy: 'vote_average.desc',
			appliesTo: ['movie', 'tv']
		},
		{
			id: 'new-releases',
			name: m.smartlists_filter_newReleases(),
			description: m.smartlists_filter_newReleasesDesc(),
			filters: {},
			sortBy: 'primary_release_date.desc',
			appliesTo: ['movie']
		},
		{
			id: 'new-episodes',
			name: m.smartlists_filter_newEpisodes(),
			description: m.smartlists_filter_newEpisodesDesc(),
			filters: {},
			sortBy: 'first_air_date.desc',
			appliesTo: ['tv']
		}
	];

	let selectedPresetId = $state<string>('');

	function applyPreset(presetId: string) {
		const preset = filterPresets.find((p) => p.id === presetId);
		if (!preset) return;

		filters = { ...preset.filters };

		onSortByChange?.({ sortBy: preset.sortBy });
	}

	function handleApplyPreset(presetId: string) {
		selectedPresetId = presetId;
		applyPreset(presetId);
	}

	function clearPreset() {
		selectedPresetId = '';
		filters = {};
	}

	function toggleSection(section: string) {
		const willOpen = openSection !== section;
		openSection = willOpen ? section : null;
		if (willOpen) {
			onSectionOpen?.({ section });
		}
	}

	let lastForceCloseSignal = 0;
	$effect(() => {
		if (forceCloseSignal !== lastForceCloseSignal) {
			lastForceCloseSignal = forceCloseSignal;
			openSection = null;
		}
	});

	$effect(() => {
		loadGenres();
		loadProviders();
		loadCertifications();
	});

	$effect(() => {
		loadLanguages();
		loadCountries();
	});

	$effect(() => {
		const castIds = filters.withCast ?? [];
		const crewIds = filters.withCrew ?? [];
		selectedPeople = [
			...castIds.map((id) => ({ id, name: `Person ${id}`, type: 'cast' as const })),
			...crewIds.map((id) => ({ id, name: `Person ${id}`, type: 'crew' as const }))
		];
	});

	$effect(() => {
		const withIds = filters.withKeywords ?? [];
		const withoutIds = filters.withoutKeywords ?? [];
		selectedKeywords = [
			...withIds.map((id) => ({ id, name: `Keyword ${id}`, exclude: false })),
			...withoutIds.map((id) => ({ id, name: `Keyword ${id}`, exclude: true }))
		];
	});

	async function loadGenres() {
		loadingGenres = true;
		try {
			const result = await getSmartListHelpers({ helper: 'genres', type: mediaType });
			genres = result as unknown as Array<{ id: number; name: string }>;
		} finally {
			loadingGenres = false;
		}
	}

	async function loadProviders() {
		loadingProviders = true;
		try {
			const result = await getSmartListHelpers({
				helper: 'providers',
				type: mediaType,
				region: filters.watchRegion ?? (page.data.defaultRegion || TMDB.DEFAULT_REGION)
			});
			providers = result as unknown as Array<{
				provider_id: number;
				provider_name: string;
				logo_path: string;
			}>;
		} finally {
			loadingProviders = false;
		}
	}

	async function loadCertifications() {
		loadingCertifications = true;
		try {
			const result = await getSmartListHelpers({ helper: 'certifications', type: mediaType });
			certifications = result as unknown as Array<{
				certification: string;
				meaning: string;
				order: number;
			}>;
			certifications.sort((a, b) => a.order - b.order);
		} finally {
			loadingCertifications = false;
		}
	}

	async function loadLanguages() {
		if (languages.length > 0) return;
		loadingLanguages = true;
		try {
			const result = await getSmartListHelpers({ helper: 'languages' });
			languages = result as unknown as Array<{ iso_639_1: string; english_name: string }>;
			languages.sort((a, b) => a.english_name.localeCompare(b.english_name));
		} finally {
			loadingLanguages = false;
		}
	}

	async function loadCountries() {
		if (countries.length > 0) return;
		loadingCountries = true;
		try {
			const result = await getSmartListHelpers({ helper: 'countries' });
			countries = result as unknown as Array<{ iso_3166_1: string; english_name: string }>;
			countries.sort((a, b) => a.english_name.localeCompare(b.english_name));
		} finally {
			loadingCountries = false;
		}
	}

	function toggleGenre(genreId: number, include: boolean) {
		if (include) {
			const current = filters.withGenres ?? [];
			if (current.includes(genreId)) {
				filters.withGenres = current.filter((id) => id !== genreId);
			} else {
				filters.withGenres = [...current, genreId];
				if (filters.withoutGenres?.includes(genreId)) {
					filters.withoutGenres = filters.withoutGenres.filter((id) => id !== genreId);
				}
			}
		} else {
			const current = filters.withoutGenres ?? [];
			if (current.includes(genreId)) {
				filters.withoutGenres = current.filter((id) => id !== genreId);
			} else {
				filters.withoutGenres = [...current, genreId];
				if (filters.withGenres?.includes(genreId)) {
					filters.withGenres = filters.withGenres.filter((id) => id !== genreId);
				}
			}
		}
	}

	function toggleProvider(providerId: number) {
		const current = filters.withWatchProviders ?? [];
		if (current.includes(providerId)) {
			filters.withWatchProviders = current.filter((id) => id !== providerId);
		} else {
			filters.withWatchProviders = [...current, providerId];
		}
	}

	function isProviderSelected(providerId: number): boolean {
		return (filters.withWatchProviders ?? []).includes(providerId);
	}

	function addPerson(person: { id: number; name: string }, type: 'cast' | 'crew') {
		if (type === 'cast') {
			if (!filters.withCast?.includes(person.id)) {
				filters.withCast = [...(filters.withCast ?? []), person.id];
				selectedPeople = [...selectedPeople, { id: person.id, name: person.name, type: 'cast' }];
			}
		} else {
			if (!filters.withCrew?.includes(person.id)) {
				filters.withCrew = [...(filters.withCrew ?? []), person.id];
				selectedPeople = [...selectedPeople, { id: person.id, name: person.name, type: 'crew' }];
			}
		}
	}

	function removePerson(personId: number, type: 'cast' | 'crew') {
		if (type === 'cast') {
			filters.withCast = (filters.withCast ?? []).filter((id) => id !== personId);
		} else {
			filters.withCrew = (filters.withCrew ?? []).filter((id) => id !== personId);
		}
		selectedPeople = selectedPeople.filter((p) => !(p.id === personId && p.type === type));
	}

	function addKeyword(keyword: { id: number; name: string }, exclude: boolean) {
		if (exclude) {
			if (!filters.withoutKeywords?.includes(keyword.id)) {
				filters.withoutKeywords = [...(filters.withoutKeywords ?? []), keyword.id];
				selectedKeywords = [
					...selectedKeywords,
					{ id: keyword.id, name: keyword.name, exclude: true }
				];
			}
		} else {
			if (!filters.withKeywords?.includes(keyword.id)) {
				filters.withKeywords = [...(filters.withKeywords ?? []), keyword.id];
				selectedKeywords = [
					...selectedKeywords,
					{ id: keyword.id, name: keyword.name, exclude: false }
				];
			}
		}
	}

	function removeKeyword(keywordId: number, exclude: boolean) {
		if (exclude) {
			filters.withoutKeywords = (filters.withoutKeywords ?? []).filter((id) => id !== keywordId);
		} else {
			filters.withKeywords = (filters.withKeywords ?? []).filter((id) => id !== keywordId);
		}
		selectedKeywords = selectedKeywords.filter(
			(k) => !(k.id === keywordId && k.exclude === exclude)
		);
	}
</script>

<div class="space-y-3">
	<PresetSelector
		presets={filterPresets}
		{mediaType}
		{selectedPresetId}
		onApplyPreset={(presetId) => handleApplyPreset(presetId)}
		onClearPreset={clearPreset}
	/>

	<FilterAccordion
		title={m.smartlists_filter_basicFilters()}
		isOpen={openSection === 'basic'}
		onToggle={() => toggleSection('basic')}
	>
		<div class="space-y-4 pt-2">
			<GenreFilter
				{genres}
				withGenres={filters.withGenres ?? []}
				withoutGenres={filters.withoutGenres ?? []}
				genreMode={filters.genreMode ?? 'or'}
				loading={loadingGenres}
				onToggleGenre={toggleGenre}
				onGenreModeChange={(mode) => (filters.genreMode = mode)}
			/>

			<NumericRangeFilter
				minLabel={m.smartlists_filter_yearFrom()}
				maxLabel={m.smartlists_filter_yearTo()}
				minValue={filters.yearMin}
				maxValue={filters.yearMax}
				minPlaceholder="1900"
				maxPlaceholder="2025"
				minMin={1900}
				minMax={2030}
				maxMin={1900}
				maxMax={2030}
				onMinChange={(v) => (filters.yearMin = v)}
				onMaxChange={(v) => (filters.yearMax = v)}
			/>

			<NumericRangeFilter
				minLabel={m.smartlists_filter_minRating()}
				maxLabel={m.smartlists_filter_minVotes()}
				minValue={filters.voteAverageMin}
				maxValue={filters.voteCountMin}
				minPlaceholder="0"
				maxPlaceholder="100"
				minMin={0}
				minMax={10}
				maxMin={0}
				step="0.5"
				onMinChange={(v) => (filters.voteAverageMin = v)}
				onMaxChange={(v) => (filters.voteCountMin = v)}
			/>
		</div>
	</FilterAccordion>

	<FilterAccordion
		title={m.smartlists_filter_content()}
		isOpen={openSection === 'content'}
		onToggle={() => toggleSection('content')}
	>
		<div class="space-y-4 pt-2">
			<KeywordSelector
				{selectedKeywords}
				onAddKeyword={addKeyword}
				onRemoveKeyword={removeKeyword}
			/>

			<div class="form-control">
				<label class="label py-1" for="language">
					<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
						>{m.smartlists_filter_originalLanguage()}</span
					>
				</label>
				<select
					id="language"
					bind:value={filters.withOriginalLanguage}
					class="select-bordered select w-full select-sm"
				>
					<option value="">{m.smartlists_filter_anyLanguage()}</option>
					{#if loadingLanguages}
						<option disabled>{m.smartlists_filter_loading()}</option>
					{:else}
						{#each languages as lang (lang.iso_639_1)}
							<option value={lang.iso_639_1}>{lang.english_name}</option>
						{/each}
					{/if}
				</select>
			</div>

			<NumericRangeFilter
				minLabel={m.smartlists_filter_minRuntime()}
				maxLabel={m.smartlists_filter_maxRuntime()}
				minValue={filters.runtimeMin}
				maxValue={filters.runtimeMax}
				minPlaceholder="0"
				maxPlaceholder="300"
				minMin={0}
				maxMin={0}
				onMinChange={(v) => (filters.runtimeMin = v)}
				onMaxChange={(v) => (filters.runtimeMax = v)}
			/>

			<div class="form-control">
				<label class="label py-1" for="certification">
					<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
						>{m.smartlists_filter_ageRating()}</span
					>
				</label>
				<select
					id="certification"
					bind:value={filters.certification}
					class="select-bordered select w-full select-sm"
				>
					<option value="">{m.smartlists_filter_anyRating()}</option>
					{#if loadingCertifications}
						<option disabled>{m.smartlists_filter_loading()}</option>
					{:else}
						{#each certifications as cert (cert.certification)}
							<option value={cert.certification}>{cert.certification}</option>
						{/each}
					{/if}
				</select>
			</div>
		</div>
	</FilterAccordion>

	<FilterAccordion
		title={m.smartlists_filter_people()}
		isOpen={openSection === 'people'}
		onToggle={() => toggleSection('people')}
	>
		<div class="space-y-4 pt-2">
			<PeopleSelector {selectedPeople} onAddPerson={addPerson} onRemovePerson={removePerson} />
		</div>
	</FilterAccordion>

	<FilterAccordion
		title={m.smartlists_filter_streamingPlatforms()}
		isOpen={openSection === 'platform'}
		onToggle={() => toggleSection('platform')}
	>
		<div class="space-y-4 pt-2">
			<div class="form-control">
				<label class="label py-1" for="watchRegion">
					<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
						>{m.smartlists_filter_region()}</span
					>
				</label>
				<select
					id="watchRegion"
					bind:value={filters.watchRegion}
					class="select-bordered select w-full select-sm"
					onchange={() => loadProviders()}
				>
					{#if loadingCountries}
						<option disabled>{m.smartlists_filter_loading()}</option>
					{:else}
						{#each countries as country (country.iso_3166_1)}
							<option value={country.iso_3166_1}>{country.english_name}</option>
						{/each}
					{/if}
				</select>
			</div>

			<ChipSelector
				loading={loadingProviders}
				loadingMessage={m.smartlists_filter_loading()}
				labelText={m.smartlists_filter_availableOn()}
				selectedCount={filters.withWatchProviders?.length ?? 0}
				selectedBadgeClass="badge-primary"
			>
				<div class="grid grid-cols-5 gap-2 sm:grid-cols-6">
					{#each providers.slice(0, 24) as provider (provider.provider_id)}
						<button
							type="button"
							class="relative aspect-square overflow-hidden rounded-lg border-2 transition-all {isProviderSelected(
								provider.provider_id
							)
								? 'border-primary ring-2 ring-primary/30'
								: 'border-base-300 opacity-60 hover:opacity-100'}"
							onclick={() => toggleProvider(provider.provider_id)}
							title={provider.provider_name}
						>
							<img
								src="https://image.tmdb.org/t/p/w92{provider.logo_path}"
								alt={provider.provider_name}
								class="h-full w-full object-cover"
							/>
						</button>
					{/each}
				</div>
			</ChipSelector>
		</div>
	</FilterAccordion>

	{#if mediaType === 'tv'}
		<FilterAccordion
			title={m.smartlists_filter_tvShowStatus()}
			isOpen={openSection === 'tv'}
			onToggle={() => toggleSection('tv')}
		>
			<div class="pt-2">
				<div class="form-control">
					<label class="label py-1" for="tvStatus">
						<span
							class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
							>{m.smartlists_filter_showStatus()}</span
						>
					</label>
					<select
						id="tvStatus"
						bind:value={filters.withStatus}
						class="select-bordered select w-full select-sm"
					>
						<option value="">{m.smartlists_filter_anyStatus()}</option>
						<option value="0">{m.smartlists_filter_returningSeries()}</option>
						<option value="1">{m.smartlists_filter_planned()}</option>
						<option value="2">{m.smartlists_filter_inProduction()}</option>
						<option value="3">{m.smartlists_filter_ended()}</option>
						<option value="4">{m.smartlists_filter_canceled()}</option>
						<option value="5">{m.smartlists_filter_pilot()}</option>
					</select>
				</div>
			</div>
		</FilterAccordion>
	{/if}
</div>

<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import CommonOptions from './add/CommonOptions.svelte';
	import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
	import SeriesAddOptions, {
		type MonitorType,
		type MonitorNewItems,
		type SeriesType
	} from './add/SeriesAddOptions.svelte';
	import type { RootFolderWithSpaceAndDefault as RootFolder } from '#lib/types/downloadClient.js';

	interface ScoringProfile {
		id: string;
		name: string;
		description?: string;
		isBuiltIn: boolean;
		isDefault?: boolean;
	}

	interface Season {
		season_number: number;
		name: string;
		episode_count: number;
		air_date?: string;
		poster_path?: string;
	}

	/** The subtitle profile a new item will inherit, plus the level it came from. */
	interface EffectiveSubtitleProfileInfo {
		profile: { id: string; name: string };
		source: 'movie' | 'series' | 'library' | 'default';
	}

	interface Props {
		title: string;
		year?: number;
		posterPath?: string | null;
		rootFolders: RootFolder[];
		scoringProfiles: ScoringProfile[];
		selectedRootFolder: string;
		selectedScoringProfile: string;
		searchOnAdd: boolean;
		wantsSubtitles: boolean;
		/** Resolved subtitle profile for a NEW item; undefined while loading, null when unset. */
		effectiveSubtitleProfile?: EffectiveSubtitleProfileInfo | null;
		/** Language profiles for the add-time picker. */
		languageProfiles?: Array<{ id: string; name: string }>;
		/** Effective requirements seeding the customize editor. */
		effectiveSubtitleRequirements?: SubtitleRequirement[] | null;
		/** Add-time language profile override ('' = inherit). */
		selectedLanguageProfile?: string;
		/** Add-time per-item subtitle requirement override (null = inherit). */
		subtitleRequirementsOverride?: SubtitleRequirement[] | null;
		monitorType: MonitorType;
		monitorNewItems: MonitorNewItems;
		monitorSpecials: boolean;
		seriesType: SeriesType;
		seasonFolder: boolean;
		monitoredSeasons: SvelteSet<number>;
		seasons: Season[];
		showAdvanced: boolean;
		error: string | null;
		enforceAnimeSubtype: boolean;
		requiredMediaSubType?: 'standard' | 'anime';
		onSearchOnAddInput?: () => void;
		onWantsSubtitlesInput?: () => void;
		onMonitoredInput?: () => void;
	}

	let {
		title,
		year,
		posterPath,
		rootFolders,
		scoringProfiles,
		selectedRootFolder = $bindable(),
		selectedScoringProfile = $bindable(),
		searchOnAdd = $bindable(),
		wantsSubtitles = $bindable(),
		effectiveSubtitleProfile,
		languageProfiles = [],
		effectiveSubtitleRequirements = null,
		selectedLanguageProfile = $bindable(''),
		subtitleRequirementsOverride = $bindable<SubtitleRequirement[] | null>(null),
		monitorType = $bindable(),
		monitorNewItems = $bindable(),
		monitorSpecials = $bindable(),
		seriesType = $bindable(),
		seasonFolder = $bindable(),
		monitoredSeasons,
		seasons,
		showAdvanced = $bindable(),
		error,
		enforceAnimeSubtype,
		requiredMediaSubType,
		onSearchOnAddInput,
		onWantsSubtitlesInput,
		onMonitoredInput
	}: Props = $props();
</script>

<div class="space-y-5">
	<div class="flex items-start gap-4">
		{#if posterPath}
			<img
				src={`https://image.tmdb.org/t/p/w92${posterPath}`}
				alt={title}
				class="w-16 rounded-md shadow-md"
			/>
		{:else}
			<div class="flex h-24 w-16 items-center justify-center rounded-md bg-base-300">
				<span class="text-xs text-base-content/30">No Image</span>
			</div>
		{/if}
		<div>
			<h3 class="text-lg font-bold">{title}</h3>
			{#if year}
				<p class="text-sm text-base-content/70">{year}</p>
			{/if}
			<span class="mt-1 badge badge-sm badge-secondary">TV Series</span>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
		</div>
	{/if}

	{#if enforceAnimeSubtype}
		<div class="alert text-sm alert-info">
			<span
				>{requiredMediaSubType === 'anime'
					? 'Anime detected. Only folders with subtype Anime are available.'
					: 'Anime root folder enforcement is enabled. Only Standard folders are available.'}</span
			>
		</div>
	{/if}

	<CommonOptions
		mediaType="tv"
		{rootFolders}
		{scoringProfiles}
		{requiredMediaSubType}
		{effectiveSubtitleProfile}
		{languageProfiles}
		{effectiveSubtitleRequirements}
		{onSearchOnAddInput}
		{onWantsSubtitlesInput}
		bind:selectedRootFolder
		bind:selectedScoringProfile
		bind:searchOnAdd
		bind:wantsSubtitles
		bind:selectedLanguageProfile
		bind:subtitleRequirementsOverride
	/>

	<SeriesAddOptions
		{seasons}
		{onMonitoredInput}
		bind:monitorType
		bind:monitorNewItems
		bind:monitorSpecials
		bind:seriesType
		bind:seasonFolder
		{monitoredSeasons}
		bind:showAdvanced
	/>
</div>

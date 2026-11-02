<script lang="ts">
	import { X, Loader2, Search } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { getWritableRootFoldersForMediaType } from '#lib/utils/root-folders.js';
	import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
	import type { RootFolderWithSpaceAndDefault as RootFolder } from '#lib/types/downloadClient.js';
	import type { DesiredQuality } from '#lib/types/library.js';
	import type { MinimumAvailability } from './add/MovieAddOptions.svelte';
	import type { MonitorType, MonitorNewItems, SeriesType } from './add/SeriesAddOptions.svelte';
	import AddMovieForm from './AddMovieForm.svelte';
	import AddSeriesForm from './AddSeriesForm.svelte';
	import {
		getRootFolders,
		getLibraries,
		getScoringProfiles,
		getLibraryClassificationSettings
	} from '#lib/api/settings.js';
	import { getEffectiveSubtitleProfile, getLanguageProfiles } from '#lib/api/subtitles.js';
	import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
	import {
		getLibraryStatus,
		createMovie,
		createSeries,
		bulkAddMovies,
		type LibraryStatus
	} from '#lib/api/library.js';
	import { getTmdb } from '#lib/api/discover.js';

	interface Props {
		open: boolean;
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		title: string;
		year?: number;
		posterPath?: string | null;
		onClose: () => void;
		onSuccess?: () => void;
	}

	let { open, mediaType, tmdbId, title, year, posterPath, onClose, onSuccess }: Props = $props();

	interface LibraryEntity {
		id: string;
		mediaType: 'movie' | 'tv';
		defaultSearchOnAdd: boolean;
		defaultWantsSubtitles: boolean;
		qualityProfileId?: string | null;
		rootFolders: Array<{ id: string }>;
	}

	interface ScoringProfile {
		id: string;
		name: string;
		description?: string;
		isBuiltIn: boolean;
		isDefault?: boolean;
		minResolution?: string | null;
		maxResolution?: string | null;
	}

	/** The subtitle profile a new item will inherit, plus the level it came from. */
	interface EffectiveSubtitleProfileInfo {
		profile: {
			id: string;
			name: string;
			subtitles?: SubtitleRequirement[];
		};
		source: 'movie' | 'series' | 'library' | 'default';
	}

	interface Season {
		season_number: number;
		name: string;
		episode_count: number;
		air_date?: string;
		poster_path?: string;
	}

	interface CollectionPart {
		id: number;
		title: string;
		release_date?: string;
		poster_path?: string;
		inLibrary?: boolean;
	}

	interface CollectionInfo {
		id: number;
		name: string;
		parts: CollectionPart[];
	}

	interface TmdbMovieDetails {
		title: string;
		original_title?: string | null;
		original_language?: string | null;
		origin_country?: string[] | null;
		production_countries?: Array<{ iso_3166_1?: string }> | null;
		genres?: Array<{ id?: number; name?: string }> | null;
		belongs_to_collection?: { id: number } | null;
	}

	interface TmdbTvDetails {
		name: string;
		original_name?: string | null;
		original_language?: string | null;
		origin_country?: string[] | null;
		production_countries?: Array<{ iso_3166_1?: string }> | null;
		genres?: Array<{ id?: number; name?: string }> | null;
		seasons?: Season[];
	}

	let rootFolders = $state<RootFolder[]>([]);
	let libraries = $state<LibraryEntity[]>([]);
	let scoringProfiles = $state<ScoringProfile[]>([]);
	/** Resolved subtitle profile for a NEW item; null once the endpoint reports no default. */
	let effectiveSubtitleProfile = $state<EffectiveSubtitleProfileInfo | null>(null);
	let seasons = $state<Season[]>([]);
	let isLoading = $state(false);
	let isSubmitting = $state(false);
	let error = $state<string | null>(null);
	let showAdvanced = $state(false);

	let collection = $state<CollectionInfo | null>(null);
	let addEntireCollection = $state(false);
	let enforceAnimeSubtype = $state(false);
	let detectedAnime = $state(false);

	let selectedRootFolder = $state('');
	let selectedScoringProfile = $state('');
	let searchOnAdd = $state(true);
	let wantsSubtitles = $state(true);
	/** Add-time language profile override ('' = inherit). */
	let selectedLanguageProfile = $state('');
	/** Add-time per-item subtitle requirement override (null = inherit). */
	let subtitleRequirementsOverride = $state<SubtitleRequirement[] | null>(null);
	/** Language profiles available for the add-time picker. */
	let languageProfiles = $state<Array<{ id: string; name: string }>>([]);
	let monitoredTouched = $state(false);
	let searchOnAddTouched = $state(false);
	let wantsSubtitlesTouched = $state(false);

	let minimumAvailability = $state<MinimumAvailability>('released');
	let availabilityDelay = $state(0);
	let monitored = $state(true);
	let desiredQualities = $state<DesiredQuality[]>([]);

	let monitorType = $state<MonitorType>('all');
	let monitorNewItems = $state<MonitorNewItems>('all');
	let monitorSpecials = $state(false);
	let seriesType = $state<SeriesType>('standard');
	let seasonFolder = $state(true);
	let monitoredSeasons = new SvelteSet<number>();

	const requiredMediaSubType = $derived(
		enforceAnimeSubtype ? (detectedAnime ? ('anime' as const) : ('standard' as const)) : undefined
	);
	const filteredRootFolders = $derived(
		getWritableRootFoldersForMediaType(rootFolders, mediaType, requiredMediaSubType)
	);
	const rootFolderLibraryMap = $derived.by(() => {
		const assignments = new SvelteMap<string, LibraryEntity>();
		for (const library of libraries) {
			for (const rootFolder of library.rootFolders ?? []) {
				assignments.set(rootFolder.id, library);
			}
		}
		return assignments;
	});
	const selectedRootFolderLibrary = $derived(
		selectedRootFolder ? rootFolderLibraryMap.get(selectedRootFolder) : undefined
	);
	const selectedRootFolderObj = $derived(
		selectedRootFolder ? rootFolders.find((folder) => folder.id === selectedRootFolder) : undefined
	);

	function getRecommendedRootFolderId(folders: RootFolder[]): string | undefined {
		if (folders.length === 0) return undefined;

		if (requiredMediaSubType) {
			return (
				folders.find(
					(folder) =>
						folder.isDefault && (folder.mediaSubType ?? 'standard') === requiredMediaSubType
				)?.id ?? folders[0].id
			);
		}

		if (detectedAnime) {
			return (
				folders.find(
					(folder) => folder.isDefault && (folder.mediaSubType ?? 'standard') === 'anime'
				)?.id ??
				folders.find(
					(folder) => folder.isDefault && (folder.mediaSubType ?? 'standard') === 'standard'
				)?.id ??
				folders.find((folder) => folder.isDefault)?.id ??
				folders[0].id
			);
		}

		return (
			folders.find(
				(folder) => folder.isDefault && (folder.mediaSubType ?? 'standard') === 'standard'
			)?.id ??
			folders.find((folder) => folder.isDefault)?.id ??
			folders[0].id
		);
	}

	const missingCollectionMovies = $derived(
		collection?.parts?.filter((p) => !p.inLibrary && p.id !== tmdbId) ?? []
	);

	const willBeMonitored = $derived(mediaType === 'tv' ? monitorType !== 'none' : monitored);

	const willSearchOnAdd = $derived(searchOnAdd);

	$effect(() => {
		if (open) {
			monitored = true;
			searchOnAdd = true;
			wantsSubtitles = true;
			selectedLanguageProfile = '';
			subtitleRequirementsOverride = null;
			minimumAvailability = 'released';
			availabilityDelay = 0;
			desiredQualities = [];
			monitorType = 'all';
			monitorNewItems = 'all';
			monitorSpecials = false;
			seriesType = 'standard';
			seasonFolder = true;
			monitoredSeasons.clear();
			showAdvanced = false;
			error = null;

			collection = null;
			addEntireCollection = false;
			enforceAnimeSubtype = false;
			detectedAnime = false;
			monitoredTouched = false;
			searchOnAddTouched = false;
			wantsSubtitlesTouched = false;
			effectiveSubtitleProfile = null;

			loadData();
		}
	});

	$effect(() => {
		if (mediaType === 'tv' && seasons.length > 0) {
			void [monitorType, monitorSpecials];
			updateMonitoredSeasonsFromType(monitorType);
		}
	});

	$effect(() => {
		if (!open) return;
		if (filteredRootFolders.length === 0) {
			selectedRootFolder = '';
			return;
		}

		const stillValid = filteredRootFolders.some((folder) => folder.id === selectedRootFolder);
		if (!stillValid) {
			selectedRootFolder = getRecommendedRootFolderId(filteredRootFolders) ?? '';
		}
	});

	$effect(() => {
		if (!open || !selectedRootFolderLibrary) return;

		if (!searchOnAddTouched) {
			searchOnAdd = selectedRootFolderLibrary.defaultSearchOnAdd;
		}
		if (!wantsSubtitlesTouched) {
			wantsSubtitles = selectedRootFolderLibrary.defaultWantsSubtitles;
		}
		if (!monitoredTouched) {
			const defaultMonitored = selectedRootFolderObj?.defaultMonitored ?? true;
			if (mediaType === 'movie') {
				monitored = defaultMonitored;
			} else {
				monitorType = defaultMonitored ? 'all' : 'none';
			}
		}
	});

	function handleMonitoredInput() {
		monitoredTouched = true;
	}

	function handleSearchOnAddInput() {
		searchOnAddTouched = true;
	}

	function handleWantsSubtitlesInput() {
		wantsSubtitlesTouched = true;
	}

	function updateMonitoredSeasonsFromType(type: MonitorType) {
		monitoredSeasons.clear();

		const shouldIncludeSeason = (s: Season) => {
			if (s.season_number === 0) return monitorSpecials;
			return true;
		};

		switch (type) {
			case 'all':
				seasons.filter(shouldIncludeSeason).forEach((s) => monitoredSeasons.add(s.season_number));
				break;
			case 'firstSeason': {
				const firstSeason =
					seasons.find((s) => s.season_number === 1) ?? seasons.find((s) => s.season_number > 0);
				if (firstSeason) monitoredSeasons.add(firstSeason.season_number);
				break;
			}
			case 'lastSeason': {
				const regularSeasons = seasons.filter((s) => s.season_number > 0);
				const lastSeason =
					regularSeasons.length > 0
						? regularSeasons[regularSeasons.length - 1]
						: seasons[seasons.length - 1];
				if (lastSeason) monitoredSeasons.add(lastSeason.season_number);
				break;
			}
			case 'recent':
				seasons.filter(shouldIncludeSeason).forEach((s) => monitoredSeasons.add(s.season_number));
				break;
			case 'none':
				break;
			default:
				seasons.filter(shouldIncludeSeason).forEach((s) => monitoredSeasons.add(s.season_number));
				break;
		}
	}

	function updateAnimeDetectionFromMovie(movieDetails: TmdbMovieDetails | null | undefined) {
		detectedAnime = isLikelyAnimeMedia({
			genres: movieDetails?.genres,
			originalLanguage: movieDetails?.original_language,
			originCountries: movieDetails?.origin_country,
			productionCountries: movieDetails?.production_countries,
			title: movieDetails?.title,
			originalTitle: movieDetails?.original_title
		});
	}

	function updateAnimeDetectionFromSeries(tvDetails: TmdbTvDetails | null | undefined) {
		detectedAnime = isLikelyAnimeMedia({
			genres: tvDetails?.genres,
			originalLanguage: tvDetails?.original_language,
			originCountries: tvDetails?.origin_country,
			productionCountries: tvDetails?.production_countries,
			title: tvDetails?.name,
			originalTitle: tvDetails?.original_name
		});
	}

	async function loadData() {
		isLoading = true;
		error = null;

		try {
			const tmdbPromise = mediaType === 'tv' ? getTmdb(`tv/${tmdbId}`) : getTmdb(`movie/${tmdbId}`);

			// The destructured names below and the type tuple in the `as unknown as`
			// cast further down must both stay in this exact order, the cast
			// bypasses structural type-checking entirely, so a reordering here
			// (previously `tmdbRes`/`languageProfilesData` swapped relative to the
			// Promise.all array) silently binds the wrong result to the wrong name
			// with no compiler error. If you add/reorder an entry, update all three
			// (names, Promise.all array, type tuple) together.
			const [
				foldersData,
				librariesData,
				profilesData,
				classificationData,
				subtitleProfileData,
				languageProfilesData,
				tmdbRes
			] = (await Promise.all([
				getRootFolders(),
				getLibraries({ mediaType }),
				getScoringProfiles(),
				getLibraryClassificationSettings(),
				// Non-critical: powers the effective-profile line + warning on the add form.
				getEffectiveSubtitleProfile(mediaType === 'tv' ? 'series' : 'movie').catch(() => undefined),
				// Non-critical: powers the add-time language profile picker.
				getLanguageProfiles().catch(() => ({ profiles: [] })),
				tmdbPromise
			])) as unknown as [
				{ folders?: RootFolder[] } | RootFolder[],
				{ libraries?: LibraryEntity[] },
				{ profiles?: ScoringProfile[]; defaultProfileId?: string },
				{ enforceAnimeSubtype?: boolean },
				EffectiveSubtitleProfileInfo | null | undefined,
				{ profiles?: Array<{ id: string; name: string }> },
				unknown
			];

			rootFolders = Array.isArray(foldersData) ? foldersData : (foldersData.folders ?? []);
			libraries = librariesData.libraries ?? [];
			scoringProfiles = profilesData.profiles ?? [];
			languageProfiles = languageProfilesData?.profiles ?? [];
			effectiveSubtitleProfile = subtitleProfileData ?? null;
			enforceAnimeSubtype = classificationData?.enforceAnimeSubtype === true;

			if (mediaType === 'tv' && tmdbRes) {
				const tvData = tmdbRes as unknown as TmdbTvDetails;
				seasons = tvData.seasons?.filter((s: Season) => s.episode_count > 0) ?? [];
				monitoredSeasons.clear();
				for (const s of seasons) {
					monitoredSeasons.add(s.season_number);
				}
				updateAnimeDetectionFromSeries(tvData);
				if (detectedAnime) seriesType = 'anime';
			}

			if (mediaType === 'movie') {
				const movieRes = tmdbRes;
				if (movieRes) {
					const movieData = tmdbRes as unknown as TmdbMovieDetails;
					updateAnimeDetectionFromMovie(movieData);
					fetchCollectionData();
				} else {
					fetchCollectionData();
				}
			}

			selectedRootFolder = getRecommendedRootFolderId(filteredRootFolders) ?? '';

			const libraryProfileId = selectedRootFolderLibrary?.qualityProfileId;
			const libraryProfileIsValid =
				libraryProfileId !== undefined &&
				libraryProfileId !== null &&
				scoringProfiles.some((p) => p.id === libraryProfileId);
			const defaultProfileId = libraryProfileIsValid
				? libraryProfileId
				: profilesData.defaultProfileId;
			const defaultProfile =
				(defaultProfileId && scoringProfiles.find((p) => p.id === defaultProfileId)) ??
				scoringProfiles.find((p) => p.isDefault) ??
				scoringProfiles[0];
			if (defaultProfile) {
				selectedScoringProfile = defaultProfile.id;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load data';
		} finally {
			isLoading = false;
		}
	}

	async function fetchCollectionData() {
		try {
			const movieData = (await getTmdb(`movie/${tmdbId}`)) as unknown as TmdbMovieDetails;
			if (!movieData.belongs_to_collection) return;

			const collectionData = (await getTmdb(
				`collection/${movieData.belongs_to_collection.id}`
			)) as unknown as { id: number; name: string; parts: CollectionPart[] };
			if (!collectionData.parts || collectionData.parts.length <= 1) return;

			const tmdbIds = collectionData.parts.map((p: CollectionPart) => p.id);
			const statusData = await getLibraryStatus({ tmdbIds, mediaType: 'movie' });

			// tmdbIds (plural) always yields the map-shaped response.
			const statusMap = statusData.status as Record<number, LibraryStatus>;

			collection = {
				id: collectionData.id,
				name: collectionData.name,
				parts: collectionData.parts.map((p: CollectionPart) => ({
					...p,
					inLibrary: statusMap[p.id]?.inLibrary ?? false
				}))
			};
		} catch (_e) {
			// Collection fetch is non-critical
		}
	}

	async function handleSubmit() {
		if (!selectedRootFolder) {
			error = 'Please select a root folder';
			return;
		}

		isSubmitting = true;
		error = null;

		try {
			if (mediaType === 'movie' && addEntireCollection && missingCollectionMovies.length > 0) {
				await handleBulkCollectionAdd();
				return;
			}

			const basePayload = {
				tmdbId,
				rootFolderId: selectedRootFolder,
				scoringProfileId: selectedScoringProfile || undefined,
				monitored: willBeMonitored,
				searchOnAdd: willSearchOnAdd,
				wantsSubtitles,
				languageProfileId: selectedLanguageProfile || null,
				subtitleRequirementsOverride
			};

			const result = (mediaType === 'movie'
				? await createMovie({
						...basePayload,
						minimumAvailability,
						availabilityDelay,
						desiredQualities: desiredQualities.length > 0 ? desiredQualities : null
					})
				: await createSeries({
						...basePayload,
						monitorType,
						monitorNewItems,
						monitorSpecials,
						seriesType,
						seasonFolder,
						monitoredSeasons: Array.from(monitoredSeasons)
					})) as unknown as {
				success: boolean;
				id?: string;
				movie?: { id?: string; searchWarning?: string };
				series?: { id?: string; searchWarning?: string };
			};

			const mediaId = result.movie?.id ?? result.series?.id ?? result.id;
			const searchWarning = result.movie?.searchWarning ?? result.series?.searchWarning;
			const viewAction = mediaId
				? {
						label: 'View',
						href: mediaType === 'movie' ? `/library/movie/${mediaId}` : `/library/tv/${mediaId}`
					}
				: undefined;

			if (searchWarning) {
				toasts.warning(`${title} added to library`, {
					description: searchWarning,
					action: viewAction
				});
			} else {
				toasts.success(`${title} added to library`, {
					description: willSearchOnAdd ? 'Searching for releases...' : undefined,
					action: viewAction
				});
			}

			onClose();
			onSuccess?.();
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : 'Failed to add to library';
			error = errorMessage;
			toasts.error(errorMessage);
		} finally {
			isSubmitting = false;
		}
	}

	async function handleBulkCollectionAdd() {
		try {
			const allTmdbIds = [tmdbId, ...missingCollectionMovies.map((m) => m.id)];

			const payload = {
				tmdbIds: allTmdbIds,
				rootFolderId: selectedRootFolder,
				scoringProfileId: selectedScoringProfile || undefined,
				monitored: willBeMonitored,
				minimumAvailability,
				availabilityDelay,
				searchOnAdd: willSearchOnAdd,
				wantsSubtitles
			};

			const result = (await bulkAddMovies(payload)) as unknown as {
				added?: number;
				errors?: unknown[];
			};

			const addedCount = result.added ?? 0;
			const errorCount = result.errors?.length ?? 0;

			if (addedCount > 0) {
				toasts.success(
					`Added ${addedCount} movie${addedCount > 1 ? 's' : ''} from ${collection?.name}`,
					{
						description: willSearchOnAdd ? 'Searching for releases...' : undefined
					}
				);
			}

			if (errorCount > 0) {
				toasts.error(`Failed to add ${errorCount} movie${errorCount > 1 ? 's' : ''}`);
			}

			onClose();
			onSuccess?.();
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : 'Failed to add collection';
			error = errorMessage;
			toasts.error(errorMessage);
		} finally {
			isSubmitting = false;
		}
	}

	function handleClose() {
		if (!isSubmitting) {
			onClose();
		}
	}
</script>

<ModalWrapper {open} onClose={handleClose} maxWidth="2xl" labelledBy="add-library-modal-title">
	<div class="mb-6 flex items-center justify-between">
		<h3 id="add-library-modal-title" class="text-xl font-bold">Add to Library</h3>
		<button
			class="btn btn-circle btn-ghost btn-sm"
			onclick={handleClose}
			disabled={isSubmitting}
			aria-label="Close"
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<div class="min-w-0 overflow-hidden">
		{#if isLoading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="h-8 w-8 animate-spin text-primary" />
			</div>
		{:else if mediaType === 'movie'}
			<AddMovieForm
				{title}
				{year}
				{posterPath}
				{tmdbId}
				{rootFolders}
				{scoringProfiles}
				{requiredMediaSubType}
				{enforceAnimeSubtype}
				{error}
				{collection}
				{effectiveSubtitleProfile}
				{languageProfiles}
				effectiveSubtitleRequirements={effectiveSubtitleProfile?.profile.subtitles ?? null}
				bind:selectedLanguageProfile
				bind:subtitleRequirementsOverride
				onMonitoredInput={handleMonitoredInput}
				onSearchOnAddInput={handleSearchOnAddInput}
				onWantsSubtitlesInput={handleWantsSubtitlesInput}
				bind:selectedRootFolder
				bind:selectedScoringProfile
				bind:searchOnAdd
				bind:wantsSubtitles
				bind:minimumAvailability
				bind:availabilityDelay
				bind:monitored
				bind:desiredQualities
				bind:addEntireCollection
			/>
		{:else}
			<AddSeriesForm
				{title}
				{year}
				{posterPath}
				{rootFolders}
				{scoringProfiles}
				{requiredMediaSubType}
				{enforceAnimeSubtype}
				{error}
				{seasons}
				{monitoredSeasons}
				{effectiveSubtitleProfile}
				{languageProfiles}
				effectiveSubtitleRequirements={effectiveSubtitleProfile?.profile.subtitles ?? null}
				bind:selectedLanguageProfile
				bind:subtitleRequirementsOverride
				onMonitoredInput={handleMonitoredInput}
				onSearchOnAddInput={handleSearchOnAddInput}
				onWantsSubtitlesInput={handleWantsSubtitlesInput}
				bind:selectedRootFolder
				bind:selectedScoringProfile
				bind:searchOnAdd
				bind:wantsSubtitles
				bind:monitorType
				bind:monitorNewItems
				bind:monitorSpecials
				bind:seriesType
				bind:seasonFolder
				bind:showAdvanced
			/>
		{/if}
	</div>

	<div class="modal-action mt-6 border-t border-base-300 pt-4">
		<button class="btn btn-ghost" onclick={handleClose} disabled={isSubmitting}> Cancel </button>
		<button
			class="btn btn-primary"
			onclick={handleSubmit}
			disabled={isLoading || isSubmitting || filteredRootFolders.length === 0}
		>
			{#if isSubmitting}
				<Loader2 class="mr-2 h-4 w-4 animate-spin" />
				Adding...
			{:else if willSearchOnAdd}
				<Search class="mr-2 h-4 w-4" />
				Add + Search
			{:else}
				Add to Library
			{/if}
		</button>
	</div>
</ModalWrapper>

<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Loader2 } from '@lucide/svelte';
	import { MAX_BULK_IMPORT_JOBS } from '#lib/shared/bulk-import.js';
	import { beforeNavigate, goto } from '$app/navigation';
	import type { ReadonlyURLSearchParams } from '$app/state';
	import { page } from '$app/state';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import {
		Step1PathSelector,
		DetectionGroupList,
		GroupEditorPanel,
		Step3MultiImport,
		Step3SingleImport,
		Step4Completion
	} from '#lib/components/library/import/index.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import {
		getRootFolders,
		getLibraryClassificationSettings,
		getLibraries,
		executeImport,
		detectMedia,
		getLibraryStatus,
		bulkImport,
		getBulkImportProgress,
		getLibraryJob,
		resolveUnmatched,
		trackUnmatched,
		enrollUnmatched,
		type BulkImportJob
	} from '#lib/api/index.js';
	import { searchTmdb as searchTmdbApi } from '#lib/api/index.js';
	import { getTmdb } from '#lib/api/discover.js';
	import { browseFilesystem } from '#lib/api/index.js';
	import { sortRootFoldersForMediaType } from '#lib/utils/root-folders.js';
	import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import type {
		MediaType,
		MatchResult,
		DetectionGroup,
		DetectionSection,
		TvSeasonSection
	} from '#lib/components/library/import/types.js';
	import { findUnmatchedOrigin } from '#lib/components/library/import/unmatched-origins.js';
	import type { ManualImportRequest } from '#lib/validation/schemas.js';
	import { getFileManagementSettings } from '#lib/api/settings.js';
	import { SvelteSet } from 'svelte/reactivity';

	type WizardStep = 1 | 2 | 3 | 4;

	interface BrowseEntry {
		name: string;
		path: string;
		isDirectory: boolean;
		size?: number;
	}

	interface RootFolder {
		id: string;
		name: string;
		path: string;
		mediaType: string;
		mediaSubType?: string | null;
		isDefault?: boolean;
		readOnly?: boolean;
	}

	interface DestinationLibrary {
		id: string;
		name: string;
		slug: string;
		mediaType: MediaType;
		mediaSubType?: string | null;
		isDefault?: boolean;
		isDefaultFolder?: boolean;
		defaultRootFolderId?: string | null;
		defaultRootFolderPath?: string | null;
		rootFolders?: { id: string; name: string; path: string }[];
	}

	interface DetectionResult extends DetectionGroup {
		grouped: boolean;
		totalGroups: number;
		selectedGroupId: string;
		groups: DetectionGroup[];
	}

	interface GroupReviewState {
		selectedMediaType: MediaType;
		selectedMatch: MatchResult | null;
		searchQuery: string;
		matchCandidates: MatchResult[];
		importTarget: 'new' | 'existing';
		seasonNumber: number;
		episodeNumber: number;
		batchSeasonOverride: number | null;
		selectedRootFolder: string;
		importMode: 'move' | 'copy' | 'symlink';
		preferHardlink: boolean;
	}

	interface ExecuteResult {
		success: boolean;
		mediaType: MediaType;
		tmdbId: number;
		libraryId: string;
		importedPath: string;
		importedCount?: number;
		importedPaths?: string[];
	}

	interface ImportRouteContext {
		mediaType: MediaType;
		tmdbId: number;
		libraryId: string | null;
		title: string | null;
		year: number | null;
	}

	interface ImportedBulkItem {
		title: string;
		year?: number | null;
		mediaType: MediaType;
		libraryId?: string | null;
		href?: string | null;
	}

	interface PendingNavigation {
		href: string;
		external: boolean;
	}

	type QueueMediaFilter = 'all' | MediaType;

	let step = $state<WizardStep>(1);
	let preferredMediaType = $state<'auto' | MediaType>('auto');

	let sourcePath = $state('/');
	let browserPath = $state('/');
	let browserEntries = $state<BrowseEntry[]>([]);
	let browserParentPath = $state<string | null>(null);
	let browserLoading = $state(false);
	let browserError = $state<string | null>(null);

	let rootFolders = $state<RootFolder[]>([]);
	let destinationLibraries = $state<DestinationLibrary[]>([]);
	let loadingRootFolders = $state(true);
	let enforceAnimeSubtype = $state(false);

	let detecting = $state(false);
	let detection = $state<DetectionResult | null>(null);
	let selectedGroupId = $state<string | null>(null);
	let importedGroupIds = $state<string[]>([]);
	// Maps groupId -> real library ID returned by the server after import completes.
	let importedGroupLibraryIds = $state<Record<string, string>>({});
	let skippedGroupIds = $state<string[]>([]);
	let groupReviewState = $state<Record<string, GroupReviewState>>({});
	// Unmatched-prefill (?unmatched=client:hash,…) bookkeeping: hash and
	// client progress per detection group, plus where to return when done.
	// Groups flagged inRoot live inside a managed root: the wizard cannot
	// execute their import, so Step 3 offers monitor enroll instead.
	let unmatchedOrigins = $state<
		Record<string, { hash: string; progress: number; inRoot: boolean }>
	>({});
	let unmatchedPrefillDone = $state(false);
	let unmatchedReturnUrl = $state<string | null>(null);
	let detectedGroupQuery = $state('');
	let detectedGroupFilter = $state<'all' | 'pending' | 'ready' | 'imported' | 'skipped'>('pending');
	let detectedMediaFilter = $state<QueueMediaFilter>('all');
	let importMediaFilter = $state<QueueMediaFilter>('all');
	let reviewSelectedSeriesSectionId = $state<string | null>(null);
	let reviewSelectedSeasonSectionKey = $state<string | null>(null);
	let importSelectedSeriesSectionId = $state<string | null>(null);
	let importSelectedSeasonSectionKey = $state<string | null>(null);
	let tmdbSearchDebounce: ReturnType<typeof setTimeout> | null = null;

	let selectedMediaType = $state<MediaType>('movie');
	let selectedMatch = $state<MatchResult | null>(null);
	let searchQuery = $state('');
	let searchingMatches = $state(false);
	let matchCandidates = $state<MatchResult[]>([]);
	let importTarget = $state<'new' | 'existing'>('new');
	let applySelectedMatchToSeasonOnSelect = $state(false);

	let seasonNumber = $state(1);
	let episodeNumber = $state(1);
	let batchSeasonOverride = $state<number | null>(null);
	let selectedRootFolder = $state('');
	let importMode = $state<'move' | 'copy' | 'symlink'>('move');
	let preferHardlink = $state(true);
	let bulkImportMode = $state<'move' | 'copy' | 'symlink'>('move');
	let bulkPreferHardlink = $state(true);
	let importedBulkItems = $state<ImportedBulkItem[]>([]);
	let bulkDestinationBySectionId = $state<Record<string, string>>({});
	let executingImport = $state(false);
	let executeResult = $state<ExecuteResult | null>(null);
	let executeError = $state<string | null>(null);
	let bulkImportSummary = $state<{ importedGroups: number; failedGroups: number } | null>(null);
	let bulkProgress = $state<{ completed: number; failed: number; total: number } | null>(null);
	// Direct (non-job) completions folded into the next bulk summary.
	let pendingDirectDone = $state(0);
	let pendingDirectErrors = $state<string[]>([]);
	let bulkCurrentGroup = $state<string | null>(null);
	let backgroundImport = $state(false);
	let backgroundJobPoll: ReturnType<typeof setInterval> | null = null;
	// Cache keyed by "{tmdbId}-S{season}" → map of episodeNumber → title
	let episodeTitleCache = $state<Record<string, Record<number, string>>>({});
	let bypassNavigationGuard = false;
	let leaveImportModalOpen = $state(false);
	let pendingNavigation = $state<PendingNavigation | null>(null);
	let lastNewSessionToken = $state<string | null>(null);
	const routeImportContext = $derived.by(() => parseImportContext(page.url.searchParams));
	const isDirectLibraryImportContext = $derived.by(() => Boolean(routeImportContext?.libraryId));
	const isMediaTypeLockedByContext = $derived.by(() => Boolean(routeImportContext));
	const lockedMediaType = $derived.by(() => routeImportContext?.mediaType ?? undefined);
	const isFileOnlyContext = $derived.by(() =>
		Boolean(
			routeImportContext && routeImportContext.mediaType === 'movie' && routeImportContext.libraryId
		)
	);

	const detectionGroups = $derived.by(() => {
		if (!detection) return [];
		if (Array.isArray(detection.groups) && detection.groups.length > 0) {
			return detection.groups;
		}
		return [toDetectionGroup(detection)];
	});

	const activeGroup = $derived.by(() => {
		if (detectionGroups.length === 0) return null;
		if (!selectedGroupId) return detectionGroups[0];
		return detectionGroups.find((group) => group.id === selectedGroupId) ?? detectionGroups[0];
	});
	const isSingleFileSelection = $derived.by(() =>
		Boolean(activeGroup && detectionGroups.length === 1 && activeGroup.sourceType === 'file')
	);
	const skipActionsEnabled = $derived.by(() => !isSingleFileSelection);
	const selectedMatchContextMismatch = $derived.by(() => {
		const context = routeImportContext;
		if (!context || !selectedMatch) {
			return false;
		}
		return selectedMatch.mediaType === context.mediaType && selectedMatch.tmdbId !== context.tmdbId;
	});
	const parsedSourceContextMismatch = $derived.by(() => {
		const context = routeImportContext;
		const group = activeGroup;
		if (!context || !group || !context.title) {
			return false;
		}

		const normalizedParsedTitle = normalizeTitleForComparison(group.parsedTitle || '');
		const normalizedContextTitle = normalizeTitleForComparison(context.title);
		if (!normalizedParsedTitle || !normalizedContextTitle) {
			return false;
		}

		if (normalizedParsedTitle !== normalizedContextTitle) {
			return true;
		}

		if (context.year && group.parsedYear && Math.abs(context.year - group.parsedYear) > 1) {
			return true;
		}

		return false;
	});

	const isActiveGroupImported = $derived.by(() =>
		Boolean(activeGroup && importedGroupIds.includes(activeGroup.id))
	);
	const activeUnmatchedOrigin = $derived.by(() =>
		activeGroup ? (unmatchedOrigins[activeGroup.id] ?? null) : null
	);
	const activeUnmatchedInRoot = $derived.by(
		() => activeUnmatchedOrigin != null && activeUnmatchedOrigin.inRoot
	);
	const step2Ready = $derived(Boolean(activeGroup && selectedMatch && !isActiveGroupImported));
	const destinationLibrariesForType = $derived(
		getAvailableDestinationLibrariesForType(selectedMediaType, selectedMatch)
	);
	const isBatchTvImport = $derived(
		Boolean(activeGroup && selectedMediaType === 'tv' && activeGroup.detectedFileCount > 1)
	);
	const remainingGroupCount = $derived.by(
		() =>
			detectionGroups.filter(
				(group) => !importedGroupIds.includes(group.id) && !skippedGroupIds.includes(group.id)
			).length
	);
	const pendingGroupCount = $derived.by(
		() =>
			detectionGroups.filter(
				(group) =>
					!importedGroupIds.includes(group.id) &&
					!skippedGroupIds.includes(group.id) &&
					!canImportGroup(group)
			).length
	);
	const skippedGroupCount = $derived.by(
		() => detectionGroups.filter((group) => skippedGroupIds.includes(group.id)).length
	);
	const readyGroupCount = $derived.by(
		() =>
			detectionGroups.filter(
				(group) =>
					!importedGroupIds.includes(group.id) &&
					!skippedGroupIds.includes(group.id) &&
					canImportGroup(group)
			).length
	);
	const isMultiGroupReview = $derived(detectionGroups.length > 1);
	const selectedImportGroupCount = $derived.by(
		() =>
			detectionGroups.filter(
				(group) => !importedGroupIds.includes(group.id) && !skippedGroupIds.includes(group.id)
			).length
	);
	const selectedNeedsInputCount = $derived.by(
		() =>
			detectionGroups.filter(
				(group) =>
					!importedGroupIds.includes(group.id) &&
					!skippedGroupIds.includes(group.id) &&
					!canImportGroup(group)
			).length
	);
	const canProceedFromReview = $derived.by(() => {
		if (isMultiGroupReview) {
			return selectedImportGroupCount > 0;
		}
		return step2Ready && !isGroupSkipped(activeGroup?.id ?? '');
	});
	const filteredDetectionGroups = $derived.by(() => {
		const query = detectedGroupQuery.trim().toLowerCase();

		const filtered = detectionGroups.filter((group) => {
			const isImported = importedGroupIds.includes(group.id);
			const isSkipped = skippedGroupIds.includes(group.id);
			const isRemaining = !isImported && !isSkipped;
			const isReady = isRemaining && canImportGroup(group);
			const isPending = isRemaining && !isReady;

			if (detectedGroupFilter === 'imported' && !isImported) return false;
			if (detectedGroupFilter === 'skipped' && !isSkipped) return false;
			if (detectedGroupFilter === 'pending' && !isPending) return false;
			if (detectedGroupFilter === 'ready' && !isReady) return false;

			if (!query) return true;

			return (
				group.displayName.toLowerCase().includes(query) ||
				group.sourcePath.toLowerCase().includes(query) ||
				group.parsedTitle.toLowerCase().includes(query)
			);
		});

		return filtered.sort(
			(a, b) =>
				a.displayName.localeCompare(b.displayName, undefined, { numeric: true }) ||
				a.id.localeCompare(b.id, undefined, { numeric: true })
		);
	});
	const filteredDetectionGroupsByMedia = $derived.by(() =>
		filteredDetectionGroups.filter((group) => {
			if (detectedMediaFilter === 'all') {
				return true;
			}
			return getEffectiveMediaType(group) === detectedMediaFilter;
		})
	);
	const reviewDetectionSections = $derived.by(() =>
		buildDetectionSections(filteredDetectionGroupsByMedia)
	);
	const selectedImportGroups = $derived.by(() =>
		detectionGroups.filter((group) => !isGroupImported(group.id) && !isGroupSkipped(group.id))
	);
	const selectedImportGroupsByMedia = $derived.by(() =>
		selectedImportGroups.filter((group) => {
			if (importMediaFilter === 'all') {
				return true;
			}
			return getEffectiveMediaType(group) === importMediaFilter;
		})
	);
	const importSelectionSections = $derived.by(() =>
		buildDetectionSections(selectedImportGroupsByMedia)
	);
	const reviewMovieSections = $derived.by(() =>
		reviewDetectionSections.filter((section) => section.mediaType === 'movie')
	);
	const reviewTvSections = $derived.by(() =>
		reviewDetectionSections.filter((section) => section.mediaType === 'tv')
	);
	const activeReviewTvSection = $derived.by(() => {
		if (reviewTvSections.length === 0) return null;
		if (!reviewSelectedSeriesSectionId) return reviewTvSections[0];

		return (
			reviewTvSections.find((section) => section.id === reviewSelectedSeriesSectionId) ??
			reviewTvSections[0]
		);
	});
	const activeReviewSeasonSection = $derived.by(() => {
		if (!activeReviewTvSection?.seasonSections || activeReviewTvSection.seasonSections.length === 0)
			return null;
		if (!reviewSelectedSeasonSectionKey) {
			return activeReviewTvSection.seasonSections[0];
		}

		return (
			activeReviewTvSection.seasonSections.find(
				(seasonSection) => seasonSection.key === reviewSelectedSeasonSectionKey
			) ?? activeReviewTvSection.seasonSections[0]
		);
	});
	const canApplyMatchSelectionToActiveSeason = $derived.by(() =>
		Boolean(
			selectedMediaType === 'tv' &&
			activeReviewSeasonSection &&
			getSkippableSeasonGroups(activeReviewSeasonSection).length > 0
		)
	);
	const hasMultipleReviewTvSeries = $derived.by(() => reviewTvSections.length > 1);

	const importMovieSections = $derived.by(() =>
		importSelectionSections.filter((section) => section.mediaType === 'movie')
	);
	const importTvSections = $derived.by(() =>
		importSelectionSections.filter((section) => section.mediaType === 'tv')
	);
	const activeImportTvSection = $derived.by(() => {
		if (importTvSections.length === 0) return null;
		if (!importSelectedSeriesSectionId) return importTvSections[0];

		return (
			importTvSections.find((section) => section.id === importSelectedSeriesSectionId) ??
			importTvSections[0]
		);
	});
	const activeImportSeasonSection = $derived.by(() => {
		if (!activeImportTvSection?.seasonSections || activeImportTvSection.seasonSections.length === 0)
			return null;
		if (!importSelectedSeasonSectionKey) {
			return activeImportTvSection.seasonSections[0];
		}

		return (
			activeImportTvSection.seasonSections.find(
				(seasonSection) => seasonSection.key === importSelectedSeasonSectionKey
			) ?? activeImportTvSection.seasonSections[0]
		);
	});
	const hasMultipleImportTvSeries = $derived.by(() => importTvSections.length > 1);

	const canProceedToImport = $derived.by(() => {
		if (
			!selectedMatch ||
			!activeGroup ||
			isActiveGroupImported ||
			skippedGroupIds.includes(activeGroup.id)
		)
			return false;
		if (!isBatchTvImport && selectedMediaType === 'tv' && (seasonNumber < 0 || episodeNumber < 1))
			return false;
		if (selectedMatch.inLibrary && importTarget !== 'existing') return false;

		if (importTarget === 'existing') {
			return selectedMatch.inLibrary;
		}

		if (destinationLibrariesForType.length === 0) return false;
		if (destinationLibrariesForType.length === 1) return true;
		return selectedRootFolder.length > 0;
	});

	const hasActiveImportSession = $derived.by(
		() => Boolean(detection) && (step === 2 || step === 3 || (executingImport && !bulkProgress))
	);

	beforeNavigate((navigation) => {
		if (navigation.shallow && navigation.type === 'goto') return;

		if (bypassNavigationGuard || !hasActiveImportSession) {
			return;
		}
		if (navigation.willUnload) {
			return;
		}

		const destinationUrl = navigation.to?.url;
		if (destinationUrl && destinationUrl.href === page.url.href) {
			return;
		}

		if (destinationUrl) {
			pendingNavigation = {
				href: destinationUrl.href,
				external: destinationUrl.origin !== window.location.origin
			};
			leaveImportModalOpen = true;
		}
		navigation.cancel();
	});

	let defaultImportFolder = $state<string | undefined>(undefined);

	$effect(() => {
		loadRootFolders();
		getFileManagementSettings().then((s) => {
			if (s?.importMode === 'copy' || s?.importMode === 'symlink') {
				importMode = s.importMode;
				bulkImportMode = s.importMode;
			}
			if (typeof s?.preferHardlink === 'boolean') {
				preferHardlink = s.preferHardlink;
				bulkPreferHardlink = s.preferHardlink;
			}
			const startPath = s?.defaultImportFolder?.trim() || '/';
			defaultImportFolder = startPath;
			browse(startPath);
		});
		return () => {
			stopBackgroundImportPoll();
		};
	});

	$effect(() => {
		const context = routeImportContext;
		if (!context) return;
		if (preferredMediaType !== context.mediaType) {
			preferredMediaType = context.mediaType;
		}
	});

	$effect(() => {
		if (unmatchedPrefillDone) return;
		const raw = page.url.searchParams.get('unmatched');
		if (!raw) return;
		unmatchedPrefillDone = true;
		void (async () => {
			await loadRootFolders();
			await prefillUnmatched(raw);
		})();
	});

	$effect(() => {
		const newSessionToken = page.url.searchParams.get('newSession');
		if (!newSessionToken || newSessionToken === lastNewSessionToken) {
			return;
		}
		lastNewSessionToken = newSessionToken;
		resetWizard();
	});

	$effect(() => {
		let nextRootFolder = selectedRootFolder;
		if (destinationLibrariesForType.length === 0) {
			nextRootFolder = '';
		} else if (!destinationLibrariesForType.some((library) => library.id === selectedRootFolder)) {
			nextRootFolder =
				getRecommendedDestinationLibraryId(destinationLibrariesForType, {
					preferAnime: selectedMatch?.isAnime === true
				}) ?? '';
		}

		if (nextRootFolder !== selectedRootFolder) {
			selectedRootFolder = nextRootFolder;
			persistActiveGroupState();
		}
	});

	$effect(() => {
		if (!detection || detectionGroups.length === 0) return;
		if (Object.keys(groupReviewState).length === 0) return;

		let updated = false;
		const nextState: Record<string, GroupReviewState> = { ...groupReviewState };

		for (const group of detectionGroups) {
			const state = nextState[group.id];
			if (!state) continue;

			const libraries = getAvailableDestinationLibrariesForType(
				state.selectedMediaType,
				state.selectedMatch
			);
			const hasValidSelection =
				state.selectedRootFolder.length > 0 &&
				libraries.some((library) => library.id === state.selectedRootFolder);
			const recommendedRootFolder =
				getRecommendedDestinationLibraryId(libraries, {
					preferAnime: state.selectedMatch?.isAnime === true
				}) ?? '';

			if (!hasValidSelection && state.selectedRootFolder !== recommendedRootFolder) {
				nextState[group.id] = {
					...state,
					selectedRootFolder: recommendedRootFolder
				};
				updated = true;
			}
		}

		if (updated) {
			groupReviewState = nextState;
			if (selectedGroupId && nextState[selectedGroupId]) {
				selectedRootFolder = nextState[selectedGroupId].selectedRootFolder;
			}
		}
	});

	$effect(() => {
		if (!selectedMatch) {
			return;
		}

		const nextImportTarget = selectedMatch.inLibrary
			? 'existing'
			: importTarget === 'existing'
				? 'new'
				: importTarget;
		if (nextImportTarget !== importTarget) {
			importTarget = nextImportTarget;
			persistActiveGroupState();
		}
	});

	$effect(() => {
		if (step !== 2) {
			return;
		}
		if (reviewTvSections.length === 0) {
			reviewSelectedSeriesSectionId = null;
			reviewSelectedSeasonSectionKey = null;
			return;
		}

		if (!reviewTvSections.some((section) => section.id === reviewSelectedSeriesSectionId)) {
			reviewSelectedSeriesSectionId = reviewTvSections[0].id;
			reviewSelectedSeasonSectionKey = null;
		}
	});

	$effect(() => {
		if (!canApplyMatchSelectionToActiveSeason) {
			applySelectedMatchToSeasonOnSelect = false;
		}
	});

	$effect(() => {
		if (step !== 2) {
			return;
		}
		const activeSection = activeReviewTvSection;
		if (
			!activeSection ||
			!activeSection.seasonSections ||
			activeSection.seasonSections.length === 0
		) {
			reviewSelectedSeasonSectionKey = null;
			return;
		}
		if (
			!reviewSelectedSeasonSectionKey ||
			!activeSection.seasonSections.some(
				(seasonSection) => seasonSection.key === reviewSelectedSeasonSectionKey
			)
		) {
			reviewSelectedSeasonSectionKey = activeSection.seasonSections[0].key;
		}
	});

	$effect(() => {
		if (step !== 3) {
			return;
		}
		if (importTvSections.length === 0) {
			importSelectedSeriesSectionId = null;
			importSelectedSeasonSectionKey = null;
			return;
		}
		if (!importTvSections.some((section) => section.id === importSelectedSeriesSectionId)) {
			importSelectedSeriesSectionId = importTvSections[0].id;
			importSelectedSeasonSectionKey = null;
		}
	});

	$effect(() => {
		if (step !== 3) {
			return;
		}

		const nextSelections = { ...bulkDestinationBySectionId };
		let changed = false;

		for (const section of importSelectionSections) {
			const options = getSectionDestinationOptions(section);
			if (options.length === 0) {
				if (nextSelections[section.id]) {
					delete nextSelections[section.id];
					changed = true;
				}
				continue;
			}

			const current = nextSelections[section.id];
			if (!current || !options.some((folder) => folder.id === current)) {
				nextSelections[section.id] = getRecommendedSectionDestinationId(section, options);
				changed = true;
			}
		}

		if (changed) {
			bulkDestinationBySectionId = nextSelections;
		}
	});

	$effect(() => {
		if (step !== 3) {
			return;
		}
		const activeSection = activeImportTvSection;
		if (
			!activeSection ||
			!activeSection.seasonSections ||
			activeSection.seasonSections.length === 0
		) {
			importSelectedSeasonSectionKey = null;
			return;
		}
		if (
			!importSelectedSeasonSectionKey ||
			!activeSection.seasonSections.some(
				(seasonSection) => seasonSection.key === importSelectedSeasonSectionKey
			)
		) {
			importSelectedSeasonSectionKey = activeSection.seasonSections[0].key;
		}
	});

	$effect(() => {
		if (step !== 2) {
			return;
		}
		if (detectedGroupFilter !== 'pending') {
			return;
		}
		if (pendingGroupCount === 0 && readyGroupCount > 0) {
			detectedGroupFilter = 'ready';
		}
	});

	// Fetch TMDB episode titles for matched TV groups and cache by tmdbId+season
	$effect(() => {
		if (step !== 2 && step !== 3) return;
		for (const group of detectionGroups) {
			if (getEffectiveMediaType(group) !== 'tv' || group.detectedFileCount > 1) continue;
			const state = groupReviewState[group.id];
			if (!state) continue;
			const tmdbId = state.selectedMatch?.tmdbId;
			const season = state.seasonNumber;
			if (!tmdbId || season < 0) continue;
			const cacheKey = `${tmdbId}-S${season}`;
			if (cacheKey in episodeTitleCache) continue;
			episodeTitleCache = { ...episodeTitleCache, [cacheKey]: {} };
			fetchSeasonEpisodeTitles(tmdbId, season, cacheKey);
		}
	});

	async function fetchSeasonEpisodeTitles(tmdbId: number, season: number, cacheKey: string) {
		try {
			const data = (await getTmdb(`tv/${tmdbId}/season/${season}`)) as {
				episodes?: Array<{ episode_number?: number; name?: string }>;
			} | null;
			if (data?.episodes && Array.isArray(data.episodes)) {
				const titles: Record<number, string> = {};
				for (const ep of data.episodes) {
					if (typeof ep.episode_number === 'number' && ep.name) {
						titles[ep.episode_number] = ep.name;
					}
				}
				episodeTitleCache = { ...episodeTitleCache, [cacheKey]: titles };
			}
		} catch {
			// episode titles are a nice-to-have - silently skip on error
		}
	}

	async function loadRootFolders() {
		loadingRootFolders = true;
		try {
			const [foldersResult, classificationResult, librariesResult] = await Promise.allSettled([
				getRootFolders(),
				getLibraryClassificationSettings(),
				getLibraries({ includeSystem: true })
			]);

			if (foldersResult.status === 'rejected') throw foldersResult.reason;

			const foldersPayload = foldersResult.value;
			if (Array.isArray(foldersPayload)) {
				rootFolders = foldersPayload;
			} else if (foldersPayload && typeof foldersPayload === 'object') {
				rootFolders = (foldersPayload as { folders?: RootFolder[] }).folders ?? [];
			} else {
				rootFolders = [];
			}

			enforceAnimeSubtype = false;
			if (classificationResult.status === 'fulfilled') {
				const classificationPayload = classificationResult.value;
				enforceAnimeSubtype = Boolean(
					classificationPayload &&
					typeof classificationPayload === 'object' &&
					(classificationPayload as { enforceAnimeSubtype?: boolean }).enforceAnimeSubtype === true
				);
			}

			destinationLibraries = [];
			if (librariesResult.status === 'fulfilled') {
				const librariesPayload = librariesResult.value;
				if (
					librariesPayload &&
					typeof librariesPayload === 'object' &&
					Array.isArray((librariesPayload as { libraries?: DestinationLibrary[] }).libraries)
				) {
					destinationLibraries = (
						(librariesPayload as { libraries?: DestinationLibrary[] }).libraries ?? []
					).map((lib) => ({
						...lib,
						rootFolders:
							(
								lib as DestinationLibrary & {
									rootFolders?: { id: string; name: string; path: string }[];
								}
							).rootFolders ?? []
					}));
				}
			}
		} catch {
			toasts.error(m.toast_library_import_failedToLoadRootFolders());
		} finally {
			loadingRootFolders = false;
		}
	}

	async function browse(path?: string) {
		browserLoading = true;
		browserError = null;
		try {
			const payload = await browseFilesystem(path, {
				includeFiles: true,
				fileFilter: 'video',
				excludeManagedRoots: true
			});

			if (!payload || typeof payload !== 'object') {
				browserError = 'Invalid response from filesystem browser';
				return;
			}

			const data = payload as {
				currentPath?: string;
				parentPath?: string | null;
				entries?: BrowseEntry[];
				error?: string;
			};

			if (data.error) {
				browserError = data.error;
			}
			browserPath = data.currentPath ?? path ?? '';
			if (!sourcePath && data.currentPath) {
				sourcePath = data.currentPath;
			}
			browserParentPath = data.parentPath ?? null;
			browserEntries = data.entries ?? [];
		} catch (error) {
			browserError = error instanceof Error ? error.message : 'Failed to browse path';
		} finally {
			browserLoading = false;
		}
	}

	function parseImportContext(
		searchParams: URLSearchParams | ReadonlyURLSearchParams
	): ImportRouteContext | null {
		const mediaType = searchParams.get('mediaType');
		if (mediaType !== 'movie' && mediaType !== 'tv') {
			return null;
		}

		const tmdbIdRaw = searchParams.get('tmdbId');
		const tmdbId = tmdbIdRaw ? Number.parseInt(tmdbIdRaw, 10) : Number.NaN;
		if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
			return null;
		}

		const libraryIdValue = searchParams.get('libraryId');
		const titleValue = searchParams.get('title');
		const yearRaw = searchParams.get('year');
		let parsedYear: number | null = null;
		if (yearRaw) {
			const year = Number.parseInt(yearRaw, 10);
			if (Number.isFinite(year) && year > 0) {
				parsedYear = year;
			}
		}

		return {
			mediaType,
			tmdbId,
			libraryId: libraryIdValue?.trim() || null,
			title: titleValue?.trim() || null,
			year: parsedYear
		};
	}

	function buildRouteContextMatch(group: DetectionGroup): MatchResult | null {
		const context = routeImportContext;
		if (!context) return null;

		return {
			tmdbId: context.tmdbId,
			title: context.title || group.parsedTitle || group.displayName,
			year: context.year ?? group.parsedYear,
			mediaType: context.mediaType,
			confidence: 1,
			inLibrary: Boolean(context.libraryId),
			libraryId: context.libraryId ?? undefined
		} satisfies MatchResult;
	}

	function toDetectionGroup(result: DetectionResult): DetectionGroup {
		return {
			id: result.id || result.sourcePath,
			displayName: result.displayName || result.fileName,
			sourceType: result.sourceType || 'file',
			sourcePath: result.sourcePath,
			selectedFilePath: result.selectedFilePath,
			fileName: result.fileName,
			detectedFileCount: result.detectedFileCount,
			detectedSeasons: result.detectedSeasons,
			suggestedSeason: result.suggestedSeason,
			parsedTitle: result.parsedTitle,
			parsedYear: result.parsedYear,
			parsedSeason: result.parsedSeason,
			parsedEpisode: result.parsedEpisode,
			parsedEpisodes: result.parsedEpisodes,
			inferredMediaType: result.inferredMediaType,
			matches: result.matches ?? []
		};
	}

	function createInitialGroupState(group: DetectionGroup): GroupReviewState {
		const initialCandidates = group.matches ?? [];
		const initialMatch = initialCandidates[0] ?? null;
		const initialRootFolder = getRecommendedDestinationLibraryId(
			getAvailableDestinationLibrariesForType(group.inferredMediaType, initialMatch),
			{
				preferAnime: initialMatch?.isAnime === true
			}
		);
		return {
			selectedMediaType: group.inferredMediaType,
			selectedMatch: initialMatch,
			searchQuery: group.parsedTitle,
			matchCandidates: initialCandidates,
			importTarget: initialMatch?.inLibrary ? 'existing' : 'new',
			seasonNumber: group.parsedSeason ?? 1,
			episodeNumber: group.parsedEpisode ?? 1,
			batchSeasonOverride: group.suggestedSeason ?? null,
			selectedRootFolder: initialRootFolder ?? '',
			importMode,
			preferHardlink
		};
	}

	function loadGroupState(groupId: string) {
		const existing = groupReviewState[groupId];
		const group = detectionGroups.find((item) => item.id === groupId);
		const state = existing ?? (group ? createInitialGroupState(group) : null);
		if (!state) return;

		if (!existing) {
			groupReviewState = {
				...groupReviewState,
				[groupId]: state
			};
		}

		selectedMediaType = state.selectedMediaType;
		selectedMatch = state.selectedMatch;
		searchQuery = state.searchQuery;
		matchCandidates = state.matchCandidates;
		importTarget = state.importTarget;
		seasonNumber = state.seasonNumber;
		episodeNumber = state.episodeNumber;
		batchSeasonOverride = state.batchSeasonOverride;
		selectedRootFolder = state.selectedRootFolder;
		importMode = state.importMode;
		preferHardlink = state.preferHardlink;
	}

	function persistActiveGroupState() {
		if (!selectedGroupId) return;
		groupReviewState = {
			...groupReviewState,
			[selectedGroupId]: {
				selectedMediaType,
				selectedMatch,
				searchQuery,
				matchCandidates,
				importTarget,
				seasonNumber,
				episodeNumber,
				batchSeasonOverride,
				selectedRootFolder,
				importMode,
				preferHardlink
			}
		};
	}

	function handleSeasonNumberChange() {
		if (!selectedGroupId) {
			return;
		}

		const group = detectionGroups.find((item) => item.id === selectedGroupId);
		if (!group) {
			persistActiveGroupState();
			return;
		}

		let nextBatchSeasonOverride = batchSeasonOverride;
		if (selectedMediaType === 'tv' && !isBatchTvImport && typeof group.parsedSeason !== 'number') {
			nextBatchSeasonOverride = seasonNumber >= 0 ? seasonNumber : null;
			batchSeasonOverride = nextBatchSeasonOverride;
		}

		groupReviewState = {
			...groupReviewState,
			[selectedGroupId]: {
				selectedMediaType,
				selectedMatch,
				searchQuery,
				matchCandidates,
				importTarget,
				seasonNumber,
				episodeNumber,
				batchSeasonOverride: nextBatchSeasonOverride,
				selectedRootFolder,
				importMode,
				preferHardlink
			}
		};
	}

	function canApplyActiveSeasonOverride(): boolean {
		if (!activeGroup) return false;
		if (selectedMediaType !== 'tv' || isBatchTvImport) return false;
		return typeof activeGroup.parsedSeason !== 'number';
	}

	function switchGroup(groupId: string) {
		if (groupId === selectedGroupId) return;
		persistActiveGroupState();
		selectedGroupId = groupId;
		loadGroupState(groupId);
		maybeAutoSearchUnmatchedShell(groupId);
	}

	/**
	 * Shell groups (unmatched in-root sources) arrive with no candidates:
	 * run the prefilled clean-title search so the user reviews, not types.
	 * Normal groups are untouched — their review UX stays as-is.
	 */
	function maybeAutoSearchUnmatchedShell(groupId: string) {
		const origin = unmatchedOrigins[groupId];
		if (!origin || !origin.inRoot) return;
		const state = groupReviewState[groupId];
		if (!state || state.selectedMatch) return;
		if (!state.searchQuery.trim()) return;
		void searchTmdb();
	}

	function markGroupImported(groupId: string) {
		if (importedGroupIds.includes(groupId)) return;
		importedGroupIds = [...importedGroupIds, groupId];
		skippedGroupIds = skippedGroupIds.filter((id) => id !== groupId);
	}

	function markGroupSkipped(groupId: string) {
		if (!skipActionsEnabled) return;
		if (importedGroupIds.includes(groupId)) return;
		if (skippedGroupIds.includes(groupId)) return;
		skippedGroupIds = [...skippedGroupIds, groupId];
	}

	function unskipGroup(groupId: string) {
		if (!skippedGroupIds.includes(groupId)) return;
		skippedGroupIds = skippedGroupIds.filter((id) => id !== groupId);
	}

	function toggleSkipActiveGroup() {
		if (!skipActionsEnabled) return;
		if (!activeGroup) return;
		if (skippedGroupIds.includes(activeGroup.id)) {
			unskipGroup(activeGroup.id);
			return;
		}
		markGroupSkipped(activeGroup.id);
	}

	function continueWithNextDetected() {
		const nextGroup = detectionGroups.find(
			(group) => !importedGroupIds.includes(group.id) && !skippedGroupIds.includes(group.id)
		);
		if (!nextGroup) {
			// Unmatched prefill ending here must leave the page: resetting
			// with ?unmatched= still in the URL would re-resolve the just
			// tracked torrents straight back into review.
			if (unmatchedReturnUrl) {
				bypassNavigationGuard = true;
				void goto(unmatchedReturnUrl);
				return;
			}
			resetWizard();
			return;
		}
		switchGroup(nextGroup.id);
		step = 2;
	}

	function getRequiredRootFolderSubType(
		match: MatchResult | null | undefined
	): 'standard' | 'anime' | undefined {
		if (!enforceAnimeSubtype) return undefined;
		if (match?.isAnime === true) return 'anime';
		if (match?.isAnime === false) return 'standard';
		return undefined;
	}

	function getWritableRootFoldersForType(
		mediaType: MediaType,
		match: MatchResult | null = null
	): RootFolder[] {
		const writableFolders = rootFolders.filter((folder) => !folder.readOnly);
		return sortRootFoldersForMediaType(
			writableFolders,
			mediaType,
			getRequiredRootFolderSubType(match)
		);
	}

	function getAvailableDestinationLibrariesForType(
		mediaType: MediaType,
		match: MatchResult | null = null
	): DestinationLibrary[] {
		const allowedFolders = getWritableRootFoldersForType(mediaType, match);
		if (allowedFolders.length === 0) return [];

		const allowedRootFolderIds = new Set(allowedFolders.map((folder) => folder.id));
		const result: DestinationLibrary[] = [];

		for (const library of destinationLibraries) {
			if (library.mediaType !== mediaType) continue;

			// Expand each allowed root folder of this library into its own option.
			// This lets users pick any root folder, not just the library default.
			const eligibleFolders = (library.rootFolders ?? []).filter((rf) =>
				allowedRootFolderIds.has(rf.id)
			);

			if (eligibleFolders.length > 0) {
				for (const rf of eligibleFolders) {
					result.push({
						...library,
						id: rf.id,
						defaultRootFolderId: rf.id,
						defaultRootFolderPath: rf.path,
						isDefaultFolder: rf.id === library.defaultRootFolderId
					});
				}
			} else if (
				library.defaultRootFolderId &&
				allowedRootFolderIds.has(library.defaultRootFolderId)
			) {
				// Fallback when rootFolders array is absent but defaultRootFolderId is valid
				result.push({ ...library, id: library.defaultRootFolderId, isDefaultFolder: true });
			}
		}

		return result.sort((a, b) => {
			// Prefer: default library first, then default folder within library, then alphabetical
			const libDefault = Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault));
			if (libDefault !== 0) return libDefault;
			const folderDefault = Number(Boolean(b.isDefaultFolder)) - Number(Boolean(a.isDefaultFolder));
			if (folderDefault !== 0) return folderDefault;

			return (
				a.name.localeCompare(b.name) ||
				(a.defaultRootFolderPath ?? '').localeCompare(b.defaultRootFolderPath ?? '')
			);
		});
	}

	function getRecommendedDestinationLibraryId(
		libraries: DestinationLibrary[],
		options?: { preferAnime?: boolean }
	): string | undefined {
		if (libraries.length === 0) return undefined;

		const preferAnime = options?.preferAnime === true;

		// Each entry's id is a root folder ID. Prefer the one the user flagged as
		// default in Settings > Library & Storage > Root Folders, which matches AddToLibraryModal.
		const globalDefaultRootFolderIds = new Set(
			rootFolders.filter((rf) => rf.isDefault).map((rf) => rf.id)
		);
		const globalDefaultId = libraries.find((lib) => globalDefaultRootFolderIds.has(lib.id))?.id;

		if (preferAnime) {
			return (
				libraries.find(
					(library) => library.isDefault && (library.mediaSubType ?? 'standard') === 'anime'
				)?.id ??
				globalDefaultId ??
				libraries.find(
					(library) => library.isDefault && (library.mediaSubType ?? 'standard') === 'standard'
				)?.id ??
				libraries.find((library) => library.isDefault)?.id ??
				libraries[0].id
			);
		}

		return (
			globalDefaultId ??
			libraries.find(
				(library) => library.isDefault && (library.mediaSubType ?? 'standard') === 'standard'
			)?.id ??
			libraries.find((library) => library.isDefault)?.id ??
			libraries[0].id
		);
	}

	function isGroupImported(groupId: string): boolean {
		return importedGroupIds.includes(groupId);
	}

	function isGroupSkipped(groupId: string): boolean {
		return skippedGroupIds.includes(groupId);
	}

	/**
	 * Action badge for unmatched in-root groups: 'link' when the library
	 * already holds the complete file (the bulk/single dispatch will track),
	 * 'enroll' when it will enroll for monitor import, null otherwise
	 * (normal groups stay unlabeled). Mirrors the dispatch rules so the
	 * label never promises what the button won't do.
	 */
	/**
	 * Single source of truth for what an unmatched in-root group will do:
	 * 'link' when the library already holds the complete file, 'enroll'
	 * when it will enroll for monitor import, null otherwise. The enroll
	 * view, the bulk dispatcher and the row badges all read this — the
	 * label never promises what the button won't do.
	 */
	function resolveUnmatchedGroupAction(groupId: string): 'link' | 'enroll' | null {
		const origin = unmatchedOrigins[groupId];
		if (!origin?.inRoot) return null;
		const match = groupReviewState[groupId]?.selectedMatch;
		if (!match) return null;
		if (match.inLibrary && match.hasFile && origin.progress >= 1) return 'link';
		return 'enroll';
	}

	function getUnmatchedGroupAction(group: DetectionGroup): 'link' | 'enroll' | null {
		return resolveUnmatchedGroupAction(group.id);
	}

	function getGroupState(group: DetectionGroup): GroupReviewState {
		return groupReviewState[group.id] ?? createInitialGroupState(group);
	}

	function getEffectiveMediaType(group: DetectionGroup): MediaType {
		return getGroupState(group).selectedMediaType;
	}

	function buildDetectionSections(groups: DetectionGroup[]): DetectionSection[] {
		const sections: DetectionSection[] = [];
		const tvSectionIndex: Record<string, number> = {};

		for (const group of groups) {
			const mediaType = getEffectiveMediaType(group);
			if (mediaType === 'movie') {
				sections.push({
					id: `movie:${group.id}`,
					label: group.displayName,
					mediaType: 'movie',
					items: [group]
				});
				continue;
			}

			const key = getTvSeriesSectionKey(group);
			const existingIndex = tvSectionIndex[key];
			if (existingIndex === undefined) {
				const section: DetectionSection = {
					id: key,
					label: getTvSeriesSectionLabel(group),
					mediaType: 'tv',
					items: [],
					seasonSections: []
				};
				sections.push(section);
				tvSectionIndex[key] = sections.length - 1;
			} else {
				sections[existingIndex].items.push(group);
				continue;
			}
			sections[tvSectionIndex[key]].items.push(group);
		}

		for (const section of sections) {
			section.items.sort((a, b) =>
				a.displayName.localeCompare(b.displayName, undefined, { numeric: true })
			);
			if (section.mediaType === 'tv') {
				section.seasonSections = buildTvSeasonSections(section.items);
			}
		}

		return sections;
	}

	function getTvSeriesSectionKey(group: DetectionGroup): string {
		const state = getGroupState(group);
		const match = state.selectedMatch;
		if (match && match.mediaType === 'tv') {
			return `tv:tmdb:${match.tmdbId}`;
		}
		const normalizedParsedTitle = normalizeGroupingKey(group.parsedTitle || group.displayName);
		const year = group.parsedYear ? `:${group.parsedYear}` : '';
		return `tv:parsed:${normalizedParsedTitle}${year}`;
	}

	function getTvSeriesSectionLabel(group: DetectionGroup): string {
		const state = getGroupState(group);
		const match = state.selectedMatch;
		if (match && match.mediaType === 'tv') {
			return match.year ? `${match.title} (${match.year})` : match.title;
		}
		const parsedTitle = group.parsedTitle?.trim();
		if (parsedTitle) {
			return group.parsedYear ? `${parsedTitle} (${group.parsedYear})` : parsedTitle;
		}
		return m.library_import_unmatchedTvSeries();
	}

	function normalizeGroupingKey(value: string): string {
		return value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim()
			.replace(/\s+/g, '-');
	}

	function normalizeTitleForComparison(value: string): string {
		return value
			.toLowerCase()
			.replace(/^(?:the|an?)\s+/, '') // Remove leading articles before stripping spaces
			.replace(/[^a-z0-9]/g, '');
	}

	function buildTvSeasonSections(items: DetectionGroup[]): TvSeasonSection[] {
		const sectionIndex: Record<string, number> = {};
		const sections: TvSeasonSection[] = [];

		for (const group of items) {
			const seasonNumber = getGroupSeasonNumber(group);
			const key = seasonNumber === null ? 'unknown' : `s${seasonNumber}`;
			const existingIndex = sectionIndex[key];

			if (existingIndex === undefined) {
				sections.push({
					key,
					label:
						seasonNumber === null
							? m.library_import_seasonUnmapped()
							: m.library_import_seasonNumber({ number: seasonNumber }),
					seasonNumber,
					items: [group]
				});
				sectionIndex[key] = sections.length - 1;
				continue;
			}

			sections[existingIndex].items.push(group);
		}

		for (const section of sections) {
			section.items.sort((a, b) =>
				a.displayName.localeCompare(b.displayName, undefined, { numeric: true })
			);
		}

		return sections.sort((a, b) => {
			if (a.seasonNumber === null && b.seasonNumber === null) return 0;
			if (a.seasonNumber === null) return 1;
			if (b.seasonNumber === null) return -1;
			return a.seasonNumber - b.seasonNumber;
		});
	}

	function getGroupSeasonNumber(group: DetectionGroup): number | null {
		if (typeof group.parsedSeason === 'number') {
			return group.parsedSeason;
		}
		const state = getGroupState(group);
		if (typeof state.batchSeasonOverride === 'number') {
			return state.batchSeasonOverride;
		}
		if (typeof group.suggestedSeason === 'number') {
			return group.suggestedSeason;
		}
		return null;
	}

	function getDetectedSeasonsLabel(section: DetectionSection): string {
		if (
			section.mediaType !== 'tv' ||
			!section.seasonSections ||
			section.seasonSections.length === 0
		) {
			return 'none';
		}
		const seasons = section.seasonSections
			.filter((season) => season.seasonNumber !== null)
			.map((season) => season.seasonNumber as number);
		if (seasons.length === 0) {
			return 'none';
		}
		return seasons.join(', ');
	}

	function hasUnknownSeasonItems(section: DetectionSection): boolean {
		if (section.mediaType !== 'tv' || !section.seasonSections) {
			return false;
		}
		return section.seasonSections.some((season) => season.seasonNumber === null);
	}

	function getSectionSeasonOverride(section: DetectionSection): number | null {
		if (section.mediaType !== 'tv') {
			return null;
		}
		for (const group of section.items) {
			const override = getGroupState(group).batchSeasonOverride;
			if (typeof override === 'number') {
				return override;
			}
		}
		return null;
	}

	function applySeasonOverrideToSection(section: DetectionSection, seasonNumber: number | null) {
		if (section.mediaType !== 'tv') return;
		const nextState = { ...groupReviewState };
		for (const group of section.items) {
			const state = getGroupState(group);
			const nextSeason =
				seasonNumber !== null && group.parsedSeason === undefined
					? seasonNumber
					: state.seasonNumber;
			nextState[group.id] = {
				...state,
				seasonNumber: nextSeason,
				batchSeasonOverride: seasonNumber
			};
		}
		groupReviewState = nextState;

		if (activeGroup && section.items.some((group) => group.id === activeGroup.id)) {
			loadGroupState(activeGroup.id);
		}
	}

	function selectReviewSeriesSection(sectionId: string) {
		if (reviewSelectedSeriesSectionId === sectionId) {
			return;
		}
		reviewSelectedSeriesSectionId = sectionId;
		reviewSelectedSeasonSectionKey = null;
	}

	function selectReviewSeasonSection(seasonKey: string) {
		reviewSelectedSeasonSectionKey = seasonKey;
	}

	function getSkippableSeasonGroups(
		seasonSection: TvSeasonSection | null | undefined
	): DetectionGroup[] {
		if (!seasonSection) return [];
		return seasonSection.items.filter((group) => !isGroupImported(group.id));
	}

	function isSeasonSectionFullySkipped(seasonSection: TvSeasonSection | null | undefined): boolean {
		const groups = getSkippableSeasonGroups(seasonSection);
		return groups.length > 0 && groups.every((group) => isGroupSkipped(group.id));
	}

	function getSeasonSectionSkippedCount(seasonSection: TvSeasonSection | null | undefined): number {
		return getSkippableSeasonGroups(seasonSection).filter((group) => isGroupSkipped(group.id))
			.length;
	}

	function toggleSeasonSectionSkipped(seasonSection: TvSeasonSection | null | undefined) {
		if (!skipActionsEnabled || !seasonSection) return;

		const groups = getSkippableSeasonGroups(seasonSection);
		if (groups.length === 0) return;

		if (isSeasonSectionFullySkipped(seasonSection)) {
			const groupIds = groups.map((group) => group.id);
			skippedGroupIds = skippedGroupIds.filter((groupId) => !groupIds.includes(groupId));
			return;
		}

		const nextSkippedIds = [...skippedGroupIds];
		for (const group of groups) {
			if (!nextSkippedIds.includes(group.id)) {
				nextSkippedIds.push(group.id);
			}
		}
		skippedGroupIds = nextSkippedIds;
	}

	function canApplySelectedMatchToSeason(
		seasonSection: TvSeasonSection | null | undefined,
		match: MatchResult | null = selectedMatch
	): boolean {
		if (!seasonSection || !match) return false;
		if (match.mediaType !== 'tv') return false;
		return getSkippableSeasonGroups(seasonSection).length > 0;
	}

	function applySelectedMatchToSeason(
		seasonSection: TvSeasonSection | null | undefined,
		matchToApply: MatchResult | null = selectedMatch,
		options?: { showToast?: boolean }
	): boolean {
		const showToast = options?.showToast ?? true;
		if (!seasonSection) return false;
		if (!matchToApply || matchToApply.mediaType !== 'tv') {
			if (showToast) {
				toasts.warning(m.toast_library_import_selectTvMatchForSeasonApply());
			}
			return false;
		}
		const selectedTvMatch = matchToApply;

		const groups = getSkippableSeasonGroups(seasonSection);
		if (groups.length === 0) return false;

		const librariesForTv = getAvailableDestinationLibrariesForType('tv', selectedTvMatch);
		const recommendedRootFolder =
			getRecommendedDestinationLibraryId(librariesForTv, {
				preferAnime: selectedTvMatch.isAnime === true
			}) ?? '';
		const nextState = { ...groupReviewState };

		for (const group of groups) {
			const state = getGroupState(group);
			const hasSelectedMatch = state.matchCandidates.some(
				(match) =>
					match.mediaType === selectedTvMatch.mediaType && match.tmdbId === selectedTvMatch.tmdbId
			);
			const nextCandidates = hasSelectedMatch
				? state.matchCandidates
				: [selectedTvMatch, ...state.matchCandidates];
			const hasValidRootFolder =
				state.selectedRootFolder.length > 0 &&
				librariesForTv.some((library) => library.id === state.selectedRootFolder);

			nextState[group.id] = {
				...state,
				selectedMediaType: 'tv',
				selectedMatch: selectedTvMatch,
				searchQuery: selectedTvMatch.title,
				matchCandidates: nextCandidates,
				importTarget: selectedTvMatch.inLibrary ? 'existing' : 'new',
				selectedRootFolder: selectedTvMatch.inLibrary
					? state.selectedRootFolder
					: hasValidRootFolder
						? state.selectedRootFolder
						: recommendedRootFolder
			};
		}

		groupReviewState = nextState;
		if (activeGroup && nextState[activeGroup.id]) {
			loadGroupState(activeGroup.id);
		}

		if (showToast) {
			toasts.success(m.toast_library_import_appliedMatchToSeason({ count: groups.length }));
		}
		return true;
	}

	function getSectionDestinationGroups(section: DetectionSection): DetectionGroup[] {
		return section.items.filter((group) => !isGroupImported(group.id) && !isGroupSkipped(group.id));
	}

	function getSectionDestinationEligibleGroups(section: DetectionSection): DetectionGroup[] {
		return getSectionDestinationGroups(section).filter((group) => {
			const state = getGroupState(group);
			return !(state.selectedMatch?.inLibrary && state.importTarget === 'existing');
		});
	}

	function getSectionDestinationOptions(section: DetectionSection): DestinationLibrary[] {
		const groups = getSectionDestinationEligibleGroups(section);

		if (groups.length === 0) return [];

		const seenIds = new SvelteSet<string>();
		const result: DestinationLibrary[] = [];

		for (const group of groups) {
			const state = getGroupState(group);
			const groupLibraries = getAvailableDestinationLibrariesForType(
				state.selectedMediaType,
				state.selectedMatch
			);
			for (const library of groupLibraries) {
				if (!seenIds.has(library.id)) {
					seenIds.add(library.id);
					result.push(library);
				}
			}
		}

		return result
			.filter((library) => library.mediaType === section.mediaType)
			.sort((a, b) => {
				const defaultOrder = Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault));
				if (defaultOrder !== 0) return defaultOrder;
				return a.name.localeCompare(b.name);
			});
	}

	function getRecommendedSectionDestinationId(
		section: DetectionSection,
		options: DestinationLibrary[]
	): string {
		const shouldPreferAnime = getSectionDestinationGroups(section).some(
			(group) => getGroupState(group).selectedMatch?.isAnime === true
		);
		return getRecommendedDestinationLibraryId(options, { preferAnime: shouldPreferAnime }) ?? '';
	}

	function updateSectionDestination(sectionId: string, value: string) {
		bulkDestinationBySectionId = {
			...bulkDestinationBySectionId,
			[sectionId]: value
		};
	}

	function canApplySelectedDestinationToMedia(section: DetectionSection): boolean {
		const selectedDestination = bulkDestinationBySectionId[section.id] ?? '';
		if (!selectedDestination) return false;

		const groups = getSectionDestinationEligibleGroups(section);
		if (groups.length === 0) return false;

		return groups.some((group) => {
			const state = getGroupState(group);
			const libraries = getAvailableDestinationLibrariesForType(
				state.selectedMediaType,
				state.selectedMatch
			);
			return libraries.some((library) => library.id === selectedDestination);
		});
	}

	function applySelectedDestinationToMedia(section: DetectionSection) {
		const selectedDestination = bulkDestinationBySectionId[section.id] ?? '';
		if (!selectedDestination) {
			toasts.warning(m.toast_library_import_selectDestinationFirst());
			return;
		}

		const groups = getSectionDestinationEligibleGroups(section);
		if (groups.length === 0) return;

		let updatedCount = 0;
		let restrictedCount = 0;
		const nextState = { ...groupReviewState };

		for (const group of groups) {
			const state = getGroupState(group);

			const libraries = getAvailableDestinationLibrariesForType(
				state.selectedMediaType,
				state.selectedMatch
			);
			if (!libraries.some((library) => library.id === selectedDestination)) {
				restrictedCount += 1;
				continue;
			}

			const nextImportTarget = state.selectedMatch?.inLibrary ? state.importTarget : 'new';
			if (
				state.selectedRootFolder === selectedDestination &&
				state.importTarget === nextImportTarget
			) {
				continue;
			}

			nextState[group.id] = {
				...state,
				selectedRootFolder: selectedDestination,
				importTarget: nextImportTarget
			};
			updatedCount += 1;
		}

		if (updatedCount > 0) {
			groupReviewState = nextState;
			if (activeGroup && nextState[activeGroup.id]) {
				loadGroupState(activeGroup.id);
			}
			toasts.success(m.toast_library_import_appliedDestinationToMedia({ count: updatedCount }));
		}

		if (restrictedCount > 0) {
			toasts.warning(m.toast_library_import_destinationRestrictedForMediaItems());
		}
	}

	function selectImportSeriesSection(sectionId: string) {
		if (importSelectedSeriesSectionId === sectionId) {
			return;
		}
		importSelectedSeriesSectionId = sectionId;
		importSelectedSeasonSectionKey = null;
	}

	function selectImportSeasonSection(seasonKey: string) {
		importSelectedSeasonSectionKey = seasonKey;
	}

	function getGroupEpisodeInfo(
		group: DetectionGroup
	): { season: number; episode: number; title?: string } | null {
		if (getEffectiveMediaType(group) !== 'tv') return null;
		const state = getGroupState(group);
		if (group.detectedFileCount > 1) return null;
		if (state.seasonNumber < 0 || state.episodeNumber < 1) return null;
		const tmdbId = state.selectedMatch?.tmdbId;
		const cacheKey = tmdbId ? `${tmdbId}-S${state.seasonNumber}` : null;
		const title = cacheKey ? episodeTitleCache[cacheKey]?.[state.episodeNumber] : undefined;
		return { season: state.seasonNumber, episode: state.episodeNumber, title };
	}

	function canImportGroup(group: DetectionGroup): boolean {
		if (importedGroupIds.includes(group.id) || skippedGroupIds.includes(group.id)) {
			return false;
		}

		const state = getGroupState(group);
		const match = state.selectedMatch;
		if (!match) {
			return false;
		}
		if (match.inLibrary && state.importTarget !== 'existing') {
			return false;
		}

		const isBatchTv = state.selectedMediaType === 'tv' && group.detectedFileCount > 1;
		if (
			!isBatchTv &&
			state.selectedMediaType === 'tv' &&
			(state.seasonNumber < 0 || state.episodeNumber < 1)
		) {
			return false;
		}

		if (state.importTarget === 'existing') {
			return match.inLibrary;
		}

		const libraries = getAvailableDestinationLibrariesForType(
			state.selectedMediaType,
			state.selectedMatch
		);
		if (libraries.length === 0) return false;
		if (libraries.length === 1) return true;
		return state.selectedRootFolder.length > 0;
	}

	function findDefaultReviewGroupId(
		groups: DetectionGroup[],
		preferredGroupId: string | null
	): string | null {
		if (groups.length === 0) return null;

		const firstNeedsInput = groups.find((group) => !canImportGroup(group));
		if (firstNeedsInput) {
			return firstNeedsInput.id;
		}

		if (preferredGroupId && groups.some((group) => group.id === preferredGroupId)) {
			return preferredGroupId;
		}

		return groups[0].id;
	}

	function buildImportPayload(group: DetectionGroup) {
		const state = getGroupState(group);
		if (!state.selectedMatch) {
			throw new Error(`No match selected for "${group.displayName}"`);
		}

		const resolvedImportTarget = state.selectedMatch.inLibrary ? 'existing' : state.importTarget;
		const librariesForType = getAvailableDestinationLibrariesForType(
			state.selectedMediaType,
			state.selectedMatch
		);
		const isBatchTv = state.selectedMediaType === 'tv' && group.detectedFileCount > 1;

		return {
			sourcePath: group.sourcePath,
			mediaType: state.selectedMediaType,
			tmdbId: state.selectedMatch.tmdbId,
			importTarget: resolvedImportTarget,
			importMode: state.importMode,
			// Always concrete so background/bulk jobs run with the behavior the
			// user saw at submit time instead of re-reading global settings at
			// execution time.
			preferHardlink: state.preferHardlink,

			...(resolvedImportTarget === 'new'
				? {
						rootFolderId: state.selectedRootFolder || librariesForType[0]?.id
					}
				: {}),

			...(state.selectedMediaType === 'tv' && !isBatchTv
				? {
						seasonNumber: state.seasonNumber,
						episodeNumber: state.episodeNumber
					}
				: {}),
			...(state.selectedMediaType === 'tv' && isBatchTv && state.batchSeasonOverride !== null
				? { seasonNumber: state.batchSeasonOverride }
				: {})
		};
	}

	async function executeImportRequest(payload: Record<string, unknown>): Promise<ExecuteResult> {
		const data = await executeImport(payload as ManualImportRequest);
		return data.data as ExecuteResult;
	}

	function clearMatchSearch() {
		if (!activeGroup) return;
		searchQuery = '';
		const state = getGroupState(activeGroup);

		matchCandidates =
			state.matchCandidates.length > 0 ? state.matchCandidates : (activeGroup.matches ?? []);

		if (selectedMatch && !matchCandidates.some((match) => match.tmdbId === selectedMatch?.tmdbId)) {
			selectedMatch = matchCandidates[0] ?? null;
		}
		persistActiveGroupState();
	}

	function handleMatchSearchInput(event: Event) {
		const target = event.target as HTMLInputElement;
		searchQuery = target.value.replace(/^\s+/, '');
		persistActiveGroupState();

		if (tmdbSearchDebounce) {
			clearTimeout(tmdbSearchDebounce);
		}

		if (searchQuery.trim().length < 2) {
			if (activeGroup) {
				matchCandidates = activeGroup.matches ?? [];
				if (matchCandidates.length > 0) {
					selectedMatch = matchCandidates[0] ?? selectedMatch;
				}
				persistActiveGroupState();
			}
			return;
		}

		tmdbSearchDebounce = setTimeout(() => {
			searchTmdb();
		}, 300);
	}

	function applyDetectionResult(detectedData: DetectionResult) {
		stopBackgroundImportPoll();
		executeResult = null;
		bulkImportSummary = null;
		bulkProgress = null;
		bulkCurrentGroup = null;
		importedGroupIds = [];
		importedGroupLibraryIds = {};
		skippedGroupIds = [];
		detectedGroupQuery = '';
		detectedGroupFilter = 'pending';
		detectedMediaFilter = 'all';
		importMediaFilter = 'all';
		reviewSelectedSeriesSectionId = null;
		reviewSelectedSeasonSectionKey = null;
		importSelectedSeriesSectionId = null;
		importSelectedSeasonSectionKey = null;
		if (tmdbSearchDebounce) {
			clearTimeout(tmdbSearchDebounce);
			tmdbSearchDebounce = null;
		}

		const groups =
			Array.isArray(detectedData.groups) && detectedData.groups.length > 0
				? detectedData.groups
				: [toDetectionGroup(detectedData)];

		const nextGroupState: Record<string, GroupReviewState> = {};
		for (const group of groups) {
			const state = createInitialGroupState(group);
			const contextMatch = buildRouteContextMatch(group);
			if (contextMatch) {
				const mergedMatches = [
					contextMatch,
					...state.matchCandidates.filter(
						(match) =>
							!(match.mediaType === contextMatch.mediaType && match.tmdbId === contextMatch.tmdbId)
					)
				];
				group.matches = mergedMatches;
				state.selectedMediaType = contextMatch.mediaType;
				state.matchCandidates = mergedMatches;
				state.selectedMatch = contextMatch;
				state.searchQuery = contextMatch.title;
				state.importTarget = contextMatch.inLibrary ? 'existing' : 'new';
			}
			nextGroupState[group.id] = state;
		}
		detection = {
			...detectedData,
			groups,
			totalGroups: groups.length
		};
		groupReviewState = nextGroupState;
		const hasNeedsInputGroups = groups.some((group) => !canImportGroup(group));
		detectedGroupFilter = hasNeedsInputGroups ? 'pending' : 'ready';

		const preferredGroupId =
			detectedData.selectedGroupId &&
			groups.some((group) => group.id === detectedData.selectedGroupId)
				? detectedData.selectedGroupId
				: null;
		const nextSelectedGroupId = findDefaultReviewGroupId(groups, preferredGroupId);
		selectedGroupId = nextSelectedGroupId;
		if (nextSelectedGroupId) {
			loadGroupState(nextSelectedGroupId);
		}
		step = 2;
	}

	/**
	 * Unmatched prefill (?unmatched=clientId:hash,…): resolve client hashes
	 * to local paths, detect the ones outside managed roots through the
	 * normal pipeline, and synthesize shell groups for in-root sources the
	 * wizard cannot execute (those enroll for monitor import instead).
	 * Additive: normal entry (Step 1 browsing) is untouched.
	 */
	async function prefillUnmatched(raw: string) {
		const entries = raw
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const idx = part.indexOf(':');
				if (idx <= 0) return null;
				return { clientId: part.slice(0, idx), hash: part.slice(idx + 1) };
			})
			.filter((e): e is { clientId: string; hash: string } => Boolean(e?.clientId && e?.hash));
		if (entries.length === 0) return;

		unmatchedReturnUrl = resolvePath('/activity?tab=unmatched');
		try {
			const resolved = await resolveUnmatched(entries);
			if (resolved.missing.length > 0) {
				toasts.warning(`${resolved.missing.length} download(s) left the client and were skipped`);
			}
			if (resolved.alreadyTracked.length > 0) {
				toasts.warning(
					`${resolved.alreadyTracked.length} download(s) are already tracked — see the Queue tab`
				);
			}
			const usable = resolved.resolved.filter((r) => r.localPath);
			if (resolved.resolved.length - usable.length > 0) {
				toasts.warning('Some downloads have no resolvable path and were skipped');
			}
			if (usable.length === 0) return;

			const inRoot = usable.filter((r) => r.insideManagedRoot);
			const normal = usable.filter((r) => !r.insideManagedRoot);
			if (normal.length > 0) {
				await runDetection(normal.map((r) => r.localPath as string));
				const byPath = new Map(
					normal.map((r) => [r.localPath as string, { hash: r.hash, progress: r.progress }])
				);
				for (const group of detectionGroups) {
					const origin = findUnmatchedOrigin(group, byPath);
					if (!origin) {
						toasts.warning(
							`"${group.displayName}" lost its download link — it will import untracked`
						);
						continue;
					}
					if (!unmatchedOrigins[group.id]) {
						unmatchedOrigins = {
							...unmatchedOrigins,
							[group.id]: {
								hash: origin.hash,
								progress: origin.progress,
								inRoot: false
							}
						};
					}
				}
			}

			for (const item of inRoot) {
				const shell: DetectionGroup = {
					id: `unmatched:${item.clientId}:${item.hash}`,
					displayName: item.name,
					sourceType: 'file',
					sourcePath: item.localPath as string,
					selectedFilePath: item.localPath as string,
					fileName: item.name,
					detectedFileCount: 1,
					parsedTitle: item.searchHint,
					inferredMediaType: 'movie',
					matches: []
				};
				if (!detectionGroups.some((g) => g.id === shell.id)) {
					const merged: DetectionGroup[] = [...detectionGroups, shell];
					if (!detection) {
						detection = {
							...shell,
							grouped: false,
							totalGroups: merged.length,
							selectedGroupId: shell.id,
							groups: merged
						};
					} else {
						detection = { ...detection, groups: merged, totalGroups: merged.length };
					}
					groupReviewState = {
						...groupReviewState,
						[shell.id]: createInitialGroupState(shell)
					};
				}
				unmatchedOrigins = {
					...unmatchedOrigins,
					[shell.id]: { hash: item.hash, progress: item.progress, inRoot: true }
				};
			}

			const firstPending =
				detectionGroups.find((group) => {
					const st = groupReviewState[group.id];
					return st && !st.selectedMatch;
				}) ?? detectionGroups[0];
			if (firstPending) {
				switchGroup(firstPending.id);
				step = 2;
			}
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to load unmatched downloads');
		}
	}

	async function runDetection(paths?: string[]) {
		const mediaTypeHint = preferredMediaType !== 'auto' ? preferredMediaType : undefined;

		if (paths && paths.length > 0) {
			detecting = true;
			try {
				const results = await Promise.all(
					paths.map((p) => detectMedia(p, mediaTypeHint, isFileOnlyContext || undefined))
				);
				const mergedGroups: DetectionGroup[] = results.flatMap((r) => {
					const d = r.data as DetectionResult;
					return Array.isArray(d.groups) && d.groups.length > 0 ? d.groups : [toDetectionGroup(d)];
				});
				if (mergedGroups.length === 0) {
					toasts.error(m.toast_library_import_detectionFailed());
					return;
				}
				const firstData = results[0].data as DetectionResult;
				const mergedData: DetectionResult = {
					...firstData,
					groups: mergedGroups,
					totalGroups: mergedGroups.length,
					selectedGroupId: mergedGroups[0]?.id ?? ''
				};
				applyDetectionResult(mergedData);
			} catch (error) {
				toasts.error(
					error instanceof Error ? error.message : m.toast_library_import_detectionFailed()
				);
			} finally {
				detecting = false;
			}
			return;
		}

		if (!sourcePath.trim()) {
			toasts.error(m.toast_library_import_selectSourcePath());
			return;
		}

		detecting = true;
		try {
			const data = await detectMedia(sourcePath, mediaTypeHint, isFileOnlyContext || undefined);
			const detectedData = data.data as DetectionResult;
			applyDetectionResult(detectedData);
		} catch (error) {
			toasts.error(
				error instanceof Error ? error.message : m.toast_library_import_detectionFailed()
			);
		} finally {
			detecting = false;
		}
	}

	async function searchTmdb() {
		if (routeImportContext) {
			return;
		}
		const currentGroup = activeGroup;
		if (!currentGroup) return;
		if (tmdbSearchDebounce) {
			clearTimeout(tmdbSearchDebounce);
			tmdbSearchDebounce = null;
		}

		if (!searchQuery.trim()) {
			toasts.error(m.toast_library_import_enterTitle());
			return;
		}

		searchingMatches = true;
		try {
			const searchData = await searchTmdbApi({
				query: searchQuery,
				type: selectedMediaType
			});
			const results = (searchData as { results?: Array<{ id: number }> }).results ?? [];

			const tmdbIds = results.map((item: { id: number }) => item.id);
			const statusData = await getLibraryStatus({
				tmdbIds,
				mediaType: selectedMediaType
			});
			const statusMap =
				(statusData as unknown as { status?: Record<string, unknown> }).status ?? {};

			matchCandidates = results.map((item: Record<string, unknown>) => {
				const tmdbId = item.id as number;
				const date = (item.release_date || item.first_air_date) as string | undefined;
				const year = date ? parseInt(date.split('-')[0], 10) : undefined;
				const status = statusMap[tmdbId] as Record<string, unknown> | undefined;
				const genreIds = Array.isArray(item.genre_ids)
					? item.genre_ids.filter((value): value is number => typeof value === 'number')
					: [];
				const originCountries = Array.isArray(item.origin_country)
					? item.origin_country.filter((value): value is string => typeof value === 'string')
					: [];
				const isAnime = isLikelyAnimeMedia({
					genres: genreIds.map((id) => ({ id })),
					originalLanguage:
						typeof item.original_language === 'string' ? item.original_language : null,
					originCountries,
					title: typeof item.title === 'string' ? item.title : null,
					originalTitle:
						typeof item.original_title === 'string'
							? item.original_title
							: typeof item.original_name === 'string'
								? item.original_name
								: null
				});
				return {
					tmdbId,
					title: (item.title || item.name || m.common_unknown()) as string,
					year,
					mediaType: selectedMediaType,
					isAnime,
					confidence: 0,
					inLibrary: Boolean(status?.inLibrary),
					hasFile: Boolean(status?.hasFile),
					libraryId: status?.libraryId as string | undefined
				} satisfies MatchResult;
			});

			if (matchCandidates.length === 0) {
				toasts.warning(m.toast_library_import_noMatchesFound());
			}
		} catch {
			toasts.error(m.toast_library_import_failedToSearchTmdb());
		} finally {
			persistActiveGroupState();
			searchingMatches = false;
		}
	}

	function chooseMatch(match: MatchResult) {
		selectedMatch = match;
		importTarget = match.inLibrary ? 'existing' : 'new';
		if (importTarget === 'new') {
			selectedRootFolder =
				getRecommendedDestinationLibraryId(
					getAvailableDestinationLibrariesForType(selectedMediaType, match),
					{
						preferAnime: match.isAnime === true
					}
				) ?? '';
		}

		if (
			applySelectedMatchToSeasonOnSelect &&
			canApplySelectedMatchToSeason(activeReviewSeasonSection, match)
		) {
			const applied = applySelectedMatchToSeason(activeReviewSeasonSection, match);
			if (applied) {
				return;
			}
		}

		persistActiveGroupState();
	}

	function switchMediaType(nextType: MediaType) {
		if (routeImportContext) {
			return;
		}
		if (selectedMediaType === nextType) return;
		selectedMediaType = nextType;
		selectedMatch = null;
		matchCandidates = [];
		importTarget = 'new';
		selectedRootFolder =
			getRecommendedDestinationLibraryId(getAvailableDestinationLibrariesForType(nextType, null)) ??
			'';
		batchSeasonOverride = nextType === 'tv' ? (activeGroup?.suggestedSeason ?? null) : null;
		persistActiveGroupState();
		if (searchQuery.trim().length >= 2) {
			searchTmdb();
		}
	}

	function goToStep(targetStep: WizardStep) {
		persistActiveGroupState();
		if (targetStep === 3) {
			if (isMultiGroupReview) {
				if (selectedImportGroupCount === 0) return;
			} else if (!step2Ready) {
				return;
			}
		}
		step = targetStep;
	}

	function resetWizard() {
		stopBackgroundImportPoll();
		backgroundImport = false;
		preferredMediaType = routeImportContext?.mediaType ?? 'auto';
		sourcePath = '/';
		browserPath = '/';
		browserParentPath = null;
		browserEntries = [];
		browserError = null;
		step = 1;
		detection = null;
		selectedMatch = null;
		selectedMediaType = routeImportContext?.mediaType ?? 'movie';
		matchCandidates = [];
		searchQuery = '';
		seasonNumber = 1;
		episodeNumber = 1;
		batchSeasonOverride = null;
		executeResult = null;
		executeError = null;
		bulkImportSummary = null;
		importedBulkItems = [];
		bulkProgress = null;
		bulkCurrentGroup = null;
		importTarget = 'new';
		selectedGroupId = null;
		importedGroupIds = [];
		importedGroupLibraryIds = {};
		skippedGroupIds = [];
		groupReviewState = {};
		unmatchedOrigins = {};
		unmatchedReturnUrl = null;
		unmatchedPrefillDone = false;
		selectedRootFolder = '';
		detectedGroupQuery = '';
		detectedGroupFilter = 'pending';
		detectedMediaFilter = 'all';
		importMediaFilter = 'all';
		reviewSelectedSeriesSectionId = null;
		reviewSelectedSeasonSectionKey = null;
		importSelectedSeriesSectionId = null;
		importSelectedSeasonSectionKey = null;
		if (tmdbSearchDebounce) {
			clearTimeout(tmdbSearchDebounce);
			tmdbSearchDebounce = null;
		}
		void browse(defaultImportFolder ?? '/');
	}

	/**
	 * Record unmatched tracking for a group whose import just landed.
	 * No-op for non-prefill groups. Failures stay visible: files in the
	 * library, client row still unmatched.
	 */
	async function trackUnmatchedGroup(groupId: string) {
		const origin = unmatchedOrigins[groupId];
		const state = groupReviewState[groupId];
		const match = state?.selectedMatch;
		if (!origin || !match) return;
		try {
			const tracked = await trackUnmatched([
				{
					hash: origin.hash,
					mediaType: state.selectedMediaType,
					tmdbId: match.tmdbId,
					seasonNumber: state.selectedMediaType === 'tv' ? state.seasonNumber : null
				}
			]);
			if (tracked.skipped.length > 0) {
				toasts.warning(
					`Imported but not tracked: ${tracked.skipped.map((s) => s.reason).join(', ')}`
				);
			}
		} catch {
			toasts.warning('Imported but not tracked — the download is still unmatched');
		}
	}

	/**
	 * Enroll the active unmatched in-root group for monitor-driven import
	 * (or link it now when the library already holds the file and the
	 * download is complete). Marks the group imported and moves on, like
	 * the single-import flow.
	 */
	async function enrollUnmatchedFlow() {
		if (!activeGroup || !selectedMatch || !selectedGroupId) return;
		const origin = unmatchedOrigins[selectedGroupId];
		if (!origin) return;
		persistActiveGroupState();
		executingImport = true;
		try {
			const result = await enrollUnmatched([
				{
					hash: origin.hash,
					mediaType: selectedMediaType,
					tmdbId: selectedMatch.tmdbId,
					seasonNumber: selectedMediaType === 'tv' ? seasonNumber : null,
					rootFolderId: selectedMatch.inLibrary ? null : selectedRootFolder || null
				}
			]);
			if (result.enrolled > 0) {
				toasts.success(m.activity_unmatched_enrolledToast());
				markGroupImported(selectedGroupId);
				continueWithNextDetected();
			} else {
				toasts.warning(
					`Enroll skipped: ${result.skipped.map((s) => s.reason).join(', ') || 'unknown'}`
				);
			}
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Enroll failed');
		} finally {
			executingImport = false;
		}
	}

	async function linkNowUnmatchedFlow() {
		if (!activeGroup || !selectedMatch || !selectedGroupId) return;
		const origin = unmatchedOrigins[selectedGroupId];
		if (!origin) return;
		persistActiveGroupState();
		executingImport = true;
		try {
			const result = await trackUnmatched([
				{
					hash: origin.hash,
					mediaType: selectedMediaType,
					tmdbId: selectedMatch.tmdbId,
					seasonNumber: selectedMediaType === 'tv' ? seasonNumber : null
				}
			]);
			if (result.tracked > 0) {
				toasts.success(m.activity_unmatched_attachedToast({ count: result.tracked }));
				markGroupImported(selectedGroupId);
				continueWithNextDetected();
			} else {
				toasts.warning(
					`Link skipped: ${result.skipped.map((s) => s.reason).join(', ') || 'unknown'}`
				);
			}
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Link failed');
		} finally {
			executingImport = false;
		}
	}

	async function executeImportFlow() {
		const currentGroup = activeGroup;
		if (!currentGroup || !selectedMatch) return;
		if (!canProceedToImport) return;
		persistActiveGroupState();

		if (backgroundImport) {
			await executeBackgroundImportFlow(currentGroup);
			return;
		}

		executingImport = true;
		executeError = null;
		try {
			const payload = buildImportPayload(currentGroup);
			const result = await executeImportRequest(payload);
			executeResult = result;
			bulkImportSummary = null;
			if (selectedGroupId) {
				markGroupImported(selectedGroupId);
				await trackUnmatchedGroup(selectedGroupId);
			}
			if (isDirectLibraryImportContext && originLibraryLink) {
				toasts.success(m.toast_library_import_importComplete());
				bypassNavigationGuard = true;
				await goto(originLibraryLink);
				return;
			}
			step = 4;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Import failed';
			if (isDirectLibraryImportContext) {
				executeError = message;
				step = 4;
			} else {
				toasts.error(message);
			}
		} finally {
			executingImport = false;
		}
	}

	/**
	 * Background imports (#530): hand the work to the library job queue and let
	 * the user keep using the wizard. A poller tracks the job to completion.
	 */
	async function executeBackgroundImportFlow(currentGroup: DetectionGroup) {
		executingImport = true;
		executeError = null;
		try {
			const payload = buildImportPayload(currentGroup);
			const data = await executeImport({ ...payload, background: true });
			const result = data.data as { jobId: string; background: boolean };
			toasts.info(m.library_import_backgroundStarted());
			bulkProgress = { completed: 0, failed: 0, total: 1 };
			bulkCurrentGroup = currentGroup.displayName;
			bulkImportSummary = null;
			watchBackgroundImport(result.jobId, selectedGroupId);
			if (isDirectLibraryImportContext && originLibraryLink) {
				bypassNavigationGuard = true;
				await goto(originLibraryLink);
				return;
			}
			step = 4;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Import failed';
			if (isDirectLibraryImportContext) {
				executeError = message;
				step = 4;
			} else {
				toasts.error(message);
			}
		} finally {
			executingImport = false;
		}
	}

	function stopBackgroundImportPoll() {
		if (backgroundJobPoll) {
			clearInterval(backgroundJobPoll);
			backgroundJobPoll = null;
		}
	}

	function watchBackgroundImport(jobId: string, groupId: string | null) {
		stopBackgroundImportPoll();
		backgroundJobPoll = setInterval(() => {
			void (async () => {
				try {
					const response = await getLibraryJob(jobId);

					const job = (
						response as
							| {
									job?: {
										status?: string;
										metadata?: { result?: { libraryId?: string } } | null;
									};
							  }
							| undefined
					)?.job;
					if (job?.status === 'completed') {
						stopBackgroundImportPoll();
						bulkProgress = { completed: 1, failed: 0, total: 1 };
						bulkCurrentGroup = null;
						bulkImportSummary = { importedGroups: 1, failedGroups: 0 };
						toasts.success(m.toast_library_import_importComplete());
						if (groupId && groupId === selectedGroupId) {
							markGroupImported(groupId);
							await trackUnmatchedGroup(groupId);
							const libraryId = job.metadata?.result?.libraryId;
							if (libraryId) {
								importedGroupLibraryIds = { ...importedGroupLibraryIds, [groupId]: libraryId };
							}
						}
					} else if (job?.status === 'failed' || job?.status === 'cancelled') {
						stopBackgroundImportPoll();
						bulkProgress = null;
						executeError = m.library_import_importFailed();
						toasts.error(m.library_import_importFailed());
					}
				} catch {
					// Transient poll errors (server restart) — keep polling; the job
					// is durable in the library_jobs table.
				}
			})();
		}, 2000);
	}

	interface BulkImportJobRow {
		id: string;
		status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
		errorMessage?: string | null;
		metadata?: {
			groupName?: string;
			result?: { libraryId?: string };
		} | null;
	}

	/** Mark a group imported from its finished job row. */
	function applyBulkJobResult(row: BulkImportJobRow, groupIdMap: Record<string, string>) {
		if (row.status !== 'completed') return;
		const groupId = groupIdMap[row.metadata?.groupName ?? ''];
		if (!groupId) return;
		markGroupImported(groupId);
		void trackUnmatchedGroup(groupId);
		const libraryId = row.metadata?.result?.libraryId;
		if (libraryId) {
			importedGroupLibraryIds = { ...importedGroupLibraryIds, [groupId]: libraryId };
		}
	}

	/** Shared completion handling for both the SSE-driven (foreground) and
	 * poll-driven (background) bulk import paths. */
	function finalizeBulkOutcome(imported: number, failed: number, errors: string[]) {
		imported += pendingDirectDone;
		errors = [...pendingDirectErrors, ...errors];
		pendingDirectDone = 0;
		pendingDirectErrors = [];
		executeResult = null;
		bulkImportSummary = { importedGroups: imported, failedGroups: failed };

		// Collect library links from successfully imported groups
		const collectedItems: ImportedBulkItem[] = [];
		for (const groupId of importedGroupIds) {
			const group = detectionGroups.find((g) => g.id === groupId);
			if (!group) continue;
			const state = groupReviewState[groupId];
			if (!state?.selectedMatch) continue;
			const match = state.selectedMatch;
			let libraryId: string | null = null;
			if (importedGroupLibraryIds[groupId]) {
				// Prefer the real library ID returned by the server after import.
				libraryId = importedGroupLibraryIds[groupId];
			} else if (state.importTarget === 'existing' && match.inLibrary && match.libraryId) {
				libraryId = match.libraryId;
			}
			const mediaTypePath = state.selectedMediaType === 'movie' ? 'movie' : 'tv';
			const href = libraryId ? resolvePath(`/library/${mediaTypePath}/${libraryId}`) : null;
			collectedItems.push({
				title: match.title,
				year: match.year ?? null,
				mediaType: state.selectedMediaType,
				libraryId,
				href
			});
		}
		importedBulkItems = collectedItems;

		if (imported === 0 && failed > 0) {
			toasts.error(errors[0] ?? m.toast_library_import_noGroupsImported());
			executeError = errors[0] ?? m.toast_library_import_noGroupsImported();
			step = 4;
		} else if (imported > 0) {
			if (isDirectLibraryImportContext && originLibraryLink) {
				toasts.success(m.toast_library_import_importComplete());
				bypassNavigationGuard = true;
				void goto(originLibraryLink);
				return;
			}
			step = 4;
			if (failed > 0) {
				toasts.warning(m.toast_library_import_bulkImportPartial({ imported, failed }));
			} else {
				toasts.success(m.toast_library_import_bulkImportSuccess({ count: imported }));
			}
		} else {
			toasts.error(m.toast_library_import_noGroupsImported());
			step = 4;
		}

		bulkProgress = null;
	}

	/**
	 * Poll every manual_import job in a bulk batch (grouped by parentJobId)
	 * until all are terminal. Used for both the foreground "stay and watch"
	 * path (progress bar visible on step 3) and the background path (wizard
	 * moves on immediately); they're the same mechanism, differing only
	 * in whether `foreground` keeps `executingImport`/the progress bar active
	 * until completion.
	 */
	function watchBulkImportBatch(
		parentJobId: string,
		groupIdMap: Record<string, string>,
		foreground: boolean
	) {
		stopBackgroundImportPoll();
		backgroundJobPoll = setInterval(() => {
			void (async () => {
				try {
					const response = await getBulkImportProgress(parentJobId);
					const rows = (response as { jobs?: BulkImportJobRow[] } | undefined)?.jobs;
					if (!rows || rows.length === 0) return;

					const completed = rows.filter((r) => r.status === 'completed').length;
					const failed = rows.filter(
						(r) => r.status === 'failed' || r.status === 'cancelled'
					).length;
					const total = rows.length;

					// Track progress regardless of foreground/background; if the
					// user lands on step 4 while a background batch is still
					// running, it shows the same live numbers instead of a static
					// "still running" message.
					bulkProgress = { completed, failed, total };
					const running = rows.find((r) => r.status === 'running');
					bulkCurrentGroup = running?.metadata?.groupName ?? null;

					if (completed + failed < total) return;

					stopBackgroundImportPoll();
					for (const row of rows) {
						applyBulkJobResult(row, groupIdMap);
					}
					const errors = rows.filter((r) => r.errorMessage).map((r) => r.errorMessage as string);
					if (foreground) executingImport = false;
					finalizeBulkOutcome(completed, failed, errors);
				} catch {
					// Transient poll errors (server restart) — keep polling; jobs
					// are durable rows, not lost like the old in-memory queue.
				}
			})();
		}, 1500);
	}

	/**
	 * Bulk Step-3 dispatch for unmatched in-root groups: link when the
	 * library already holds the complete file, enroll otherwise (with the
	 * section destination for new matches). Returns true when the group is
	 * handled; errors accumulate in `errors` for the summary.
	 */
	async function dispatchUnmatchedInRootBulk(
		group: DetectionGroup,
		errors: string[]
	): Promise<boolean> {
		const origin = unmatchedOrigins[group.id];
		const state = groupReviewState[group.id];
		const match = state?.selectedMatch;
		if (!origin || !match) return false;
		const seasonNumber = state.selectedMediaType === 'tv' ? state.seasonNumber : null;
		const action = resolveUnmatchedGroupAction(group.id);
		if (!action) return false;
		try {
			if (action === 'link') {
				const result = await trackUnmatched([
					{
						hash: origin.hash,
						mediaType: state.selectedMediaType,
						tmdbId: match.tmdbId,
						seasonNumber
					}
				]);
				if (result.tracked === 0) {
					errors.push(
						`${group.displayName}: ${result.skipped.map((s) => s.reason).join(', ') || 'skipped'}`
					);
					return false;
				}
			} else {
				let rootFolderId: string | null = null;
				if (!match.inLibrary) {
					rootFolderId =
						getBulkSectionDestinationForGroup(group.id) ??
						getRecommendedDestinationLibraryId(
							getAvailableDestinationLibrariesForType(state.selectedMediaType, match),
							{ preferAnime: match.isAnime === true }
						) ??
						null;
					if (!rootFolderId) {
						errors.push(`${group.displayName}: no destination library`);
						return false;
					}
				}
				const result = await enrollUnmatched([
					{
						hash: origin.hash,
						mediaType: state.selectedMediaType,
						tmdbId: match.tmdbId,
						seasonNumber,
						rootFolderId
					}
				]);
				if (result.enrolled === 0) {
					errors.push(
						`${group.displayName}: ${result.skipped.map((s) => s.reason).join(', ') || 'skipped'}`
					);
					return false;
				}
			}
			markGroupImported(group.id);
			return true;
		} catch (error) {
			errors.push(`${group.displayName}: ${error instanceof Error ? error.message : 'failed'}`);
			return false;
		}
	}

	function getBulkSectionDestinationForGroup(groupId: string): string | null {
		for (const section of importSelectionSections) {
			const inItems = section.items.some((g) => g.id === groupId);
			const inSeasons = (section.seasonSections ?? []).some((s) =>
				s.items.some((g) => g.id === groupId)
			);
			if (inItems || inSeasons) return bulkDestinationBySectionId[section.id] ?? null;
		}
		return null;
	}

	async function executeBulkImportFlow() {
		if (selectedImportGroupCount === 0) {
			toasts.warning(m.toast_library_import_noSelectedItems());
			return;
		}

		if (selectedNeedsInputCount > 0) {
			toasts.warning(m.toast_library_import_itemsNeedInput());
			return;
		}

		persistActiveGroupState();

		const jobs: BulkImportJob[] = [];
		const groupIdMap: Record<string, string> = {};
		let directDone = 0;
		const directErrors: string[] = [];

		for (const group of detectionGroups) {
			if (importedGroupIds.includes(group.id)) continue;
			if (skippedGroupIds.includes(group.id)) continue;
			if (!canImportGroup(group)) continue;
			// In-root unmatched sources cannot execute here (managed-root
			// guard): link or enroll them directly instead of bulk jobs.
			if (unmatchedOrigins[group.id]?.inRoot) {
				if (await dispatchUnmatchedInRootBulk(group, directErrors)) directDone++;
				continue;
			}

			try {
				const payload = buildImportPayload(group);
				jobs.push({
					request: { ...payload, importMode: bulkImportMode, preferHardlink: bulkPreferHardlink },
					groupName: group.displayName
				});
				groupIdMap[group.displayName] = group.id;
			} catch (error) {
				toasts.error(
					`${group.displayName}: ${error instanceof Error ? error.message : 'Invalid payload'}`
				);
				return;
			}
		}

		if (jobs.length === 0) {
			if (directDone > 0) {
				finalizeBulkOutcome(directDone, 0, directErrors);
			} else {
				toasts.warning(m.toast_library_import_noSelectedItems());
			}
			return;
		}

		pendingDirectDone = 0;
		pendingDirectErrors = [];

		// Note: direct dispatch above already marked its groups imported;
		// those marks stand even if the bulk submit below aborts, since the
		// link/enroll calls themselves succeeded.
		if (jobs.length > MAX_BULK_IMPORT_JOBS) {
			toasts.error(m.toast_library_import_tooManyItems());
			return;
		}

		executingImport = true;
		bulkProgress = { completed: 0, failed: 0, total: jobs.length };
		bulkCurrentGroup = null;

		try {
			const response = await bulkImport(jobs);
			const data = response.data as { parentJobId: string; totalGroups: number };
			pendingDirectDone = directDone;
			pendingDirectErrors = directErrors;

			if (backgroundImport) {
				toasts.info(m.library_import_backgroundStarted());
				watchBulkImportBatch(data.parentJobId, groupIdMap, false);
				executingImport = false;
				if (isDirectLibraryImportContext && originLibraryLink) {
					bypassNavigationGuard = true;
					await goto(originLibraryLink);
					return;
				}
				step = 4;
				return;
			}

			watchBulkImportBatch(data.parentJobId, groupIdMap, true);
		} catch (error) {
			executingImport = false;
			bulkProgress = null;
			bulkCurrentGroup = null;
			toasts.error(error instanceof Error ? error.message : 'Failed to start bulk import');
		}
	}

	const completionLink = $derived.by(() => {
		if (!executeResult) return null;
		const path =
			executeResult.mediaType === 'movie'
				? `/library/movie/${executeResult.libraryId}`
				: `/library/tv/${executeResult.libraryId}`;
		return resolvePath(path);
	});
	const originLibraryLink = $derived.by(() => {
		if (!routeImportContext?.libraryId) return null;
		const path =
			routeImportContext.mediaType === 'movie'
				? `/library/movie/${routeImportContext.libraryId}`
				: `/library/tv/${routeImportContext.libraryId}`;
		return resolvePath(path);
	});

	function formatMediaTypeLabel(mediaType: MediaType): string {
		return mediaType === 'movie' ? m.library_import_movieLabel() : m.library_import_tvShowLabel();
	}

	function closeLeaveImportModal() {
		leaveImportModalOpen = false;
		pendingNavigation = null;
	}

	async function confirmLeaveImportModal() {
		const destination = pendingNavigation;
		if (!destination) {
			closeLeaveImportModal();
			return;
		}

		leaveImportModalOpen = false;
		pendingNavigation = null;
		bypassNavigationGuard = true;

		if (destination.external) {
			window.location.assign(destination.href);
			return;
		}

		await goto(destination.href);
	}
</script>

<svelte:head>
	<title>{m.library_import_pageTitle()}</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-5">
	<div class="flex flex-col gap-2">
		<h1 class="text-3xl font-bold">{m.library_import_heading()}</h1>
		<p class="text-base-content/70">{m.library_import_subtitle()}</p>
	</div>

	<ul class="steps w-full">
		<li class="step {step >= 1 ? 'step-primary' : ''}">{m.library_import_stepSelectPath()}</li>
		<li class="step {step >= 2 ? 'step-primary' : ''}">{m.library_import_stepReviewMatches()}</li>
		<li class="step {step >= 3 ? 'step-primary' : ''}">{m.library_import_stepImport()}</li>
		<li class="step {step >= 4 ? 'step-primary' : ''}">{m.library_import_stepComplete()}</li>
	</ul>

	{#if step === 1}
		<Step1PathSelector
			bind:preferredMediaType
			bind:sourcePath
			{browserPath}
			{browserParentPath}
			{browserEntries}
			{browserLoading}
			{browserError}
			{detecting}
			{isMediaTypeLockedByContext}
			{isFileOnlyContext}
			onBrowse={browse}
			onDetect={(paths) => runDetection(paths)}
		/>
	{/if}

	{#if step === 2 && detection && activeGroup}
		<div class="space-y-4">
			{#if detectionGroups.length > 1}
				<DetectionGroupList
					{reviewDetectionSections}
					{reviewMovieSections}
					{reviewTvSections}
					{activeReviewTvSection}
					{activeReviewSeasonSection}
					{hasMultipleReviewTvSeries}
					bind:detectedGroupQuery
					bind:detectedGroupFilter
					bind:detectedMediaFilter
					{selectedGroupId}
					{importedGroupIds}
					{skippedGroupIds}
					{pendingGroupCount}
					{readyGroupCount}
					{remainingGroupCount}
					{skippedGroupCount}
					{skipActionsEnabled}
					{getEffectiveMediaType}
					{formatMediaTypeLabel}
					{canImportGroup}
					getGroupSelectedMatch={(group) => getGroupState(group).selectedMatch}
					getGroupActionLabel={getUnmatchedGroupAction}
					{hasUnknownSeasonItems}
					{getSectionSeasonOverride}
					{getSkippableSeasonGroups}
					{getSeasonSectionSkippedCount}
					{isSeasonSectionFullySkipped}
					{getDetectedSeasonsLabel}
					{canApplySelectedMatchToSeason}
					{getGroupEpisodeInfo}
					{lockedMediaType}
					onSwitchGroup={switchGroup}
					onSkipGroup={markGroupSkipped}
					onUnskipGroup={unskipGroup}
					onSelectReviewSeriesSection={selectReviewSeriesSection}
					onSelectReviewSeasonSection={selectReviewSeasonSection}
					onApplyMatchToSeason={applySelectedMatchToSeason}
					onToggleSeasonSkipped={toggleSeasonSectionSkipped}
					onSeasonOverrideChange={applySeasonOverrideToSection}
				/>
			{/if}

			<GroupEditorPanel
				{activeGroup}
				{selectedMediaType}
				{selectedMatch}
				bind:searchQuery
				{matchCandidates}
				bind:importTarget
				bind:seasonNumber
				bind:episodeNumber
				bind:batchSeasonOverride
				bind:selectedRootFolder
				{isMediaTypeLockedByContext}
				{isBatchTvImport}
				isGroupImported={isGroupImported(activeGroup?.id ?? '')}
				isGroupSkipped={isGroupSkipped(activeGroup?.id ?? '')}
				{skipActionsEnabled}
				{searchingMatches}
				{routeImportContext}
				{selectedMatchContextMismatch}
				{parsedSourceContextMismatch}
				{canApplyMatchSelectionToActiveSeason}
				bind:applyMatchToSeasonOnSelect={applySelectedMatchToSeasonOnSelect}
				{canImportGroup}
				{canApplyActiveSeasonOverride}
				onSwitchMediaType={switchMediaType}
				onChooseMatch={chooseMatch}
				onSearchInput={handleMatchSearchInput}
				onSearch={searchTmdb}
				onClearSearch={clearMatchSearch}
				onSeasonNumberChange={handleSeasonNumberChange}
				onEpisodeNumberChange={persistActiveGroupState}
				onToggleSkip={toggleSkipActiveGroup}
			/>

			<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<button class="btn btn-ghost" onclick={() => goToStep(1)}>{m.action_back()}</button>
				<button
					class="btn btn-primary"
					onclick={() => goToStep(3)}
					disabled={!canProceedFromReview}
				>
					{m.library_import_continueToImport()}
				</button>
			</div>
		</div>
	{/if}

	{#if step === 3 && isMultiGroupReview && detection}
		<Step3MultiImport
			bind:importMode={bulkImportMode}
			bind:preferHardlink={bulkPreferHardlink}
			bind:backgroundImport
			{importMovieSections}
			{importTvSections}
			{activeImportTvSection}
			{activeImportSeasonSection}
			{hasMultipleImportTvSeries}
			bind:importMediaFilter
			{bulkDestinationBySectionId}
			{selectedImportGroupCount}
			{selectedNeedsInputCount}
			{readyGroupCount}
			{skippedGroupCount}
			{executingImport}
			canImport={canImportGroup}
			getGroupActionLabel={getUnmatchedGroupAction}
			{getEffectiveMediaType}
			{getGroupEpisodeInfo}
			{lockedMediaType}
			getSectionDestinations={getSectionDestinationOptions}
			getSectionEligibleCount={(section) => getSectionDestinationEligibleGroups(section).length}
			canApplyDestination={canApplySelectedDestinationToMedia}
			onSelectImportSeriesSection={selectImportSeriesSection}
			onSelectImportSeasonSection={selectImportSeasonSection}
			onBulkImport={executeBulkImportFlow}
			onUpdateSectionDestination={updateSectionDestination}
			onApplyDestination={applySelectedDestinationToMedia}
			onReviewGroup={(groupId) => {
				switchGroup(groupId);
				step = 2;
			}}
			onGoToStep={(s: number) => goToStep(s as WizardStep)}
		/>

		{#if bulkProgress}
			{@const progressPct = bulkProgress.completed + bulkProgress.failed}
			{@const progressRemaining = bulkProgress.total - progressPct}
			<div class="mt-4 rounded-lg border border-primary/30 bg-base-200 p-4">
				<div class="mb-2 flex items-center justify-between text-sm">
					<span class="font-medium">
						Importing {bulkProgress.completed + bulkProgress.failed} of {bulkProgress.total}...
					</span>
					{#if bulkCurrentGroup}
						<span class="ml-2 truncate text-base-content/60">{bulkCurrentGroup}</span>
					{/if}
				</div>
				<progress
					class="progress w-full progress-primary"
					value={progressPct}
					max={bulkProgress.total}
				></progress>
				<div class="mt-1 flex justify-between text-xs text-base-content/50">
					<span
						>{bulkProgress.completed} completed{#if bulkProgress.failed > 0}, {bulkProgress.failed} failed{/if}</span
					>
					<span>{progressRemaining} remaining</span>
				</div>
			</div>
		{/if}
	{/if}

	{#if step === 3 && activeUnmatchedInRoot && selectedMatch && !isMultiGroupReview}
		{@const enrollMatch = selectedMatch}
		{@const linkNow = activeGroup ? resolveUnmatchedGroupAction(activeGroup.id) === 'link' : false}
		<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
			<h2 class="text-lg font-semibold">{m.activity_unmatched_enrollHeading()}</h2>
			{#if linkNow}
				<p class="mt-1 text-sm text-base-content/70">
					{m.activity_unmatched_linkNowBody({
						title: enrollMatch.title,
						year: enrollMatch.year ?? '?'
					})}
				</p>
			{:else if enrollMatch.inLibrary}
				<p class="mt-1 text-sm text-base-content/70">
					{m.activity_unmatched_enrollExistingBody()}
				</p>
			{:else}
				<p class="mt-1 text-sm text-base-content/70">
					{m.activity_unmatched_enrollBody({
						title: enrollMatch.title,
						year: enrollMatch.year ?? '?'
					})}
				</p>
			{/if}
			{#if selectedMediaType === 'tv'}
				<p class="mt-1 text-sm text-base-content/70">
					{m.activity_unmatched_enrollSeason({ season: seasonNumber })}
				</p>
			{/if}
			{#if !enrollMatch.inLibrary}
				{#if destinationLibrariesForType.length === 0 && !loadingRootFolders}
					<div class="mt-3 alert text-sm alert-warning">
						<span>
							{m.activity_unmatched_noDestination({
								type: selectedMediaType === 'tv' ? 'TV' : 'Movie'
							})}
							<a class="link" href="/settings/library/root-folders"
								>{m.activity_unmatched_noDestinationLink()}</a
							>
						</span>
					</div>
				{:else}
					<div class="mt-3">
						<label class="mb-1 block text-sm font-medium" for="unmatched-enroll-root">
							{m.activity_unmatched_enrollNewDest()}
						</label>
						<select
							id="unmatched-enroll-root"
							class="select-bordered select w-full select-sm"
							bind:value={selectedRootFolder}
							onchange={persistActiveGroupState}
							disabled={loadingRootFolders}
						>
							{#each destinationLibrariesForType as lib (lib.id)}
								<option value={lib.id}>
									{lib.name}{lib.defaultRootFolderPath ? ` — ${lib.defaultRootFolderPath}` : ''}
								</option>
							{/each}
						</select>
					</div>
				{/if}
			{/if}
			<div class="mt-4 flex justify-end gap-2">
				<button class="btn btn-ghost btn-sm" disabled={executingImport} onclick={() => goToStep(2)}>
					{m.action_back()}
				</button>
				<button
					class="btn btn-primary btn-sm"
					disabled={executingImport || (!linkNow && !enrollMatch.inLibrary && !selectedRootFolder)}
					onclick={() => void (linkNow ? linkNowUnmatchedFlow() : enrollUnmatchedFlow())}
				>
					{#if executingImport}
						<Loader2 class="h-4 w-4 animate-spin" />
					{/if}
					{linkNow ? m.activity_unmatched_linkNow() : m.activity_unmatched_enrollAction()}
				</button>
			</div>
		</div>
	{/if}

	{#if step === 3 && !isMultiGroupReview && activeGroup && selectedMatch && !activeUnmatchedInRoot}
		<Step3SingleImport
			{activeGroup}
			{selectedMatch}
			{selectedMediaType}
			bind:importTarget
			{destinationLibrariesForType}
			bind:selectedRootFolder
			bind:importMode
			bind:preferHardlink
			bind:backgroundImport
			{loadingRootFolders}
			{seasonNumber}
			{episodeNumber}
			{batchSeasonOverride}
			{canProceedToImport}
			{executingImport}
			{selectedMatchContextMismatch}
			{routeImportContext}
			onGoToStep={(s: number) => goToStep(s as WizardStep)}
			onExecuteImport={executeImportFlow}
			onRootFolderChange={persistActiveGroupState}
		/>
	{/if}

	{#if step === 4}
		<Step4Completion
			{executeError}
			{executeResult}
			{bulkImportSummary}
			{importedBulkItems}
			{skippedGroupCount}
			{remainingGroupCount}
			{completionLink}
			{originLibraryLink}
			backgroundProgress={bulkProgress}
			backgroundCurrentItem={bulkCurrentGroup}
			onTryAgain={() => {
				executeError = null;
				step = 3;
			}}
			onReset={resetWizard}
			onContinueWithNext={continueWithNextDetected}
		/>
		{#if unmatchedReturnUrl}
			{@const returnUrl = unmatchedReturnUrl}
			<div class="mt-4 flex justify-end">
				<button
					class="btn btn-ghost btn-sm"
					onclick={() => {
						bypassNavigationGuard = true;
						void goto(returnUrl);
					}}
				>
					{m.activity_unmatched_backToActivity()}
				</button>
			</div>
		{/if}
	{/if}
</div>

<ConfirmationModal
	open={leaveImportModalOpen}
	title={m.library_import_cancelImportTitle()}
	message={m.library_import_cancelImportMessage()}
	confirmLabel={m.library_import_cancelImportConfirm()}
	cancelLabel={m.library_import_cancelImportStay()}
	confirmVariant="error"
	onConfirm={confirmLeaveImportModal}
	onCancel={closeLeaveImportModal}
/>

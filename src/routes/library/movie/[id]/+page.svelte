<script lang="ts">
	import type { PageData } from './$types';
	import type { LibraryMovie, MovieFile } from '#lib/types/library.js';
	import {
		LibraryMovieHeader,
		MovieFilesTab,
		MovieEditModal,
		RenamePreviewModal,
		ScoreDetailModal,
		ChangeMatchModal
	} from '#lib/components/library/index.js';
	import type { FileScoreResponse } from '#lib/types/score.js';
	import { MediaSearchModal } from '#lib/components/search/index.js';
	import { SubtitleSearchModal } from '#lib/components/subtitles/index.js';
	import SubtitleSyncModal from '#lib/components/subtitles/SubtitleSyncModal.svelte';
	import SubtitleRequirementsSection from '#lib/components/subtitles/SubtitleRequirementsSection.svelte';
	import DeleteConfirmationModal from '#lib/components/ui/modal/DeleteConfirmationModal.svelte';
	import {
		ConfirmationModal,
		ModalWrapper,
		ModalHeader,
		ModalFooter
	} from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { autoSearchSubtitles, syncSubtitle } from '#lib/api/subtitles.js';
	import {
		getMovie,
		updateMovie,
		deleteMovie,
		deleteMovieFile,
		getMovieScore
	} from '#lib/api/library.js';
	import { apiGetStream } from '#lib/api/index.js';
	import type { MovieEditData } from '#lib/components/library/MovieEditModal.svelte';
	import {
		FileEdit,
		Loader2,
		RefreshCw,
		Captions,
		Layers,
		Plus,
		Zap,
		Eye,
		EyeOff,
		Info
	} from '@lucide/svelte';
	import { page } from '$app/state';
	import { goto, refreshAll } from '$app/navigation';
	import { resolvePath } from '#lib/utils/routing.js';
	import { getLibraryDetailBackHref } from '#lib/utils/libraryReturnNavigation.js';
	import { deriveSubtitleProgress } from '#lib/utils/subtitle-status-display.js';
	import { requirementKey, type SubtitleRequirement } from '#lib/shared/language-profile.js';
	import { createDynamicSSE } from '#lib/sse/index.js';
	import { getFileName } from '#lib/utils/format.js';
	import { layoutState, deriveMobileSseStatus } from '#lib/layout.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import { ACTIVE_DOWNLOAD_STATUSES } from '#lib/types/queue.js';
	import { createSubtitleProgress } from '#lib/stores/subtitleProgress.svelte.js';

	let { data }: { data: PageData } = $props();

	// Viewer accounts browse a read-only library; admin controls stay hidden.
	const isAdminUser = $derived(data.user?.role === 'admin');

	const activeStatusSet: Set<string> = new Set(ACTIVE_DOWNLOAD_STATUSES);

	// Reactive data that will be updated via SSE
	let movieState = $state<LibraryMovie | null>(null);
	let queueItemState = $state<PageData['queueItem'] | undefined>(undefined);
	let lastMovieId = $state<string | null>(null);
	const movie = $derived(movieState ?? data.movie);
	const queueItem = $derived(queueItemState === undefined ? data.queueItem : queueItemState);

	// Requirement-aware subtitle badge view-model. Null when the movie has no
	// effective profile (the loader then returns a trivially-satisfied status).
	const subtitleRequirementProgress = $derived(
		deriveSubtitleProgress(data.subtitleStatus, data.effectiveLanguageProfile?.profile ?? null)
	);

	// Back link target: the exact filtered list state from the page the user
	// navigated from (issue #515), read from sessionStorage rather than a
	// `?returnTo=` URL param so it doesn't show up in the address bar. Null
	// during SSR (sessionStorage is client-only); fills in after hydration.
	const moviesBackHref = $derived(getLibraryDetailBackHref('movies', '/library/movies'));

	function describeError(error: unknown, fallback: string): string {
		return error instanceof Error ? error.message : fallback;
	}

	function showActionError(message: string, error: unknown): void {
		toasts.error(message, { description: describeError(error, message) });
	}

	$effect(() => {
		const incomingMovieId = data.movie.id;
		if (lastMovieId !== incomingMovieId) {
			movieState = $state.snapshot(data.movie);
			queueItemState = $state.snapshot(data.queueItem);
			lastMovieId = incomingMovieId;
		}
	});

	// SSE Connection - internally handles browser/SSR
	const sse = createDynamicSSE<{
		'media:updated': { movie: LibraryMovie; queueItem: PageData['queueItem'] };
		'queue:sync': { queueItem: PageData['queueItem'] };
		'queue:added': { id: string; title: string; status: string; progress: number | null };
		'queue:updated': { id: string; title: string; status: string; progress: number | null };
		'queue:removed': { id: string };
		'file:added': {
			file: MovieFile;
			wasUpgrade: boolean;
			replacedFileIds?: string[];
		};
		'file:removed': { fileId: string };
	}>(() => `/api/library/movies/${movie.id}/stream`, {
		'media:updated': (payload) => {
			movieState = payload.movie;
			queueItemState = payload.queueItem;
		},
		'queue:sync': (payload) => {
			queueItemState = payload.queueItem;
		},
		'queue:added': (payload) => {
			queueItemState = {
				id: payload.id,
				title: payload.title,
				status: payload.status,
				progress: payload.progress
			};
		},
		'queue:updated': (payload) => {
			if (!activeStatusSet.has(payload.status)) {
				queueItemState = null;
			} else {
				queueItemState = {
					id: payload.id,
					title: payload.title,
					status: payload.status,
					progress: payload.progress
				};
			}
		},
		'queue:removed': (payload) => {
			if (queueItem?.id === payload.id) {
				queueItemState = null;
			}
		},
		'file:added': (payload) => {
			// Remove replaced files first
			if (payload.replacedFileIds) {
				movie.files = movie.files.filter((f) => !payload.replacedFileIds?.includes(f.id));
			}
			// Check if file already exists (update scenario)
			const existingIndex = movie.files.findIndex((f) => f.id === payload.file.id);
			if (existingIndex >= 0) {
				movie.files[existingIndex] = payload.file;
			} else {
				movie.files = [...movie.files, payload.file];
			}
			movie.hasFile = movie.files.length > 0;
			refreshAll();
		},
		'file:removed': (payload) => {
			movie.files = movie.files.filter((f) => f.id !== payload.fileId);
			movie.hasFile = movie.files.length > 0;
			refreshAll();
		}
	});

	$effect(() => {
		layoutState.setMobileSseStatus(deriveMobileSseStatus(sse));
		return () => {
			layoutState.clearMobileSseStatus();
		};
	});

	const prefetchProfileId = $derived.by(
		() => movie.scoringProfileId ?? data.qualityProfiles.find((p) => p.isDefault)?.id ?? null
	);
	const isStreamerProfile = $derived.by(() => movie.scoringProfileId === 'streamer');
	let prefetchedStreamKey = $state<string | null>(null);

	// Prefetch stream when page loads (warms cache for faster playback)
	$effect(() => {
		if (!(prefetchProfileId === 'streamer' && movie?.tmdbId)) return;
		const key = `movie:${movie.tmdbId}`;
		if (prefetchedStreamKey === key) return;
		prefetchedStreamKey = key;

		apiGetStream(
			`/api/streaming/session/movie/${movie.tmdbId}`,
			{ prefetch: '1' },
			{ signal: AbortSignal.timeout(5000), headers: { 'X-Prefetch': 'true' } }
		).catch(() => {});
	});

	// State
	let isEditModalOpen = $state(false);
	let isChangeMatchModalOpen = $state(false);
	let isSearchModalOpen = $state(false);
	let isSubtitleSearchModalOpen = $state(false);
	let isSubtitleSyncModalOpen = $state(false);
	let syncingSubtitleId = $state<string | null>(null);
	let subtitleSyncError = $state<string | null>(null);
	let isRenameModalOpen = $state(false);
	let isDeleteModalOpen = $state(false);
	let isDeleteFileModalOpen = $state(false);
	let deletingFileId = $state<string | null>(null);
	let deletingFileName = $state<string | null>(null);
	let isScoreModalOpen = $state(false);
	let isSaving = $state(false);
	let isDeleting = $state(false);
	let isDeletingFile = $state(false);
	let isProviderLinkModalOpen = $state(false);
	let resolvingProvider = $state<'anilist' | 'mal'>('anilist');
	let providerRefInput = $state('');
	let isSavingProviderRef = $state(false);
	let subtitleAutoSearching = $state(false);
	let autoSearching = $state(false);
	let autoSearchResult = $state<{
		found: boolean;
		grabbed: boolean;
		releaseName?: string;
		error?: string;
	} | null>(null);
	let scoreData = $state<FileScoreResponse | null>(null);
	let scoreLoading = $state(false);
	let scoreFetched = $state(false);
	let collectionSubtitleAutoSearching = $state(false);
	let collectionSearching = $state(false);
	let trackPanelOpen = $state(false);
	let trackAction = $state<'monitor-search' | 'monitor' | 'add'>('monitor-search');
	let tracking = $state(false);
	let addingPart = $state<{ tmdbId: number; title: string } | null>(null);
	let hoveredPartTmdbId = $state<number | null>(null);
	let addPartAction = $state<'monitor-search' | 'monitor' | 'add'>('monitor-search');
	let addingPartLoading = $state(false);

	const collectionParts = $derived(
		(data.collection?.parts ?? []).filter((p) => p.tmdbId !== movie.tmdbId)
	);
	const missingParts = $derived(collectionParts.filter((p) => !p.inLibrary));
	const trackedMissingFile = $derived(collectionParts.filter((p) => p.inLibrary && !p.hasFile));
	const trackedMissingSubtitles = $derived(
		collectionParts.filter((p) => p.inLibrary && p.hasFile && !p.hasSubtitles)
	);

	async function handleAddPart() {
		if (!addingPart || !movie.rootFolderId) return;
		addingPartLoading = true;
		try {
			const res = await fetch('/api/library/movies', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					tmdbId: addingPart.tmdbId,
					rootFolderId: movie.rootFolderId,
					scoringProfileId: movie.scoringProfileId ?? undefined,
					monitored: addPartAction !== 'add',
					searchOnAdd: addPartAction === 'monitor-search',
					minimumAvailability: 'released',
					availabilityDelay: 0,
					wantsSubtitles: true
				})
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error ?? 'Failed to add movie');
			toasts.success(`${addingPart.title} added to library`);
			addingPart = null;
			await refreshAll();
		} catch (err) {
			showActionError('Failed to add movie', err);
		} finally {
			addingPartLoading = false;
		}
	}

	async function handleTrackCollection() {
		if (!data.collection || !movie.rootFolderId) return;
		tracking = true;
		try {
			const res = await fetch(`/api/library/collections/${data.collection.tmdbId}/track`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					rootFolderId: movie.rootFolderId,
					scoringProfileId: movie.scoringProfileId ?? undefined,
					monitored: trackAction !== 'add',
					searchOnAdd: trackAction === 'monitor-search'
				})
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error ?? 'Failed to add collection');
			if (result.added > 0) {
				toasts.success(`Added ${result.added} movie${result.added === 1 ? '' : 's'} to library`);
				trackPanelOpen = false;
				await refreshAll();
			}
		} catch (err) {
			showActionError('Failed to add collection', err);
		} finally {
			tracking = false;
		}
	}

	const subtitleProgress = createSubtitleProgress();

	$effect(() => {
		if (page.url.searchParams.get('edit') === '1') {
			isEditModalOpen = true;
		}
	});

	// Derived score info for header badge (use normalized score for comparison with search results)
	const scoreInfo = $derived.by(() => {
		if (!scoreData) return null;
		return {
			score: scoreData.normalizedScore,
			isAtCutoff: scoreData.upgradeStatus.isAtCutoff,
			upgradesAllowed: scoreData.upgradeStatus.upgradesAllowed
		};
	});

	// Find quality profile name (use default if none set)
	const qualityProfileName = $derived.by(() => {
		if (movie.scoringProfileId) {
			return data.qualityProfiles.find((p) => p.id === movie.scoringProfileId)?.name ?? null;
		}
		// No profile set - show the default
		const defaultProfile = data.qualityProfiles.find((p) => p.isDefault);
		return defaultProfile ? m.library_movies_profileDefault({ name: defaultProfile.name }) : null;
	});

	const movieStoragePath = $derived.by(() => {
		const rootPath = movie.rootFolderPath ?? '';
		const relativePath = movie.path ?? '';

		if (!rootPath) {
			return relativePath;
		}

		if (!relativePath) {
			return rootPath;
		}

		const normalizedRoot = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
		const normalizedRelative = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;

		return `${normalizedRoot}/${normalizedRelative}`;
	});

	const providerLinkRows = $derived.by(() => {
		const isAnimeItem =
			(movie.rootFolderPath ?? '').toLowerCase().includes('/anime/') ||
			Boolean(movie.providerRefs?.anilist) ||
			Boolean(movie.providerRefs?.mal);
		if (!isAnimeItem) return [];

		const refs = movie.providerRefs ?? {};
		const rows: Array<
			{ label: string; value: string } & (
				| { resolved: true; href: string; provider: 'anilist' | 'mal' }
				| { resolved: false; provider: 'anilist' | 'mal' }
			)
		> = [];
		if (data.configuredMetadataProviders.anilist) {
			if (refs.anilist) {
				rows.push({
					label: 'AniList',
					href: `https://anilist.co/anime/${refs.anilist}`,
					value: refs.anilist,
					resolved: true,
					provider: 'anilist'
				});
			} else {
				rows.push({
					label: 'AniList',
					value: 'N/A',
					resolved: false,
					provider: 'anilist'
				});
			}
		}
		if (data.configuredMetadataProviders.mal) {
			if (refs.mal) {
				rows.push({
					label: 'MAL',
					href: `https://myanimelist.net/anime/${refs.mal}`,
					value: refs.mal,
					resolved: true,
					provider: 'mal'
				});
			} else {
				rows.push({
					label: 'MAL',
					value: 'N/A',
					resolved: false,
					provider: 'mal'
				});
			}
		}
		return rows;
	});
	const usesAnimeMetadataProvider = $derived(
		Boolean(movie.providerRefs?.anilist) || Boolean(movie.providerRefs?.mal)
	);

	function buildProviderSearchLink(provider: 'anilist' | 'mal'): string {
		const query = `${movie.title}${movie.year ? ` ${movie.year}` : ''}`;
		if (provider === 'anilist') {
			return `https://anilist.co/search/anime?search=${encodeURIComponent(query)}`;
		}
		return `https://myanimelist.net/anime.php?q=${encodeURIComponent(query)}&cat=anime`;
	}

	function openProviderLinkModal(provider: 'anilist' | 'mal'): void {
		resolvingProvider = provider;
		providerRefInput = '';
		isProviderLinkModalOpen = true;
	}

	function closeProviderLinkModal(): void {
		isProviderLinkModalOpen = false;
		providerRefInput = '';
	}

	async function saveProviderRef(): Promise<void> {
		const normalized = providerRefInput.trim();
		if (!normalized) return;

		isSavingProviderRef = true;
		try {
			const nextRefs = { ...(movie.providerRefs ?? {}), [resolvingProvider]: normalized };
			await updateMovie(movie.id, {
				providerRefs: nextRefs
			} as unknown as Record<string, unknown>);
			closeProviderLinkModal();
			await refreshMovieFromApi();
			toasts.success('Provider link updated');
		} catch (error) {
			showActionError('Failed to update provider link', error);
		} finally {
			isSavingProviderRef = false;
		}
	}

	async function refreshMovieFromApi(): Promise<void> {
		try {
			const result = (await getMovie(movie.id)) as { movie?: LibraryMovie };
			if (!result.movie) return;

			const refreshed = result.movie as LibraryMovie;
			movieState = {
				...movie,
				...refreshed,
				files: refreshed.files ?? [],
				subtitles: refreshed.subtitles ?? []
			};
		} catch (error) {
			showActionError(m.toast_library_movieDetail_failedToRefresh(), error);
		}
	}

	async function handleMonitorToggle(newValue: boolean) {
		isSaving = true;
		try {
			await updateMovie(movie.id, { monitored: newValue });
			movie.monitored = newValue;
		} catch (error) {
			showActionError(m.toast_library_movieDetail_failedToUpdateMonitor(), error);
		} finally {
			isSaving = false;
		}
	}

	function handleSearch() {
		isSearchModalOpen = true;
	}

	import { createSearchProgress } from '#lib/stores/searchProgress.svelte.js';
	import { getPrimaryAutoSearchIssue } from '#lib/utils/autoSearchIssues.js';

	// Per-item subtitle requirement override (details-page editing).
	let savingRequirements = $state(false);
	const missingRequirementKeys = $derived(
		(data.subtitleStatus?.missing ?? []).map((requirement) => requirementKey(requirement))
	);

	async function handleRequirementsSave(requirements: SubtitleRequirement[] | null) {
		savingRequirements = true;
		try {
			const response = await fetch(`/api/library/movies/${movie.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ subtitleRequirementsOverride: requirements })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? 'Failed to save subtitle languages');
			}
			await refreshAll();
		} finally {
			savingRequirements = false;
		}
	}

	async function handleRequirementSearch(requirement: SubtitleRequirement) {
		try {
			const response = await fetch('/api/subtitles/auto-search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ movieId: movie.id, requirement })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? 'Search failed');
			}
			await refreshAll();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Subtitle search failed');
		}
	}

	const searchProgress = createSearchProgress();

	function handleImport() {
		const query = [
			`mediaType=movie`,
			`tmdbId=${encodeURIComponent(String(movie.tmdbId))}`,
			`libraryId=${encodeURIComponent(movie.id)}`,
			`title=${encodeURIComponent(movie.title)}`,
			...(movie.year ? [`year=${encodeURIComponent(String(movie.year))}`] : [])
		].join('&');
		void goto(resolvePath(`/library/import?${query}`));
	}

	async function handleAutoSearch() {
		autoSearching = true;
		autoSearchResult = null;

		try {
			await searchProgress.startSearch(`/api/library/movies/${movie.id}/auto-search`);

			// Use the results from the search
			if (searchProgress.results) {
				autoSearchResult = {
					found: searchProgress.results.found ?? false,
					grabbed: searchProgress.results.grabbed ?? false,
					releaseName: searchProgress.results.releaseName,
					error: searchProgress.results.error
				};

				// Show toast notification
				const issue = getPrimaryAutoSearchIssue(searchProgress.results);
				if (searchProgress.results.grabbed) {
					toasts.success(
						m.toast_library_movieDetail_foundAndGrabbed({
							release: searchProgress.results.releaseName ?? ''
						})
					);
				} else if (issue) {
					toasts.error(issue.message, { description: issue.description });
				} else {
					toasts.info(m.toast_library_movieDetail_noSuitableReleases());
				}
			}
		} catch (error) {
			autoSearchResult = {
				found: false,
				grabbed: false,
				error:
					error instanceof Error ? error.message : m.toast_library_movieDetail_failedAutoSearch()
			};
			toasts.error(
				error instanceof Error ? error.message : m.toast_library_movieDetail_failedAutoSearch()
			);
		} finally {
			autoSearching = false;
			searchProgress.reset();
		}
	}

	function handleEdit() {
		isEditModalOpen = true;
	}

	function handleChangeMatch() {
		isChangeMatchModalOpen = true;
	}

	function handleChangeMatchSuccess() {
		isChangeMatchModalOpen = false;
		window.location.reload();
	}

	function handleEditClose() {
		isEditModalOpen = false;
		if (page.url.searchParams.get('edit') === '1') {
			goto(page.url.pathname, { replace: true, reset: false });
		}
	}

	async function handleEditSave(editData: MovieEditData) {
		isSaving = true;
		const collectionChanged =
			editData.tmdbCollectionId !== movie.tmdbCollectionId ||
			editData.collectionName !== movie.collectionName;
		try {
			const result = await updateMovie(movie.id, editData as unknown as Record<string, unknown>);

			// Update local state
			movie.monitored = editData.monitored;
			movie.scoringProfileId = editData.scoringProfileId;
			movie.desiredQualities = editData.desiredQualities;
			movie.minimumAvailability = editData.minimumAvailability;
			movie.availabilityDelay = editData.availabilityDelay;
			movie.wantsSubtitles = editData.wantsSubtitles;
			movie.languageProfileId = editData.languageProfileId;
			movie.tmdbCollectionId = editData.tmdbCollectionId ?? null;
			movie.collectionName = editData.collectionName ?? null;

			if (result?.moveQueued) {
				toasts.success(m.library_movieDetail_moveQueued());
			} else {
				movie.rootFolderId = editData.rootFolderId;
				const newFolder = data.rootFolders.find((f) => f.id === editData.rootFolderId);
				movie.rootFolderPath = newFolder?.path ?? null;
			}

			isEditModalOpen = false;

			if (collectionChanged) {
				isRenameModalOpen = true;
			}
		} catch (error) {
			showActionError(m.toast_library_movieDetail_failedToUpdate(), error);
		} finally {
			isSaving = false;
		}
	}

	function handleDelete() {
		isDeleteModalOpen = true;
	}

	async function performDelete(deleteFiles: boolean, removeFromLibrary: boolean) {
		isDeleting = true;
		try {
			const result = await deleteMovie(movie.id, deleteFiles, removeFromLibrary);

			if (result.success) {
				if (removeFromLibrary) {
					toasts.success(m.toast_library_movieDetail_movieRemoved());
					// Navigate to library since the movie no longer exists
					goto(resolvePath('/library/movies'));
				} else {
					toasts.success(m.toast_library_movieDetail_movieFilesDeleted());
					movie.files = [];
					movie.hasFile = false;
					queueItemState = null;
				}
			} else {
				toasts.error(m.toast_library_movieDetail_failedToDeleteMovie(), {
					description: result.error
				});
			}
		} catch (error) {
			showActionError(m.toast_library_movieDetail_failedToDeleteMovie(), error);
		} finally {
			isDeleting = false;
			isDeleteModalOpen = false;
		}
	}

	async function handleDeleteFile(fileId: string) {
		const file = movie.files.find((f) => f.id === fileId);
		deletingFileId = fileId;
		deletingFileName = file ? getFileName(file.relativePath) : m.library_movieDetail_thisFile();
		isDeleteFileModalOpen = true;
	}

	function closeDeleteFileModal() {
		isDeleteFileModalOpen = false;
		deletingFileId = null;
		deletingFileName = null;
	}

	async function confirmDeleteFile() {
		if (!deletingFileId) {
			closeDeleteFileModal();
			return;
		}

		isDeletingFile = true;
		try {
			const result = await deleteMovieFile(movie.id, deletingFileId);

			if (result.success) {
				toasts.success(m.toast_library_movieDetail_fileDeleted());
				const updatedFiles = movie.files.filter((f) => f.id !== deletingFileId);
				movie.files = updatedFiles;
				movie.hasFile = updatedFiles.length > 0;
				closeDeleteFileModal();
			} else {
				toasts.error(m.toast_library_movieDetail_failedToDeleteFile(), {
					description: result.error
				});
			}
		} catch (error) {
			showActionError(m.toast_library_movieDetail_failedToDeleteFile(), error);
		} finally {
			isDeletingFile = false;
		}
	}

	// Subtitle handlers
	function handleSubtitleSearch() {
		isSubtitleSearchModalOpen = true;
	}

	function handleSubtitleSync() {
		if (isStreamerProfile) {
			return;
		}
		subtitleSyncError = null;
		isSubtitleSyncModalOpen = true;
	}

	async function handleSubtitleAutoSearch() {
		subtitleAutoSearching = true;
		try {
			const raw = await autoSearchSubtitles({ movieId: movie.id });
			const result = raw as unknown as {
				success: boolean;
				subtitle?: {
					id?: string;
					subtitleId?: string;
					language?: string;
					isForced?: boolean;
					isHearingImpaired?: boolean;
					format?: string;
				};
			};

			if (result.success && result.subtitle) {
				const subtitleId = result.subtitle.id ?? result.subtitle.subtitleId;
				if (subtitleId) {
					handleSubtitleDownloaded({
						id: subtitleId,
						language: result.subtitle.language ?? 'unknown',
						isForced: result.subtitle.isForced,
						isHearingImpaired: result.subtitle.isHearingImpaired,
						format: result.subtitle.format
					});
				}
			}
		} catch (error) {
			showActionError(m.toast_library_movieDetail_failedToAutoSearchSubs(), error);
		} finally {
			subtitleAutoSearching = false;
		}
	}

	async function handleCollectionSubtitleAutoSearch(): Promise<void> {
		if (!movie.tmdbCollectionId) return;
		collectionSubtitleAutoSearching = true;

		try {
			const results = await subtitleProgress.startBatch({
				type: 'collection',
				collectionId: movie.tmdbCollectionId
			});

			if (results.downloaded > 0) {
				toasts.success(
					m.toast_library_movieDetail_foundAndGrabbed({
						release: `${results.downloaded} subtitles`
					})
				);
			} else {
				toasts.info(m.toast_library_tvDetail_noSubtitlesFound());
			}
		} catch (error) {
			showActionError(m.toast_library_movieDetail_failedToAutoSearchSubs(), error);
		} finally {
			collectionSubtitleAutoSearching = false;
			subtitleProgress.reset();
		}
	}

	async function handleCollectionSearch(): Promise<void> {
		if (trackedMissingFile.length === 0) return;
		collectionSearching = true;
		let searched = 0;
		try {
			await Promise.all(
				trackedMissingFile
					.filter((p) => p.movieId)
					.map((p) =>
						fetch(`/api/library/movies/${p.movieId}/auto-search`, { method: 'POST' })
							.then((r) => {
								if (r.ok) searched++;
							})
							.catch(() => {})
					)
			);
			if (searched > 0) {
				toasts.success(`Triggered search for ${searched} movie${searched > 1 ? 's' : ''}`);
			}
		} catch (error) {
			showActionError('Failed to trigger search', error);
		} finally {
			collectionSearching = false;
		}
	}

	function handleSubtitleDownloaded(subtitle: {
		id: string;
		language: string;
		isForced?: boolean;
		isHearingImpaired?: boolean;
		format?: string;
		wasSynced?: boolean;
		syncOffset?: number | null;
	}) {
		if (!movie.subtitles) {
			movie.subtitles = [];
		}
		if (movie.subtitles.some((s) => s.id === subtitle.id)) {
			return;
		}
		movie.subtitles = [...movie.subtitles, subtitle];
	}

	async function handleSubtitleResync(
		subtitleId: string,
		settings?: { splitPenalty?: number; noSplits?: boolean }
	): Promise<void> {
		syncingSubtitleId = subtitleId;
		subtitleSyncError = null;

		try {
			const result = await syncSubtitle(subtitleId, {
				...(settings?.splitPenalty !== undefined && { splitPenalty: settings.splitPenalty }),
				...(settings?.noSplits !== undefined && { noSplits: settings.noSplits })
			});

			if (!result.success) {
				throw new Error(result.error || m.toast_library_movieDetail_subtitleSyncFailed());
			}

			movie.subtitles = (movie.subtitles ?? []).map((subtitle) =>
				subtitle.id === subtitleId
					? {
							...subtitle,
							wasSynced: true,
							syncOffset: result.offsetMs
						}
					: subtitle
			);

			toasts.success(m.toast_library_movieDetail_subtitleSynced(), {
				description: m.toast_library_movieDetail_subtitleSyncOffset({
					offset: String(result.offsetMs)
				})
			});
		} catch (error) {
			subtitleSyncError = describeError(error, m.toast_library_movieDetail_subtitleSyncFailed());
			showActionError(m.toast_library_movieDetail_failedToSyncSub(), error);
		} finally {
			syncingSubtitleId = null;
		}
	}

	// Score handlers
	async function fetchScore() {
		if (scoreFetched || !movie.hasFile) return;

		scoreLoading = true;
		try {
			const result = await getMovieScore(movie.id);
			if (result.success) {
				scoreData = result.score;
			}
		} catch (error) {
			showActionError(m.toast_library_movieDetail_failedToLoadScore(), error);
		} finally {
			scoreLoading = false;
			scoreFetched = true;
		}
	}

	function handleScoreClick() {
		if (!scoreFetched) {
			fetchScore();
		}
		isScoreModalOpen = true;
	}

	// Fetch score on mount if movie has a file
	$effect(() => {
		if (movie.hasFile && !scoreFetched) {
			fetchScore();
		}
	});
</script>

<svelte:head>
	<title>{m.library_movieDetail_pageTitle({ title: movie.title })}</title>
	<meta
		name="description"
		content={movie.overview || m.library_movieDetail_metaDescription({ title: movie.title })}
	/>
</svelte:head>

<div class="flex w-full flex-col gap-4 overflow-x-hidden px-4 pb-20 md:gap-6 md:px-6 lg:px-8">
	<!-- Header -->
	<LibraryMovieHeader
		{movie}
		librarySlug={data.librarySlug}
		libraryName={data.libraryName}
		backHref={moviesBackHref}
		tmdbMovie={data.tmdbDetails}
		defaultRegion={page.data.defaultRegion}
		configuredProviders={data.configuredMetadataProviders}
		isDownloading={queueItem !== null}
		onMonitorToggle={handleMonitorToggle}
		onAutoSearch={handleAutoSearch}
		onSearch={handleSearch}
		onImport={handleImport}
		onEdit={handleEdit}
		onDelete={handleDelete}
		onChangeMatch={handleChangeMatch}
		onScoreClick={handleScoreClick}
		{autoSearching}
		{autoSearchResult}
		{scoreInfo}
		{scoreLoading}
		subtitleProgress={subtitleRequirementProgress}
		preferOriginalTitleDefault={data.preferOriginalTitleDefault}
		readOnly={!isAdminUser}
	/>

	<!-- Subtitle requirements (per-item override editing) -->
	<SubtitleRequirementsSection
		requirements={data.effectiveSubtitleRequirements?.requirements ?? []}
		missingKeys={missingRequirementKeys}
		source={data.effectiveSubtitleRequirements?.source ?? null}
		profileName={data.effectiveLanguageProfile?.profile.name ?? null}
		audioShortfall={data.movie.languageShortfall ?? false}
		editable={isAdminUser}
		saving={savingRequirements}
		onSave={handleRequirementsSave}
		onSearch={handleRequirementSearch}
	/>

	<!-- Main Content -->
	<div class="grid gap-4 lg:grid-cols-2 lg:gap-6 xl:grid-cols-3">
		<!-- Files Section (takes 2 columns on large screens) -->
		<div class="min-w-0 md:col-span-2 lg:col-span-2">
			<div class="min-w-0 overflow-hidden rounded-xl bg-base-200 p-4 md:p-6">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-lg font-semibold">{m.library_movieDetail_filesHeading()}</h2>
					<div class="flex flex-wrap items-center gap-2">
						{#if isAdminUser && !isStreamerProfile && (movie.subtitles?.length ?? 0) > 0}
							<button class="btn gap-1 btn-ghost btn-sm" onclick={handleSubtitleSync}>
								<RefreshCw class="h-4 w-4" />
								{m.library_movieDetail_syncSubtitles()}
							</button>
						{/if}
						{#if isAdminUser && movie.files.length > 0}
							<button class="btn gap-1 btn-ghost btn-sm" onclick={() => (isRenameModalOpen = true)}>
								<FileEdit class="h-4 w-4" />
								{m.library_movieDetail_rename()}
							</button>
						{/if}
					</div>
				</div>
				<MovieFilesTab
					files={movie.files}
					subtitles={movie.subtitles}
					subtitleProgress={subtitleRequirementProgress}
					{isStreamerProfile}
					readOnly={!isAdminUser}
					onDeleteFile={handleDeleteFile}
					onSearch={handleSearch}
					onSubtitleSearch={handleSubtitleSearch}
					onSubtitleAutoSearch={handleSubtitleAutoSearch}
					{subtitleAutoSearching}
				/>
			</div>

			{#if data.collection}
				{@const col = data.collection}
				<div class="mt-4 hidden rounded-xl bg-base-200 md:mt-6 md:block">
					<!-- Header -->
					<div class="flex items-center justify-between p-4 pb-3 md:p-6">
						<div class="flex items-center gap-2">
							<Layers class="h-4 w-4 shrink-0 text-primary" />
							<h2 class="text-lg font-semibold">
								Part of <span class="text-primary">{col.name}</span>
							</h2>
						</div>
						<div class="flex items-center gap-1">
							{#if isAdminUser && trackedMissingFile.length > 0}
								<button
									class="btn gap-2 btn-ghost btn-sm"
									onclick={handleCollectionSearch}
									disabled={collectionSearching}
									title="Search for missing movies in this collection"
								>
									{#if collectionSearching}
										<Loader2 size={16} class="animate-spin" />
									{:else}
										<Zap size={16} />
									{/if}
								</button>
							{/if}
							{#if isAdminUser && trackedMissingSubtitles.length > 0}
								<button
									class="btn gap-2 btn-ghost btn-sm"
									onclick={handleCollectionSubtitleAutoSearch}
									disabled={collectionSubtitleAutoSearching}
									title="Auto-download missing subtitles for movies in this collection"
								>
									{#if collectionSubtitleAutoSearching}
										<Loader2 size={16} class="animate-spin" />
									{:else}
										<Captions size={16} />
									{/if}
								</button>
							{/if}
						</div>
					</div>

					<!-- Parts grid -->
					<div class="px-4 pb-4 md:px-6">
						<div class="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
							{#each collectionParts as part (part.tmdbId)}
								{#if part.inLibrary && part.movieId}
									<a
										href={resolvePath(`/library/movie/${part.movieId}`)}
										class="flex min-w-0 flex-col items-center gap-1.5 rounded-lg p-2 transition-colors hover:bg-base-300"
									>
										<div class="relative aspect-2/3 w-full overflow-hidden rounded bg-base-300">
											{#if part.posterPath}
												<img
													src="https://image.tmdb.org/t/p/w185{part.posterPath}"
													alt={part.title}
													class="h-full w-full object-cover"
													loading="lazy"
												/>
											{/if}
											{#if part.hasFile}
												<span
													class="absolute right-0.5 bottom-0.5 rounded-full bg-success/80 p-0.5 text-success-content"
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														class="h-2.5 w-2.5"
														fill="none"
														viewBox="0 0 24 24"
														stroke="currentColor"
														stroke-width="3"
													>
														<path
															stroke-linecap="round"
															stroke-linejoin="round"
															d="M5 13l4 4L19 7"
														/>
													</svg>
												</span>
											{/if}
										</div>
										<span class="line-clamp-2 text-center text-xs leading-tight font-medium"
											>{part.title}</span
										>
										{#if part.year}<span class="text-[10px] text-base-content/50">{part.year}</span
											>{/if}
									</a>
								{:else}
									<div
										role="group"
										class="flex min-w-0 flex-col items-center gap-1.5 rounded-lg p-2 transition-colors hover:bg-base-300/60"
										onmouseenter={() => (hoveredPartTmdbId = part.tmdbId)}
										onmouseleave={() => (hoveredPartTmdbId = null)}
									>
										<div class="relative aspect-2/3 w-full overflow-hidden rounded bg-base-300">
											{#if part.posterPath}
												<img
													src="https://image.tmdb.org/t/p/w185{part.posterPath}"
													alt={part.title}
													class="h-full w-full object-cover opacity-40 transition-opacity {hoveredPartTmdbId ===
													part.tmdbId
														? 'opacity-60'
														: ''}"
													loading="lazy"
												/>
											{:else}
												<div class="h-full w-full opacity-40"></div>
											{/if}
											<div
												class="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/20 transition-opacity {hoveredPartTmdbId ===
												part.tmdbId
													? 'opacity-100'
													: 'opacity-0'}"
											>
												<button
													type="button"
													class="rounded-full bg-primary p-1.5 text-primary-content shadow-lg hover:bg-primary/80"
													title="Add to library"
													onclick={() => {
														addingPart = { tmdbId: part.tmdbId, title: part.title };
														addPartAction = 'monitor-search';
														trackPanelOpen = false;
													}}
												>
													<Plus class="h-3.5 w-3.5" />
												</button>
												<a
													href={resolvePath(`/discover/movie/${part.tmdbId}`)}
													class="rounded-full bg-base-100/80 p-1.5 text-base-content shadow-lg hover:bg-base-100"
													title="View in Discover"
												>
													<Info class="h-3.5 w-3.5" />
												</a>
											</div>
										</div>
										<span
											class="line-clamp-2 text-center text-xs leading-tight font-medium text-base-content/50"
											>{part.title}</span
										>
										{#if part.year}<span class="text-[10px] text-base-content/40">{part.year}</span
											>{/if}
									</div>
								{/if}
							{/each}
						</div>
					</div>

					<!-- Bottom panel: per-movie add or track-all -->
					{#if addingPart || missingParts.length > 0}
						<div class="border-t border-base-300 px-4 py-4 md:px-6">
							{#if addingPart}
								<!-- Per-movie add panel -->
								<div class="space-y-4">
									<div class="flex items-center justify-between">
										<p class="text-sm font-medium">
											Add <span class="text-primary">{addingPart.title}</span>
										</p>
										<button class="btn btn-ghost btn-xs" onclick={() => (addingPart = null)}
											>✕</button
										>
									</div>
									<div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
										{#each [{ value: 'monitor-search', Icon: Zap, label: 'Monitor & Search', desc: 'Add and start searching for releases immediately' }, { value: 'monitor', Icon: Eye, label: 'Monitor Only', desc: 'Add and monitor for releases automatically' }, { value: 'add', Icon: EyeOff, label: 'Add Unmonitored', desc: 'Add without automatic searching or monitoring' }] as opt (opt)}
											<button
												type="button"
												class="flex items-start gap-3 rounded-xl border-2 p-3 text-left transition-colors {addPartAction ===
												opt.value
													? 'border-primary bg-primary/5'
													: 'border-base-300 hover:border-base-content/30 hover:bg-base-300/40'}"
												onclick={() => (addPartAction = opt.value as typeof addPartAction)}
											>
												<div
													class="mt-0.5 shrink-0 rounded-lg p-1.5 {addPartAction === opt.value
														? 'bg-primary/15 text-primary'
														: 'bg-base-300 text-base-content/50'}"
												>
													<opt.Icon class="h-4 w-4" />
												</div>
												<div class="min-w-0">
													<p class="text-sm leading-tight font-semibold">{opt.label}</p>
													<p class="mt-0.5 text-xs leading-snug text-base-content/55">{opt.desc}</p>
												</div>
											</button>
										{/each}
									</div>
									<div class="flex gap-2">
										<button
											class="btn gap-2 btn-primary btn-sm"
											onclick={handleAddPart}
											disabled={addingPartLoading}
										>
											{#if addingPartLoading}<Loader2
													class="h-3.5 w-3.5 animate-spin"
												/>{:else}<Plus class="h-3.5 w-3.5" />{/if}
											Confirm
										</button>
										<button class="btn btn-ghost btn-sm" onclick={() => (addingPart = null)}
											>Cancel</button
										>
									</div>
								</div>
							{:else if !trackPanelOpen}
								<button
									class="btn gap-2 btn-primary btn-sm"
									onclick={() => (trackPanelOpen = true)}
								>
									<Plus class="h-4 w-4" />
									Add collection
									<span class="badge-primary-content badge badge-sm"
										>{missingParts.length} missing</span
									>
								</button>
							{:else}
								<div class="space-y-4">
									<p class="text-sm text-base-content/70">
										{missingParts.length} movie{missingParts.length === 1 ? '' : 's'} from this collection
										{missingParts.length === 1 ? 'is' : 'are'} not in your library. How would you like
										to add {missingParts.length === 1 ? 'it' : 'them'}?
									</p>

									<div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
										{#each [{ value: 'monitor-search', Icon: Zap, label: 'Monitor & Search', desc: 'Add and start searching for releases immediately' }, { value: 'monitor', Icon: Eye, label: 'Monitor Only', desc: 'Add and monitor for releases automatically' }, { value: 'add', Icon: EyeOff, label: 'Add Unmonitored', desc: 'Add without automatic searching or monitoring' }] as opt (opt)}
											<button
												type="button"
												class="flex items-start gap-3 rounded-xl border-2 p-3 text-left transition-colors {trackAction ===
												opt.value
													? 'border-primary bg-primary/5'
													: 'border-base-300 hover:border-base-content/30 hover:bg-base-300/40'}"
												onclick={() => (trackAction = opt.value as typeof trackAction)}
											>
												<div
													class="mt-0.5 shrink-0 rounded-lg p-1.5 {trackAction === opt.value
														? 'bg-primary/15 text-primary'
														: 'bg-base-300 text-base-content/50'}"
												>
													<opt.Icon class="h-4 w-4" />
												</div>
												<div class="min-w-0">
													<p class="text-sm leading-tight font-semibold">{opt.label}</p>
													<p class="mt-0.5 text-xs leading-snug text-base-content/55">{opt.desc}</p>
												</div>
											</button>
										{/each}
									</div>

									<div class="flex gap-2">
										<button
											class="btn gap-2 btn-primary btn-sm"
											onclick={handleTrackCollection}
											disabled={tracking}
										>
											{#if tracking}
												<Loader2 class="h-3.5 w-3.5 animate-spin" />
												Adding...
											{:else}
												<Plus class="h-3.5 w-3.5" />
												Confirm
											{/if}
										</button>
										<button class="btn btn-ghost btn-sm" onclick={() => (trackPanelOpen = false)}>
											Cancel
										</button>
									</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Sidebar -->
		<div class="min-w-0 space-y-4 md:space-y-6">
			<!-- Details -->
			<div class="rounded-xl bg-base-200 p-4 md:p-6">
				<h3 class="mb-3 font-semibold">{m.library_movieDetail_detailsHeading()}</h3>
				<dl class="space-y-2 text-sm">
					{#if movie.originalTitle && movie.originalTitle !== movie.title}
						<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
							<dt class="text-base-content/60">{m.library_movieDetail_originalTitle()}</dt>
							<dd class="sm:text-right">{movie.originalTitle}</dd>
						</div>
					{/if}
					{#if usesAnimeMetadataProvider && movie.studios && movie.studios.length > 0}
						<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
							<dt class="text-base-content/60">Studios</dt>
							<dd class="sm:text-right">{movie.studios.join(', ')}</dd>
						</div>
					{/if}
					<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
						<dt class="text-base-content/60">{m.library_movieHeader_qualityProfileLabel()}</dt>
						<dd>{qualityProfileName || m.common_default()}</dd>
					</div>
					{#if movie.imdbId}
						<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
							<dt class="text-base-content/60">{m.library_movieDetail_imdb()}</dt>
							<dd>
								<a
									href="https://www.imdb.com/title/{movie.imdbId}"
									target="_blank"
									rel="noopener noreferrer"
									class="link link-primary"
								>
									{movie.imdbId}
								</a>
							</dd>
						</div>
					{/if}
					<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
						<dt class="text-base-content/60">{m.library_movieDetail_tmdbId()}</dt>
						<dd>
							<a
								href="https://www.themoviedb.org/movie/{movie.tmdbId}"
								target="_blank"
								rel="noopener noreferrer"
								class="link link-primary"
							>
								{movie.tmdbId}
							</a>
						</dd>
					</div>
					{#each providerLinkRows as row (row.label)}
						<div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
							<dt class="text-base-content/60">{row.label}</dt>
							<dd>
								{#if row.resolved}
									<a
										href={row.href}
										target="_blank"
										rel="noopener noreferrer"
										class="link link-primary"
									>
										{row.value}
									</a>
								{:else}
									<button
										type="button"
										class="link link-warning"
										onclick={() => openProviderLinkModal(row.provider)}
									>
										{row.value}
									</button>
								{/if}
							</dd>
						</div>
					{/each}
					<div class="border-t border-base-content/10 pt-2">
						<dt class="text-base-content/60">{m.library_movieDetail_path()}</dt>
						<dd class="mt-1 font-mono text-xs break-all">
							{movieStoragePath}
						</dd>
					</div>
				</dl>
			</div>

			{#if data.collection}
				{@const col = data.collection}
				<div class="rounded-xl bg-base-200 md:hidden">
					<div class="flex items-center justify-between p-4 pb-3">
						<div class="flex min-w-0 items-center gap-2">
							<Layers class="h-4 w-4 shrink-0 text-primary" />
							<h2 class="truncate text-base font-semibold">
								Part of <span class="text-primary">{col.name}</span>
							</h2>
						</div>
						<div class="flex shrink-0 items-center gap-1">
							{#if isAdminUser && trackedMissingFile.length > 0}
								<button
									class="btn gap-2 btn-ghost btn-sm"
									onclick={handleCollectionSearch}
									disabled={collectionSearching}
									title="Search for missing movies in this collection"
								>
									{#if collectionSearching}
										<Loader2 size={16} class="animate-spin" />
									{:else}
										<Zap size={16} />
									{/if}
								</button>
							{/if}
							{#if isAdminUser && trackedMissingSubtitles.length > 0}
								<button
									class="btn gap-2 btn-ghost btn-sm"
									onclick={handleCollectionSubtitleAutoSearch}
									disabled={collectionSubtitleAutoSearching}
									title="Auto-download missing subtitles for movies in this collection"
								>
									{#if collectionSubtitleAutoSearching}
										<Loader2 size={16} class="animate-spin" />
									{:else}
										<Captions size={16} />
									{/if}
								</button>
							{/if}
						</div>
					</div>

					<!-- Horizontal scroll strip -->
					<div class="-mx-1 flex max-w-full gap-3 overflow-x-auto overscroll-x-contain px-3 pb-3">
						{#each collectionParts as part (part.tmdbId)}
							{#if part.inLibrary && part.movieId}
								<a
									href={resolvePath(`/library/movie/${part.movieId}`)}
									class="flex w-24 shrink-0 flex-col items-center gap-1.5 rounded-lg p-2 transition-colors hover:bg-base-300"
								>
									<div class="relative aspect-2/3 w-full overflow-hidden rounded bg-base-300">
										{#if part.posterPath}
											<img
												src="https://image.tmdb.org/t/p/w185{part.posterPath}"
												alt={part.title}
												class="h-full w-full object-cover"
												loading="lazy"
											/>
										{/if}
										{#if part.hasFile}
											<span
												class="absolute right-0.5 bottom-0.5 rounded-full bg-success/80 p-0.5 text-success-content"
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													class="h-2.5 w-2.5"
													fill="none"
													viewBox="0 0 24 24"
													stroke="currentColor"
													stroke-width="3"
												>
													<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
												</svg>
											</span>
										{/if}
									</div>
									<span class="line-clamp-2 text-center text-xs leading-tight font-medium"
										>{part.title}</span
									>
									{#if part.year}<span class="text-[10px] text-base-content/50">{part.year}</span
										>{/if}
								</a>
							{:else}
								<div
									role="group"
									class="flex w-24 shrink-0 flex-col items-center gap-1.5 rounded-lg p-2 transition-colors hover:bg-base-300/60"
									onmouseenter={() => (hoveredPartTmdbId = part.tmdbId)}
									onmouseleave={() => (hoveredPartTmdbId = null)}
								>
									<div class="relative aspect-2/3 w-full overflow-hidden rounded bg-base-300">
										{#if part.posterPath}
											<img
												src="https://image.tmdb.org/t/p/w185{part.posterPath}"
												alt={part.title}
												class="h-full w-full object-cover opacity-40 transition-opacity {hoveredPartTmdbId ===
												part.tmdbId
													? 'opacity-60'
													: ''}"
												loading="lazy"
											/>
										{:else}
											<div class="h-full w-full opacity-40"></div>
										{/if}
										<div
											class="absolute inset-0 flex items-center justify-center gap-1 bg-black/20 transition-opacity {hoveredPartTmdbId ===
											part.tmdbId
												? 'opacity-100'
												: 'opacity-0'}"
										>
											<button
												type="button"
												class="rounded-full bg-primary p-1.5 text-primary-content shadow-lg hover:bg-primary/80"
												onclick={() => {
													addingPart = { tmdbId: part.tmdbId, title: part.title };
													addPartAction = 'monitor-search';
													trackPanelOpen = false;
												}}
												title="Add to library"
											>
												<Plus class="h-3 w-3" />
											</button>
											<a
												href={resolvePath(`/discover/movie/${part.tmdbId}`)}
												class="rounded-full bg-base-100/80 p-1.5 text-base-content shadow-lg hover:bg-base-100"
												title="View in Discover"
											>
												<Info class="h-3 w-3" />
											</a>
										</div>
									</div>
									<span
										class="line-clamp-2 text-center text-xs leading-tight font-medium text-base-content/50"
										>{part.title}</span
									>
									{#if part.year}<span class="text-[10px] text-base-content/40">{part.year}</span
										>{/if}
								</div>
							{/if}
						{/each}
					</div>

					<!-- Mobile bottom panel: per-movie add or track-all -->
					{#if addingPart || missingParts.length > 0}
						<div class="border-t border-base-300 p-4">
							{#if addingPart}
								<div class="space-y-4">
									<div class="flex items-center justify-between">
										<p class="text-sm font-medium">
											Add <span class="text-primary">{addingPart.title}</span>
										</p>
										<button class="btn btn-ghost btn-xs" onclick={() => (addingPart = null)}
											>✕</button
										>
									</div>
									<div class="flex flex-col gap-2">
										{#each [{ value: 'monitor-search', Icon: Zap, label: 'Monitor & search', desc: 'Add and start searching for releases immediately' }, { value: 'monitor', Icon: Eye, label: 'Monitor only', desc: 'Add and wait for future releases automatically' }, { value: 'add', Icon: EyeOff, label: 'Add unmonitored', desc: 'Add without automatic searching or monitoring' }] as opt (opt)}
											<button
												type="button"
												class="flex items-start gap-3 rounded-xl border-2 p-3 text-left transition-colors {addPartAction ===
												opt.value
													? 'border-primary bg-primary/5'
													: 'border-base-300 hover:border-base-content/30'}"
												onclick={() => (addPartAction = opt.value as typeof addPartAction)}
											>
												<div
													class="mt-0.5 shrink-0 rounded-lg p-1.5 {addPartAction === opt.value
														? 'bg-primary/15 text-primary'
														: 'bg-base-300 text-base-content/50'}"
												>
													<opt.Icon class="h-4 w-4" />
												</div>
												<div class="min-w-0">
													<p class="text-sm leading-tight font-semibold">{opt.label}</p>
													<p class="mt-0.5 text-xs leading-snug text-base-content/55">{opt.desc}</p>
												</div>
											</button>
										{/each}
									</div>
									<div class="flex gap-2">
										<button
											class="btn flex-1 gap-2 btn-primary btn-sm"
											onclick={handleAddPart}
											disabled={addingPartLoading}
										>
											{#if addingPartLoading}<Loader2
													class="h-3.5 w-3.5 animate-spin"
												/>{:else}<Plus class="h-3.5 w-3.5" />{/if}
											Confirm
										</button>
										<button class="btn btn-ghost btn-sm" onclick={() => (addingPart = null)}
											>Cancel</button
										>
									</div>
								</div>
							{:else if !trackPanelOpen}
								<button
									class="btn w-full gap-2 btn-primary btn-sm"
									onclick={() => (trackPanelOpen = true)}
								>
									<Plus class="h-4 w-4" />
									Add collection
									<span class="badge-primary-content badge badge-sm"
										>{missingParts.length} missing</span
									>
								</button>
							{:else}
								<div class="space-y-4">
									<p class="text-sm text-base-content/70">
										{missingParts.length} movie{missingParts.length === 1 ? '' : 's'} from this collection
										{missingParts.length === 1 ? 'is' : 'are'} not in your library. How would you like
										to add {missingParts.length === 1 ? 'it' : 'them'}?
									</p>
									<div class="flex flex-col gap-2">
										{#each [{ value: 'monitor-search', Icon: Zap, label: 'Monitor & search', desc: 'Add and start searching for releases immediately' }, { value: 'monitor', Icon: Eye, label: 'Monitor only', desc: 'Add and wait for future releases automatically' }, { value: 'add', Icon: EyeOff, label: 'Add unmonitored', desc: 'Add without automatic searching or monitoring' }] as opt (opt)}
											<button
												type="button"
												class="flex items-start gap-3 rounded-xl border-2 p-3 text-left transition-colors {trackAction ===
												opt.value
													? 'border-primary bg-primary/5'
													: 'border-base-300 hover:border-base-content/30'}"
												onclick={() => (trackAction = opt.value as typeof trackAction)}
											>
												<div
													class="mt-0.5 shrink-0 rounded-lg p-1.5 {trackAction === opt.value
														? 'bg-primary/15 text-primary'
														: 'bg-base-300 text-base-content/50'}"
												>
													<opt.Icon class="h-4 w-4" />
												</div>
												<div class="min-w-0">
													<p class="text-sm leading-tight font-semibold">{opt.label}</p>
													<p class="mt-0.5 text-xs leading-snug text-base-content/55">{opt.desc}</p>
												</div>
											</button>
										{/each}
									</div>
									<div class="flex gap-2">
										<button
											class="btn flex-1 gap-2 btn-primary btn-sm"
											onclick={handleTrackCollection}
											disabled={tracking}
										>
											{#if tracking}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus
													class="h-3.5 w-3.5"
												/>{/if}
											Confirm
										</button>
										<button class="btn btn-ghost btn-sm" onclick={() => (trackPanelOpen = false)}
											>Cancel</button
										>
									</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- Edit Modal -->
<MovieEditModal
	open={isEditModalOpen}
	{movie}
	qualityProfiles={data.qualityProfiles}
	delayProfiles={data.delayProfiles}
	languageProfiles={data.languageProfiles}
	effectiveLanguageProfile={data.effectiveLanguageProfile}
	rootFolders={data.rootFolders}
	saving={isSaving}
	onClose={handleEditClose}
	onSave={handleEditSave}
/>

<!-- Change Match Modal -->
<ChangeMatchModal
	open={isChangeMatchModalOpen}
	mediaType="movie"
	mediaId={movie.id}
	currentTitle={movie.title}
	currentYear={movie.year}
	onClose={() => (isChangeMatchModalOpen = false)}
	onSuccess={handleChangeMatchSuccess}
/>

<!-- Search Modal -->
<MediaSearchModal
	open={isSearchModalOpen}
	movieId={movie.id}
	onClose={() => (isSearchModalOpen = false)}
/>

<!-- Subtitle Search Modal -->
<SubtitleSearchModal
	open={isSubtitleSearchModalOpen}
	title={movie.title}
	movieId={movie.id}
	onClose={() => (isSubtitleSearchModalOpen = false)}
	onDownloaded={handleSubtitleDownloaded}
/>

<SubtitleSyncModal
	open={isSubtitleSyncModalOpen}
	title={movie.title}
	subtitles={movie.subtitles ?? []}
	{syncingSubtitleId}
	errorMessage={subtitleSyncError}
	onClose={() => {
		isSubtitleSyncModalOpen = false;
		subtitleSyncError = null;
	}}
	onSync={handleSubtitleResync}
/>

<!-- Rename Preview Modal -->
<RenamePreviewModal
	open={isRenameModalOpen}
	mediaType="movie"
	mediaId={movie.id}
	mediaTitle={movie.title}
	onClose={() => (isRenameModalOpen = false)}
	onRenamed={() => {
		void refreshMovieFromApi();
	}}
/>

<!-- Delete Confirmation Modal -->
<DeleteConfirmationModal
	open={isDeleteModalOpen}
	title={m.library_movieDetail_deleteMovieTitle()}
	itemName={movie.title}
	hasFiles={movie.hasFile === true || (queueItem !== null && queueItem !== undefined)}
	hasActiveDownload={queueItem !== null && queueItem !== undefined}
	loading={isDeleting}
	onConfirm={performDelete}
	onCancel={() => (isDeleteModalOpen = false)}
/>

<!-- File Delete Confirmation Modal -->
<ConfirmationModal
	open={isDeleteFileModalOpen}
	title={m.library_movieDetail_deleteFileTitle()}
	message={m.library_movieDetail_deleteFileMessage({
		fileName: deletingFileName ?? m.library_movieDetail_thisFile()
	})}
	confirmLabel={m.common_delete()}
	confirmVariant="error"
	loading={isDeletingFile}
	onConfirm={confirmDeleteFile}
	onCancel={closeDeleteFileModal}
/>

<!-- Score Detail Modal -->
<ScoreDetailModal open={isScoreModalOpen} onClose={() => (isScoreModalOpen = false)} {scoreData} />

<ModalWrapper
	open={isProviderLinkModalOpen}
	onClose={closeProviderLinkModal}
	maxWidth="md"
	labelledBy="movie-provider-link-modal-title"
>
	<ModalHeader
		title={`Link ${resolvingProvider === 'anilist' ? 'AniList' : 'MAL'} ID`}
		onClose={closeProviderLinkModal}
	/>
	<div class="space-y-4">
		<p class="text-sm text-base-content/70">
			This item is not linked for {resolvingProvider === 'anilist' ? 'AniList' : 'MAL'}.
		</p>
		<div class="rounded-lg bg-base-200 p-3 text-sm">
			<a
				href={buildProviderSearchLink(resolvingProvider)}
				target="_blank"
				rel="noopener noreferrer"
				class="link link-primary"
			>
				Open provider search
			</a>
		</div>
		<label class="form-control w-full">
			<span class="label-text mb-1 text-sm">
				{resolvingProvider === 'anilist' ? 'AniList ID' : 'MAL ID'}
			</span>
			<input
				type="text"
				class="input-bordered input w-full"
				bind:value={providerRefInput}
				placeholder={resolvingProvider === 'anilist' ? 'e.g. 154587' : 'e.g. 33218'}
			/>
		</label>
	</div>
	<ModalFooter
		onCancel={closeProviderLinkModal}
		onSave={() => void saveProviderRef()}
		saving={isSavingProviderRef}
		saveDisabled={!providerRefInput.trim()}
		saveLabel="Save Link"
	/>
</ModalWrapper>

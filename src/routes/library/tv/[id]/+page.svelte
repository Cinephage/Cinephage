<script lang="ts">
	import type { PageData } from './$types';
	import type { EpisodeFileInfo } from './+page.server';
	import {
		LibrarySeriesHeader,
		SeasonAccordion,
		SeriesEditModal,
		RenamePreviewModal,
		ChangeMatchModal
	} from '#lib/components/library/index.js';
	import { TVSeriesSidebar, BulkActionBar } from '#lib/components/library/tv/index.js';
	import { MediaSearchModal } from '#lib/components/search/index.js';
	import { SubtitleSearchModal } from '#lib/components/subtitles/index.js';
	import SubtitleSyncModal from '#lib/components/subtitles/SubtitleSyncModal.svelte';
	import SubtitleRequirementsSection from '#lib/components/subtitles/SubtitleRequirementsSection.svelte';
	import { deriveSeriesSubtitleProgress } from '#lib/utils/subtitle-status-display.js';
	import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
	import DeleteConfirmationModal from '#lib/components/ui/modal/DeleteConfirmationModal.svelte';
	import { ModalWrapper, ModalHeader, ModalFooter } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { todayDateString } from '#lib/utils/format.js';
	import { autoSearchSubtitles, syncSubtitle, deleteSubtitle } from '#lib/api/subtitles.js';
	import {
		updateSeries,
		getSeries,
		deleteSeries,
		deleteSeason,
		deleteEpisode,
		updateSeason,
		updateEpisode
	} from '#lib/api/library.js';
	import { apiPostStream } from '#lib/api/index.js';
	import type { SeriesEditData } from '#lib/components/library/SeriesEditModal.svelte';
	import type { SearchMode } from '#lib/components/search/InteractiveSearchModal.svelte';
	import { CheckSquare, FileEdit, RefreshCw, X } from '@lucide/svelte';
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { goto, refreshAll } from '$app/navigation';
	import { resolvePath } from '#lib/utils/routing.js';
	import { getLibraryDetailBackHref } from '#lib/utils/libraryReturnNavigation.js';
	import { createDynamicSSE } from '#lib/sse/index.js';
	import { createSearchProgress } from '#lib/stores/searchProgress.svelte.js';
	import { createSubtitleProgress } from '#lib/stores/subtitleProgress.svelte.js';
	import { getPrimaryAutoSearchIssue } from '#lib/utils/autoSearchIssues.js';
	import { layoutState, deriveMobileSseStatus } from '#lib/layout.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import { calculateEpisodeStats } from '#lib/utils/episode-stats.svelte.js';
	import { ACTIVE_DOWNLOAD_STATUSES } from '#lib/types/queue.js';

	let { data }: { data: PageData } = $props();

	// Viewer accounts browse a read-only library; admin controls stay hidden.
	const isAdminUser = $derived(data.user?.role === 'admin');

	const activeStatusSet: Set<string> = new Set(ACTIVE_DOWNLOAD_STATUSES);

	// Reactive data that will be updated via SSE
	let seriesState = $state<PageData['series'] | null>(null);
	let seasonsState = $state<PageData['seasons'] | null>(null);
	let queueItemsState = $state<PageData['queueItems'] | null>(null);
	let lastSeriesId = $state<string | null>(null);
	const series = $derived(seriesState ?? data.series);
	const seasons = $derived(seasonsState ?? data.seasons);
	const queueItems = $derived(queueItemsState ?? data.queueItems);

	// Back link target: the exact filtered list state from the page the user
	// navigated from (issue #515), read from sessionStorage rather than a
	// `?returnTo=` URL param so it doesn't show up in the address bar. Null
	// during SSR (sessionStorage is client-only); fills in after hydration.
	const tvBackHref = $derived(getLibraryDetailBackHref('tv', '/library/tv'));

	function computeSeriesEpisodeStats(seasonList: PageData['seasons']) {
		const regularSeasons = seasonList.filter((season) => season.seasonNumber > 0);
		const allEpisodes = regularSeasons.flatMap((season) => season.episodes);
		const stats = calculateEpisodeStats(allEpisodes);

		return {
			totalEpisodes: stats.totalAired,
			totalFiles: stats.downloaded,
			percentComplete: stats.percentComplete
		};
	}

	// A series is partially monitored when it is monitored but only some aired episodes are.
	const partiallyMonitored = $derived.by(() => {
		if (!series.monitored) return false;
		const today = todayDateString();
		const allEps = seasons
			.filter((s) => s.seasonNumber > 0)
			.flatMap((s) => s.episodes)
			.filter((ep) => ep.airDate && ep.airDate <= today);
		if (allEps.length === 0) return false;
		const monitoredCount = allEps.filter((ep) => ep.monitored !== false).length;
		return monitoredCount > 0 && monitoredCount < allEps.length;
	});

	// Keep series completion counters aligned with the actual episode rows shown in seasons.
	const seriesForDisplay = $derived.by(() => {
		const { totalEpisodes, totalFiles, percentComplete } = computeSeriesEpisodeStats(seasons);
		return {
			...series,
			episodeCount: totalEpisodes,
			episodeFileCount: totalFiles,
			percentComplete
		};
	});

	// Calculate total size across all seasons from episode files
	const totalSeriesSize = $derived(
		seasons.reduce(
			(total, season) => total + season.episodes.reduce((sum, ep) => sum + (ep.file?.size ?? 0), 0),
			0
		)
	);

	$effect(() => {
		const incomingSeriesId = data.series.id;
		if (lastSeriesId !== incomingSeriesId) {
			seriesState = $state.snapshot(data.series);
			seasonsState = $state.snapshot(data.seasons);
			queueItemsState = $state.snapshot(data.queueItems);
			lastSeriesId = incomingSeriesId;
		}
	});

	// AniList/MAL provider refs resolve in the background (see +page.server.ts,
	// not awaited there, so a slow/unmatched provider never blocks first
	// paint). Merge them in once they land; guard against having navigated to
	// a different series in the meantime.
	$effect(() => {
		const forSeriesId = data.series.id;
		data.animeProviderRefsPromise
			?.then((refs) => {
				if (seriesState && seriesState.id === forSeriesId) {
					seriesState.providerRefs = refs;
				}
			})
			.catch(() => {
				// Best-effort enrichment; the page already rendered with whatever
				// refs were already stored.
			});
	});

	// SSE Connection - internally handles browser/SSR
	// Shared type for queue SSE payloads
	type QueueEventPayload = {
		id: string;
		title: string;
		status: string;
		progress: number | null;
		episodeIds?: string[];
		seasonNumber?: number;
	};

	const sse = createDynamicSSE<{
		'media:updated': {
			series: typeof series;
			seasons: typeof seasons;
			queueItems: typeof queueItems;
		};
		'queue:sync': { queueItems: typeof queueItems };
		'queue:added': QueueEventPayload;
		'queue:updated': QueueEventPayload;
		'queue:removed': { id: string };
		'file:added': {
			file: EpisodeFileInfo;
			episodeIds: string[];
			seasonNumber: number;
			wasUpgrade: boolean;
			replacedFileIds?: string[];
		};
		'file:removed': { fileId: string; episodeIds: string[] };
		'search:started': { seriesId: string };
		'search:completed': { seriesId: string };
	}>(() => `/api/library/series/${series.id}/stream`, {
		'media:updated': (payload) => {
			seriesState = payload.series;
			seasonsState = payload.seasons;
			queueItemsState = payload.queueItems;
		},
		'queue:sync': (payload) => {
			queueItemsState = payload.queueItems;
		},
		'queue:added': (payload) => {
			// Add new queue item if not already tracked
			const exists = queueItems.some((q) => q.id === payload.id);
			if (!exists) {
				queueItemsState = [
					...queueItems,
					{
						id: payload.id,
						title: payload.title,
						status: payload.status,
						progress: payload.progress,
						episodeIds: payload.episodeIds || null,
						seasonNumber: payload.seasonNumber || null
					}
				];
			}
		},
		'queue:updated': (payload) => {
			if (!activeStatusSet.has(payload.status)) {
				// Remove from queue state when no longer active
				queueItemsState = queueItems.filter((q) => q.id !== payload.id);
			} else {
				// Update or add queue item
				const existingIndex = queueItems.findIndex((q) => q.id === payload.id);
				const newQueueItem = {
					id: payload.id,
					title: payload.title,
					status: payload.status,
					progress: payload.progress,
					episodeIds: payload.episodeIds || null,
					seasonNumber: payload.seasonNumber || null
				};
				if (existingIndex >= 0) {
					queueItemsState = queueItems.map((q, idx) => (idx === existingIndex ? newQueueItem : q));
				} else {
					queueItemsState = [...queueItems, newQueueItem];
				}
			}
		},
		'queue:removed': (payload) => {
			queueItemsState = queueItems.filter((q) => q.id !== payload.id);
		},
		'file:added': (payload) => {
			// Work with seasonsState to ensure reactivity
			if (!seasonsState) {
				return;
			}

			const seasonIndex = seasonsState.findIndex((s) => s.seasonNumber === payload.seasonNumber);

			if (seasonIndex === -1) {
				return;
			}

			// Create new seasons array with immutable updates
			seasonsState = seasonsState.map((season, sIdx) => {
				if (sIdx !== seasonIndex) return season;

				// Update episodes immutably
				const updatedEpisodes = season.episodes.map((episode) => {
					if (!payload.episodeIds.includes(episode.id)) return episode;
					return {
						...episode,
						file: payload.file,
						hasFile: true
					};
				});

				// Calculate new file count
				const episodeFileCount = updatedEpisodes.filter((e) => e.file !== null).length;

				return {
					...season,
					episodes: updatedEpisodes,
					episodeFileCount
				};
			});

			// Update series state immutably
			if (seriesState) {
				const { totalEpisodes, totalFiles } = computeSeriesEpisodeStats(seasonsState);
				seriesState = {
					...seriesState,
					episodeFileCount: totalFiles,
					percentComplete: totalEpisodes > 0 ? Math.round((totalFiles / totalEpisodes) * 100) : 0
				};
			}
		},
		'file:removed': (payload) => {
			// Work with seasonsState to ensure reactivity
			if (!seasonsState) return;

			// Create new seasons array with immutable updates
			seasonsState = seasonsState.map((season) => {
				// Update episodes immutably
				const updatedEpisodes = season.episodes.map((episode) => {
					if (episode.file?.id !== payload.fileId) return episode;
					return {
						...episode,
						file: null,
						hasFile: false
					};
				});

				// Calculate new file count
				const episodeFileCount = updatedEpisodes.filter((e) => e.file !== null).length;

				return {
					...season,
					episodes: updatedEpisodes,
					episodeFileCount
				};
			});

			// Update series state immutably
			if (seriesState) {
				const { totalEpisodes, totalFiles } = computeSeriesEpisodeStats(seasonsState);
				seriesState = {
					...seriesState,
					episodeFileCount: totalFiles,
					percentComplete: totalEpisodes > 0 ? Math.round((totalFiles / totalEpisodes) * 100) : 0
				};
			}
		},
		'search:started': () => {
			searchingMissing = true;
		},
		'search:completed': () => {
			searchingMissing = false;
		}
	});

	$effect(() => {
		layoutState.setMobileSseStatus(deriveMobileSseStatus(sse));
		return () => {
			layoutState.clearMobileSseStatus();
		};
	});

	// State
	let isEditModalOpen = $state(false);
	let isChangeMatchModalOpen = $state(false);
	let isSearchModalOpen = $state(false);
	let isRenameModalOpen = $state(false);
	let isDeleteModalOpen = $state(false);
	let cascadeMonitorOpen = $state(false);
	let isSaving = $state(false);
	let isRefreshing = $state(false);
	let refreshProgress = $state<{ current: number; total: number; message: string } | null>(null);
	let isDeleting = $state(false);
	let isProviderLinkModalOpen = $state(false);
	let resolvingProvider = $state<'anilist' | 'mal'>('anilist');
	let providerRefInput = $state('');
	let isSavingProviderRef = $state(false);

	// Selection state
	let selectedEpisodes = new SvelteSet<string>();
	let showCheckboxes = $state(false);
	let openSeasonId = $state<string | null>(null);

	// Auto-search state
	let autoSearchingEpisodes = new SvelteSet<string>();
	let autoSearchEpisodeResults = new SvelteMap<
		string,
		{ found: boolean; grabbed: boolean; releaseName?: string; error?: string }
	>();
	let autoSearchingSeasons = new SvelteSet<string>();
	let autoSearchSeasonResults = new SvelteMap<
		string,
		{ found: boolean; grabbed: boolean; releaseName?: string; error?: string }
	>();
	let searchingMissing = $state(false);
	let missingSearchProgress = $state<{ current: number; total: number } | null>(null);
	let missingSearchResult = $state<{ searched: number; found: number; grabbed: number } | null>(
		null
	);

	$effect(() => {
		searchingMissing = data.isSearching;
	});
	const isStreamerProfile = $derived.by(() => series.scoringProfileId === 'streamer');

	// Subtitle search state
	let isSubtitleSearchModalOpen = $state(false);
	let isSubtitleSyncModalOpen = $state(false);
	let syncingSubtitleId = $state<string | null>(null);
	let subtitleSyncError = $state<string | null>(null);
	let subtitleSearchContext = $state<{
		episodeId: string;
		title: string;
	} | null>(null);
	let subtitleAutoSearchingEpisodes = new SvelteSet<string>();
	let subtitleSyncingId = $state<string | null>(null);
	let subtitleDeletingId = $state<string | null>(null);
	let bulkSubtitleAutoSearching = $state(false);
	let bulkSubtitleSyncing = $state(false);
	let subtitleAutoSearchingSeries = $state(false);
	let subtitleAutoSearchingSeasons = new SvelteSet<string>();

	function describeError(error: unknown, fallback: string): string {
		return error instanceof Error ? error.message : fallback;
	}

	function showActionError(message: string, error: unknown): void {
		toasts.error(message, { description: describeError(error, message) });
	}

	// Search progress store for auto-search
	const searchProgress = createSearchProgress();
	const subtitleProgress = createSubtitleProgress();

	// Search context
	let searchContext = $state<{
		title: string;
		season?: number;
		episode?: number;
		searchMode?: SearchMode;
	} | null>(null);

	// Season/Episode delete state
	let isSeasonDeleteModalOpen = $state(false);
	let isEpisodeDeleteModalOpen = $state(false);
	let deletingSeasonId = $state<string | null>(null);
	let deletingSeasonName = $state<string>('');
	let deletingEpisodeId = $state<string | null>(null);
	let deletingEpisodeName = $state<string>('');
	let isDeletingSeason = $state(false);
	let isDeletingEpisode = $state(false);

	const deletingSeasonHasFiles = $derived.by(() => {
		if (!deletingSeasonId) return false;
		const season = seasons.find((s) => s.id === deletingSeasonId);
		return (season?.episodeFileCount ?? 0) > 0;
	});

	const deletingEpisodeHasFiles = $derived.by(() => {
		if (!deletingEpisodeId) return false;
		for (const season of seasons) {
			const ep = season.episodes.find((e) => e.id === deletingEpisodeId);
			if (ep) return ep.file !== null;
		}
		return false;
	});

	$effect(() => {
		if (page.url.searchParams.get('edit') === '1') {
			isEditModalOpen = true;
		}
	});

	// Find quality profile name (use default if none set)
	const qualityProfileName = $derived.by(() => {
		if (series.scoringProfileId) {
			return data.qualityProfiles.find((p) => p.id === series.scoringProfileId)?.name ?? null;
		}
		// No profile set - show the default
		const defaultProfile = data.qualityProfiles.find((p) => p.isDefault);
		return defaultProfile ? m.library_tv_profileDefault({ name: defaultProfile.name }) : null;
	});

	// Build a set of episode IDs that are currently downloading
	const downloadingEpisodeIds = $derived.by(() => {
		const ids = new SvelteSet<string>();
		for (const item of queueItems) {
			if (item.episodeIds) {
				for (const epId of item.episodeIds) {
					ids.add(epId);
				}
			}
		}
		return ids;
	});

	// Build a set of season numbers that have a season pack downloading
	const downloadingSeasons = $derived.by(() => {
		const seasons = new SvelteSet<number>();
		for (const item of queueItems) {
			// Season pack: has seasonNumber but no specific episodeIds
			if (item.seasonNumber !== null && (!item.episodeIds || item.episodeIds.length === 0)) {
				seasons.add(item.seasonNumber);
			}
		}
		return seasons;
	});

	// Calculate missing aired episode count for manual auto-grab.
	const missingEpisodeCount = $derived.by(() => {
		const now = todayDateString();
		let count = 0;
		for (const season of seasons) {
			if (season.seasonNumber === 0) continue;
			for (const episode of season.episodes) {
				if (!episode.file && episode.airDate && episode.airDate <= now) {
					// Don't count as missing if it's downloading
					if (
						!downloadingEpisodeIds.has(episode.id) &&
						!downloadingSeasons.has(episode.seasonNumber)
					) {
						count++;
					}
				}
			}
		}
		return count;
	});

	// Calculate downloading count
	const downloadingCount = $derived(queueItems.length);

	// Derive selection count
	const selectedCount = $derived(selectedEpisodes.size);

	// Handlers
	async function handleMonitorToggle(newValue: boolean) {
		if (newValue && !series.monitored) {
			cascadeMonitorOpen = true;
			return;
		}
		isSaving = true;
		try {
			await updateSeries(series.id, { monitored: newValue });
			series.monitored = newValue;
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToUpdateMonitor(), error);
		} finally {
			isSaving = false;
		}
	}

	async function enableMonitorSeriesOnly() {
		cascadeMonitorOpen = false;
		isSaving = true;
		try {
			await updateSeries(series.id, { monitored: true });
			series.monitored = true;
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToUpdateMonitor(), error);
		} finally {
			isSaving = false;
		}
	}

	async function enableMonitorCascade() {
		cascadeMonitorOpen = false;
		isSaving = true;
		try {
			await updateSeries(series.id, { monitored: true });
			series.monitored = true;
			await Promise.all(
				seasons
					.filter((s) => s.seasonNumber > 0)
					.map((s) => updateSeason(s.id, { monitored: true, updateEpisodes: true }))
			);
			if (seasonsState) {
				seasonsState = seasonsState.map((s) => ({
					...s,
					monitored: s.seasonNumber > 0 ? true : s.monitored,
					episodes:
						s.seasonNumber > 0 ? s.episodes.map((ep) => ({ ...ep, monitored: true })) : s.episodes
				}));
			}
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToUpdateMonitor(), error);
		} finally {
			isSaving = false;
		}
	}

	function handleSearch() {
		// Top-level search is for multi-season packs / complete series only
		searchContext = {
			title: series.title,
			searchMode: 'multiSeasonPack'
		};
		isSearchModalOpen = true;
	}

	function handleImport() {
		const query = [
			`mediaType=tv`,
			`tmdbId=${encodeURIComponent(String(series.tmdbId))}`,
			`libraryId=${encodeURIComponent(series.id)}`,
			`title=${encodeURIComponent(series.title)}`,
			...(series.year ? [`year=${encodeURIComponent(String(series.year))}`] : [])
		].join('&');
		void goto(resolvePath(`/library/import?${query}`));
	}

	function buildProviderSearchLink(provider: 'anilist' | 'mal'): string {
		const query = `${series.title}${series.year ? ` ${series.year}` : ''}`;
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
			const nextRefs = { ...(series.providerRefs ?? {}), [resolvingProvider]: normalized };
			await updateSeries(series.id, {
				providerRefs: nextRefs
			} as unknown as Record<string, unknown>);
			closeProviderLinkModal();
			await refreshSeriesFromApi();
			toasts.success('Provider link updated');
		} catch (error) {
			showActionError('Failed to update provider link', error);
		} finally {
			isSavingProviderRef = false;
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
		// Seasons/episodes were fully regenerated under a new identity; a full
		// reload keeps this in step with the episode-group-change path above
		// rather than trying to patch every derived client-side field.
		window.location.reload();
	}

	function handleEditClose() {
		isEditModalOpen = false;
		if (page.url.searchParams.get('edit') === '1') {
			goto(page.url.pathname, { replace: true, reset: false });
		}
	}

	function updateSeriesStatsFromSeasons(updatedSeasons: typeof seasons): void {
		const { totalEpisodes, totalFiles } = computeSeriesEpisodeStats(updatedSeasons);

		seriesState = {
			...series,
			episodeCount: totalEpisodes,
			episodeFileCount: totalFiles,
			percentComplete: totalEpisodes > 0 ? Math.round((totalFiles / totalEpisodes) * 100) : 0
		};
	}

	async function refreshSeriesFromApi(): Promise<void> {
		try {
			const result = await getSeries(series.id);
			if (!result.series) return;

			// Narrow to the page's season shape; the server series row is a
			// superset of the load() projection.
			const { seasons: refreshedSeasons, ...seriesFields } = result.series as unknown as Record<
				string,
				unknown
			> & { seasons?: PageData['seasons'] };
			seriesState = { ...series, ...seriesFields };
			if (Array.isArray(refreshedSeasons)) {
				seasonsState = refreshedSeasons;
			}
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToRefresh(), error);
		}
	}

	async function handleRefresh() {
		isRefreshing = true;
		refreshProgress = null;

		try {
			const response = await apiPostStream(`/api/library/series/${series.id}/refresh`);

			// Read the streaming response
			const reader = response.body?.getReader();
			if (!reader) {
				toasts.error(m.toast_library_tvDetail_refreshNoStream());
				return;
			}

			const decoder = new TextDecoder();
			let buffer = '';
			let completed = false;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Parse SSE events from buffer
				const lines = buffer.split('\n');
				buffer = lines.pop() || ''; // Keep incomplete line in buffer

				let eventType = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) {
						eventType = line.slice(7).trim();
					} else if (line.startsWith('data: ')) {
						const jsonStr = line.slice(6);
						try {
							const eventData = JSON.parse(jsonStr);

							if (eventType === 'progress' || eventData.type === 'progress') {
								refreshProgress = {
									current: eventData.seasonNumber,
									total: eventData.totalSeasons,
									message: eventData.message
								};
							} else if (eventType === 'complete' || eventData.type === 'complete') {
								completed = true;
							} else if (eventType === 'error' || eventData.type === 'error') {
								toasts.error(eventData.message || m.toast_library_tvDetail_seriesRefreshFailed());
							}
						} catch {
							// Ignore parse errors (e.g., heartbeat comments)
						}
					}
				}
			}

			if (completed) {
				await refreshSeriesFromApi();
			}
		} catch (error) {
			showActionError(m.toast_library_tvDetail_refreshFailed(), error);
		} finally {
			isRefreshing = false;
			refreshProgress = null;
		}
	}

	async function handleEditSave(editData: SeriesEditData) {
		isSaving = true;
		try {
			const episodeGroupChanged =
				editData.episodeGroupId !== undefined &&
				editData.episodeGroupId !== (series.episodeGroupId ?? null);

			const result = await updateSeries(series.id, editData as unknown as Record<string, unknown>);

			series.monitored = editData.monitored;
			series.scoringProfileId = editData.scoringProfileId;
			series.seasonFolder = editData.seasonFolder;
			series.seriesType = editData.seriesType;
			series.wantsSubtitles = editData.wantsSubtitles;
			series.languageProfileId = editData.languageProfileId;

			if (episodeGroupChanged) {
				series.episodeGroupId = editData.episodeGroupId ?? null;
				// Full page reload needed since all seasons/episodes were rebuilt
				toasts.info('Episode ordering updated. Reloading page...');
				window.location.reload();
				return;
			}

			if (result?.moveQueued) {
				toasts.success(
					'Move queued. File transfer has started and will appear in Activity until completion.'
				);
			} else {
				series.rootFolderId = editData.rootFolderId;
				const newFolder = data.rootFolders.find((f) => f.id === editData.rootFolderId);
				series.rootFolderPath = newFolder?.path ?? null;
			}

			isEditModalOpen = false;
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToUpdate(), error);
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
			const result = await deleteSeries(series.id, deleteFiles, removeFromLibrary);

			if (result.success) {
				if (removeFromLibrary) {
					toasts.success(m.toast_library_tvDetail_seriesRemoved());
					// Navigate to library since the series no longer exists
					window.location.href = '/library/tv';
				} else {
					toasts.success(
						deleteFiles
							? m.toast_library_tvDetail_seriesFilesDeleted()
							: m.toast_library_tvDetail_seriesUnmatched()
					);
					const updatedSeasons = seasons.map((season) => ({
						...season,
						episodeFileCount: 0,
						episodes: season.episodes.map((episode) => ({
							...episode,
							hasFile: false as boolean | null,
							file: null
						}))
					}));
					seasonsState = updatedSeasons;
					updateSeriesStatsFromSeasons(updatedSeasons);
					queueItemsState = [];
				}
			} else {
				toasts.error(m.toast_library_tvDetail_failedToDeleteSeries(), {
					description: result.error
				});
			}
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToDeleteSeries(), error);
		} finally {
			isDeleting = false;
			isDeleteModalOpen = false;
		}
	}

	// Season deletion handlers
	interface Season {
		id: string;
		seasonNumber: number;
		name: string | null;
	}

	function handleSeasonDelete(season: Season) {
		deletingSeasonId = season.id;
		deletingSeasonName =
			season.name || m.library_tvDetail_seasonFallback({ number: String(season.seasonNumber) });
		isSeasonDeleteModalOpen = true;
	}

	async function performSeasonDelete(deleteFiles: boolean) {
		if (!deletingSeasonId) return;

		isDeletingSeason = true;
		try {
			const result = await deleteSeason(deletingSeasonId, deleteFiles);

			if (result.success) {
				toasts.success(m.toast_library_tvDetail_seasonFilesDeleted());
				// Mark all episodes in this season as missing
				const updatedSeasons = seasons.map((s) =>
					s.id === deletingSeasonId
						? {
								...s,
								episodeFileCount: 0,
								episodes: s.episodes.map((e) => ({
									...e,
									hasFile: false as boolean | null,
									file: null
								}))
							}
						: s
				);
				seasonsState = updatedSeasons;
				updateSeriesStatsFromSeasons(updatedSeasons);
			} else {
				toasts.error(m.toast_library_tvDetail_failedToDeleteSeasonFiles(), {
					description: result.error
				});
			}
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToDeleteSeason(), error);
		} finally {
			isDeletingSeason = false;
			isSeasonDeleteModalOpen = false;
			deletingSeasonId = null;
		}
	}

	// Episode deletion handlers
	interface Episode {
		id: string;
		wantsSubtitlesOverride?: boolean | null;
		seasonNumber: number;
		episodeNumber: number;
		title: string | null;
	}

	function handleEpisodeDelete(episode: Episode) {
		deletingEpisodeId = episode.id;
		const epTitle =
			episode.title ||
			m.library_tvDetail_episodeFallback({ number: String(episode.episodeNumber) });
		deletingEpisodeName = `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')} - ${epTitle}`;
		isEpisodeDeleteModalOpen = true;
	}

	async function performEpisodeDelete(deleteFiles: boolean) {
		if (!deletingEpisodeId) return;

		isDeletingEpisode = true;
		try {
			const result = await deleteEpisode(deletingEpisodeId, deleteFiles);

			if (result.success) {
				toasts.success(m.toast_library_tvDetail_episodeFilesDeleted());
				// Mark episode as missing (hasFile: false) instead of removing it
				const updatedSeasons = seasons.map((season) => {
					const hasEpisode = season.episodes.some((e) => e.id === deletingEpisodeId);
					if (!hasEpisode) {
						return season;
					}

					const updatedEpisodes = season.episodes.map((e) =>
						e.id === deletingEpisodeId ? { ...e, hasFile: false as boolean | null, file: null } : e
					);
					const updatedEpisodeFileCount = updatedEpisodes.filter((e) => e.file !== null).length;
					const updatedEpisodeCount = updatedEpisodes.length;

					return {
						...season,
						episodes: updatedEpisodes,
						episodeFileCount: updatedEpisodeFileCount,
						episodeCount: updatedEpisodeCount
					};
				});
				seasonsState = updatedSeasons;
				updateSeriesStatsFromSeasons(updatedSeasons);
			} else {
				toasts.error(m.toast_library_tvDetail_failedToDeleteEpisodeFiles(), {
					description: result.error
				});
			}
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToDeleteEpisode(), error);
		} finally {
			isDeletingEpisode = false;
			isEpisodeDeleteModalOpen = false;
			deletingEpisodeId = null;
		}
	}

	async function handleSeasonMonitorToggle(seasonId: string, newValue: boolean) {
		try {
			await updateSeason(seasonId, { monitored: newValue, updateEpisodes: true });

			seasonsState = seasons.map((season) =>
				season.id === seasonId
					? {
							...season,
							monitored: newValue,
							episodes: season.episodes.map((ep) => ({ ...ep, monitored: newValue }))
						}
					: season
			);
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToUpdateSeasonMonitor(), error);
		}
	}

	async function handleEpisodeMonitorToggle(episodeId: string, newValue: boolean) {
		try {
			await updateEpisode(episodeId, { monitored: newValue });

			seasonsState = seasons.map((season) => ({
				...season,
				episodes: season.episodes.map((ep) =>
					ep.id === episodeId ? { ...ep, monitored: newValue } : ep
				)
			}));
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToUpdateEpisodeMonitor(), error);
		}
	}

	interface Season {
		id: string;
		seasonNumber: number;
	}

	interface Episode {
		seasonNumber: number;
		episodeNumber: number;
	}

	function handleSeasonSearch(season: Season) {
		searchContext = {
			title: series.title,
			season: season.seasonNumber
		};
		isSearchModalOpen = true;
	}

	function handleEpisodeSearch(episode: Episode) {
		searchContext = {
			title: series.title,
			season: episode.seasonNumber,
			episode: episode.episodeNumber
		};
		isSearchModalOpen = true;
	}

	// Auto-search handlers
	async function handleAutoSearchEpisode(episode: Episode & { id: string }) {
		if (autoSearchingEpisodes.has(episode.id)) return;
		autoSearchingEpisodes.add(episode.id);

		try {
			await searchProgress.startSearch(`/api/library/series/${series.id}/auto-search`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'episode',
					episodeId: episode.id
				})
			});

			if (searchProgress.results) {
				const issue = getPrimaryAutoSearchIssue(searchProgress.results);
				const itemResult = searchProgress.results.results?.[0] as
					{ found?: boolean; grabbed?: boolean; releaseName?: string; error?: string } | undefined;
				autoSearchEpisodeResults.set(episode.id, {
					found: itemResult?.found ?? false,
					grabbed: itemResult?.grabbed ?? false,
					releaseName: itemResult?.releaseName,
					error: itemResult?.error ?? searchProgress.results.error ?? issue?.message
				});

				// Clear result after 5 seconds
				setTimeout(() => {
					autoSearchEpisodeResults.delete(episode.id);
				}, 5000);
			}
		} catch (error) {
			autoSearchEpisodeResults.set(episode.id, {
				found: false,
				grabbed: false,
				error: error instanceof Error ? error.message : m.toast_library_tvDetail_searchFailed()
			});
		} finally {
			autoSearchingEpisodes.delete(episode.id);
			searchProgress.reset();
		}
	}

	async function handleAutoSearchSeason(season: Season) {
		if (autoSearchingSeasons.has(season.id)) return;
		autoSearchingSeasons.add(season.id);

		try {
			await searchProgress.startSearch(`/api/library/series/${series.id}/auto-search`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'season',
					seasonNumber: season.seasonNumber
				})
			});

			if (searchProgress.results) {
				const issue = getPrimaryAutoSearchIssue(searchProgress.results);
				const itemResult = searchProgress.results.results?.[0] as
					{ found?: boolean; grabbed?: boolean; releaseName?: string; error?: string } | undefined;
				autoSearchSeasonResults.set(season.id, {
					found: itemResult?.found ?? false,
					grabbed: itemResult?.grabbed ?? false,
					releaseName: itemResult?.releaseName,
					error: itemResult?.error ?? searchProgress.results.error ?? issue?.message
				});

				// Clear result after 5 seconds
				setTimeout(() => {
					autoSearchSeasonResults.delete(season.id);
				}, 5000);
			}
		} catch (error) {
			autoSearchSeasonResults.set(season.id, {
				found: false,
				grabbed: false,
				error: error instanceof Error ? error.message : m.toast_library_tvDetail_searchFailed()
			});
		} finally {
			autoSearchingSeasons.delete(season.id);
			searchProgress.reset();
		}
	}

	async function handleSearchMissing() {
		if (searchingMissing) return;
		searchingMissing = true;
		missingSearchProgress = null;
		missingSearchResult = null;

		try {
			await searchProgress.startSearch(`/api/library/series/${series.id}/auto-search`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'missing' })
			});

			if (searchProgress.results) {
				const issue = getPrimaryAutoSearchIssue(searchProgress.results);
				const results = searchProgress.results.results as
					Array<{ found?: boolean; grabbed?: boolean }> | undefined;
				missingSearchResult = searchProgress.results.summary ?? {
					searched: results?.length ?? 0,
					found: results?.filter((r) => r.found).length ?? 0,
					grabbed: results?.filter((r) => r.grabbed).length ?? 0
				};

				// Streaming grabs can complete before queue/file SSE updates arrive; refresh once so
				// the episode/file counters reflect the completed auto-grab immediately.
				if ((missingSearchResult.grabbed ?? 0) > 0) {
					toasts.success(
						m.toast_library_tvDetail_grabbedMissing({ count: String(missingSearchResult.grabbed) })
					);
					setTimeout(() => {
						void refreshSeriesFromApi();
					}, 500);
				} else if (issue) {
					toasts.error(issue.message, { description: issue.description });
				} else if ((missingSearchResult.found ?? 0) > 0) {
					toasts.info(m.toast_library_tvDetail_foundNotEligible());
				} else {
					toasts.info(m.toast_library_tvDetail_noSuitableReleases());
				}
			}

			// Clear result after 10 seconds
			setTimeout(() => {
				missingSearchResult = null;
			}, 10000);
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToSearchMissing(), error);
		} finally {
			searchingMissing = false;
			missingSearchProgress = null;
			searchProgress.reset();
		}
	}

	async function handleBulkAutoSearch() {
		const episodeIds = [...selectedEpisodes];
		if (episodeIds.length === 0) return;

		// Mark all selected as searching
		for (const id of episodeIds) {
			autoSearchingEpisodes.add(id);
		}

		try {
			await searchProgress.startSearch(`/api/library/series/${series.id}/auto-search`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'bulk',
					episodeIds
				})
			});

			if (searchProgress.results) {
				const results = searchProgress.results.results as
					| Array<{
							itemId?: string;
							found?: boolean;
							grabbed?: boolean;
							releaseName?: string;
							error?: string;
					  }>
					| undefined;

				// Update results for each episode
				for (const itemResult of results ?? []) {
					if (itemResult.itemId) {
						autoSearchEpisodeResults.set(itemResult.itemId, {
							found: itemResult.found ?? false,
							grabbed: itemResult.grabbed ?? false,
							releaseName: itemResult.releaseName,
							error: itemResult.error
						});
					}
				}
			}

			// Clear selection after search
			selectedEpisodes.clear();
			showCheckboxes = false;

			// Clear results after 5 seconds
			setTimeout(() => {
				for (const id of episodeIds) {
					autoSearchEpisodeResults.delete(id);
				}
			}, 5000);
		} catch (error) {
			showActionError(m.toast_library_tvDetail_bulkSearchFailed(), error);
		} finally {
			for (const id of episodeIds) {
				autoSearchingEpisodes.delete(id);
			}
			searchProgress.reset();
		}
	}

	// Subtitle search handlers
	interface EpisodeForSubtitle {
		id: string;
		title: string | null;
		seasonNumber: number;
		episodeNumber: number;
	}

	interface DownloadedSubtitle {
		id?: string;
		subtitleId?: string;
		language?: string;
		isForced?: boolean;
		isHearingImpaired?: boolean;
		format?: string;
		wasSynced?: boolean;
		syncOffset?: number | null;
	}

	function appendSubtitleToEpisode(episodeId: string, subtitle: DownloadedSubtitle): void {
		const subtitleId = subtitle.id ?? subtitle.subtitleId;
		if (!subtitleId) return;

		const normalizedSubtitle = {
			id: subtitleId,
			language: subtitle.language ?? 'unknown',
			isForced: subtitle.isForced ?? false,
			isHearingImpaired: subtitle.isHearingImpaired ?? false,
			format: subtitle.format
		};

		seasonsState = seasons.map((season) => ({
			...season,
			episodes: season.episodes.map((episode) => {
				if (episode.id !== episodeId) return episode;
				const existingSubtitles = episode.subtitles ?? [];
				if (existingSubtitles.some((existing) => existing.id === subtitleId)) {
					return episode;
				}
				return {
					...episode,
					subtitles: [...existingSubtitles, normalizedSubtitle]
				};
			})
		}));
	}

	function handleSubtitleSearch(episode: EpisodeForSubtitle) {
		const episodeTitle =
			episode.title ||
			m.library_tvDetail_episodeFallback({ number: String(episode.episodeNumber) });
		subtitleSearchContext = {
			episodeId: episode.id,
			title: `${series.title} S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')} - ${episodeTitle}`
		};
		isSubtitleSearchModalOpen = true;
	}

	function handleSubtitleSync() {
		if (isStreamerProfile) {
			return;
		}
		subtitleSyncError = null;
		isSubtitleSyncModalOpen = true;
	}

	async function handleSubtitleAutoSearch(episode: EpisodeForSubtitle) {
		subtitleAutoSearchingEpisodes.add(episode.id);

		try {
			const result = await autoSearchSubtitles({ episodeId: episode.id });

			if (result.success && result.subtitle) {
				appendSubtitleToEpisode(episode.id, result.subtitle);
			}
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToAutoSearchSubs(), error);
		} finally {
			subtitleAutoSearchingEpisodes.delete(episode.id);
		}
	}

	function handleSubtitleDownloaded(subtitle: DownloadedSubtitle) {
		const episodeId = subtitleSearchContext?.episodeId;
		if (!episodeId) return;
		appendSubtitleToEpisode(episodeId, subtitle);
	}

	const syncableSubtitles = $derived.by(() => {
		const results: Array<DownloadedSubtitle & { id: string; label: string }> = [];

		for (const season of seasons) {
			for (const episode of season.episodes) {
				for (const subtitle of episode.subtitles ?? []) {
					if ('isEmbedded' in subtitle && subtitle.isEmbedded) continue;
					results.push({
						...subtitle,
						id: subtitle.id,
						language: subtitle.language,
						label: `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')} - ${episode.title || m.library_tvDetail_episodeFallback({ number: String(episode.episodeNumber) })}`
					});
				}
			}
		}

		return results;
	});

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
				throw new Error(result.error || m.toast_library_tvDetail_subtitleSyncFailed());
			}

			seasonsState = seasons.map((season) => ({
				...season,
				episodes: season.episodes.map((episode) => ({
					...episode,
					subtitles: (episode.subtitles ?? []).map((subtitle) =>
						subtitle.id === subtitleId
							? {
									...subtitle,
									wasSynced: true,
									syncOffset: result.offsetMs
								}
							: subtitle
					)
				}))
			}));

			toasts.success(m.toast_library_tvDetail_subtitleSynced(), {
				description: m.toast_library_tvDetail_subtitleSyncOffset({
					offset: String(result.offsetMs)
				})
			});
		} catch (error) {
			subtitleSyncError = describeError(error, m.toast_library_tvDetail_subtitleSyncFailed());
			showActionError(m.toast_library_tvDetail_failedToSyncSub(), error);
		} finally {
			syncingSubtitleId = null;
		}
	}

	// Subtitle sync from popover (individual subtitle)
	async function handleSubtitleSyncFromPopover(subtitleId: string): Promise<void> {
		subtitleSyncingId = subtitleId;
		try {
			const result = await syncSubtitle(subtitleId);

			if (!result.success) {
				throw new Error(result.error || m.toast_library_tvDetail_subtitleSyncFailed());
			}

			seasonsState = seasons.map((season) => ({
				...season,
				episodes: season.episodes.map((episode) => ({
					...episode,
					subtitles: (episode.subtitles ?? []).map((subtitle) =>
						subtitle.id === subtitleId
							? { ...subtitle, wasSynced: true, syncOffset: result.offsetMs }
							: subtitle
					)
				}))
			}));

			toasts.success(m.toast_library_tvDetail_subtitleSynced(), {
				description: m.toast_library_tvDetail_subtitleSyncOffset({
					offset: String(result.offsetMs)
				})
			});
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToSyncSub(), error);
		} finally {
			subtitleSyncingId = null;
		}
	}

	// Subtitle delete from popover
	async function handleSubtitleDeleteFromPopover(subtitleId: string): Promise<void> {
		subtitleDeletingId = subtitleId;
		try {
			const result = await deleteSubtitle(subtitleId);

			if (!result.success) {
				throw new Error(result.error || m.toast_library_tvDetail_deleteFailed());
			}

			seasonsState = seasons.map((season) => ({
				...season,
				episodes: season.episodes.map((episode) => ({
					...episode,
					subtitles: (episode.subtitles ?? []).filter((s) => s.id !== subtitleId)
				}))
			}));

			toasts.success(m.toast_library_tvDetail_subtitleDeleted());
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToDeleteSubtitle(), error);
		} finally {
			subtitleDeletingId = null;
		}
	}

	// Bulk sync handler for SubtitleSyncModal (NDJSON streaming)
	async function handleBulkSubtitleSync(
		subtitleIds: string[],
		settings: { splitPenalty: number; noSplits: boolean },
		onProgress: (result: {
			subtitleId: string;
			success: boolean;
			offsetMs: number;
			error?: string;
			index: number;
			total: number;
		}) => void,
		onComplete: () => void
	): Promise<void> {
		try {
			const response = await apiPostStream('/api/subtitles/sync/bulk', {
				subtitleIds,
				...settings
			});

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error(m.toast_library_tvDetail_noResponseBody());
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const result = JSON.parse(line);
						onProgress(result);

						// Update seasons state for successful syncs
						if (result.success) {
							seasonsState = seasons.map((season) => ({
								...season,
								episodes: season.episodes.map((episode) => ({
									...episode,
									subtitles: (episode.subtitles ?? []).map((subtitle) =>
										subtitle.id === result.subtitleId
											? { ...subtitle, wasSynced: true, syncOffset: result.offsetMs }
											: subtitle
									)
								}))
							}));
						}
					} catch {
						// Ignore parse errors
					}
				}
			}

			onComplete();
		} catch (error) {
			showActionError(m.toast_library_tvDetail_bulkSyncError(), error);
			onComplete();
		}
	}

	// Bulk subtitle auto-search for selected episodes (BulkActionBar)
	// Refactored to use the batch SSE endpoint with real-time progress
	async function handleBulkSubtitleAutoSearch(): Promise<void> {
		const episodeIds = [...selectedEpisodes];
		if (episodeIds.length === 0) return;

		bulkSubtitleAutoSearching = true;

		try {
			const results = await subtitleProgress.startBatch({ type: 'episodes', episodeIds });

			for (const item of subtitleProgress.items) {
				if (item.episodeId && item.status === 'downloaded' && item.subtitle) {
					appendSubtitleToEpisode(item.episodeId, {
						language: item.subtitle.language,
						isForced: false,
						isHearingImpaired: false
					});
				}
			}

			if (results.downloaded > 0) {
				toasts.success(
					m.toast_library_tvDetail_downloadedSubtitles({ count: String(results.downloaded) })
				);
			} else {
				toasts.info(m.toast_library_tvDetail_noSubtitlesFound());
			}

			selectedEpisodes.clear();
			showCheckboxes = false;
		} catch (error) {
			showActionError(m.toast_library_tvDetail_bulkSubAutoSearchFailed(), error);
		} finally {
			bulkSubtitleAutoSearching = false;
			subtitleProgress.reset();
		}
	}

	// Per-season subtitle auto-search
	async function handleSubtitleAutoSearchSeason(season: {
		id: string;
		seasonNumber: number;
	}): Promise<void> {
		subtitleAutoSearchingSeasons.add(season.id);

		try {
			const results = await subtitleProgress.startBatch({
				type: 'season',
				seriesId: series.id,
				seasonNumber: season.seasonNumber
			});

			for (const item of subtitleProgress.items) {
				if (item.episodeId && item.status === 'downloaded' && item.subtitle) {
					appendSubtitleToEpisode(item.episodeId, {
						language: item.subtitle.language,
						isForced: false,
						isHearingImpaired: false
					});
				}
			}

			if (results.downloaded > 0) {
				toasts.success(
					m.toast_library_tvDetail_downloadedSubtitles({ count: String(results.downloaded) })
				);
			} else {
				toasts.info(m.toast_library_tvDetail_noSubtitlesFound());
			}
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToAutoSearchSubs(), error);
		} finally {
			subtitleAutoSearchingSeasons.delete(season.id);
			subtitleProgress.reset();
		}
	}

	// Per-series subtitle auto-search (all missing)
	const seriesSubtitleProgress = $derived(
		deriveSeriesSubtitleProgress(data.seasons.flatMap((season) => season.episodes))
	);

	let savingRequirements = $state(false);
	let searchingRequirements = $state(false);

	async function handleEpisodeGateChange(episodeId: string, value: boolean | null) {
		try {
			const response = await fetch(`/api/library/episodes/${episodeId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ wantsSubtitlesOverride: value })
			});
			if (!response.ok) throw new Error('Failed to update episode subtitle gate');
			await refreshAll();
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToUpdateMonitor(), error);
		}
	}

	async function handleRequirementSearch(requirement: SubtitleRequirement) {
		searchingRequirements = true;
		try {
			const response = await fetch('/api/subtitles/auto-search/batch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'series', seriesId: seriesForDisplay.id, requirement })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? 'Search failed');
			}
			await refreshAll();
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToUpdateMonitor(), error);
		} finally {
			searchingRequirements = false;
		}
	}

	async function handleRequirementsSave(requirements: SubtitleRequirement[] | null) {
		savingRequirements = true;
		try {
			const response = await fetch(`/api/library/series/${seriesForDisplay.id}`, {
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

	async function handleSubtitleAutoSearchSeries(): Promise<void> {
		subtitleAutoSearchingSeries = true;

		try {
			const results = await subtitleProgress.startBatch({
				type: 'series',
				seriesId: series.id
			});

			for (const item of subtitleProgress.items) {
				if (item.episodeId && item.status === 'downloaded' && item.subtitle) {
					appendSubtitleToEpisode(item.episodeId, {
						language: item.subtitle.language,
						isForced: false,
						isHearingImpaired: false
					});
				}
			}

			if (results.downloaded > 0) {
				toasts.success(
					m.toast_library_tvDetail_downloadedSubtitles({ count: String(results.downloaded) })
				);
			} else {
				toasts.info(m.toast_library_tvDetail_noSubtitlesFound());
			}
		} catch (error) {
			showActionError(m.toast_library_tvDetail_failedToAutoSearchSubs(), error);
		} finally {
			subtitleAutoSearchingSeries = false;
			subtitleProgress.reset();
		}
	}

	// Bulk subtitle sync for selected episodes (BulkActionBar)
	async function handleBulkSubtitleSyncSelected(): Promise<void> {
		const episodeIds = [...selectedEpisodes];
		if (episodeIds.length === 0) return;

		// Collect all non-embedded subtitle IDs for selected episodes
		const subtitleIds: string[] = [];
		for (const season of seasons) {
			for (const episode of season.episodes) {
				if (!episodeIds.includes(episode.id)) continue;
				for (const subtitle of episode.subtitles ?? []) {
					if ('isEmbedded' in subtitle && subtitle.isEmbedded) continue;
					subtitleIds.push(subtitle.id);
				}
			}
		}

		if (subtitleIds.length === 0) {
			toasts.info(m.toast_library_tvDetail_noSyncableSubtitles());
			return;
		}

		bulkSubtitleSyncing = true;

		try {
			const response = await apiPostStream('/api/subtitles/sync/bulk', { subtitleIds });

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error(m.toast_library_tvDetail_noResponseBody());
			}

			const decoder = new TextDecoder();
			let buffer = '';
			let successCount = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const result = JSON.parse(line);
						if (result.success) {
							successCount++;
							seasonsState = seasons.map((season) => ({
								...season,
								episodes: season.episodes.map((episode) => ({
									...episode,
									subtitles: (episode.subtitles ?? []).map((subtitle) =>
										subtitle.id === result.subtitleId
											? { ...subtitle, wasSynced: true, syncOffset: result.offsetMs }
											: subtitle
									)
								}))
							}));
						}
					} catch {
						// Ignore parse errors
					}
				}
			}

			toasts.success(m.toast_library_tvDetail_syncedSubtitles({ count: String(successCount) }));
			selectedEpisodes.clear();
			showCheckboxes = false;
		} catch (error) {
			showActionError(m.toast_library_tvDetail_bulkSyncError(), error);
		} finally {
			bulkSubtitleSyncing = false;
		}
	}

	// Selection handlers
	function handleEpisodeSelectChange(episodeId: string, selected: boolean) {
		if (selected) {
			selectedEpisodes.add(episodeId);
		} else {
			selectedEpisodes.delete(episodeId);
		}
	}

	function handleSelectAllInSeason(seasonId: string, selectAll: boolean) {
		const season = seasons.find((s) => s.id === seasonId);
		if (!season) return;

		const episodeIds = season.episodes.map((e) => e.id);

		if (selectAll) {
			for (const id of episodeIds) {
				selectedEpisodes.add(id);
			}
		} else {
			for (const id of episodeIds) {
				selectedEpisodes.delete(id);
			}
		}
	}

	function toggleSelectionMode() {
		showCheckboxes = !showCheckboxes;
		if (!showCheckboxes) {
			selectedEpisodes.clear();
		}
	}

	function clearSelection() {
		selectedEpisodes.clear();
	}

	function handleSeasonToggle(seasonId: string) {
		openSeasonId = openSeasonId === seasonId ? null : seasonId;
	}

	// Helper function to look up episode IDs from local data
	function lookupEpisodeIds(season: number, episodes: number[]): string[] {
		const ids: string[] = [];
		for (const seasonData of seasons) {
			if (seasonData.seasonNumber === season) {
				for (const ep of seasonData.episodes) {
					if (episodes.includes(ep.episodeNumber)) {
						ids.push(ep.id);
					}
				}
				break;
			}
		}
		return ids;
	}
</script>

<svelte:head>
	<title>{m.library_tvDetail_pageTitle({ title: series.title })}</title>
	<meta
		name="description"
		content={series.overview || m.library_tvDetail_metaDescription({ title: series.title })}
	/>
</svelte:head>

<div
	class="flex w-full flex-col gap-4 px-4 pb-20 sm:pb-0 md:gap-6 md:overflow-x-hidden md:px-6 lg:px-8"
>
	<!-- Header -->
	<LibrarySeriesHeader
		series={seriesForDisplay}
		tmdbSeries={data.tmdbDetails}
		defaultRegion={page.data.defaultRegion}
		configuredProviders={data.configuredMetadataProviders}
		librarySlug={data.librarySlug}
		libraryName={data.libraryName}
		backHref={tvBackHref}
		refreshing={isRefreshing}
		{refreshProgress}
		episodeCount={seriesForDisplay.episodeCount}
		episodeFileCount={seriesForDisplay.episodeFileCount}
		percentComplete={seriesForDisplay.percentComplete}
		{totalSeriesSize}
		{downloadingCount}
		{missingEpisodeCount}
		{searchingMissing}
		{missingSearchProgress}
		{missingSearchResult}
		{partiallyMonitored}
		subtitleProgress={seriesSubtitleProgress}
		preferOriginalTitleDefault={data.preferOriginalTitleDefault}
		onMonitorToggle={handleMonitorToggle}
		onSearch={handleSearch}
		onSearchMissing={handleSearchMissing}
		onSubtitleAutoSearch={handleSubtitleAutoSearchSeries}
		subtitleAutoSearching={subtitleAutoSearchingSeries}
		onImport={handleImport}
		onEdit={handleEdit}
		onDelete={handleDelete}
		onRefresh={handleRefresh}
		onChangeMatch={handleChangeMatch}
		readOnly={!isAdminUser}
	/>

	<!-- Subtitle requirements (series-level fallback for all episodes) -->
	<SubtitleRequirementsSection
		requirements={data.effectiveSubtitleRequirements?.requirements ?? []}
		source={data.effectiveSubtitleRequirements?.source ?? null}
		profileName={data.effectiveLanguageProfile?.profile.name ?? null}
		audioShortfall={data.series.languageShortfall ?? false}
		editable={isAdminUser}
		saving={savingRequirements || searchingRequirements}
		onSave={handleRequirementsSave}
		onSearch={handleRequirementSearch}
	/>

	<!-- Main Content -->
	<div class="grid gap-4 lg:grid-cols-2 lg:gap-6 xl:grid-cols-3">
		<!-- Seasons (takes 2 columns) -->
		<div class="min-w-0 space-y-4 md:col-span-2 lg:col-span-2">
			<div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex items-center gap-3">
					<h2 class="text-lg font-semibold">{m.library_tvDetail_seasonsHeading()}</h2>
				</div>
				<div class="flex gap-1">
					{#if isAdminUser && !isStreamerProfile && syncableSubtitles.length > 0}
						<button class="btn gap-1 btn-ghost btn-sm" onclick={handleSubtitleSync}>
							<RefreshCw class="h-4 w-4" />
							{m.library_tvDetail_syncSubtitles()}
						</button>
					{/if}
					{#if isAdminUser}
						<button
							class="btn gap-1 btn-ghost btn-sm"
							onclick={() => (isRenameModalOpen = true)}
							title={m.library_tvDetail_renameFilesTitle()}
						>
							<FileEdit class="h-4 w-4" />
							{m.library_tvDetail_rename()}
						</button>
					{/if}
					{#if isAdminUser}
						<button
							class="btn gap-2 btn-ghost btn-sm"
							onclick={toggleSelectionMode}
							title={showCheckboxes
								? m.library_tvDetail_exitSelectionMode()
								: m.library_tvDetail_selectEpisodes()}
						>
							<CheckSquare size={16} />
							{showCheckboxes ? m.library_tvDetail_done() : m.library_tvDetail_select()}
						</button>
					{/if}
				</div>
			</div>

			{#if seasons.length === 0}
				<div class="rounded-xl bg-base-200 p-8 text-center text-base-content/60">
					{m.library_tvDetail_noSeasonsFound()}
				</div>
			{:else}
				{#each seasons as season (season.id)}
					<SeasonAccordion
						{season}
						seriesMonitored={series.monitored ?? false}
						{isStreamerProfile}
						wantsSubtitles={series.wantsSubtitles ?? false}
						readOnly={!isAdminUser}
						defaultOpen={openSeasonId === season.id}
						{selectedEpisodes}
						{showCheckboxes}
						{downloadingEpisodeIds}
						{downloadingSeasons}
						autoSearchingSeason={autoSearchingSeasons.has(season.id)}
						autoSearchSeasonResult={autoSearchSeasonResults.get(season.id) ?? null}
						{autoSearchingEpisodes}
						{autoSearchEpisodeResults}
						{subtitleAutoSearchingEpisodes}
						subtitleAutoSearchingSeason={subtitleAutoSearchingSeasons.has(season.id)}
						{subtitleSyncingId}
						{subtitleDeletingId}
						onToggleOpen={handleSeasonToggle}
						onSeasonMonitorToggle={handleSeasonMonitorToggle}
						onEpisodeMonitorToggle={handleEpisodeMonitorToggle}
						onSeasonSearch={handleSeasonSearch}
						onAutoSearchSeason={handleAutoSearchSeason}
						onSubtitleAutoSearchSeason={handleSubtitleAutoSearchSeason}
						onEpisodeSearch={handleEpisodeSearch}
						onAutoSearchEpisode={handleAutoSearchEpisode}
						onEpisodeSelectChange={handleEpisodeSelectChange}
						onSelectAllInSeason={handleSelectAllInSeason}
						onSubtitleSearch={handleSubtitleSearch}
						onSubtitleAutoSearch={handleSubtitleAutoSearch}
						onSubtitleSync={isStreamerProfile ? undefined : handleSubtitleSyncFromPopover}
						onSubtitleGateChange={handleEpisodeGateChange}
						onSubtitleDelete={handleSubtitleDeleteFromPopover}
						onSeasonDelete={handleSeasonDelete}
						onEpisodeDelete={handleEpisodeDelete}
					/>
				{/each}
			{/if}
		</div>

		<!-- Sidebar -->
		<TVSeriesSidebar
			series={seriesForDisplay}
			{qualityProfileName}
			configuredProviders={data.configuredMetadataProviders}
			onResolveProviderRef={openProviderLinkModal}
		/>
	</div>
</div>

<!-- Bulk Action Bar (admin only) -->
{#if isAdminUser}
	<BulkActionBar
		{selectedCount}
		searching={autoSearchingEpisodes.size > 0}
		subtitleAutoSearching={bulkSubtitleAutoSearching}
		subtitleSyncing={bulkSubtitleSyncing}
		onSearch={handleBulkAutoSearch}
		onClear={clearSelection}
		onSubtitleAutoSearch={handleBulkSubtitleAutoSearch}
		onSubtitleSync={isStreamerProfile ? undefined : handleBulkSubtitleSyncSelected}
	/>
{/if}

<!-- Edit Modal -->
<SeriesEditModal
	open={isEditModalOpen}
	{series}
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
	mediaType="tv"
	mediaId={series.id}
	currentTitle={series.title}
	currentYear={series.year}
	onClose={() => (isChangeMatchModalOpen = false)}
	onSuccess={handleChangeMatchSuccess}
/>

<!-- Search Modal -->
<MediaSearchModal
	open={isSearchModalOpen}
	seriesId={series.id}
	season={searchContext?.season}
	episode={searchContext?.episode}
	searchMode={searchContext?.searchMode ?? 'all'}
	resolveEpisodeIds={lookupEpisodeIds}
	onClose={() => {
		isSearchModalOpen = false;
		searchContext = null;
	}}
/>

<!-- Subtitle Search Modal -->
<SubtitleSearchModal
	open={isSubtitleSearchModalOpen}
	title={subtitleSearchContext?.title ?? ''}
	episodeId={subtitleSearchContext?.episodeId}
	onClose={() => {
		isSubtitleSearchModalOpen = false;
		subtitleSearchContext = null;
	}}
	onDownloaded={handleSubtitleDownloaded}
/>

<SubtitleSyncModal
	open={isSubtitleSyncModalOpen}
	title={series.title}
	subtitles={syncableSubtitles.map((subtitle) => ({
		id: subtitle.id,
		language: subtitle.language ?? 'unknown',
		format: subtitle.format,
		isForced: subtitle.isForced,
		isHearingImpaired: subtitle.isHearingImpaired,
		matchScore: (subtitle as { matchScore?: number | null }).matchScore,
		dateAdded: (subtitle as { dateAdded?: string | null }).dateAdded,
		wasSynced: subtitle.wasSynced,
		syncOffset: subtitle.syncOffset,
		label: subtitle.label
	}))}
	{syncingSubtitleId}
	errorMessage={subtitleSyncError}
	onClose={() => {
		isSubtitleSyncModalOpen = false;
		subtitleSyncError = null;
	}}
	onSync={handleSubtitleResync}
	onBulkSync={handleBulkSubtitleSync}
/>

<!-- Rename Preview Modal -->
<RenamePreviewModal
	open={isRenameModalOpen}
	mediaType="tv"
	mediaId={series.id}
	mediaTitle={series.title}
	onClose={() => (isRenameModalOpen = false)}
	onRenamed={() => {
		void refreshSeriesFromApi();
	}}
/>

<!-- Cascade Monitor Prompt -->
{#if cascadeMonitorOpen}
	<ModalWrapper
		open={cascadeMonitorOpen}
		onClose={() => (cascadeMonitorOpen = false)}
		maxWidth="sm"
	>
		<div class="mb-4 flex items-center justify-between">
			<h3 class="text-lg font-bold">Enable monitoring</h3>
			<button
				type="button"
				class="btn btn-circle btn-ghost btn-sm"
				onclick={() => (cascadeMonitorOpen = false)}
				aria-label="Close"
			>
				<X class="h-4 w-4" />
			</button>
		</div>
		<p class="py-2 text-base-content/80">Also enable monitoring for all seasons and episodes?</p>
		<div class="modal-action">
			<button type="button" class="btn btn-ghost" onclick={enableMonitorSeriesOnly}>
				Series only
			</button>
			<button type="button" class="btn btn-primary" onclick={enableMonitorCascade}>
				Yes, enable all
			</button>
		</div>
	</ModalWrapper>
{/if}

<!-- Delete Confirmation Modal -->
<DeleteConfirmationModal
	open={isDeleteModalOpen}
	title={m.library_tvDetail_deleteSeriesTitle()}
	itemName={series.title}
	hasFiles={(series.episodeFileCount ?? 0) > 0}
	hasActiveDownload={queueItems.length > 0}
	loading={isDeleting}
	onConfirm={performDelete}
	onCancel={() => (isDeleteModalOpen = false)}
/>

<!-- Season Delete Confirmation Modal -->
<DeleteConfirmationModal
	open={isSeasonDeleteModalOpen}
	title={m.library_tvDetail_deleteSeasonTitle()}
	itemName={deletingSeasonName}
	allowRemoveFromLibrary={false}
	hasFiles={deletingSeasonHasFiles}
	loading={isDeletingSeason}
	onConfirm={performSeasonDelete}
	onCancel={() => (isSeasonDeleteModalOpen = false)}
/>

<!-- Episode Delete Confirmation Modal -->
<DeleteConfirmationModal
	open={isEpisodeDeleteModalOpen}
	title={m.library_tvDetail_deleteEpisodeTitle()}
	itemName={deletingEpisodeName}
	allowRemoveFromLibrary={false}
	hasFiles={deletingEpisodeHasFiles}
	loading={isDeletingEpisode}
	onConfirm={performEpisodeDelete}
	onCancel={() => (isEpisodeDeleteModalOpen = false)}
/>

<ModalWrapper
	open={isProviderLinkModalOpen}
	onClose={closeProviderLinkModal}
	maxWidth="md"
	labelledBy="provider-link-modal-title"
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

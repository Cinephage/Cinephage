<script lang="ts">
	import { X, Loader2, LibraryBig } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import BulkAddOptions from './BulkAddOptions.svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import type { RootFolderWithSpaceAndDefault as RootFolder } from '#lib/types/downloadClient.js';
	import { getRootFolders, getScoringProfiles } from '#lib/api/settings.js';
	import { bulkAddMovies, bulkAddSeries } from '#lib/api/library.js';
	import { chunkItems, type DiscoverSelectionEntry } from '#lib/utils/discoverSelection.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		items: DiscoverSelectionEntry[];
		onClose: () => void;
		onSuccess?: () => void;
	}

	let { open, items, onClose, onSuccess }: Props = $props();

	interface ScoringProfile {
		id: string;
		name: string;
		description?: string;
		isBuiltIn: boolean;
		isDefault?: boolean;
	}

	type MinimumAvailability = 'announced' | 'inCinemas' | 'released';
	type MonitorType =
		| 'all'
		| 'future'
		| 'missing'
		| 'existing'
		| 'firstSeason'
		| 'lastSeason'
		| 'recent'
		| 'pilot'
		| 'none';
	type MonitorNewItems = 'all' | 'none';
	type SeriesType = 'standard' | 'anime' | 'daily';

	/** Bulk endpoints accept at most 50 ids per request. */
	const BULK_CHUNK_SIZE = 50;

	const movieItems = $derived(items.filter((i) => i.mediaType === 'movie'));
	const tvItems = $derived(items.filter((i) => i.mediaType === 'tv'));

	let rootFolders = $state<RootFolder[]>([]);
	let scoringProfiles = $state<ScoringProfile[]>([]);
	let isLoading = $state(false);
	let isSubmitting = $state(false);
	/** Items dispatched so far, 0..items.length — drives the progress line. */
	let submittedCount = $state(0);
	let error = $state<string | null>(null);

	let movieRootFolder = $state('');
	let tvRootFolder = $state('');
	let selectedScoringProfile = $state('');
	let searchOnAdd = $state(true);
	let wantsSubtitles = $state(true);
	let movieMonitored = $state(true);
	let minimumAvailability = $state<MinimumAvailability>('released');
	let availabilityDelay = $state(0);
	let tvMonitored = $state(true);
	let monitorType = $state<MonitorType>('all');
	let monitorNewItems = $state<MonitorNewItems>('all');
	let monitorSpecials = $state(false);
	let seriesType = $state<SeriesType>('standard');
	let seasonFolder = $state(true);

	const canSubmit = $derived(
		!isLoading &&
			!isSubmitting &&
			items.length > 0 &&
			(movieItems.length === 0 || !!movieRootFolder) &&
			(tvItems.length === 0 || !!tvRootFolder)
	);

	$effect(() => {
		if (open) {
			movieMonitored = true;
			tvMonitored = true;
			searchOnAdd = true;
			wantsSubtitles = true;
			minimumAvailability = 'released';
			availabilityDelay = 0;
			monitorType = 'all';
			monitorNewItems = 'all';
			monitorSpecials = false;
			seriesType = 'standard';
			seasonFolder = true;
			error = null;
			submittedCount = 0;
			loadData();
		}
	});

	async function loadData() {
		isLoading = true;
		error = null;
		try {
			const [foldersData, profilesData] = (await Promise.all([
				getRootFolders(),
				getScoringProfiles()
			])) as unknown as [
				{ folders?: RootFolder[] } | RootFolder[],
				{ profiles?: ScoringProfile[]; defaultProfileId?: string }
			];

			rootFolders = Array.isArray(foldersData) ? foldersData : (foldersData.folders ?? []);
			scoringProfiles = profilesData.profiles ?? [];

			const defaultProfile =
				(profilesData.defaultProfileId &&
					scoringProfiles.find((p) => p.id === profilesData.defaultProfileId)) ??
				scoringProfiles.find((p) => p.isDefault) ??
				scoringProfiles[0];
			if (defaultProfile) {
				selectedScoringProfile = defaultProfile.id;
			}

			// Default folder selection mirrors the single-add form: the default
			// writable folder for the media type, else the first writable one.
			const movies = getWritableFolders('movie');
			if (movies.length > 0 && !movies.some((f) => f.id === movieRootFolder)) {
				movieRootFolder = movies[0].id;
			}
			const tv = getWritableFolders('tv');
			if (tv.length > 0 && !tv.some((f) => f.id === tvRootFolder)) {
				tvRootFolder = tv[0].id;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : m.discover_bulkAdd_loadFailed();
		} finally {
			isLoading = false;
		}
	}

	function getWritableFolders(mediaType: 'movie' | 'tv'): RootFolder[] {
		return rootFolders
			.filter((folder) => !folder.readOnly && folder.mediaType === mediaType)
			.sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1));
	}

	async function handleSubmit() {
		isSubmitting = true;
		error = null;
		submittedCount = 0;

		let added = 0;
		let skipped = 0;
		let failed = 0;
		let firstErrorMessage: string | undefined;

		const collect = (result: {
			added?: number;
			skipped?: number;
			errors?: Array<{ error?: string }>;
		}) => {
			added += result.added ?? 0;
			skipped += result.skipped ?? 0;
			failed += result.errors?.length ?? 0;
			if (!firstErrorMessage && result.errors?.length) {
				firstErrorMessage = result.errors[0]?.error;
			}
		};

		try {
			for (const chunk of chunkItems(movieItems, BULK_CHUNK_SIZE)) {
				const result = await bulkAddMovies({
					tmdbIds: chunk.map((i) => i.tmdbId),
					rootFolderId: movieRootFolder,
					scoringProfileId: selectedScoringProfile || undefined,
					monitored: movieMonitored,
					minimumAvailability,
					availabilityDelay,
					searchOnAdd,
					wantsSubtitles
				});
				collect(result);
				submittedCount += chunk.length;
			}

			for (const chunk of chunkItems(tvItems, BULK_CHUNK_SIZE)) {
				const result = await bulkAddSeries({
					tmdbIds: chunk.map((i) => i.tmdbId),
					rootFolderId: tvRootFolder,
					scoringProfileId: selectedScoringProfile || undefined,
					monitored: tvMonitored,
					seriesType,
					monitorType,
					monitorNewItems,
					monitorSpecials,
					seasonFolder,
					searchOnAdd,
					wantsSubtitles
				});
				collect(result);
				submittedCount += chunk.length;
			}

			if (added > 0) {
				toasts.success(m.discover_bulkAdd_toastAdded({ count: added }), {
					description: skipped > 0 ? m.discover_bulkAdd_toastSkipped({ count: skipped }) : undefined
				});
			}
			if (failed > 0) {
				toasts.error(m.discover_bulkAdd_toastFailed({ count: failed }), {
					description: firstErrorMessage
				});
			} else if (added === 0 && skipped > 0) {
				toasts.info(m.discover_bulkAdd_toastAllSkipped({ count: skipped }));
			}

			onClose();
			onSuccess?.();
		} catch (e) {
			error = e instanceof Error ? e.message : m.discover_bulkAdd_submitFailed();
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

<ModalWrapper {open} onClose={handleClose} maxWidth="2xl" labelledBy="bulk-add-modal-title">
	<div class="mb-6 flex items-center justify-between">
		<h3 id="bulk-add-modal-title" class="text-xl font-bold">
			{m.discover_bulkAdd_title({ count: items.length })}
		</h3>
		<button
			class="btn btn-circle btn-ghost btn-sm"
			onclick={handleClose}
			disabled={isSubmitting}
			aria-label={m.ui_modal_closeModal()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<div class="min-w-0">
		<!-- Selected items recap -->
		<div class="mb-5 flex gap-2 overflow-x-auto pb-1">
			{#each items as item (`${item.mediaType}-${item.tmdbId}`)}
				<div
					class="w-12 flex-none overflow-hidden rounded-md shadow-sm ring-1 ring-base-content/10"
					title={item.year ? `${item.title} (${item.year})` : item.title}
				>
					<TmdbImage path={item.posterPath} size="w92" alt={item.title} class="aspect-2/3 w-full" />
				</div>
			{/each}
		</div>

		{#if isLoading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="h-8 w-8 animate-spin text-primary" />
			</div>
		{:else}
			{#if error}
				<div class="mb-4 alert alert-error">
					<span>{error}</span>
				</div>
			{/if}

			<BulkAddOptions
				movieCount={movieItems.length}
				tvCount={tvItems.length}
				{rootFolders}
				{scoringProfiles}
				bind:movieRootFolder
				bind:tvRootFolder
				bind:selectedScoringProfile
				bind:searchOnAdd
				bind:wantsSubtitles
				bind:movieMonitored
				bind:minimumAvailability
				bind:availabilityDelay
				bind:tvMonitored
				bind:monitorType
				bind:monitorNewItems
				bind:monitorSpecials
				bind:seriesType
				bind:seasonFolder
			/>
		{/if}
	</div>

	<div class="modal-action mt-6 border-t border-base-300 pt-4">
		{#if isSubmitting}
			<span class="mr-auto text-sm text-base-content/60">
				{m.discover_bulkAdd_progress({ done: submittedCount, total: items.length })}
			</span>
		{/if}
		<button class="btn btn-ghost" onclick={handleClose} disabled={isSubmitting}>
			{m.action_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleSubmit} disabled={!canSubmit}>
			{#if isSubmitting}
				<Loader2 class="mr-2 h-4 w-4 animate-spin" />
				{m.discover_bulkAdd_adding()}
			{:else}
				<LibraryBig class="mr-2 h-4 w-4" />
				{m.discover_bulkAdd_addButton({ count: items.length })}
			{/if}
		</button>
	</div>
</ModalWrapper>

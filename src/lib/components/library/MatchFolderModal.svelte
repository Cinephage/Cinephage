<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { X, Clapperboard, Tv, Check, Loader2, Folder } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import { getFileName } from '#lib/utils/format.js';
	import { batchUnmatchedMatch } from '#lib/api/library.js';

	import type { UnmatchedFolder } from '#lib/types/unmatched.js';
	import {
		createTmdbMatchSearch,
		type TmdbMatchResult
	} from '#lib/components/library/match/match-search.svelte.js';
	import MatchSearchField from '#lib/components/library/match/MatchSearchField.svelte';
	import MatchResultList from '#lib/components/library/match/MatchResultList.svelte';

	interface Props {
		open: boolean;
		folder: UnmatchedFolder;
		onClose: () => void;
		onSuccess: (folderPath: string) => void;
	}

	let { open, folder, onClose, onSuccess }: Props = $props();

	// Form state
	let searchQuery = $state('');
	let searchType = $state<'movie' | 'tv'>('movie');
	let isMatching = $state(false);
	let selectedMedia = $state<TmdbMatchResult | null>(null);

	const search = createTmdbMatchSearch({
		query: () => searchQuery,
		type: () => searchType,
		enabled: () => !selectedMedia,
		failureMessage: m.library_matchFolder_searchFailed
	});
	let matchPreview = $state<Array<{ file: string; season?: number; episode?: number }>>([]);
	let seasonOverride = $state<number | null>(null);

	// Whether the folder's media type is locked (known from folder data)
	const typeLocked = $derived(folder.mediaType === 'movie' || folder.mediaType === 'tv');

	// Reset state when folder changes
	$effect(() => {
		if (folder) {
			searchQuery = folder.commonParsedTitle || folder.folderName || '';
			searchType = folder.mediaType === 'tv' ? 'tv' : 'movie';
			selectedMedia = null;
			search.reset();
			matchPreview = [];
			seasonOverride = null;
		}
	});

	// Generate match preview when media is selected
	$effect(() => {
		if (selectedMedia && folder) {
			matchPreview = folder.files.map((file) => {
				const fileName = getFileName(file.path);
				return {
					file: fileName,
					season: file.parsedSeason ?? undefined,
					episode: file.parsedEpisode ?? undefined
				};
			});
		}
	});

	const hasMissingSeasons = $derived(
		searchType === 'tv' && matchPreview.some((item) => item.season === undefined)
	);

	// Typing debounce and the Enter escape hatch live in the shared search.
	$effect(() => {
		return search.schedule();
	});

	// Select media
	function selectMedia(media: TmdbMatchResult) {
		selectedMedia = media;
	}

	// Match folder
	async function matchFolder() {
		if (!selectedMedia) return;

		isMatching = true;
		try {
			const fileIds = folder.files.map((f) => f.id);

			const result = (await batchUnmatchedMatch({
				fileIds,
				tmdbId: selectedMedia.id,
				mediaType: searchType,
				...(seasonOverride !== null ? { season: seasonOverride } : {})
			})) as unknown as {
				success: boolean;
				data: { matched: number; failed: number };
				error?: string;
			};

			if (result.success) {
				toasts.success(
					m.library_matchFolder_matchedFiles({ count: result.data.matched }),
					result.data.failed > 0
						? { description: m.library_matchFolder_filesFailed({ count: result.data.failed }) }
						: undefined
				);
				onSuccess(folder.folderPath);
			} else {
				toasts.error(m.library_matchFolder_failedToMatch(), { description: result.error });
			}
		} catch {
			toasts.error(m.library_matchFolder_errorMatching());
		} finally {
			isMatching = false;
		}
	}

	// Close modal
	function close() {
		onClose();
		selectedMedia = null;
	}

	// Go back to search
	function backToSearch() {
		selectedMedia = null;
	}
</script>

<ModalWrapper {open} onClose={close} maxWidth="2xl" labelledBy="match-folder-modal-title">
	<!-- Header -->
	<div class="mb-4 flex items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<Folder class="h-5 w-5 text-primary" />
			<h3 id="match-folder-modal-title" class="text-lg font-bold">
				{m.library_matchFolder_title()}
			</h3>
			<span
				class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium
				{searchType === 'tv' ? 'bg-secondary/15 text-secondary' : 'bg-primary/15 text-primary'}"
			>
				{#if searchType === 'tv'}
					<Tv class="h-3 w-3" />{m.common_tvShow()}
				{:else}
					<Clapperboard class="h-3 w-3" />{m.common_movie()}
				{/if}
			</span>
		</div>
		<button
			class="btn btn-circle shrink-0 btn-ghost btn-sm"
			onclick={close}
			aria-label={m.action_close()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<!-- Folder Info -->
	<div class="mb-4 rounded-lg bg-base-200 p-3">
		<p class="truncate font-medium" title={folder.folderPath}>{folder.folderName}</p>
		<p class="text-sm text-base-content/70">
			{folder.fileCount === 1
				? m.library_matchFolder_fileCount_one({ count: folder.fileCount })
				: m.library_matchFolder_fileCount_other({ count: folder.fileCount })} • {folder.mediaType ===
			'movie'
				? m.common_movie()
				: m.common_tvShow()}
		</p>
	</div>

	{#if selectedMedia}
		<!-- Preview Mode -->
		<div class="space-y-4">
			<div class="flex items-center gap-3 rounded-lg bg-base-200 p-3">
				{#if selectedMedia.poster_path}
					<TmdbImage
						path={selectedMedia.poster_path}
						size="w92"
						alt={selectedMedia.title || selectedMedia.name || 'Media poster'}
						class="h-16 w-12 rounded object-cover"
					/>
				{:else}
					<div class="flex h-16 w-12 items-center justify-center rounded bg-base-300">
						{#if searchType === 'movie'}
							<Clapperboard class="h-6 w-6 text-base-content/30" />
						{:else}
							<Tv class="h-6 w-6 text-base-content/30" />
						{/if}
					</div>
				{/if}
				<div class="flex-1">
					<p class="font-medium">{selectedMedia.title || selectedMedia.name}</p>
					{#if searchType === 'movie' && selectedMedia.release_date}
						<p class="text-sm text-base-content/70">{selectedMedia.release_date.substring(0, 4)}</p>
					{:else if searchType === 'tv' && selectedMedia.first_air_date}
						<p class="text-sm text-base-content/70">
							{selectedMedia.first_air_date.substring(0, 4)}
						</p>
					{/if}
				</div>
				<button class="btn btn-ghost btn-sm" onclick={backToSearch}> {m.action_change()} </button>
			</div>

			<!-- Season override for TV shows with unparsed seasons -->
			{#if hasMissingSeasons}
				<div class="rounded-lg border border-warning/40 bg-warning/10 p-3">
					<p class="mb-2 text-sm font-medium text-warning-content">
						{m.library_matchFolder_seasonParseWarning()}
					</p>
					<div class="flex items-center gap-3">
						<label class="flex items-center gap-2 text-sm">
							{m.library_matchFolder_seasonLabel()}
							<input
								type="number"
								min="0"
								class="input-bordered input w-20 input-sm"
								placeholder="1"
								bind:value={seasonOverride}
							/>
						</label>
						{#if seasonOverride !== null}
							<span class="text-xs text-base-content/60"
								>{m.library_matchFolder_seasonAppliedHint()}</span
							>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Match Preview -->
			<div>
				<p class="mb-2 text-sm font-medium">
					{m.library_matchFolder_filesWillBeMatched({ count: matchPreview.length })}:
				</p>
				<div class="max-h-48 space-y-1 overflow-y-auto rounded-lg bg-base-200 p-2">
					{#each matchPreview.slice(0, 10) as item, index (`${item.file}-${index}`)}
						{@const resolvedSeason =
							item.season ?? (seasonOverride !== null ? seasonOverride : undefined)}
						<div class="flex items-center justify-between rounded bg-base-300/50 px-2 py-1 text-sm">
							<span class="flex-1 truncate" title={item.file}>{item.file}</span>
							{#if resolvedSeason !== undefined && item.episode !== undefined}
								<span
									class="ml-2 badge shrink-0 badge-sm {item.season === undefined
										? 'badge-warning'
										: 'badge-secondary'}"
								>
									S{String(resolvedSeason).padStart(2, '0')}E{String(item.episode).padStart(2, '0')}
								</span>
							{:else if resolvedSeason === undefined && item.episode !== undefined}
								<span class="ml-2 badge shrink-0 badge-sm badge-error"
									>{m.library_matchFolder_noSeason()}</span
								>
							{/if}
						</div>
					{/each}
					{#if matchPreview.length > 10}
						<p class="py-1 text-center text-xs text-base-content/50">
							{m.library_matchFolder_andMoreFiles({ count: matchPreview.length - 10 })}
						</p>
					{/if}
				</div>
			</div>

			<!-- Actions -->
			<div class="flex justify-end gap-2 pt-2">
				<button class="btn btn-ghost" onclick={backToSearch} disabled={isMatching}>
					{m.action_back()}
				</button>
				<button
					class="btn btn-primary"
					onclick={matchFolder}
					disabled={isMatching || (hasMissingSeasons && seasonOverride === null)}
				>
					{#if isMatching}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<Check class="h-4 w-4" />
					{/if}
					{m.library_matchFolder_matchFiles({ count: folder.fileCount })}
				</button>
			</div>
		</div>
	{:else}
		<!-- Search Mode -->

		<!-- Type toggle - only shown when folder mediaType is not determined -->
		{#if !typeLocked}
			<div class="mb-4 flex gap-2">
				<button
					class="btn btn-sm {searchType === 'movie' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => (searchType = 'movie')}
				>
					<Clapperboard class="h-4 w-4" />
					{m.common_movie()}
				</button>
				<button
					class="btn btn-sm {searchType === 'tv' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => (searchType = 'tv')}
				>
					<Tv class="h-4 w-4" />
					{m.common_tvShow()}
				</button>
			</div>
		{/if}

		<MatchSearchField
			bind:value={searchQuery}
			placeholder={m.library_matchFolder_searchPlaceholder()}
			searching={search.searching}
			onEnter={() => search.run()}
			class="mt-1"
		/>

		<!-- Search Results -->
		{#if search.results.length > 0}
			<p class="mt-3 text-xs text-base-content/40">
				{search.results.length === 1
					? m.library_matchFolder_resultCountSingular()
					: m.library_matchFolder_resultCount({ count: search.results.length })}
			</p>
			<div class="mt-1.5 max-h-80 overflow-y-auto">
				<MatchResultList results={search.results} mediaType={searchType} onpick={selectMedia} />
			</div>
		{:else if searchQuery && !search.searching}
			<div class="mt-4 py-8 text-center text-base-content/50">
				<p>{m.common_noResults()}</p>
			</div>
		{:else if !search.searching}
			<p class="mt-4 py-8 text-center text-base-content/50">
				{m.library_matchFolder_searchHint({
					type:
						searchType === 'movie'
							? m.common_movie().toLowerCase()
							: m.common_tvShow().toLowerCase()
				})}
			</p>
		{/if}
	{/if}
</ModalWrapper>

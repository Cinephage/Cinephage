<script lang="ts">
	import { untrack } from 'svelte';
	import {
		Search,
		X,
		Clapperboard,
		Tv,
		Check,
		Loader2,
		AlertCircle,
		ChevronRight
	} from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getFileName } from '#lib/utils/format.js';
	import { batchUnmatchedMatch } from '#lib/api/library.js';
	import { searchTmdb } from '#lib/api/discover.js';

	interface UnmatchedFile {
		id: string;
		path: string;
		mediaType: string;
		parsedSeason: number | null;
		parsedEpisode: number | null;
		size: number | null;
	}

	interface TmdbSearchResult {
		id: number;
		name?: string;
		title?: string;
		poster_path: string | null;
		first_air_date?: string;
		release_date?: string;
		overview?: string;
	}

	interface PreviewResult {
		fileId: string;
		filePath: string;
		filename: string;
		status: 'matched' | 'unmatched' | 'error';
		season?: number;
		episode?: number;
		reason?: string;
	}

	interface Props {
		open: boolean;
		selectedFileIds: string[];
		allFiles: UnmatchedFile[];
		onClose: () => void;
		onSuccess: (matchedIds: string[]) => void;
	}

	let { open, selectedFileIds, allFiles, onClose, onSuccess }: Props = $props();

	// Get selected files
	const selectedFiles = $derived(allFiles.filter((f) => selectedFileIds.includes(f.id)));

	// Constraint checks
	const hasTV = $derived(selectedFiles.some((f) => f.mediaType === 'tv'));
	const hasMovie = $derived(selectedFiles.some((f) => f.mediaType === 'movie'));
	const hasMixedTypes = $derived(hasTV && hasMovie);
	const searchType = $derived<'movie' | 'tv'>(hasTV ? 'tv' : 'movie');
	const multipleMovies = $derived(
		!hasMixedTypes && searchType === 'movie' && selectedFiles.length > 1
	);

	// Form state
	let searchQuery = $state('');
	let searchResults = $state<TmdbSearchResult[]>([]);
	let isSearching = $state(false);
	let isPreviewing = $state(false);
	let isMatching = $state(false);
	let selectedMedia = $state<TmdbSearchResult | null>(null);
	let previewResults = $state<PreviewResult[]>([]);
	let previewError = $state('');
	let matchingId = $state<number | null>(null);

	// Extract all unique suggested titles from file paths (parent folder name per file)
	function extractSuggestedTitles(files: UnmatchedFile[]): string[] {
		if (files.length === 0) return [];
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const seen = new Set<string>();
		const titles: string[] = [];
		for (const f of files) {
			const parts = f.path.split('/');
			// Walk up past season folders to find the show/movie folder
			let folder = '';
			for (let i = parts.length - 2; i >= 0; i--) {
				const candidate = parts[i].trim();
				if (candidate && !candidate.match(/^season\s*\d+$/i)) {
					folder = candidate;
					break;
				}
			}
			if (folder && !seen.has(folder.toLowerCase())) {
				seen.add(folder.toLowerCase());
				titles.push(folder);
			}
		}
		return titles;
	}

	const suggestedTitles = $derived(extractSuggestedTitles(selectedFiles));

	// Reset state when modal opens; auto-search only when there's one unique title
	$effect(() => {
		if (open) {
			const titles = untrack(() => extractSuggestedTitles(selectedFiles));
			searchQuery = titles.length === 1 ? titles[0] : '';
			searchResults = [];
			selectedMedia = null;
			previewResults = [];
			previewError = '';
		}
	});

	// Debounced search-as-you-type
	let debounceTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		const q = searchQuery;
		clearTimeout(debounceTimer);
		if (q.trim() && !hasMixedTypes) {
			debounceTimer = setTimeout(() => untrack(() => search()), 400);
		}
		return () => clearTimeout(debounceTimer);
	});

	// Search TMDB
	async function search() {
		if (!searchQuery.trim()) return;

		isSearching = true;
		try {
			const data = (await searchTmdb({
				query: searchQuery,
				type: searchType
			})) as unknown as { results?: TmdbSearchResult[] };
			searchResults = data.results || [];
		} catch {
			toasts.error(m.library_batchMatch_searchFailed());
			searchResults = [];
		} finally {
			isSearching = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			clearTimeout(debounceTimer);
			untrack(() => search());
		}
	}

	// Select media and generate preview
	async function selectMedia(media: TmdbSearchResult) {
		matchingId = media.id;
		selectedMedia = media;
		await generatePreview();
		matchingId = null;
	}

	// Generate preview client-side
	async function generatePreview() {
		if (!selectedMedia) return;

		isPreviewing = true;
		previewError = '';

		try {
			previewResults = selectedFiles.map((file) => ({
				fileId: file.id,
				filePath: file.path,
				filename: getFileName(file.path),
				status: 'matched' as const,
				season: file.parsedSeason ?? undefined,
				episode: file.parsedEpisode ?? undefined
			}));
		} catch {
			previewError = m.library_batchMatch_failedToGeneratePreview();
		} finally {
			isPreviewing = false;
		}
	}

	// Perform batch match
	async function performMatch() {
		if (!selectedMedia) return;

		isMatching = true;
		try {
			const episodeMapping: Record<string, { season: number; episode: number }> = {};

			if (searchType === 'tv') {
				for (const file of selectedFiles) {
					episodeMapping[file.id] = {
						season: file.parsedSeason ?? 1,
						episode: file.parsedEpisode ?? 1
					};
				}
			}

			const result = (await batchUnmatchedMatch({
				fileIds: selectedFileIds,
				tmdbId: selectedMedia.id,
				mediaType: searchType,
				...(searchType === 'tv' && Object.keys(episodeMapping).length > 0 ? { episodeMapping } : {})
			})) as unknown as {
				success: boolean;
				data: { matched: number; failed: number; errors: string[] };
				error?: string;
			};

			if (result.success) {
				toasts.success(
					m.library_batchMatch_matchedFiles({ count: result.data.matched }),
					result.data.failed > 0
						? { description: m.library_batchMatch_filesFailed({ count: result.data.failed }) }
						: undefined
				);
				const errorIds = new Set(
					result.data.errors.map((e: string) => e.match(/file ([^\s:]+)/)?.[1])
				);
				onSuccess(selectedFileIds.filter((id) => !errorIds.has(id)));
			} else {
				toasts.error(m.library_batchMatch_failedToMatchFiles(), { description: result.error });
			}
		} catch {
			toasts.error(m.library_batchMatch_errorMatchingFiles());
		} finally {
			isMatching = false;
		}
	}

	function close() {
		onClose();
		selectedMedia = null;
		previewResults = [];
	}

	function backToSearch() {
		selectedMedia = null;
		previewResults = [];
	}

	function formatSize(bytes: number | null): string {
		if (!bytes) return m.library_batchMatch_unknownSize();
		const gb = bytes / (1024 * 1024 * 1024);
		if (gb >= 1) return m.library_batchMatch_sizeGB({ size: gb.toFixed(2) });
		const mb = bytes / (1024 * 1024);
		return m.library_batchMatch_sizeMB({ size: mb.toFixed(1) });
	}
</script>

<ModalWrapper {open} onClose={close} maxWidth="3xl" labelledBy="batch-match-modal-title">
	<!-- Header -->
	<div class="mb-4 flex items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<Check class="h-5 w-5 text-primary" />
			<h3 id="batch-match-modal-title" class="text-lg font-bold">{m.library_batchMatch_title()}</h3>
			{#if !hasMixedTypes}
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
			{/if}
		</div>
		<button
			class="btn btn-circle shrink-0 btn-ghost btn-sm"
			onclick={close}
			aria-label={m.action_close()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<!-- Selected Files Summary -->
	<div class="mb-4 rounded-lg bg-base-200 p-3">
		<p class="text-sm text-base-content/70">
			{m.library_batchMatch_matchingFiles({ count: selectedFiles.length })}
		</p>
		<div class="mt-2 max-h-24 space-y-1 overflow-y-auto">
			{#each selectedFiles.slice(0, 5) as file (file.id)}
				<div class="flex items-center gap-2 text-xs">
					{#if file.mediaType === 'movie'}
						<Clapperboard class="h-3 w-3 shrink-0 text-primary" />
					{:else}
						<Tv class="h-3 w-3 shrink-0 text-secondary" />
					{/if}
					<span class="truncate">{getFileName(file.path)}</span>
					{#if file.parsedSeason !== null && file.parsedEpisode !== null}
						<span class="badge shrink-0 badge-xs badge-secondary">
							S{String(file.parsedSeason).padStart(2, '0')}E{String(file.parsedEpisode).padStart(
								2,
								'0'
							)}
						</span>
					{/if}
					<span class="shrink-0 text-base-content/50">{formatSize(file.size)}</span>
				</div>
			{/each}
			{#if selectedFiles.length > 5}
				<p class="text-xs text-base-content/50">
					{m.library_batchMatch_andMore({ count: selectedFiles.length - 5 })}
				</p>
			{/if}
		</div>
	</div>

	<!-- Mixed-type block -->
	{#if hasMixedTypes}
		<div class="alert alert-warning">
			<AlertCircle class="h-5 w-5 shrink-0" />
			<div>
				<p class="font-medium">{m.library_batchMatch_mixedTypesTitle()}</p>
				<p class="text-sm">{m.library_batchMatch_mixedTypesBody()}</p>
			</div>
		</div>
	{:else if selectedMedia}
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
				<div class="min-w-0 flex-1">
					<p class="truncate font-medium">{selectedMedia.title || selectedMedia.name}</p>
					<p class="text-sm text-base-content/70">
						{(searchType === 'movie'
							? selectedMedia.release_date
							: selectedMedia.first_air_date
						)?.substring(0, 4) ?? ''}
					</p>
				</div>
				<button class="btn shrink-0 btn-ghost btn-sm" onclick={backToSearch}
					>{m.action_change()}</button
				>
			</div>

			{#if multipleMovies}
				<div class="alert py-2 alert-warning">
					<AlertCircle class="h-4 w-4 shrink-0" />
					<p class="text-sm">{m.library_batchMatch_multipleMoviesWarning()}</p>
				</div>
			{/if}

			<!-- Preview Results -->
			<div>
				<p class="mb-2 text-sm font-medium">
					{isPreviewing
						? m.library_batchMatch_matchPreviewLoading()
						: m.library_batchMatch_matchPreview()}
				</p>

				{#if previewError}
					<div class="alert-sm alert alert-warning">
						<AlertCircle class="h-4 w-4" />
						<span>{previewError}</span>
					</div>
				{/if}

				<div class="max-h-64 space-y-1 overflow-y-auto rounded-lg bg-base-200 p-2">
					{#if isPreviewing}
						<div class="flex items-center justify-center py-8">
							<Loader2 class="h-8 w-8 animate-spin text-primary" />
						</div>
					{:else}
						{#each previewResults as result (result.fileId)}
							<div
								class="flex items-center justify-between rounded px-2 py-1.5 text-sm
								{result.status === 'matched'
									? 'bg-success/10'
									: result.status === 'error'
										? 'bg-error/10'
										: 'bg-warning/10'}"
							>
								<div class="flex min-w-0 flex-1 items-center gap-2">
									<span class="truncate">{result.filename}</span>
								</div>
								<div class="flex shrink-0 items-center gap-2">
									{#if result.season !== undefined && result.episode !== undefined}
										<span class="badge badge-sm badge-secondary">
											S{String(result.season).padStart(2, '0')}E{String(result.episode).padStart(
												2,
												'0'
											)}
										</span>
									{/if}
									<span
										class="badge badge-sm {result.status === 'matched'
											? 'badge-success'
											: result.status === 'error'
												? 'badge-error'
												: 'badge-warning'}"
									>
										{result.status === 'matched'
											? m.status_matched()
											: result.status === 'error'
												? m.status_error()
												: m.status_unmatched()}
									</span>
								</div>
							</div>
							{#if result.reason && result.status !== 'matched'}
								<p class="px-2 text-xs text-base-content/60">{result.reason}</p>
							{/if}
						{/each}
					{/if}
				</div>
			</div>

			<div class="flex justify-end gap-2 pt-2">
				<button class="btn btn-ghost" onclick={backToSearch} disabled={isMatching}
					>{m.action_back()}</button
				>
				<button
					class="btn btn-primary"
					onclick={performMatch}
					disabled={isMatching || previewResults.length === 0}
				>
					{#if isMatching}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<Check class="h-4 w-4" />
					{/if}
					{m.library_batchMatch_matchFiles({ count: selectedFiles.length })}
				</button>
			</div>
		</div>
	{:else}
		<!-- Search Mode -->
		<!-- Suggested title chips (shown when multiple unique titles detected) -->
		{#if suggestedTitles.length > 1}
			<div class="mb-3">
				<p class="mb-1.5 text-xs text-base-content/40">
					{m.library_batchMatch_suggestedSearches()}
				</p>
				<div class="flex flex-wrap gap-1.5">
					{#each suggestedTitles as title (title)}
						<button
							class="rounded-full border border-base-content/15 px-3 py-1 text-xs transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary
								{searchQuery === title ? 'border-primary/40 bg-primary/10 text-primary' : 'text-base-content/60'}"
							onclick={() => (searchQuery = title)}
						>
							{title}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<div class="group relative mb-4">
			{#if isSearching}
				<Loader2
					class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 animate-spin text-base-content/40"
				/>
			{:else}
				<Search
					class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-base-content/40 transition-colors group-focus-within:text-primary"
				/>
			{/if}
			<input
				type="text"
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				placeholder={m.library_batchMatch_searchPlaceholder()}
				bind:value={searchQuery}
				onkeydown={handleKeydown}
			/>
		</div>

		<!-- Search Results -->
		<div class="max-h-96 overflow-y-auto">
			{#if searchResults.length > 0}
				<p class="mb-2 text-xs text-base-content/40">
					{searchResults.length === 1
						? m.library_batchMatch_resultCountSingular()
						: m.library_batchMatch_resultCount({ count: searchResults.length })}
				</p>
				<div class="space-y-1">
					{#each searchResults as result (result.id)}
						{@const isLoadingThis = matchingId === result.id}
						<button
							class="group flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-base-300 disabled:opacity-60"
							onclick={() => selectMedia(result)}
							disabled={isPreviewing}
						>
							{#if result.poster_path}
								<TmdbImage
									path={result.poster_path}
									size="w92"
									alt={result.title || result.name || 'Media poster'}
									class="h-16 w-12 shrink-0 rounded object-cover"
								/>
							{:else}
								<div
									class="flex h-16 w-12 shrink-0 items-center justify-center rounded bg-base-300"
								>
									{#if searchType === 'movie'}
										<Clapperboard class="h-6 w-6 text-base-content/30" />
									{:else}
										<Tv class="h-6 w-6 text-base-content/30" />
									{/if}
								</div>
							{/if}
							<div class="min-w-0 flex-1">
								<p class="truncate font-medium">{result.title || result.name}</p>
								<p class="text-sm text-base-content/60">
									{(searchType === 'movie'
										? result.release_date
										: result.first_air_date
									)?.substring(0, 4) ?? m.common_unknownYear()}
								</p>
								{#if result.overview}
									<p class="mt-0.5 line-clamp-1 text-xs text-base-content/40">{result.overview}</p>
								{/if}
							</div>
							<div class="shrink-0">
								{#if isLoadingThis}
									<Loader2 class="h-4 w-4 animate-spin text-base-content/40" />
								{:else}
									<ChevronRight
										class="h-4 w-4 text-base-content/20 transition-all group-hover:translate-x-0.5 group-hover:text-base-content/60"
									/>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{:else if !isSearching && searchQuery}
				<p class="py-8 text-center text-base-content/50">{m.common_noResults()}</p>
			{:else if !isSearching}
				<p class="py-8 text-center text-base-content/50">
					{searchType === 'movie'
						? m.library_batchMatch_searchForMovie()
						: m.library_batchMatch_searchForTvShow()}
				</p>
			{/if}
		</div>
	{/if}
</ModalWrapper>

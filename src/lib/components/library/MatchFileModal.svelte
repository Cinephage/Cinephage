<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import { Search, X, Clapperboard, Tv, Check, Loader2, ChevronRight } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import { getFileName } from '#lib/utils/format.js';
	import { searchTmdb } from '#lib/api/discover.js';
	import { matchUnmatched } from '#lib/api/library.js';
	import { extractSearchYear } from '#lib/utils/search-query.js';

	interface UnmatchedFile {
		id: string;
		path: string;
		mediaType: string | null;
		parsedTitle: string | null;
		parsedYear: number | null;
		parsedSeason: number | null;
		parsedEpisode: number | null;
		suggestedMatches: unknown;
	}

	interface TmdbSearchResult {
		id: number;
		name?: string;
		title?: string;
		poster_path?: string | null;
		first_air_date?: string | null;
		release_date?: string | null;
		overview?: string;
	}

	interface Props {
		open: boolean;
		file: UnmatchedFile;
		onClose: () => void;
		onSuccess: (fileId: string) => void;
	}

	let { open, file, onClose, onSuccess }: Props = $props();

	// Form state (defaults only, effect syncs from props)
	let searchQuery = $state('');
	let searchType = $state<'movie' | 'tv'>('movie');
	let searchResults = $state<TmdbSearchResult[]>([]);
	let isSearching = $state(false);
	let isMatching = $state(false);
	let matchingId = $state<number | null>(null);

	// For TV shows - season/episode selection
	let selectedShow = $state<TmdbSearchResult | null>(null);
	let season = $state(1);
	let episode = $state(1);

	// Reset state when file changes
	$effect(() => {
		if (file) {
			const { title, year } = extractSearchYear(file.parsedTitle || '');
			searchQuery = year ? `${title} (${year})` : title;
			searchType = file.mediaType === 'tv' ? 'tv' : 'movie';
			selectedShow = null;
			season = file.parsedSeason ?? 1;
			episode = file.parsedEpisode ?? 1;
			searchResults = [];
		}
	});

	// Search TMDB
	async function search() {
		if (!searchQuery.trim()) return;

		isSearching = true;
		try {
			const data = await searchTmdb({ query: searchQuery, type: searchType });
			searchResults = data.results || [];
		} catch {
			toasts.error(m.library_matchFile_searchFailed());
			searchResults = [];
		} finally {
			isSearching = false;
		}
	}

	// Debounced search-as-you-type (400ms)
	let debounceTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		const q = searchQuery;
		clearTimeout(debounceTimer);
		if (q.trim()) {
			debounceTimer = setTimeout(() => untrack(() => search()), 400);
		}
		return () => clearTimeout(debounceTimer);
	});

	// Keep Enter as an immediate search escape hatch
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			clearTimeout(debounceTimer);
			untrack(() => search());
		}
	}

	// Match to a movie
	async function matchToMovie(movie: TmdbSearchResult) {
		isMatching = true;
		matchingId = movie.id;
		try {
			const result = await matchUnmatched(file.id, {
				tmdbId: movie.id,
				mediaType: 'movie'
			});

			if (result.success) {
				toasts.success(m.library_matchFile_matchedTo({ title: movie.title || movie.name || '' }));
				onSuccess(file.id);
			} else {
				toasts.error(m.library_matchFile_failedToMatch(), { description: result.error });
			}
		} catch (err) {
			const description = err instanceof Error ? err.message : m.library_matchFile_errorMatching();
			toasts.error(m.library_matchFile_errorMatching(), { description });
		} finally {
			isMatching = false;
			matchingId = null;
		}
	}

	// Select a TV show (step 1)
	function selectShow(show: TmdbSearchResult) {
		selectedShow = show;
		matchingId = null;
	}

	// Match to a TV episode (step 2)
	async function matchToEpisode() {
		if (!selectedShow) return;

		isMatching = true;
		try {
			const result = await matchUnmatched(file.id, {
				tmdbId: selectedShow.id,
				mediaType: 'tv',
				season,
				episode
			});

			if (result.success) {
				toasts.success(
					m.library_matchFile_matchedToEpisode({
						title: selectedShow.name || '',
						episode: `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
					})
				);
				onSuccess(file.id);
			} else {
				toasts.error(m.library_matchFile_failedToMatch(), { description: result.error });
			}
		} catch (err) {
			const description = err instanceof Error ? err.message : m.library_matchFile_errorMatching();
			toasts.error(m.library_matchFile_errorMatching(), { description });
		} finally {
			isMatching = false;
		}
	}

	// Close modal
	function close() {
		onClose();
		selectedShow = null;
	}
</script>

<ModalWrapper {open} onClose={close} maxWidth="2xl" labelledBy="match-file-modal-title">
	<!-- Header -->
	<div class="mb-4 flex items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<h3 id="match-file-modal-title" class="text-lg font-bold">{m.library_matchFile_title()}</h3>
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
	<p class="mt-1 truncate text-sm wrap-break-word text-base-content/70" title={file.path}>
		{getFileName(file.path)}
	</p>

	{#if searchType === 'tv' && selectedShow}
		<!-- TV Show Selected - Season/Episode Input -->
		<div class="mt-4 rounded-lg bg-base-200 p-4">
			<div class="flex items-center gap-3">
				<div class="h-16 w-12 shrink-0 overflow-hidden rounded">
					<TmdbImage
						path={selectedShow.poster_path ?? null}
						alt={selectedShow.name ?? 'Show poster'}
						size="w92"
						class="h-full w-full object-cover"
					/>
				</div>
				<div class="flex-1">
					<p class="font-medium">{selectedShow.name ?? m.common_unknown()}</p>
					<p class="text-sm text-base-content/70">
						{selectedShow.first_air_date?.substring(0, 4) || m.common_unknown()}
					</p>
				</div>
				<button class="btn btn-ghost btn-sm" onclick={() => (selectedShow = null)}>
					{m.action_change()}
				</button>
			</div>

			<div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div class="form-control">
					<label class="label" for="season-input">
						<span class="label-text">{m.common_season()}</span>
					</label>
					<input
						id="season-input"
						type="number"
						min="0"
						class="input-bordered input"
						bind:value={season}
					/>
				</div>
				<div class="form-control">
					<label class="label" for="episode-input">
						<span class="label-text">{m.common_episode()}</span>
					</label>
					<input
						id="episode-input"
						type="number"
						min="1"
						class="input-bordered input"
						bind:value={episode}
					/>
				</div>
			</div>

			<button class="btn mt-4 w-full btn-primary" onclick={matchToEpisode} disabled={isMatching}>
				{#if isMatching}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Check class="h-4 w-4" />
				{/if}
				{m.library_matchFile_matchTo({ title: selectedShow?.name || 'Unknown' })}
			</button>
		</div>
	{:else}
		<!-- Search Input -->
		<div class="group relative mt-4">
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
				placeholder={m.library_matchFile_searchPlaceholder({
					type:
						searchType === 'movie'
							? m.common_movies().toLowerCase()
							: m.common_tvShows().toLowerCase()
				})}
				bind:value={searchQuery}
				onkeydown={handleKeydown}
			/>
		</div>

		<!-- Search Results -->
		{#if searchResults.length > 0}
			<p class="mt-3 text-xs text-base-content/40">
				{searchResults.length === 1
					? m.library_matchFile_resultCountSingular()
					: m.library_matchFile_resultCount({ count: searchResults.length })}
			</p>
			<div class="mt-1.5 max-h-80 space-y-1 overflow-y-auto">
				{#each searchResults as result (result.id)}
					{@const isLoadingThis = matchingId === result.id}
					<button
						class="group flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-base-300 disabled:opacity-60"
						onclick={() => (searchType === 'movie' ? matchToMovie(result) : selectShow(result))}
						disabled={isMatching}
					>
						<div class="h-16 w-12 shrink-0 overflow-hidden rounded bg-base-300">
							{#if result.poster_path}
								<TmdbImage
									path={result.poster_path}
									alt={result.title ?? result.name ?? 'Poster'}
									size="w92"
									class="h-full w-full object-cover"
								/>
							{:else}
								<div class="flex h-full w-full items-center justify-center">
									{#if searchType === 'movie'}
										<Clapperboard class="h-6 w-6 text-base-content/30" />
									{:else}
										<Tv class="h-6 w-6 text-base-content/30" />
									{/if}
								</div>
							{/if}
						</div>
						<div class="min-w-0 flex-1">
							<p class="font-medium wrap-break-word sm:truncate">{result.title || result.name}</p>
							<p class="text-sm text-base-content/60">
								{(result.release_date || result.first_air_date)?.substring(0, 4) ||
									m.common_unknownYear()}
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
		{:else if searchQuery && !isSearching}
			<div class="mt-4 py-8 text-center text-base-content/50">
				{#if searchResults.length === 0 && searchQuery}
					<p>{m.common_noResults()}</p>
				{:else}
					<p>
						{m.library_matchFile_searchHint({
							type:
								searchType === 'movie'
									? m.common_movie().toLowerCase()
									: m.common_tvShow().toLowerCase()
						})}
					</p>
				{/if}
			</div>
		{/if}
	{/if}
</ModalWrapper>

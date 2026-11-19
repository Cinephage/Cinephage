<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { X, Clapperboard, Tv, Check, Loader2 } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import { getFileName } from '#lib/utils/format.js';
	import { matchUnmatched } from '#lib/api/library.js';
	import { extractSearchYear } from '#lib/utils/search-query.js';
	import {
		createTmdbMatchSearch,
		type TmdbMatchResult
	} from '#lib/components/library/match/match-search.svelte.js';
	import MatchSearchField from '#lib/components/library/match/MatchSearchField.svelte';
	import MatchResultList from '#lib/components/library/match/MatchResultList.svelte';

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
	let isMatching = $state(false);
	let matchingId = $state<number | null>(null);

	const search = createTmdbMatchSearch({
		query: () => searchQuery,
		type: () => searchType,
		failureMessage: m.library_matchFile_searchFailed
	});

	// For TV shows - season/episode selection
	let selectedShow = $state<TmdbMatchResult | null>(null);
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
			search.reset();
		}
	});

	// Typing debounce and the Enter escape hatch live in the shared search.
	$effect(() => {
		return search.schedule();
	});

	// Match to a movie
	async function matchToMovie(movie: TmdbMatchResult) {
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
	function selectShow(show: TmdbMatchResult) {
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
		<MatchSearchField
			bind:value={searchQuery}
			placeholder={m.library_matchFile_searchPlaceholder({
				type:
					searchType === 'movie'
						? m.common_movies().toLowerCase()
						: m.common_tvShows().toLowerCase()
			})}
			searching={search.searching}
			onEnter={() => search.run()}
			class="mt-4"
		/>

		<!-- Search Results -->
		{#if search.results.length > 0}
			<p class="mt-3 text-xs text-base-content/40">
				{search.results.length === 1
					? m.library_matchFile_resultCountSingular()
					: m.library_matchFile_resultCount({ count: search.results.length })}
			</p>
			<div class="mt-1.5 max-h-80 overflow-y-auto">
				<MatchResultList
					results={search.results}
					mediaType={searchType}
					busyId={matchingId}
					disabled={isMatching}
					onpick={(result) => (searchType === 'movie' ? matchToMovie(result) : selectShow(result))}
				/>
			</div>
		{:else if searchQuery && !search.searching}
			<div class="mt-4 py-8 text-center text-base-content/50">
				<p>{m.common_noResults()}</p>
			</div>
		{/if}
	{/if}
</ModalWrapper>

<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import {
		Search,
		X,
		Clapperboard,
		Tv,
		Check,
		Loader2,
		ArrowLeft,
		AlertTriangle
	} from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import { searchTmdb } from '#lib/api/discover.js';
	import { rematchMovie, rematchSeries, type RematchResponse } from '#lib/api/library.js';

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
		mediaType: 'movie' | 'tv';
		mediaId: string;
		currentTitle: string;
		currentYear?: number | null;
		onClose: () => void;
		onSuccess: (result: RematchResponse) => void;
	}

	let {
		open,
		mediaType,
		mediaId,
		currentTitle,
		currentYear = null,
		onClose,
		onSuccess
	}: Props = $props();

	let searchQuery = $state('');
	let searchResults = $state<TmdbSearchResult[]>([]);
	let isSearching = $state(false);
	let selectedResult = $state<TmdbSearchResult | null>(null);
	let isSubmitting = $state(false);

	// Reset to a fresh search every time the modal opens.
	$effect(() => {
		if (open) {
			searchQuery = '';
			searchResults = [];
			selectedResult = null;
			isSubmitting = false;
		}
	});

	async function search() {
		if (!searchQuery.trim()) return;

		isSearching = true;
		try {
			const data = await searchTmdb({
				query: searchQuery,
				type: mediaType === 'movie' ? 'movie' : 'tv'
			});
			searchResults = data.results || [];
		} catch {
			toasts.error(m.library_matchFile_searchFailed());
			searchResults = [];
		} finally {
			isSearching = false;
		}
	}

	let debounceTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		const q = searchQuery;
		clearTimeout(debounceTimer);
		if (q.trim()) {
			debounceTimer = setTimeout(() => untrack(() => search()), 400);
		}
		return () => clearTimeout(debounceTimer);
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			clearTimeout(debounceTimer);
			untrack(() => search());
		}
	}

	function selectResult(result: TmdbSearchResult) {
		selectedResult = result;
	}

	function backToSearch() {
		selectedResult = null;
	}

	async function confirmRematch() {
		if (!selectedResult) return;

		isSubmitting = true;
		try {
			const result =
				mediaType === 'movie'
					? await rematchMovie(mediaId, selectedResult.id)
					: await rematchSeries(mediaId, selectedResult.id);

			toasts.success(m.library_changeMatch_success({ title: result.title }));
			onSuccess(result);
		} catch (err) {
			const description = err instanceof Error ? err.message : undefined;
			toasts.error(m.library_changeMatch_failed(), { description });
		} finally {
			isSubmitting = false;
		}
	}

	function close() {
		onClose();
	}
</script>

<ModalWrapper {open} onClose={close} maxWidth="2xl" labelledBy="change-match-modal-title">
	<div class="mb-4 flex items-center justify-between gap-2">
		<h3 id="change-match-modal-title" class="text-lg font-bold">
			{m.library_changeMatch_title()}
		</h3>
		<button
			class="btn btn-circle shrink-0 btn-ghost btn-sm"
			onclick={close}
			aria-label={m.action_close()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	{#if selectedResult}
		<!-- Confirmation step -->
		<div class="flex items-center gap-3 rounded-lg bg-base-200 p-4">
			<div class="h-20 w-14 shrink-0 overflow-hidden rounded bg-base-300">
				{#if selectedResult.poster_path}
					<TmdbImage
						path={selectedResult.poster_path}
						alt={selectedResult.title ?? selectedResult.name ?? 'Poster'}
						size="w92"
						class="h-full w-full object-cover"
					/>
				{:else}
					<div class="flex h-full w-full items-center justify-center">
						{#if mediaType === 'movie'}
							<Clapperboard class="h-6 w-6 text-base-content/30" />
						{:else}
							<Tv class="h-6 w-6 text-base-content/30" />
						{/if}
					</div>
				{/if}
			</div>
			<div class="min-w-0 flex-1">
				<p class="text-sm text-base-content/50">
					{currentTitle}{currentYear ? ` (${currentYear})` : ''}
				</p>
				<p class="font-semibold">
					{selectedResult.title || selectedResult.name}
					{#if selectedResult.release_date || selectedResult.first_air_date}
						({(selectedResult.release_date || selectedResult.first_air_date)?.substring(0, 4)})
					{/if}
				</p>
			</div>
		</div>

		<div class="mt-4 flex gap-2 rounded-lg bg-warning/10 p-4 text-sm text-warning-content">
			<AlertTriangle class="h-5 w-5 shrink-0 text-warning" />
			<p>
				{mediaType === 'movie'
					? m.library_changeMatch_warningMovie()
					: m.library_changeMatch_warningSeries()}
			</p>
		</div>

		<div class="mt-4 flex gap-2">
			<button class="btn gap-1.5 btn-ghost" onclick={backToSearch} disabled={isSubmitting}>
				<ArrowLeft class="h-4 w-4" />
				{m.action_back()}
			</button>
			<button
				class="btn flex-1 gap-1.5 btn-primary"
				onclick={confirmRematch}
				disabled={isSubmitting}
			>
				{#if isSubmitting}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Check class="h-4 w-4" />
				{/if}
				{m.library_changeMatch_confirm()}
			</button>
		</div>
	{:else}
		<!-- Search step -->
		<p class="mt-1 text-sm text-base-content/70">
			{m.library_changeMatch_currentMatch({ title: currentTitle })}
		</p>

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
						mediaType === 'movie'
							? m.common_movies().toLowerCase()
							: m.common_tvShows().toLowerCase()
				})}
				bind:value={searchQuery}
				onkeydown={handleKeydown}
			/>
		</div>

		{#if searchResults.length > 0}
			<div class="mt-3 max-h-80 space-y-1 overflow-y-auto">
				{#each searchResults as result (result.id)}
					<button
						class="group flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-base-300"
						onclick={() => selectResult(result)}
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
									{#if mediaType === 'movie'}
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
					</button>
				{/each}
			</div>
		{:else if searchQuery && !isSearching}
			<div class="mt-4 py-8 text-center text-base-content/50">
				<p>{m.common_noResults()}</p>
			</div>
		{/if}
	{/if}
</ModalWrapper>

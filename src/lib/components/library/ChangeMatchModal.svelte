<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { X, Clapperboard, Tv, Check, Loader2, ArrowLeft, AlertTriangle } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import { rematchMovie, rematchSeries, type RematchResponse } from '#lib/api/library.js';
	import {
		createTmdbMatchSearch,
		type TmdbMatchResult
	} from '#lib/components/library/match/match-search.svelte.js';
	import MatchSearchField from '#lib/components/library/match/MatchSearchField.svelte';
	import MatchResultList from '#lib/components/library/match/MatchResultList.svelte';

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
	let selectedResult = $state<TmdbMatchResult | null>(null);
	let isSubmitting = $state(false);

	const search = createTmdbMatchSearch({
		query: () => searchQuery,
		type: () => mediaType,
		failureMessage: m.library_matchFile_searchFailed
	});

	// Reset to a fresh search every time the modal opens.
	$effect(() => {
		if (open) {
			searchQuery = '';
			search.reset();
			selectedResult = null;
			isSubmitting = false;
		}
	});

	// Typing debounce and the Enter escape hatch live in the shared search.
	$effect(() => {
		return search.schedule();
	});

	function selectResult(result: TmdbMatchResult) {
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

		<MatchSearchField
			bind:value={searchQuery}
			placeholder={m.library_matchFile_searchPlaceholder({
				type:
					mediaType === 'movie' ? m.common_movies().toLowerCase() : m.common_tvShows().toLowerCase()
			})}
			searching={search.searching}
			onEnter={() => search.run()}
			class="mt-4"
		/>

		{#if search.results.length > 0}
			<div class="mt-3 max-h-80 overflow-y-auto">
				<MatchResultList
					results={search.results}
					{mediaType}
					trailing={null}
					onpick={selectResult}
				/>
			</div>
		{:else if searchQuery && !search.searching}
			<div class="mt-4 py-8 text-center text-base-content/50">
				<p>{m.common_noResults()}</p>
			</div>
		{/if}
	{/if}
</ModalWrapper>

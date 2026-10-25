<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Loader2, ChevronDown, Clapperboard, Info, X, Check } from '@lucide/svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import {
		createRequest,
		getRequestCounts,
		getRequestMediaStatus,
		type RequestCountResponse,
		type RequestEpisodeEntry,
		type RequestMediaStatus
	} from '#lib/api/requests.js';
	import { getTmdb } from '#lib/api/discover.js';
	import QuotaSummary from './QuotaSummary.svelte';

	interface Props {
		open: boolean;
		/** Discover pages use 'tv'; the request API uses 'series'. */
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		title: string;
		year?: number | null;
		posterPath?: string | null;
		onClose: () => void;
		/** Called after the request is accepted (pending or auto-approved). */
		onSuccess?: () => void;
	}

	let { open, mediaType, tmdbId, title, year, posterPath, onClose, onSuccess }: Props = $props();

	const isSeries = $derived(mediaType === 'tv');

	let loading = $state(false);
	let submitting = $state(false);
	let counts = $state<RequestCountResponse | null>(null);

	interface SeasonInfo {
		seasonNumber: number;
		episodeCount: number;
		episodes: Array<{ episodeNumber: number; name: string; airDate: string | null }>;
		episodesLoaded: boolean;
	}

	let seasons = $state<SeasonInfo[]>([]);
	let expanded = new SvelteSet<number>();
	let selectedSeasons = new SvelteSet<number>();
	let selectedEpisodes = new SvelteMap<number, SvelteSet<number>>();
	let mediaStatus = $state<RequestMediaStatus | null>(null);

	// A checked season requests the whole season; picking episodes requests
	// them individually. Picking a season clears its episode picks.
	let selectedEpisodeCount = $derived(
		[...selectedEpisodes.entries()].reduce((sum, [, eps]) => sum + eps.size, 0)
	);
	let selectedSeasonCount = $derived(selectedSeasons.size);
	let hasSelection = $derived(!isSeries || selectedSeasonCount > 0 || selectedEpisodeCount > 0);

	// Locked rows: covered by an active request (duplicates are cross-user)
	// or already on disk. Locks are visible reasons, never silent dims.
	let requestedSeasons = $derived(
		new Set(mediaStatus?.activeScopes?.flatMap((s) => s.seasons) ?? [])
	);
	let requestedEpisodes = $derived(
		new Set(
			mediaStatus?.activeScopes?.flatMap((s) =>
				s.episodes.map((e) => `${e.seasonNumber}x${e.episodeNumber}`)
			) ?? []
		)
	);
	let availableEpisodes = $derived(new Set(mediaStatus?.availableEpisodes ?? []));

	function seasonLocked(seasonNumber: number): boolean {
		return requestedSeasons.has(seasonNumber);
	}

	function episodeLocked(seasonNumber: number, episodeNumber: number): string | null {
		const key = `${seasonNumber}x${episodeNumber}`;
		if (availableEpisodes.has(key)) return m.requests_lockedAvailable();
		if (requestedSeasons.has(seasonNumber) || requestedEpisodes.has(key)) {
			return m.requests_lockedRequested();
		}
		return null;
	}

	function isUnaired(airDate: string | null): boolean {
		return !!airDate && new Date(airDate).getTime() > Date.now();
	}

	function seasonUnairedCount(season: SeasonInfo): number {
		if (!season.episodesLoaded) return 0;
		return season.episodes.filter((e) => e.episodeNumber > 0 && isUnaired(e.airDate)).length;
	}

	let autoApproveEffective = $derived(
		counts?.autoApprove ? (isSeries ? counts.autoApprove.series : counts.autoApprove.movie) : false
	);

	let quotaExceeded = $derived.by(() => {
		if (!counts || submitting) return false;
		if (!isSeries) return counts.quota.movie.restricted;
		const tv = counts.quota.tv;
		if (tv.limit === null) return false;
		const unit = counts.tvQuotaUnit ?? 'episodes';
		// Mirror the server's unit math exactly: whole seasons count their
		// episode totals under 'episodes'; seasons touched by episode picks
		// count under 'seasons'.
		const seasonTotals = [...selectedSeasons].reduce(
			(sum, s) => sum + (seasons.find((info) => info.seasonNumber === s)?.episodeCount ?? 0),
			0
		);
		const needed =
			unit === 'seasons'
				? new Set([...selectedSeasons, ...selectedEpisodes.keys()]).size
				: selectedEpisodeCount + seasonTotals;
		return needed > (tv.remaining ?? 0);
	});

	$effect(() => {
		if (open) {
			void load();
		} else {
			selectedSeasons.clear();
			selectedEpisodes.clear();
			expanded.clear();
		}
	});

	async function load() {
		loading = true;
		try {
			const statusPromise = getRequestMediaStatus(isSeries ? 'series' : 'movie', tmdbId);
			const countsPromise = getRequestCounts();
			if (isSeries) {
				const details = (await getTmdb(`tv/${tmdbId}`)) as {
					seasons?: Array<{ season_number: number; episode_count?: number }>;
				};
				seasons = (details.seasons ?? [])
					.filter((s) => s.season_number > 0 && (s.episode_count ?? 0) > 0)
					.map((s): SeasonInfo => ({
						seasonNumber: s.season_number,
						episodeCount: s.episode_count ?? 0,
						episodes: [],
						episodesLoaded: false
					}));
			}
			[mediaStatus, counts] = await Promise.all([statusPromise, countsPromise]);
		} catch {
			toasts.error(m.requests_errorLoad());
		} finally {
			loading = false;
		}
	}

	async function toggleExpanded(seasonNumber: number) {
		if (expanded.has(seasonNumber)) {
			expanded.delete(seasonNumber);
			return;
		}
		expanded.add(seasonNumber);
		const season = seasons.find((s) => s.seasonNumber === seasonNumber);
		if (season && !season.episodesLoaded) {
			try {
				const detail = (await getTmdb(`tv/${tmdbId}/season/${seasonNumber}`)) as {
					episodes?: Array<{ episode_number: number; name?: string; air_date?: string | null }>;
				};
				season.episodes = (detail.episodes ?? []).map((e) => ({
					episodeNumber: e.episode_number,
					name: e.name ?? '',
					airDate: e.air_date ?? null
				}));
				season.episodesLoaded = true;
				seasons = [...seasons];
			} catch {
				toasts.error(m.requests_errorLoad());
			}
		}
	}

	function toggleSeason(seasonNumber: number) {
		if (seasonLocked(seasonNumber)) return;
		if (selectedSeasons.has(seasonNumber)) {
			selectedSeasons.delete(seasonNumber);
		} else {
			selectedSeasons.add(seasonNumber);
			selectedEpisodes.delete(seasonNumber);
		}
	}

	function toggleEpisode(seasonNumber: number, episodeNumber: number) {
		const forSeason = selectedEpisodes.get(seasonNumber) ?? new SvelteSet<number>();
		if (forSeason.has(episodeNumber)) {
			forSeason.delete(episodeNumber);
		} else {
			forSeason.add(episodeNumber);
		}
		if (forSeason.size === 0) {
			selectedEpisodes.delete(seasonNumber);
		} else {
			selectedEpisodes.set(seasonNumber, forSeason);
		}
	}

	function selectAllSeasons() {
		selectedSeasons.clear();
		for (const s of seasons) {
			if (!seasonLocked(s.seasonNumber)) selectedSeasons.add(s.seasonNumber);
		}
		selectedEpisodes.clear();
	}

	function seasonEpisodeCount(season: SeasonInfo): number {
		return season.episodeCount || season.episodes.length;
	}

	function errorMessage(code: unknown, fallback: string): string {
		switch (code) {
			case 'cooldown':
				return m.requests_errorCooldown();
			case 'movie_quota':
				return m.requests_errorQuotaMovie();
			case 'tv_quota':
				return m.requests_errorQuotaTv();
			case 'duplicate_request':
				return m.requests_errorDuplicate();
			case 'blocked_media':
				return m.requests_errorBlocked();
			case 'already_available':
				return m.requests_errorAvailable();
			case 'already_in_library':
				return m.requests_errorInLibrary();
			case 'requests_disabled':
				return m.requests_errorDisabledGlobal();
			case 'requesting_disabled':
				return m.requests_errorDisabledAccount();
			case 'banned':
				return m.requests_errorBanned();
			case 'invalid_scope':
				return m.requests_errorScope();
			default:
				return fallback;
		}
	}

	async function submit() {
		submitting = true;
		try {
			const payload: Parameters<typeof createRequest>[0] = {
				mediaType: isSeries ? 'series' : 'movie',
				tmdbId
			};
			if (isSeries) {
				if (selectedSeasonCount > 0) {
					payload.seasons = [...selectedSeasons].sort((a, b) => a - b);
				}
				if (selectedEpisodeCount > 0) {
					payload.episodes = [...selectedEpisodes.entries()].flatMap(([seasonNumber, eps]) =>
						[...eps]
							.sort((a, b) => a - b)
							.map((episodeNumber): RequestEpisodeEntry => ({ seasonNumber, episodeNumber }))
					);
				}
			}
			const created = await createRequest(payload);
			toasts.success(
				created.status === 'fulfilled'
					? m.requests_successAvailable({ title })
					: m.requests_success({ title })
			);
			onSuccess?.();
			onClose();
		} catch (error) {
			const apiError = error as { response?: { code?: unknown }; message?: string };
			toasts.error(
				errorMessage(apiError.response?.code, apiError.message ?? m.requests_errorGeneric())
			);
		} finally {
			submitting = false;
		}
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="lg">
	<div class="mb-4 flex items-start gap-3.5">
		<div class="w-14 shrink-0 overflow-hidden rounded-lg shadow-md">
			<TmdbImage path={posterPath ?? null} size="w92" alt={title} class="aspect-2/3 w-full" />
		</div>
		<div class="min-w-0 flex-1 pt-0.5">
			<h3 class="text-lg leading-tight font-semibold">
				{isSeries ? m.requests_modalTitleSeries() : m.requests_modalTitleMovie()}
			</h3>
			<p class="mt-0.5 truncate text-sm text-base-content/60">
				{title}{year ? ` · ${year}` : ''}
			</p>
		</div>
		<button
			type="button"
			class="btn btn-circle btn-ghost btn-sm"
			onclick={onClose}
			aria-label={m.action_close()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-10">
			<Loader2 class="h-6 w-6 animate-spin text-base-content/40" />
		</div>
	{:else}
		<div class="flex flex-col gap-4">
			{#if autoApproveEffective}
				<div class="flex items-center gap-2 rounded-xl bg-info/10 px-3.5 py-2.5 text-sm text-info">
					<Info class="h-4 w-4 shrink-0" />
					{m.requests_autoApproveBanner()}
				</div>
			{/if}

			{#if isSeries}
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold">{m.requests_selectSeasons()}</h4>
					<button type="button" class="btn btn-ghost btn-xs" onclick={selectAllSeasons}>
						{m.requests_selectAllSeasons()}
					</button>
				</div>

				{#if seasons.length === 0}
					<div
						class="rounded-xl border border-dashed border-base-content/15 py-8 text-center text-sm text-base-content/50"
					>
						{m.requests_noSeasons()}
					</div>
				{:else}
					<div class="-mx-1 max-h-72 space-y-1.5 overflow-y-auto px-1">
						{#each seasons as season (season.seasonNumber)}
							{@const seasonSelected = selectedSeasons.has(season.seasonNumber)}
							{@const pickedForSeason = selectedEpisodes.get(season.seasonNumber)?.size ?? 0}
							{@const locked = seasonLocked(season.seasonNumber)}
							{@const unairedCount = seasonUnairedCount(season)}
							<div
								class="rounded-xl border transition-colors {seasonSelected
									? 'border-primary/40 bg-primary/5'
									: 'border-base-content/10'}"
							>
								<div class="flex items-center gap-2.5 px-3 py-2.5">
									<input
										type="checkbox"
										class="checkbox checkbox-sm checkbox-primary {seasonSelected
											? ''
											: 'opacity-70'}"
										checked={seasonSelected}
										indeterminate={!seasonSelected && pickedForSeason > 0}
										disabled={locked}
										onchange={() => toggleSeason(season.seasonNumber)}
										aria-label={m.requests_seasonNumber({ number: season.seasonNumber })}
									/>
									<button
										type="button"
										class="flex flex-1 items-center justify-between gap-2 text-left"
										onclick={() => toggleExpanded(season.seasonNumber)}
									>
										<span
											class="text-sm font-medium"
											title={locked ? m.requests_lockedRequested() : undefined}
										>
											{m.requests_seasonNumber({ number: season.seasonNumber })}
											<span class="ml-1.5 font-normal text-base-content/45">
												{m.requests_episodeCount({ count: seasonEpisodeCount(season) })}
											</span>
											{#if locked}
												<span class="ml-1.5 text-xs font-normal text-base-content/40">
													({m.requests_lockedRequested()})
												</span>
											{/if}
											{#if unairedCount > 0}
												<span class="ml-1.5 text-xs font-normal text-base-content/40">
													({m.requests_unairedCount({ count: unairedCount })})
												</span>
											{/if}
										</span>
										<span class="flex items-center gap-2">
											{#if seasonSelected}
												<span
													class="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-content"
												>
													<Check class="h-3 w-3" strokeWidth={3} />
												</span>
											{:else if pickedForSeason > 0}
												<span
													class="rounded-full bg-secondary/15 px-2 py-0.5 text-xs font-medium text-secondary"
												>
													{pickedForSeason}
												</span>
											{/if}
											<ChevronDown
												class="h-4 w-4 text-base-content/35 transition-transform {expanded.has(
													season.seasonNumber
												)
													? ''
													: '-rotate-90'}"
											/>
										</span>
									</button>
								</div>
								{#if expanded.has(season.seasonNumber)}
									<div class="flex flex-wrap gap-1.5 px-3.5 pb-3">
										{#each season.episodes as episode (episode.episodeNumber)}
											{#if episode.episodeNumber > 0}
												{@const episodeSelected =
													seasonSelected ||
													selectedEpisodes.get(season.seasonNumber)?.has(episode.episodeNumber)}
												{@const lockReason = episodeLocked(
													season.seasonNumber,
													episode.episodeNumber
												)}
												{@const unaired = isUnaired(episode.airDate)}
												<button
													type="button"
													class="h-7 min-w-9 rounded-lg border px-1.5 text-xs font-medium transition-colors {episodeSelected
														? 'border-primary bg-primary text-primary-content'
														: lockReason
															? 'border-base-content/10 text-base-content/35'
															: unaired
																? 'border-dashed border-base-content/25 text-base-content/60 hover:border-primary/50 hover:text-base-content'
																: 'border-base-content/15 text-base-content/70 hover:border-primary/50 hover:text-base-content'}"
													class:opacity-45={seasonSelected || !!lockReason}
													disabled={seasonSelected || !!lockReason}
													onclick={() => toggleEpisode(season.seasonNumber, episode.episodeNumber)}
													title={lockReason
														? lockReason
														: unaired
															? m.requests_unairedCount({ count: 1 })
															: episode.name || undefined}
												>
													{episode.episodeNumber}
												</button>
											{/if}
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/if}

			{#if counts}
				<div class="grid gap-2 sm:grid-cols-2">
					<QuotaSummary quota={counts.quota.movie} type="movie" />
					{#if isSeries}
						<QuotaSummary quota={counts.quota.tv} type="tv" />
					{/if}
				</div>
			{/if}

			{#if quotaExceeded}
				<div class="rounded-xl bg-error/10 px-3.5 py-2.5 text-sm text-error">
					{m.requests_quotaBlocked()}
				</div>
			{/if}
		</div>
	{/if}

	<div class="modal-action mt-5 border-t border-base-300/70 pt-4">
		<button type="button" class="btn btn-ghost btn-sm" onclick={onClose}>
			{m.action_cancel()}
		</button>
		<button
			type="button"
			class="btn gap-1.5 btn-primary btn-sm"
			disabled={submitting || loading || !hasSelection || quotaExceeded}
			onclick={submit}
		>
			{#if submitting}
				<Loader2 class="h-4 w-4 animate-spin" />
				{m.requests_requesting()}
			{:else if !isSeries}
				<Clapperboard class="h-4 w-4" />
				{m.requests_requestMovie()}
			{:else if selectedSeasonCount > 0 && selectedEpisodeCount === 0}
				{m.requests_requestSeasons({ count: selectedSeasonCount })}
			{:else if selectedEpisodeCount > 0}
				{m.requests_requestEpisodes({ count: selectedEpisodeCount + selectedSeasonCount })}
			{:else}
				{m.requests_selectFirst()}
			{/if}
		</button>
	</div>
</ModalWrapper>

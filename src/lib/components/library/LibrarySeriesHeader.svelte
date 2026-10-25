<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { TVShowDetails } from '#lib/types/tmdb.js';
	import { displayTitle } from '#lib/types/library.js';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import SubtitleRequirementBadge from './SubtitleRequirementBadge.svelte';
	import type { SubtitleRequirementProgress } from '#lib/utils/subtitle-status-display.js';
	import CrewList from '#lib/components/tmdb/CrewList.svelte';
	import WatchProviders from '#lib/components/tmdb/WatchProviders.svelte';
	import MonitorToggle from './MonitorToggle.svelte';
	import {
		Settings,
		Trash2,
		ExternalLink,
		RefreshCw,
		Package,
		Download,
		Zap,
		Ban,
		Captions,
		Play,
		MoreHorizontal,
		ArrowLeft,
		Eye,
		EyeOff,
		Replace
	} from '@lucide/svelte';
	import {
		formatLanguage,
		formatDisplayDateShort,
		getStatusColor,
		formatBytes
	} from '#lib/utils/format.js';
	import { formatSeriesStatus } from '#lib/utils/format-status.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { blockMedia } from '#lib/api/settings.js';
	import { TMDB } from '#lib/config/constants.js';
	import { resolvePath } from '#lib/utils/routing.js';

	interface SeriesData {
		tmdbId: number;
		tvdbId: number | null;
		imdbId: string | null;
		providerRefs?: Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null;
		title: string;
		originalTitle?: string | null;
		preferOriginalTitle?: boolean | null;
		year: number | null;
		overview: string | null;
		status: string | null;
		network: string | null;
		genres: string[] | null;
		posterPath: string | null;
		backdropPath: string | null;
		monitored: boolean | null;
	}

	interface MissingSearchProgress {
		current: number;
		total: number;
	}

	interface MissingSearchResult {
		searched: number;
		found: number;
		grabbed: number;
	}

	interface RefreshProgress {
		current: number;
		total: number;
		message: string;
	}

	interface Props {
		series: SeriesData;
		tmdbSeries?: TVShowDetails | null;
		defaultRegion?: string;
		configuredProviders?: { anilist: boolean; mal: boolean };
		librarySlug?: string | null;
		libraryName?: string | null;
		backHref?: string | null;
		refreshing?: boolean;
		refreshProgress?: RefreshProgress | null;
		missingEpisodeCount?: number;
		searchingMissing?: boolean;
		missingSearchProgress?: MissingSearchProgress | null;
		missingSearchResult?: MissingSearchResult | null;
		episodeCount?: number | null;
		episodeFileCount?: number | null;
		percentComplete?: number;
		/** Aggregate requirement progress across file-bearing episodes. */
		subtitleProgress?: SubtitleRequirementProgress | null;
		/** Instance default for items with no explicit prefer-original flag. */
		preferOriginalTitleDefault?: boolean | null;
		totalSeriesSize?: number;
		downloadingCount?: number;
		partiallyMonitored?: boolean;
		onMonitorToggle?: (newValue: boolean) => void;
		onSearch?: () => void;
		onSearchMissing?: () => void;
		onSubtitleAutoSearch?: () => void;
		subtitleAutoSearching?: boolean;
		onImport?: () => void;
		onEdit?: () => void;
		onDelete?: () => void;
		onRefresh?: () => void;
		onChangeMatch?: () => void;
		/** Viewer mode: hide acquisition/edit controls, keep the informational header. */
		readOnly?: boolean;
	}

	let {
		series,
		tmdbSeries = null,
		defaultRegion = TMDB.DEFAULT_REGION,
		configuredProviders = { anilist: false, mal: false },
		librarySlug = null,
		libraryName = null,
		backHref = null,
		refreshing = false,
		refreshProgress: _refreshProgress = null,
		missingEpisodeCount = 0,
		searchingMissing = false,
		missingSearchProgress: _missingSearchProgress = null,
		missingSearchResult: _missingSearchResult = null,
		episodeCount = null,
		episodeFileCount = null,
		percentComplete = 0,
		subtitleProgress = null,
		preferOriginalTitleDefault = false,
		totalSeriesSize = 0,
		downloadingCount = 0,
		partiallyMonitored = false,
		onMonitorToggle,
		onSearch,
		onSearchMissing,
		onSubtitleAutoSearch,
		subtitleAutoSearching = false,
		onImport,
		onEdit,
		onDelete,
		onRefresh,
		onChangeMatch,
		readOnly = false
	}: Props = $props();

	let showBlockConfirm = $state(false);
	let overviewExpanded = $state(false);

	async function handleBlock() {
		try {
			await blockMedia({
				tmdbId: series.tmdbId,
				mediaType: 'tv',
				title: series.title,
				posterPath: series.posterPath ?? null,
				year: series.year ?? null
			});
			toasts.success(m.blockedMedia_blocked({ title: series.title }));
			window.location.href = '/settings/blocklist/blocked-media';
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'Failed to block media');
		}
	}

	function openTrailer() {
		const trailer = tmdbSeries?.videos?.results?.find(
			(v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')
		);
		if (trailer) {
			window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank');
		}
	}

	const providerLinks = $derived.by(() => {
		const refs = series.providerRefs ?? {};
		const links: Array<{ label: string; href: string }> = [];
		if (configuredProviders.anilist && refs.anilist) {
			links.push({
				label: 'AniList',
				href: `https://anilist.co/anime/${refs.anilist}`
			});
		}
		if (configuredProviders.mal && refs.mal) {
			links.push({
				label: 'MAL',
				href: `https://myanimelist.net/anime/${refs.mal}`
			});
		}
		return links;
	});

	const overview = $derived(tmdbSeries?.overview ?? series.overview);
	const isAnimated = $derived(
		series.genres?.some((g) => ['animation', 'anime'].includes(g.toLowerCase())) ||
			Boolean(series.providerRefs?.anilist) ||
			Boolean(series.providerRefs?.mal)
	);
	const avgEpisodeRuntime = $derived.by(() => {
		const runtimes = tmdbSeries?.episode_run_time ?? [];
		if (!runtimes.length) return null;
		return Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length);
	});
	const hasTrailer = $derived(
		tmdbSeries?.videos?.results?.some(
			(v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')
		) ?? false
	);

	const contentRating = $derived.by(() => {
		if (!tmdbSeries?.content_ratings?.results) return null;
		const rating =
			tmdbSeries.content_ratings.results.find((r) => r.iso_3166_1 === defaultRegion) ||
			tmdbSeries.content_ratings.results.find((r) => r.iso_3166_1 === 'US');
		return rating?.rating || null;
	});
</script>

<div class="flex flex-col gap-4">
	<!-- Top action bar -->
	<div class="flex items-center justify-between gap-2">
		<a
			href={resolvePath(
				backHref ?? (librarySlug ? `/library/tv?library=${librarySlug}` : '/library/tv')
			)}
			class="btn gap-1.5 btn-ghost text-base-content/60 btn-sm"
		>
			<ArrowLeft size={16} />
			<span class="sm:inline"
				>{m.library_backTo({ name: libraryName ?? m.library_tv_heading() })}</span
			>
		</a>
		<div class="flex shrink-0 items-center gap-1 sm:gap-2">
			{#if !readOnly}
				<!-- MonitorToggle hidden on mobile (shown in bottom bar) -->
				<div class="hidden sm:block">
					<MonitorToggle
						monitored={series.monitored ?? false}
						{partiallyMonitored}
						onToggle={onMonitorToggle}
						size="md"
					/>
				</div>
				<!-- Auto-grab (desktop) -->
				<button
					class="btn hidden gap-1.5 btn-primary btn-sm sm:flex"
					onclick={onSearchMissing}
					disabled={searchingMissing || missingEpisodeCount === 0}
				>
					{#if searchingMissing}
						<span class="loading loading-xs loading-spinner"></span>
					{:else}
						<Zap size={14} />
					{/if}
					{m.library_seriesHeader_autoGrab()}
					{#if missingEpisodeCount > 0}
						<span class="badge badge-sm">{missingEpisodeCount}</span>
					{/if}
				</button>
				<!-- Season Packs (desktop) -->
				<button class="btn hidden gap-1.5 btn-ghost btn-sm sm:flex" onclick={onSearch}>
					<Package size={14} />
					{m.library_seriesHeader_seasonPacks()}
				</button>
				<!-- Overflow menu (desktop only) -->
				<div class="dropdown dropdown-end hidden sm:block">
					<button tabindex="0" class="btn btn-ghost btn-sm">
						<MoreHorizontal size={18} />
					</button>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<ul
						tabindex="0"
						class="menu dropdown-content z-50 w-56 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg"
					>
						{#if onImport}
							<li>
								<button onclick={onImport}>
									<Download size={16} />
									{m.action_import()}
								</button>
							</li>
						{/if}
						<li>
							<button onclick={onRefresh} disabled={refreshing}>
								<RefreshCw size={16} />
								{#if refreshing}
									{m.common_loading()}
								{:else}
									{m.library_seriesHeader_refreshTooltip()}
								{/if}
							</button>
						</li>
						{#if onSubtitleAutoSearch}
							<li>
								<button onclick={onSubtitleAutoSearch} disabled={subtitleAutoSearching}>
									<Captions size={16} />
									{m.library_seriesHeader_autoDownloadSubs()}
								</button>
							</li>
						{/if}
						<div class="divider my-1"></div>
						{#if onChangeMatch}
							<li>
								<button onclick={onChangeMatch}>
									<Replace size={16} />
									{m.library_changeMatch_menuLabel()}
								</button>
							</li>
						{/if}
						<li>
							<button onclick={onEdit}>
								<Settings size={16} />
								{m.action_edit()}
							</button>
						</li>
						<li>
							<button class="text-error" onclick={onDelete}>
								<Trash2 size={16} />
								{m.action_delete()}
							</button>
						</li>
						<li>
							<button class="text-error" onclick={() => (showBlockConfirm = true)}>
								<Ban size={16} />
								{m.library_blockMediaTooltip()}
							</button>
						</li>
					</ul>
				</div>
			{/if}
		</div>
	</div>

	<!-- Hero card -->
	<div class="relative w-full overflow-hidden rounded-xl bg-base-200 shadow-xl">
		<!-- Backdrop -->
		<div class="absolute inset-0 h-full w-full">
			{#if series.backdropPath}
				<TmdbImage
					path={series.backdropPath}
					size="original"
					alt={series.title}
					class="h-full w-full object-cover opacity-55"
				/>
			{/if}
			<div
				class="absolute inset-0 bg-linear-to-t from-base-200 via-base-200/60 to-transparent"
			></div>
			<div
				class="absolute inset-0 hidden bg-linear-to-r from-base-200 via-base-200/60 to-transparent md:block"
			></div>
		</div>

		<!-- Content -->
		<div class="relative z-10">
			<div class="flex flex-col gap-6 p-6 md:flex-row md:p-8">
				<!-- Poster -->
				<div class="hidden shrink-0 flex-col gap-2 sm:flex">
					<div class="w-48 overflow-hidden rounded-lg shadow-lg md:w-56">
						<TmdbImage
							path={series.posterPath}
							size="w342"
							alt={series.title}
							class="h-auto w-full object-cover"
						/>
					</div>
					{#if !readOnly}
						<button
							class="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors
								{series.monitored
								? 'bg-success/10 text-success hover:bg-success/20'
								: 'bg-base-content/5 text-base-content/40 hover:bg-base-content/10'}"
							onclick={() => onMonitorToggle?.(!series.monitored)}
						>
							{#if series.monitored}
								<Eye size={13} />
								Monitored
							{:else}
								<EyeOff size={13} />
								Unmonitored
							{/if}
						</button>
					{/if}
				</div>

				<!-- Main Info -->
				<div class="flex min-w-0 flex-1 flex-col gap-4">
					<div class="min-w-0">
						<h1 class="text-2xl font-bold md:text-3xl">
							{displayTitle(series, preferOriginalTitleDefault)}
							{#if series.year}
								<span class="font-normal text-base-content/60">({series.year})</span>
							{/if}
						</h1>

						<div
							class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-base-content/70"
						>
							{#if tmdbSeries?.vote_average}
								<span class="flex items-center gap-1 font-semibold text-warning">
									★ {tmdbSeries.vote_average.toFixed(1)}
								</span>
							{/if}
							{#if series.status}
								<span class="badge {getStatusColor(series.status)} badge-sm">
									{formatSeriesStatus(series.status)}
								</span>
							{/if}
							{#if series.network}
								<span>•</span>
								<span>{series.network}</span>
							{/if}
							{#if series.genres && series.genres.length > 0}
								<span>•</span>
								<span>{series.genres.slice(0, 3).join(', ')}</span>
							{/if}
						</div>
					</div>

					{#if tmdbSeries?.tagline}
						<p class="border-l-2 border-primary pl-3 text-base text-base-content/50 italic">
							{tmdbSeries.tagline}
						</p>
					{/if}

					{#if overview}
						<div>
							<p
								class="text-base leading-relaxed text-base-content/90 {overviewExpanded
									? ''
									: 'line-clamp-3 sm:line-clamp-none'}"
							>
								{overview}
							</p>
							<button
								class="mt-1 text-sm text-primary/70 hover:text-primary sm:hidden"
								onclick={() => (overviewExpanded = !overviewExpanded)}
							>
								{overviewExpanded ? 'Read less' : 'Read more'}
							</button>
						</div>
					{/if}

					{#if tmdbSeries?.credits?.crew?.length || tmdbSeries?.created_by?.length}
						<div class="text-sm">
							<CrewList
								crew={tmdbSeries?.credits?.crew ?? []}
								creators={tmdbSeries?.created_by ?? []}
							/>
						</div>
					{/if}

					{#if tmdbSeries?.credits?.cast?.length}
						<div>
							<div class="mb-2 text-sm text-base-content/60">Cast</div>
							<div class="flex gap-3 overflow-x-auto pb-1">
								{#each tmdbSeries.credits.cast.slice(0, 8) as actor (actor.id)}
									<div class="flex w-16 shrink-0 flex-col items-center gap-1.5">
										<div class="h-14 w-14 overflow-hidden rounded-full bg-base-300">
											{#if actor.profile_path}
												<TmdbImage
													path={actor.profile_path}
													size="w185"
													alt={actor.name}
													class="h-full w-full object-cover"
												/>
											{:else}
												<div
													class="flex h-full w-full items-center justify-center text-lg text-base-content/30"
												>
													{actor.name.charAt(0)}
												</div>
											{/if}
										</div>
										<div class="text-center">
											<div class="line-clamp-2 text-xs leading-tight font-medium">{actor.name}</div>
											{#if actor.character}
												<div class="line-clamp-1 text-xs leading-tight text-base-content/50">
													{actor.character}
												</div>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Episode stats + external links -->
					<div
						class="flex flex-col gap-2 border-t border-base-content/10 pt-3 sm:flex-row sm:items-center sm:justify-between"
					>
						{#if episodeCount != null}
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-sm text-base-content/70">
									{episodeFileCount ?? 0} / {episodeCount}
									{m.common_episodes()}
								</span>
								{#if percentComplete === 100}
									<span class="badge badge-sm badge-success"
										>{m.library_seriesHeader_complete()}</span
									>
								{:else if percentComplete > 0}
									<span class="badge badge-sm badge-primary">{percentComplete}%</span>
								{/if}
								{#if totalSeriesSize > 0}
									<span class="badge badge-sm badge-info">{formatBytes(totalSeriesSize)}</span>
								{/if}
								{#if downloadingCount > 0}
									<span class="badge badge-sm font-semibold badge-success">
										<Download size={12} class="animate-pulse" />
										{downloadingCount}
									</span>
								{/if}
								{#if subtitleProgress}
									<SubtitleRequirementBadge progress={subtitleProgress} size="sm" />
								{/if}
							</div>
						{/if}
						<div
							class="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-base-content/10 pt-2 pb-0.5 sm:overflow-x-visible sm:border-0 sm:pt-0 sm:pb-0"
						>
							{#if series.tmdbId}
								<a
									href="https://www.themoviedb.org/tv/{series.tmdbId}"
									target="_blank"
									rel="noopener noreferrer"
									class="btn shrink-0 gap-1 btn-ghost btn-xs"
								>
									TMDB
									<ExternalLink size={12} />
								</a>
							{/if}
							{#if series.tvdbId}
								<a
									href="https://thetvdb.com/dereferrer/series/{series.tvdbId}"
									target="_blank"
									rel="noopener noreferrer"
									class="btn shrink-0 gap-1 btn-ghost btn-xs"
								>
									TVDB
									<ExternalLink size={12} />
								</a>
							{/if}
							{#if series.imdbId}
								<a
									href="https://www.imdb.com/title/{series.imdbId}"
									target="_blank"
									rel="noopener noreferrer"
									class="btn shrink-0 gap-1 btn-ghost btn-xs"
								>
									IMDb
									<ExternalLink size={12} />
								</a>
							{/if}
							{#each providerLinks as provider (provider.label)}
								<a
									href={provider.href}
									target="_blank"
									rel="noopener noreferrer"
									class="btn shrink-0 gap-1 btn-ghost btn-xs"
								>
									{provider.label}
									<ExternalLink size={12} />
								</a>
							{/each}
							{#if hasTrailer}
								<button class="btn shrink-0 gap-1 btn-ghost btn-xs" onclick={openTrailer}>
									<Play size={12} />
									{m.hero_trailer()}
								</button>
							{/if}
						</div>
					</div>
				</div>

				<!-- Right side metadata panel -->
				{#if tmdbSeries}
					<div
						class="hidden w-64 shrink-0 rounded-lg bg-base-100/30 p-4 backdrop-blur-sm md:block lg:w-80 lg:p-5"
					>
						<div class="grid grid-cols-2 gap-x-4 gap-y-2 lg:gap-x-6 lg:gap-y-3">
							<div>
								<div class="text-xs text-base-content/50">{m.hero_metadata_status()}</div>
								<div class="font-medium">{tmdbSeries.status}</div>
							</div>

							<div>
								<div class="text-xs text-base-content/50">{m.hero_metadata_language()}</div>
								<div class="font-medium">{formatLanguage(tmdbSeries.original_language)}</div>
							</div>

							{#if contentRating}
								<div>
									<div class="text-xs text-base-content/50">{m.hero_metadata_rated()}</div>
									<div>
										<span class="badge badge-outline badge-sm">{contentRating}</span>
									</div>
								</div>
							{/if}

							<div>
								<div class="text-xs text-base-content/50">{m.hero_metadata_released()}</div>
								<div class="font-medium">{formatDisplayDateShort(tmdbSeries.first_air_date)}</div>
							</div>

							{#if tmdbSeries.last_air_date}
								<div>
									<div class="text-xs text-base-content/50">Last Aired</div>
									<div class="font-medium">{formatDisplayDateShort(tmdbSeries.last_air_date)}</div>
								</div>
							{/if}

							{#if tmdbSeries.type}
								<div>
									<div class="text-xs text-base-content/50">Type</div>
									<div class="font-medium">{tmdbSeries.type}</div>
								</div>
							{/if}

							{#if tmdbSeries.number_of_seasons}
								<div>
									<div class="text-xs text-base-content/50">Seasons</div>
									<div class="font-medium">{tmdbSeries.number_of_seasons}</div>
								</div>
							{/if}

							{#if tmdbSeries.networks && tmdbSeries.networks.length > 0}
								<div>
									<div class="text-xs text-base-content/50">Network</div>
									<div class="font-medium">
										{tmdbSeries.networks
											.slice(0, 2)
											.map((n) => n.name)
											.join(', ')}
									</div>
								</div>
							{/if}

							{#if tmdbSeries.number_of_episodes}
								<div>
									<div class="text-xs text-base-content/50">Episodes</div>
									<div class="font-medium">{tmdbSeries.number_of_episodes}</div>
								</div>
							{/if}

							{#if avgEpisodeRuntime}
								<div>
									<div class="text-xs text-base-content/50">Runtime</div>
									<div class="font-medium">{avgEpisodeRuntime}m / ep</div>
								</div>
							{/if}

							{#if isAnimated && tmdbSeries.production_companies?.length}
								<div class="col-span-2">
									<div class="text-xs text-base-content/50">Studio</div>
									<div class="font-medium">
										{tmdbSeries.production_companies
											.slice(0, 2)
											.map((c) => c.name)
											.join(', ')}
									</div>
								</div>
							{/if}
						</div>

						{#if tmdbSeries['watch/providers']}
							<div class="mt-4 border-t border-base-content/10 pt-4">
								<div class="mb-2 text-xs text-base-content/50">
									{m.hero_metadata_whereToWatch()}
								</div>
								<WatchProviders
									providers={tmdbSeries['watch/providers']}
									countryCode={defaultRegion}
								/>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

<ConfirmationModal
	open={showBlockConfirm}
	onCancel={() => (showBlockConfirm = false)}
	onConfirm={handleBlock}
	title={m.blockedMedia_confirmBlockTitle()}
	message={m.blockedMedia_confirmBlockMessage({ title: series.title })}
	confirmLabel={m.blockedMedia_confirmBlockLabel()}
	confirmVariant="error"
/>

<!-- Mobile action bar (admin only: every entry mutates or acquires) -->
{#if !readOnly}
	<div
		class="fixed right-0 bottom-0 left-0 z-40 border-t border-base-content/6 bg-base-100/75 backdrop-blur-xl sm:hidden"
		style="padding-bottom: env(safe-area-inset-bottom)"
	>
		<div class="flex items-stretch justify-around">
			<!-- Monitor -->
			<button
				class="flex flex-1 flex-col items-center gap-1 py-3 transition-colors
				{series.monitored ? 'text-success' : 'text-base-content/55'}"
				onclick={() => onMonitorToggle?.(!series.monitored)}
			>
				{#if series.monitored}
					<Eye size={20} />
				{:else}
					<EyeOff size={20} />
				{/if}
				<span class="text-[10px] tracking-wide">{series.monitored ? 'Monitored' : 'Off'}</span>
			</button>

			<!-- Auto-grab -->
			<button
				class="flex flex-1 flex-col items-center gap-1 py-3 transition-colors
				{searchingMissing || missingEpisodeCount === 0 ? 'text-primary/40' : 'text-primary'}"
				onclick={onSearchMissing}
				disabled={searchingMissing || missingEpisodeCount === 0}
			>
				{#if searchingMissing}
					<span class="loading loading-xs loading-spinner"></span>
				{:else}
					<Zap size={20} />
				{/if}
				<span class="text-[10px] tracking-wide">{m.library_seriesHeader_autoGrab()}</span>
			</button>

			<!-- Season Packs -->
			<button
				class="flex flex-1 flex-col items-center gap-1 py-3 text-base-content/55 transition-colors active:text-base-content/90"
				onclick={onSearch}
			>
				<Package size={20} />
				<span class="text-[10px] tracking-wide">{m.library_seriesHeader_seasonPacks()}</span>
			</button>

			<!-- Edit -->
			<button
				class="flex flex-1 flex-col items-center gap-1 py-3 text-base-content/55 transition-colors active:text-base-content/90"
				onclick={onEdit}
			>
				<Settings size={20} />
				<span class="text-[10px] tracking-wide">{m.action_edit()}</span>
			</button>

			<!-- Overflow (dropdown-top) -->
			<div class="dropdown dropdown-end dropdown-top flex flex-1">
				<button
					tabindex="0"
					class="flex flex-1 flex-col items-center gap-1 py-3 text-error/60 transition-colors active:text-error"
				>
					<MoreHorizontal size={20} />
					<span class="text-[10px] tracking-wide">More</span>
				</button>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<ul
					tabindex="0"
					class="menu dropdown-content z-50 mb-2 w-52 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg"
				>
					<li>
						<button onclick={onRefresh} disabled={refreshing}>
							<RefreshCw size={16} />
							{#if refreshing}
								{m.common_loading()}
							{:else}
								{m.library_seriesHeader_refreshTooltip()}
							{/if}
						</button>
					</li>
					{#if onImport}
						<li>
							<button onclick={onImport}>
								<Download size={16} />
								{m.action_import()}
							</button>
						</li>
					{/if}
					{#if onSubtitleAutoSearch}
						<li>
							<button onclick={onSubtitleAutoSearch} disabled={subtitleAutoSearching}>
								<Captions size={16} />
								{m.library_seriesHeader_autoDownloadSubs()}
							</button>
						</li>
					{/if}
					{#if onChangeMatch}
						<li>
							<button onclick={onChangeMatch}>
								<Replace size={16} />
								{m.library_changeMatch_menuLabel()}
							</button>
						</li>
					{/if}
					<li>
						<button class="text-error" onclick={onDelete}>
							<Trash2 size={16} />
							{m.action_delete()}
						</button>
					</li>
					<li>
						<button class="text-error" onclick={() => (showBlockConfirm = true)}>
							<Ban size={16} />
							{m.library_blockMediaTooltip()}
						</button>
					</li>
				</ul>
			</div>
		</div>
	</div>
{/if}

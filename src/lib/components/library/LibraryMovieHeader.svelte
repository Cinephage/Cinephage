<script lang="ts">
	import type { LibraryMovie } from '#lib/types/library.js';
	import type { MovieDetails, ReleaseDate } from '#lib/types/tmdb.js';
	import { getBestQualityFromFiles, displayTitle } from '#lib/types/library.js';
	import { pickBestMovieFile } from '#lib/shared/best-file.js';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import CrewList from '#lib/components/tmdb/CrewList.svelte';
	import WatchProviders from '#lib/components/tmdb/WatchProviders.svelte';
	import MonitorToggle from './MonitorToggle.svelte';
	import StatusIndicator from './StatusIndicator.svelte';
	import QualityBadge from './QualityBadge.svelte';
	import ScoreBadge from './ScoreBadge.svelte';
	import SubtitleRequirementBadge from './SubtitleRequirementBadge.svelte';
	import type { SubtitleRequirementProgress } from '#lib/utils/subtitle-status-display.js';
	import { getMovieAvailabilityLevel } from '#lib/utils/movieAvailability.js';
	import {
		Search,
		Download,
		Settings,
		Trash2,
		ExternalLink,
		Clock,
		Zap,
		Ban,
		Play,
		MoreHorizontal,
		ArrowLeft,
		Eye,
		EyeOff,
		Replace
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { formatBytes, formatLanguage, formatDisplayDateShort } from '#lib/utils/format.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { blockMedia } from '#lib/api/settings.js';
	import { SvelteMap } from 'svelte/reactivity';
	import { TMDB } from '#lib/config/constants.js';
	import { extractReleaseDates } from '#lib/utils/extractReleaseDates.js';
	import { getSmartReleaseLine } from '#lib/utils/smartReleaseLine.js';
	import { formatReleaseLine } from '#lib/utils/releaseLineText.js';

	const SOURCE_LABELS: Record<string, string> = {
		bluray: 'Bluray',
		webdl: 'WEB-DL',
		webrip: 'WEBRip',
		hdtv: 'HDTV',
		dvd: 'DVD',
		unknown: 'Unknown'
	};

	function formatSource(source: string): string {
		return SOURCE_LABELS[source.toLowerCase()] ?? source.charAt(0).toUpperCase() + source.slice(1);
	}

	const RELEASE_TYPE_LABELS: Record<number, () => string> = {
		1: () => m.hero_releaseType_premiere(),
		2: () => m.hero_releaseType_limitedTheatrical(),
		3: () => m.hero_releaseType_theatrical(),
		4: () => m.hero_releaseType_digital(),
		5: () => m.hero_releaseType_physical(),
		6: () => m.hero_releaseType_tv()
	};

	interface AutoSearchResult {
		found: boolean;
		grabbed: boolean;
		releaseName?: string;
		error?: string;
	}

	interface ScoreInfo {
		score: number;
		isAtCutoff: boolean;
		upgradesAllowed: boolean;
	}

	interface Props {
		movie: LibraryMovie;
		librarySlug?: string | null;
		libraryName?: string | null;
		backHref?: string | null;
		tmdbMovie?: MovieDetails | null;
		defaultRegion?: string;
		configuredProviders?: { anilist: boolean; mal: boolean };
		isDownloading?: boolean;
		autoSearching?: boolean;
		autoSearchResult?: AutoSearchResult | null;
		scoreInfo?: ScoreInfo | null;
		scoreLoading?: boolean;
		/** Requirement-aware subtitle progress from the movie loader (null when no effective profile). */
		subtitleProgress?: SubtitleRequirementProgress | null;
		/** Instance default for items with no explicit prefer-original flag. */
		preferOriginalTitleDefault?: boolean | null;
		onMonitorToggle?: (newValue: boolean) => void;
		onAutoSearch?: () => void;
		onSearch?: () => void;
		onImport?: () => void;
		onEdit?: () => void;
		onDelete?: () => void;
		onChangeMatch?: () => void;
		onScoreClick?: () => void;
		/** Viewer mode: hide acquisition/edit controls, keep the informational header. */
		readOnly?: boolean;
	}

	let {
		movie,
		librarySlug = null,
		libraryName = null,
		backHref = null,
		tmdbMovie = null,
		defaultRegion = TMDB.DEFAULT_REGION,
		configuredProviders = { anilist: false, mal: false },
		isDownloading = false,
		autoSearching = false,
		autoSearchResult: _autoSearchResult = null,
		scoreInfo = null,
		scoreLoading = false,
		subtitleProgress = null,
		preferOriginalTitleDefault = false,
		onMonitorToggle,
		onAutoSearch,
		onSearch,
		onImport,
		onEdit,
		onDelete,
		onChangeMatch,
		onScoreClick,
		readOnly = false
	}: Props = $props();

	let showBlockConfirm = $state(false);
	let overviewExpanded = $state(false);

	async function handleBlock() {
		try {
			await blockMedia({
				tmdbId: movie.tmdbId,
				mediaType: 'movie',
				title: movie.title,
				posterPath: movie.posterPath ?? null,
				year: movie.year ?? null
			});
			toasts.success(m.blockedMedia_blocked({ title: movie.title }));
			window.location.href = '/settings/blocklist/blocked-media';
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'Failed to block media');
		}
	}

	function openTrailer() {
		const trailer = tmdbMovie?.videos?.results?.find(
			(v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')
		);
		if (trailer) {
			window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank');
		}
	}

	const providerLinks = $derived.by(() => {
		const refs = movie.providerRefs ?? {};
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
	const bestQuality = $derived(getBestQualityFromFiles(movie.files));
	const bestFile = $derived(pickBestMovieFile(movie.files));
	const isStreamerProfile = $derived(movie.scoringProfileId === 'streamer');
	const fileStatus = $derived.by(() => {
		if (movie.hasFile) return 'downloaded';
		if (isDownloading) return 'downloading';
		return 'missing';
	});
	const totalSize = $derived(movie.files.reduce((sum, f) => sum + (f.size || 0), 0));
	const movieAvailability = $derived(
		getMovieAvailabilityLevel({
			year: movie.year,
			added: movie.added,
			tmdbStatus: movie.tmdbStatus,
			releaseDate: movie.releaseDate,
			digitalReleaseDate: movie.digitalReleaseDate,
			physicalReleaseDate: movie.physicalReleaseDate
		})
	);
	const showUnreleasedBadge = $derived(
		!movie.hasFile && Boolean(movie.monitored) && movieAvailability !== 'released'
	);
	const unreleasedLabel = $derived.by(() => {
		if (movieAvailability === 'announced') return m.common_unreleased();
		if (movieAvailability === 'inCinemas') return m.common_inTheaters();
		return m.common_unreleased();
	});
	const unreleasedBadgeStyle = $derived(
		movieAvailability === 'inCinemas'
			? 'bg-info/5 text-info/80 ring-info/25'
			: 'bg-error/5 text-error/80 ring-error/25'
	);
	const statusQualityText = $derived.by(() => {
		if (isStreamerProfile && movie.hasFile) return 'Auto';
		if (!bestQuality.quality) return null;
		return `${bestQuality.quality}${bestQuality.hdr ? ` ${bestQuality.hdr}` : ''}`;
	});

	const overview = $derived(tmdbMovie?.overview ?? movie.overview);
	const hasTrailer = $derived(
		tmdbMovie?.videos?.results?.some(
			(v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')
		) ?? false
	);

	const releaseInfo = $derived.by(() => {
		if (!tmdbMovie?.release_dates?.results) return null;

		const countryReleases =
			tmdbMovie.release_dates.results.find((r) => r.iso_3166_1 === defaultRegion) ||
			tmdbMovie.release_dates.results.find((r) => r.iso_3166_1 === 'US');

		if (!countryReleases?.release_dates?.length) return null;

		const certification =
			countryReleases.release_dates.find((r) => r.certification)?.certification || '';

		const releasesByType = new SvelteMap<number, ReleaseDate>();
		for (const release of countryReleases.release_dates) {
			if (!releasesByType.has(release.type)) {
				releasesByType.set(release.type, release);
			}
		}

		const now = new Date();
		function toEntry(typeNum: number) {
			const release = releasesByType.get(typeNum);
			if (!release) return null;
			return {
				label: RELEASE_TYPE_LABELS[typeNum]!(),
				date: formatDisplayDateShort(release.release_date),
				isPast: new Date(release.release_date) <= now
			};
		}

		return {
			certification,
			theatrical: toEntry(3),
			digital: toEntry(4),
			physical: toEntry(5)
		};
	});

	const smartRelease = $derived.by(() => {
		if (!tmdbMovie?.release_dates) return null;
		const dates = extractReleaseDates(tmdbMovie.release_dates, defaultRegion);
		return getSmartReleaseLine({
			releaseDate: dates.theatricalDate,
			digitalReleaseDate: dates.digitalReleaseDate,
			physicalReleaseDate: dates.physicalReleaseDate,
			status: tmdbMovie.status
		});
	});

	function formatRuntime(minutes: number | null): string {
		if (!minutes) return '';
		const hours = Math.floor(minutes / 60);
		const mins = minutes % 60;
		return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
	}
</script>

<div class="flex flex-col gap-4">
	<!-- Top action bar -->
	<div class="flex items-center justify-between gap-2">
		<a
			href={resolvePath(
				backHref ?? (librarySlug ? `/library/movies?library=${librarySlug}` : '/library/movies')
			)}
			class="btn gap-1.5 btn-ghost text-base-content/60 btn-sm"
		>
			<ArrowLeft size={16} />
			<span class="sm:inline"
				>{m.library_backTo({ name: libraryName ?? m.library_movies_heading() })}</span
			>
		</a>
		<div class="flex shrink-0 items-center gap-1 sm:gap-2">
			{#if !readOnly}
				<div class="hidden sm:block">
					<MonitorToggle
						monitored={movie.monitored ?? false}
						onToggle={onMonitorToggle}
						size="md"
					/>
				</div>
				<button
					class="btn hidden gap-1.5 btn-primary btn-sm sm:flex"
					onclick={onAutoSearch}
					disabled={autoSearching}
				>
					{#if autoSearching}
						<span class="loading loading-xs loading-spinner"></span>
					{:else}
						<Zap size={14} />
					{/if}
					{m.library_movieHeader_autoGrab()}
				</button>
				<button class="btn hidden gap-1.5 btn-ghost btn-sm sm:flex" onclick={onSearch}>
					<Search size={14} />
					{m.library_movieHeader_manual()}
				</button>
				{#if onImport}
					<button class="btn hidden gap-1.5 btn-ghost btn-sm sm:flex" onclick={onImport}>
						<Download size={14} />
						{m.action_import()}
					</button>
				{/if}
				<div class="dropdown dropdown-end hidden sm:block">
					<button tabindex="0" class="btn btn-ghost btn-sm">
						<MoreHorizontal size={18} />
					</button>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<ul
						tabindex="0"
						class="menu dropdown-content z-50 w-52 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg"
					>
						<li class="hidden sm:flex">
							<button onclick={onEdit}>
								<Settings size={16} />
								{m.action_edit()}
							</button>
						</li>
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
			{/if}
		</div>
	</div>

	{#snippet metaPanel()}
		{#if tmdbMovie}
			<div class="grid grid-cols-2 gap-x-4 gap-y-3">
				<div class="col-span-2">
					<div class="text-xs text-base-content/50">{m.hero_metadata_status()}</div>
					{#if smartRelease}
						<div
							class="font-medium {smartRelease.variant === 'released'
								? 'text-success'
								: smartRelease.variant === 'theaters'
									? 'text-info'
									: smartRelease.variant === 'upcoming'
										? 'text-primary'
										: ''}"
						>
							{formatReleaseLine(smartRelease)}
						</div>
					{:else}
						<div class="font-medium">{tmdbMovie.status}</div>
					{/if}
				</div>

				{#if movie.added}
					<div>
						<div class="text-xs text-base-content/50">{m.common_added()}</div>
						<div class="font-medium">{formatDisplayDateShort(movie.added)}</div>
					</div>
				{/if}
				<div>
					<div class="text-xs text-base-content/50">{m.hero_metadata_language()}</div>
					<div class="font-medium">{formatLanguage(tmdbMovie.original_language)}</div>
				</div>

				{#if releaseInfo?.certification}
					<div>
						<div class="text-xs text-base-content/50">{m.hero_metadata_rated()}</div>
						<div class="font-medium">{releaseInfo.certification}</div>
					</div>
				{/if}
				{#if releaseInfo?.theatrical}
					<div>
						<div class="text-xs text-base-content/50">{m.hero_releaseType_theatrical()}</div>
						<div class="font-medium {releaseInfo.theatrical.isPast ? '' : 'text-primary'}">
							{releaseInfo.theatrical.date}
						</div>
					</div>
				{:else if tmdbMovie.release_date}
					<div>
						<div class="text-xs text-base-content/50">{m.hero_releaseType_theatrical()}</div>
						<div class="font-medium">{formatDisplayDateShort(tmdbMovie.release_date)}</div>
					</div>
				{/if}

				{#if releaseInfo?.digital}
					<div>
						<div class="text-xs text-base-content/50">{m.hero_releaseType_digital()}</div>
						<div class="font-medium {releaseInfo.digital.isPast ? '' : 'text-primary'}">
							{releaseInfo.digital.date}
						</div>
					</div>
				{/if}
				{#if releaseInfo?.physical}
					<div>
						<div class="text-xs text-base-content/50">{m.hero_releaseType_physical()}</div>
						<div class="font-medium {releaseInfo.physical.isPast ? '' : 'text-primary'}">
							{releaseInfo.physical.date}
						</div>
					</div>
				{/if}

				{#if tmdbMovie.belongs_to_collection}
					<div class="col-span-2">
						<div class="text-xs text-base-content/50">Collection</div>
						<div class="font-medium">{tmdbMovie.belongs_to_collection.name}</div>
					</div>
				{/if}

				{#if tmdbMovie.production_companies && tmdbMovie.production_companies.length > 0}
					<div class="col-span-2">
						<div class="text-xs text-base-content/50">{m.hero_metadata_studio()}</div>
						<div class="font-medium">{tmdbMovie.production_companies[0].name}</div>
					</div>
				{/if}

				{#if movie.hasFile && bestFile?.quality?.source}
					<div>
						<div class="text-xs text-base-content/50">Source</div>
						<div class="font-medium">{formatSource(bestFile.quality.source)}</div>
					</div>
				{/if}

				{#if movie.hasFile && totalSize > 0}
					<div>
						<div class="text-xs text-base-content/50">Size</div>
						<div class="font-medium">{formatBytes(totalSize)}</div>
					</div>
				{/if}
			</div>

			{#if tmdbMovie['watch/providers']}
				<div class="mt-4 border-t border-base-content/10 pt-4">
					<div class="mb-2 text-xs text-base-content/50">{m.hero_metadata_whereToWatch()}</div>
					<WatchProviders
						providers={tmdbMovie['watch/providers']}
						countryCode={defaultRegion}
						limit={6}
					/>
				</div>
			{/if}
		{/if}
	{/snippet}

	<!-- Hero card -->
	<div class="relative w-full overflow-hidden rounded-xl bg-base-200 shadow-xl">
		<!-- Backdrop -->
		<div class="absolute inset-0 h-full w-full">
			{#if movie.backdropPath}
				<TmdbImage
					path={movie.backdropPath}
					size="original"
					alt={movie.title}
					class="h-full w-full object-cover opacity-40"
				/>
			{/if}
			<div
				class="absolute inset-0 bg-linear-to-t from-base-200 via-base-200/60 to-transparent"
			></div>
			<div
				class="absolute inset-0 bg-linear-to-r from-base-200 via-base-200/60 to-transparent"
			></div>
		</div>

		<!-- Content -->
		<div class="relative z-10">
			<div class="flex flex-col gap-6 p-6 md:flex-row md:p-8">
				<!-- Poster -->
				<div class="hidden shrink-0 flex-col gap-2 sm:flex">
					<div class="w-48 overflow-hidden rounded-lg shadow-lg md:w-56">
						<TmdbImage
							path={movie.posterPath}
							size="w342"
							alt={movie.title}
							class="h-auto w-full object-cover"
						/>
					</div>
					{#if !readOnly}
						<button
							class="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors
								{movie.monitored
								? 'bg-success/10 text-success hover:bg-success/20'
								: 'bg-base-content/5 text-base-content/40 hover:bg-base-content/10'}"
							onclick={() => onMonitorToggle?.(!movie.monitored)}
						>
							{#if movie.monitored}
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
							{displayTitle(movie, preferOriginalTitleDefault)}
							{#if movie.year}
								<span class="font-normal text-base-content/60">({movie.year})</span>
							{/if}
						</h1>
						<div
							class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-base-content/70"
						>
							{#if tmdbMovie?.vote_average}
								<span class="flex items-center gap-1 font-semibold text-warning">
									★ {tmdbMovie.vote_average.toFixed(1)}
								</span>
							{/if}
							{#if movie.runtime}
								{#if tmdbMovie?.vote_average}<span class="hidden sm:inline">•</span>{/if}
								<span>{formatRuntime(movie.runtime)}</span>
							{/if}
							{#if movie.genres && movie.genres.length > 0}
								<span>•</span>
								<span>{movie.genres.slice(0, 3).join(', ')}</span>
							{/if}
						</div>
					</div>

					{#if tmdbMovie?.tagline}
						<p class="border-l-2 border-primary pl-3 text-base text-base-content/50 italic">
							{tmdbMovie.tagline}
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

					{#if tmdbMovie?.credits?.crew?.length}
						<div class="text-sm">
							<CrewList crew={tmdbMovie.credits.crew} />
						</div>
					{/if}

					{#if tmdbMovie?.credits?.cast?.length}
						<div>
							<div class="mb-2 text-sm text-base-content/60">Cast</div>
							<div class="flex gap-3 overflow-x-auto pb-1">
								{#each tmdbMovie.credits.cast.slice(0, 8) as actor (actor.id)}
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

					<!-- Status badges and external links -->
					<div
						class="flex flex-col gap-2 border-t border-base-content/10 pt-3 sm:flex-row sm:items-center sm:justify-between"
					>
						<div class="flex flex-wrap items-center gap-2">
							<StatusIndicator status={fileStatus} qualityText={statusQualityText} />
							{#if showUnreleasedBadge}
								<div
									class="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ring-1 {unreleasedBadgeStyle}"
								>
									<Clock size={16} />
									<span class="font-medium">{unreleasedLabel}</span>
								</div>
							{/if}
							{#if movie.hasFile && bestFile}
								{#if isStreamerProfile}
									<span class="badge badge-sm badge-secondary">{m.status_streaming()}</span>
								{:else}
									<QualityBadge
										quality={bestFile.quality}
										mediaInfo={bestFile.mediaInfo}
										size="md"
									/>
								{/if}
								{#if !isStreamerProfile}
									<ScoreBadge
										score={scoreInfo?.score ?? null}
										isAtCutoff={scoreInfo?.isAtCutoff ?? false}
										upgradesAllowed={scoreInfo?.upgradesAllowed ?? true}
										loading={scoreLoading}
										size="md"
										onclick={onScoreClick}
									/>
								{/if}
							{/if}
							{#if subtitleProgress}
								<SubtitleRequirementBadge progress={subtitleProgress} size="md" showCutoff={true} />
							{/if}
						</div>
						<div
							class="flex w-full items-center gap-1 overflow-x-auto border-t border-base-content/10 pt-2 pb-0.5 sm:w-auto sm:shrink-0 sm:overflow-x-visible sm:border-0 sm:pt-0 sm:pb-0"
						>
							{#if movie.tmdbId}
								<a
									href="https://www.themoviedb.org/movie/{movie.tmdbId}"
									target="_blank"
									rel="noopener noreferrer"
									class="btn shrink-0 gap-1 btn-ghost btn-xs"
								>
									{m.library_movieHeader_tmdbLink()}<ExternalLink size={12} />
								</a>
							{/if}
							{#if movie.imdbId}
								<a
									href="https://www.imdb.com/title/{movie.imdbId}"
									target="_blank"
									rel="noopener noreferrer"
									class="btn shrink-0 gap-1 btn-ghost btn-xs"
								>
									{m.library_movieHeader_imdbLink()}<ExternalLink size={12} />
								</a>
							{/if}
							{#each providerLinks as providerLink (providerLink.label)}
								<a
									href={providerLink.href}
									target="_blank"
									rel="noopener noreferrer"
									class="btn shrink-0 gap-1 btn-ghost btn-xs"
								>
									{providerLink.label}<ExternalLink size={12} />
								</a>
							{/each}
							{#if hasTrailer}
								<button class="btn shrink-0 gap-1 btn-ghost btn-xs" onclick={openTrailer}>
									<Play size={12} />{m.hero_trailer()}
								</button>
							{/if}
						</div>
					</div>
				</div>

				<!-- Right side metadata panel (desktop) -->
				{#if tmdbMovie}
					<div
						class="hidden w-56 shrink-0 rounded-lg bg-base-100/30 p-4 backdrop-blur-sm md:block lg:w-64 lg:p-5"
					>
						{@render metaPanel()}
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
	message={m.blockedMedia_confirmBlockMessage({ title: movie.title })}
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
				{movie.monitored ? 'text-success' : 'text-base-content/55'}"
				onclick={() => onMonitorToggle?.(!movie.monitored)}
			>
				{#if movie.monitored}
					<Eye size={20} />
				{:else}
					<EyeOff size={20} />
				{/if}
				<span class="text-[10px] tracking-wide">{movie.monitored ? 'Monitored' : 'Off'}</span>
			</button>

			<!-- Auto-grab -->
			<button
				class="flex flex-1 flex-col items-center gap-1 py-3 transition-colors
				{autoSearching ? 'text-primary/40' : 'text-primary'}"
				onclick={onAutoSearch}
				disabled={autoSearching}
			>
				{#if autoSearching}
					<span class="loading loading-xs loading-spinner"></span>
				{:else}
					<Zap size={20} />
				{/if}
				<span class="text-[10px] tracking-wide">{m.library_movieHeader_autoGrab()}</span>
			</button>

			<!-- Manual -->
			<button
				class="flex flex-1 flex-col items-center gap-1 py-3 text-base-content/55 transition-colors active:text-base-content/90"
				onclick={onSearch}
			>
				<Search size={20} />
				<span class="text-[10px] tracking-wide">{m.library_movieHeader_manual()}</span>
			</button>

			{#if onImport}
				<!-- Import -->
				<button
					class="flex flex-1 flex-col items-center gap-1 py-3 text-base-content/55 transition-colors active:text-base-content/90"
					onclick={onImport}
				>
					<Download size={20} />
					<span class="text-[10px] tracking-wide">{m.action_import()}</span>
				</button>
			{/if}

			<!-- Edit -->
			<button
				class="flex flex-1 flex-col items-center gap-1 py-3 text-base-content/55 transition-colors active:text-base-content/90"
				onclick={onEdit}
			>
				<Settings size={20} />
				<span class="text-[10px] tracking-wide">{m.action_edit()}</span>
			</button>

			<!-- Overflow -->
			<div class="dropdown dropdown-end dropdown-top flex flex-1">
				<button
					tabindex="0"
					class="flex flex-1 flex-col items-center gap-1 py-3 text-error/80 transition-colors active:text-error"
				>
					<MoreHorizontal size={20} />
					<span class="text-[10px] tracking-wide">More</span>
				</button>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<ul
					tabindex="0"
					class="menu dropdown-content z-50 mb-2 w-52 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg"
				>
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

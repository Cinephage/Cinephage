<script lang="ts">
	import type { MovieDetails, TVShowDetails, ReleaseDate } from '#lib/types/tmdb.js';
	import TmdbImage from './TmdbImage.svelte';
	import CrewList from './CrewList.svelte';
	import WatchProviders from './WatchProviders.svelte';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import AddToLibraryModal from '#lib/components/library/AddToLibraryModal.svelte';
	import RequestButton from '#lib/components/requests/RequestButton.svelte';
	import RequestStatusBadge from '#lib/components/requests/RequestStatusBadge.svelte';
	import { approveRequest, declineRequest } from '#lib/api/requests.js';
	import { refreshAll } from '$app/navigation';
	import {
		Plus,
		CircleCheckBig,
		Play,
		Film,
		ExternalLink,
		Ban,
		X,
		ChevronLeft,
		ChevronRight,
		Maximize2,
		EyeOff,
		CircleX
	} from '@lucide/svelte';
	import { fade } from 'svelte/transition';
	import type { Video } from '#lib/types/tmdb.js';
	import { formatCurrency, formatLanguage, formatDisplayDateShort } from '#lib/utils/format.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import { SvelteMap } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { TMDB } from '#lib/config/constants.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { getLibraryStatus } from '#lib/api/library.js';
	import { blockMedia } from '#lib/api/settings.js';
	import * as m from '#lib/paraglide/messages.js';
	import { extractReleaseDates } from '#lib/utils/extractReleaseDates.js';
	import { getSmartReleaseLine } from '#lib/utils/smartReleaseLine.js';
	import { formatReleaseLine } from '#lib/utils/releaseLineText.js';
	import { releaseTypeLabel } from '#lib/utils/releaseTypeLabel.js';

	// Extended type that includes library status (added by enrichWithLibraryStatus)
	type MediaDetailsWithLibraryStatus = (MovieDetails | TVShowDetails) & {
		inLibrary?: boolean;
		hasFile?: boolean;
		monitored?: boolean;
		libraryId?: string;
	};

	interface HeroRequestState {
		requested: 'none' | 'pending' | 'approved' | 'fulfilled';
		requestId: string | null;
		ownRequestId: string | null;
	}

	let {
		item,
		readOnly = false,
		requestState = null
	}: {
		item: MediaDetailsWithLibraryStatus;
		readOnly?: boolean;
		/** Server-annotated request state for this title (detail loaders). */
		requestState?: HeroRequestState | null;
	} = $props();

	let adminDeclining = $state(false);
	let adminReason = $state('');
	let adminActing = $state(false);

	async function adminApprove() {
		if (!requestState?.requestId || adminActing) return;
		adminActing = true;
		try {
			await approveRequest(requestState.requestId);
			toasts.success(m.requests_approved());
			await refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : m.requests_errorGeneric());
		} finally {
			adminActing = false;
		}
	}

	async function adminDecline() {
		if (!requestState?.requestId || adminActing) return;
		const reason = adminReason.trim();
		if (!reason) return;
		adminActing = true;
		try {
			await declineRequest(requestState.requestId, reason);
			toasts.info(m.requests_declined());
			adminDeclining = false;
			adminReason = '';
			await refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : m.requests_errorGeneric());
		} finally {
			adminActing = false;
		}
	}

	// Library status state (defaults only, effect syncs from props)
	let inLibrary = $state(false);
	let hasFile = $state(false);
	let monitored = $state(true);
	let libraryId = $state<string | undefined>(undefined);
	let showAddModal = $state(false);
	let showBlockConfirm = $state(false);
	let activeVideo = $state<Video | null>(null);
	let activeBackdrop = $state<string | null>(null);
	let overviewExpanded = $state(false);

	const overviewNeedsExpansion = $derived((item.overview?.length ?? 0) > 250);

	$effect(() => {
		if (item.id) overviewExpanded = false;
	});

	// Update state when item changes
	$effect(() => {
		inLibrary = item.inLibrary ?? false;
		hasFile = item.hasFile ?? false;
		monitored = item.monitored ?? true;
		libraryId = item.libraryId;
	});

	const countryCode = $derived(page.data.defaultRegion || TMDB.DEFAULT_REGION);

	function isMovieDetails(item: MediaDetailsWithLibraryStatus): item is MovieDetails & {
		inLibrary?: boolean;
		hasFile?: boolean;
		monitored?: boolean;
		libraryId?: string;
	} {
		return 'title' in item;
	}

	function getTitle(item: MediaDetailsWithLibraryStatus): string {
		return isMovieDetails(item) ? item.title : item.name;
	}

	function getDate(item: MediaDetailsWithLibraryStatus): string {
		return isMovieDetails(item) ? item.release_date : item.first_air_date;
	}

	function getRuntime(item: MediaDetailsWithLibraryStatus): string {
		if (isMovieDetails(item) && item.runtime) {
			const hours = Math.floor(item.runtime / 60);
			const minutes = item.runtime % 60;
			return `${hours}h ${minutes}m`;
		}
		if (!isMovieDetails(item) && item.episode_run_time && item.episode_run_time.length > 0) {
			return `${item.episode_run_time[0]}m`;
		}
		return '';
	}

	function getYear(dateString: string): number | string {
		if (!dateString) return '';
		return new Date(dateString).getFullYear();
	}

	const mediaType = $derived(isMovieDetails(item) ? 'movie' : 'tv');
	const title = $derived(getTitle(item));
	const date = $derived(getDate(item));
	const year = $derived(date ? new Date(date).getFullYear() : undefined);
	const libraryPageLink = $derived(
		libraryId
			? mediaType === 'movie'
				? `/library/movie/${libraryId}`
				: `/library/tv/${libraryId}`
			: null
	);

	async function handleBlock() {
		try {
			await blockMedia({
				tmdbId: item.id,
				mediaType,
				title,
				posterPath: item.poster_path ?? null,
				year: year ?? null
			});
			toasts.success(m.blockedMedia_blocked({ title }));
			window.location.href = '/settings/blocklist/blocked-media';
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'Failed to block media');
		}
	}

	// Get release info for movies (certification and release types)
	const releaseInfo = $derived.by(() => {
		if (!isMovieDetails(item) || !item.release_dates?.results) return null;

		const countryReleases =
			item.release_dates.results.find((r) => r.iso_3166_1 === countryCode) ||
			item.release_dates.results.find((r) => r.iso_3166_1 === 'US');

		if (!countryReleases?.release_dates?.length) return null;

		// Get certification from first release with one
		const certification =
			countryReleases.release_dates.find((r) => r.certification)?.certification || '';

		// Group releases by type, sorted by date
		const releasesByType = new SvelteMap<number, ReleaseDate>();
		for (const release of countryReleases.release_dates) {
			if (!releasesByType.has(release.type)) {
				releasesByType.set(release.type, release);
			}
		}

		// Priority order: Theatrical (3), Digital (4), Physical (5), Limited (2), TV (6), Premiere (1)
		const priorityOrder = [3, 4, 5, 2, 6, 1];
		const releases: Array<{ type: string; date: string; isPast: boolean }> = [];
		const now = new Date();

		for (const typeNum of priorityOrder) {
			const release = releasesByType.get(typeNum);
			if (release) {
				const releaseDate = new Date(release.release_date);
				releases.push({
					type: releaseTypeLabel(typeNum),
					date: formatDisplayDateShort(release.release_date),
					isPast: releaseDate <= now
				});
			}
		}

		return { certification, releases };
	});

	const smartRelease = $derived.by(() => {
		if (!isMovieDetails(item) || !item.release_dates) return null;
		const dates = extractReleaseDates(item.release_dates, countryCode);
		return getSmartReleaseLine({
			releaseDate: dates.theatricalDate,
			digitalReleaseDate: dates.digitalReleaseDate,
			physicalReleaseDate: dates.physicalReleaseDate,
			tvReleaseDate: dates.tvReleaseDate,
			status: item.status
		});
	});

	// Get content rating for TV shows
	const tvRating = $derived.by(() => {
		if (isMovieDetails(item) || !item.content_ratings?.results) return '';

		const rating =
			item.content_ratings.results.find((r) => r.iso_3166_1 === countryCode) ||
			item.content_ratings.results.find((r) => r.iso_3166_1 === 'US');

		return rating?.rating || '';
	});

	async function refreshLibraryStatus() {
		try {
			const data = (await getLibraryStatus({ tmdbId: item.id, mediaType })) as {
				success: boolean;
				status?: { inLibrary: boolean; hasFile: boolean; monitored?: boolean; libraryId: string };
			};
			if (data.success && data.status) {
				inLibrary = data.status.inLibrary;
				hasFile = data.status.hasFile;
				monitored = data.status.monitored ?? true;
				libraryId = data.status.libraryId;
			}
		} catch (e) {
			toasts.error(m.hero_failedToCheckLibraryStatus(), {
				description: e instanceof Error ? e.message : m.hero_failedToCheckLibraryStatus()
			});
		}
	}

	function handleAddSuccess() {
		// Refresh library status after adding
		refreshLibraryStatus();
	}

	const TYPE_ORDER = ['Trailer', 'Teaser', 'Clip'];
	const youtubeVideos = $derived(
		[...(item.videos?.results ?? [])]
			.filter((v) => v.site === 'YouTube' && TYPE_ORDER.includes(v.type))
			.sort((a, b) => {
				const aOrder = TYPE_ORDER.indexOf(a.type);
				const bOrder = TYPE_ORDER.indexOf(b.type);
				if (aOrder !== bOrder) return aOrder - bOrder;
				return Number(b.official) - Number(a.official);
			})
			.slice(0, 8)
	);

	const backdropImages = $derived(
		[...(item.images?.backdrops ?? [])]
			.filter((b) => b.iso_639_1 === null)
			.sort((a, b) => b.vote_average - a.vote_average)
			.slice(0, 8)
	);

	const youtubeSearchFallbackUrl = $derived(
		`https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' trailer')}`
	);

	const mediaItems = $derived.by(() => {
		const videos = youtubeVideos.map((v) => ({ type: 'video' as const, data: v }));
		const supplementCount =
			videos.length > 0 && videos.length < 3
				? Math.min(6 - videos.length, backdropImages.length)
				: 0;
		const backdrops = backdropImages
			.slice(0, supplementCount)
			.map((b) => ({ type: 'backdrop' as const, data: b }));
		return [...videos, ...backdrops];
	});

	let carouselContainer = $state<HTMLElement | null>(null);
	let showLeftArrow = $state(false);
	let showRightArrow = $state(false);

	function handleCarouselScroll() {
		if (!carouselContainer) return;
		showLeftArrow = carouselContainer.scrollLeft > 10;
		showRightArrow =
			carouselContainer.scrollLeft <
			carouselContainer.scrollWidth - carouselContainer.clientWidth - 10;
	}

	function scrollCarousel(direction: 'left' | 'right') {
		if (!carouselContainer) return;
		carouselContainer.scrollBy({
			left:
				direction === 'left'
					? -carouselContainer.clientWidth * 0.75
					: carouselContainer.clientWidth * 0.75,
			behavior: 'smooth'
		});
	}

	$effect(() => {
		if (carouselContainer) handleCarouselScroll();
	});
</script>

<div class="relative w-full overflow-hidden rounded-xl bg-base-200 shadow-xl">
	<!-- Backdrop -->
	<div class="absolute inset-0 h-full w-full">
		{#if item.backdrop_path}
			<TmdbImage
				path={item.backdrop_path}
				size="original"
				alt={title}
				class="h-full w-full object-cover opacity-40"
			/>
		{/if}
		<div class="absolute inset-0 bg-linear-to-t from-base-200 via-base-200/80 to-transparent"></div>
		<div class="absolute inset-0 bg-linear-to-r from-base-200 via-base-200/60 to-transparent"></div>
	</div>

	<!-- Content -->
	<div class="relative z-10 flex flex-col gap-6 p-6 md:flex-row md:p-8">
		<!-- Poster -->
		<div class="hidden shrink-0 sm:block">
			<div class="w-48 overflow-hidden rounded-lg shadow-lg md:w-56">
				<TmdbImage
					path={item.poster_path}
					size="w342"
					alt={title}
					class="h-auto w-full object-cover"
				/>
			</div>
		</div>

		<!-- Main Info -->
		<div class="flex min-w-0 flex-1 flex-col gap-4">
			<!-- Title and basic info -->
			<div>
				<h1 class="text-2xl font-bold md:text-3xl">
					{title}
					{#if getYear(date)}
						<span class="font-normal text-base-content/60">({getYear(date)})</span>
					{/if}
				</h1>

				<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-base-content/70">
					{#if item.vote_average}
						<span class="flex items-center gap-1 font-semibold text-warning">
							★ {item.vote_average.toFixed(1)}
						</span>
					{/if}
					{#if getRuntime(item)}
						<span>{getRuntime(item)}</span>
					{/if}
					{#if item.genres && item.genres.length > 0}
						<span>•</span>
						<span
							>{item.genres
								.slice(0, 3)
								.map((g) => g.name)
								.join(', ')}</span
						>
					{/if}
				</div>

				<!-- Mobile-only release status -->
				{#if smartRelease}
					<div
						class="mt-1 text-sm font-medium md:hidden {smartRelease.variant === 'released'
							? 'text-success'
							: smartRelease.variant === 'theaters'
								? 'text-info'
								: smartRelease.variant === 'upcoming'
									? 'text-primary'
									: 'text-base-content/60'}"
					>
						{formatReleaseLine(smartRelease)}
					</div>
				{:else if item.status}
					<div class="mt-1 text-sm text-base-content/60 md:hidden">{item.status}</div>
				{/if}
			</div>

			{#if item.tagline}
				<p class="border-l-2 border-primary pl-3 text-base text-base-content/50 italic">
					{item.tagline}
				</p>
			{/if}

			<!-- Overview -->
			{#if item.overview}
				<div>
					<p
						class="text-base leading-relaxed text-base-content/90 {!overviewExpanded &&
						overviewNeedsExpansion
							? 'line-clamp-4 sm:line-clamp-none'
							: ''}"
					>
						{item.overview}
					</p>
					{#if overviewNeedsExpansion}
						<button
							class="mt-1 text-sm text-primary sm:hidden"
							onclick={() => (overviewExpanded = !overviewExpanded)}
						>
							{overviewExpanded ? 'Read less' : 'Read more'}
						</button>
					{/if}
				</div>
			{/if}

			<!-- Crew -->
			{#if item.credits?.crew?.length > 0 || (!isMovieDetails(item) && item.created_by?.length > 0)}
				<div class="text-sm">
					<CrewList
						crew={item.credits?.crew ?? []}
						creators={!isMovieDetails(item) ? item.created_by : []}
					/>
				</div>
			{/if}

			<!-- Video clips row / backdrop gallery -->
			{#if mediaItems.length > 0}
				<div class="group/carousel relative">
					{#if showLeftArrow}
						<button
							transition:fade={{ duration: 150 }}
							onclick={() => scrollCarousel('left')}
							class="absolute top-1/2 -left-2 z-10 -translate-y-1/2 rounded-full bg-base-100/80 p-1 shadow backdrop-blur-sm hover:bg-base-100"
						>
							<ChevronLeft size={18} />
						</button>
					{/if}
					{#if showRightArrow}
						<button
							transition:fade={{ duration: 150 }}
							onclick={() => scrollCarousel('right')}
							class="absolute top-1/2 -right-2 z-10 -translate-y-1/2 rounded-full bg-base-100/80 p-1 shadow backdrop-blur-sm hover:bg-base-100"
						>
							<ChevronRight size={18} />
						</button>
					{/if}
					<div
						bind:this={carouselContainer}
						onscroll={handleCarouselScroll}
						class="flex scrollbar-none gap-3 overflow-x-auto pb-1"
					>
						{#each mediaItems as item (item.type === 'video' ? item.data.key : item.data.file_path)}
							{#if item.type === 'video'}
								<button
									class="group w-36 shrink-0 text-left"
									onclick={() => (activeVideo = item.data)}
								>
									<div class="relative aspect-video overflow-hidden rounded-lg bg-base-300">
										<img
											src="https://img.youtube.com/vi/{item.data.key}/mqdefault.jpg"
											alt={item.data.name}
											class="h-full w-full object-cover transition-opacity group-hover:opacity-75"
										/>
										<div class="absolute inset-0 flex items-center justify-center">
											<div
												class="rounded-full bg-black/50 p-2 transition-transform group-hover:scale-110"
											>
												<Play size={14} class="text-white" />
											</div>
										</div>
									</div>
									<div class="mt-1 truncate text-xs text-base-content/70">{item.data.name}</div>
									<div class="text-xs text-base-content/40">{item.data.type}</div>
								</button>
							{:else}
								<button
									class="group w-36 shrink-0 text-left"
									onclick={() => (activeBackdrop = item.data.file_path)}
								>
									<div class="relative aspect-video overflow-hidden rounded-lg bg-base-300">
										<TmdbImage
											path={item.data.file_path}
											size="w300"
											alt="Backdrop"
											class="h-full w-full object-cover transition-opacity group-hover:opacity-75"
										/>
										<div
											class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
										>
											<div class="rounded-full bg-black/50 p-2">
												<Maximize2 size={14} class="text-white" />
											</div>
										</div>
									</div>
								</button>
							{/if}
						{/each}
					</div>
				</div>
			{:else if backdropImages.length > 0}
				<div class="group/carousel relative">
					<div class="flex scrollbar-none gap-3 overflow-x-auto pb-1">
						{#each backdropImages as backdrop (backdrop.file_path)}
							<button
								class="group w-36 shrink-0 text-left"
								onclick={() => (activeBackdrop = backdrop.file_path)}
							>
								<div class="relative aspect-video overflow-hidden rounded-lg bg-base-300">
									<TmdbImage
										path={backdrop.file_path}
										size="w300"
										alt="Backdrop"
										class="h-full w-full object-cover transition-opacity group-hover:opacity-75"
									/>
									<div
										class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
									>
										<div class="rounded-full bg-black/50 p-2">
											<Maximize2 size={14} class="text-white" />
										</div>
									</div>
								</div>
							</button>
						{/each}
						<!-- YouTube search card -->
						<!-- eslint-disable svelte/no-navigation-without-resolve -- External YouTube URL -->
						<a
							href={youtubeSearchFallbackUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="group w-36 shrink-0"
						>
							<div
								class="flex aspect-video flex-col items-center justify-center gap-1.5 rounded-lg border border-base-content/10 bg-base-300 p-2 transition-colors group-hover:border-base-content/20 group-hover:bg-base-200"
							>
								<Play
									size={18}
									class="text-base-content/40 transition-colors group-hover:text-base-content/70"
								/>
								<span
									class="text-center text-xs leading-tight text-base-content/40 transition-colors group-hover:text-base-content/70"
									>{m.hero_trailer()}</span
								>
								<ExternalLink size={10} class="text-base-content/30" />
							</div>
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</div>
				</div>
			{/if}

			{#if mediaItems.length > 0 || backdropImages.length > 0}
				<hr class="border-base-content/10" />
			{/if}

			<!-- Mobile-only: Where to Watch -->
			{#if item['watch/providers']}
				<div class="border-b border-base-content/10 pb-3 md:hidden">
					<div class="mb-1.5 text-xs text-base-content/50">{m.hero_metadata_whereToWatch()}</div>
					<WatchProviders providers={item['watch/providers']} {countryCode} />
				</div>
			{/if}

			<!-- Actions row -->
			<div class="mt-auto flex flex-wrap items-center justify-between gap-4">
				<div class="flex flex-wrap items-center gap-2">
					{#if inLibrary}
						{#if hasFile}
							<div
								class="flex items-center gap-2 rounded-lg bg-success/20 px-3 py-1.5 text-sm text-success"
							>
								<CircleCheckBig class="h-4 w-4" />
								<span>{m.hero_available()}</span>
							</div>
							{#if libraryPageLink}
								<a
									href={resolvePath(libraryPageLink)}
									class="btn gap-1 btn-outline btn-primary btn-sm"
								>
									<Film class="h-4 w-4" />
									{m.hero_viewInLibrary()}
								</a>
							{/if}
						{:else if monitored}
							<div
								class="flex items-center gap-2 rounded-lg bg-error/20 px-3 py-1.5 text-sm text-error"
							>
								<CircleX class="h-4 w-4" />
								<span>{m.common_missing()}</span>
							</div>
							{#if libraryPageLink}
								<a
									href={resolvePath(libraryPageLink)}
									class="btn gap-1 btn-outline btn-primary btn-sm"
								>
									<Film class="h-4 w-4" />
									{m.hero_viewInLibrary()}
								</a>
							{/if}
						{:else}
							<div
								class="flex items-center gap-2 rounded-lg bg-base-content/10 px-3 py-1.5 text-sm text-base-content/50"
							>
								<EyeOff class="h-4 w-4" />
								<span>{m.common_unmonitored()}</span>
							</div>
							{#if libraryPageLink}
								<a
									href={resolvePath(libraryPageLink)}
									class="btn gap-1 btn-outline btn-primary btn-sm"
								>
									<Film class="h-4 w-4" />
									{m.hero_viewInLibrary()}
								</a>
							{/if}
						{/if}
					{:else if !readOnly}
						<button class="btn gap-1 btn-primary btn-sm" onclick={() => (showAddModal = true)}>
							<Plus class="h-4 w-4" />
							{m.hero_addToLibrary()}
						</button>
					{:else if !inLibrary}
						<!-- Viewers request; admins add. The request server decides
						     in-library/availability cases with explicit errors. -->
						<RequestButton
							{mediaType}
							tmdbId={item.id}
							title={getTitle(item)}
							year={parseInt(getDate(item)?.slice(0, 4)) || null}
							posterPath={item.poster_path ?? null}
						/>
					{/if}

					{#if youtubeVideos.length === 0 && backdropImages.length === 0}
						<!-- eslint-disable svelte/no-navigation-without-resolve -- External YouTube URL -->
						<a
							href={youtubeSearchFallbackUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="btn gap-1 btn-ghost btn-sm"
						>
							<Play class="h-4 w-4" />
							{m.hero_trailer()}
							<ExternalLink size={12} />
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/if}
				</div>

				<!-- Admin request actions: an open request for this title can be
				     approved or declined right from the detail page. -->
				{#if !readOnly && requestState?.requestId && requestState?.requested === 'pending'}
					<div
						class="mt-3 w-full rounded-xl border border-base-content/10 bg-base-content/[0.03] px-3.5 py-2.5 text-sm"
					>
						<div class="flex flex-wrap items-center gap-2">
							<RequestStatusBadge status="pending" size="xs" />
							<span class="text-base-content/70">{m.requests_adminPendingHint()}</span>
							<div class="ml-auto flex items-center gap-2">
								<button
									type="button"
									class="btn btn-primary btn-xs"
									disabled={adminActing}
									onclick={adminApprove}
								>
									{m.requests_approve()}
								</button>
								<button
									type="button"
									class="btn btn-ghost text-error btn-xs"
									disabled={adminActing}
									onclick={() => (adminDeclining = !adminDeclining)}
								>
									{m.requests_decline()}
								</button>
							</div>
						</div>
						{#if adminDeclining}
							<div class="mt-2 flex flex-wrap items-center gap-2">
								<input
									type="text"
									class="input min-w-48 flex-1 input-sm"
									placeholder={m.requests_declineReasonHint()}
									bind:value={adminReason}
									maxlength={500}
								/>
								<button
									type="button"
									class="btn btn-error btn-xs"
									disabled={adminActing || adminReason.trim().length === 0}
									onclick={adminDecline}
								>
									{m.requests_declineTitle()}
								</button>
							</div>
						{/if}
					</div>
				{/if}

				<!-- External links -->
				<div
					class="flex w-full items-center gap-2 border-t border-base-content/10 pt-2 sm:w-auto sm:border-0 sm:pt-0"
				>
					<button
						class="btn gap-1 btn-ghost text-error btn-xs"
						onclick={() => (showBlockConfirm = true)}
						title={m.hero_blockMediaTooltip()}
					>
						<Ban size={12} />
						{m.hero_blockMedia()}
					</button>
					<a
						href={`https://www.themoviedb.org/${mediaType}/${item.id}`}
						target="_blank"
						rel="noopener noreferrer"
						class="btn gap-1 btn-ghost btn-xs"
					>
						TMDB
						<ExternalLink size={12} />
					</a>
					{#if isMovieDetails(item) && item.imdb_id}
						<a
							href={`https://www.imdb.com/title/${item.imdb_id}`}
							target="_blank"
							rel="noopener noreferrer"
							class="btn gap-1 btn-ghost btn-xs"
						>
							IMDb
							<ExternalLink size={12} />
						</a>
					{/if}
					{#if item.homepage}
						<!-- eslint-disable svelte/no-navigation-without-resolve -- External URL -->
						<a
							href={item.homepage}
							target="_blank"
							rel="noopener noreferrer"
							class="btn gap-1 btn-ghost btn-xs"
						>
							{m.hero_website()}
							<ExternalLink size={12} />
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/if}
				</div>
			</div>
		</div>

		<!-- Right side metadata -->
		<div
			class="hidden w-64 shrink-0 rounded-lg bg-base-100/30 p-4 backdrop-blur-sm md:block lg:w-80 lg:p-5"
		>
			<div class="grid grid-cols-2 gap-x-4 gap-y-2 lg:gap-x-6 lg:gap-y-3">
				{#if smartRelease}
					<div class="col-span-2">
						<div class="text-sm text-base-content/50">{m.hero_metadata_status()}</div>
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
					</div>
				{:else}
					<div>
						<div class="text-sm text-base-content/50">{m.hero_metadata_status()}</div>
						<div class="font-medium">{item.status}</div>
					</div>
				{/if}

				<div>
					<div class="text-sm text-base-content/50">{m.hero_metadata_language()}</div>
					<div class="font-medium">{formatLanguage(item.original_language)}</div>
				</div>

				{#if isMovieDetails(item)}
					{@const movie = item as MovieDetails}

					{#if releaseInfo?.certification}
						<div>
							<div class="text-sm text-base-content/50">{m.hero_metadata_rated()}</div>
							<div>
								<span class="badge badge-outline badge-sm">{releaseInfo.certification}</span>
							</div>
						</div>
					{/if}

					{#if releaseInfo?.releases && releaseInfo.releases.length > 0}
						{#each releaseInfo.releases as release (release.type)}
							<div>
								<div class="text-sm text-base-content/50">{release.type}</div>
								<div class="font-medium {release.isPast ? '' : 'text-primary'}">
									{release.date}
								</div>
							</div>
						{/each}
					{:else}
						<div>
							<div class="text-sm text-base-content/50">
								{m.hero_releaseType_theatrical()}
							</div>
							<div class="font-medium">{formatDisplayDateShort(movie.release_date)}</div>
						</div>
					{/if}

					{#if movie.budget > 0}
						<div>
							<div class="text-sm text-base-content/50">{m.hero_metadata_budget()}</div>
							<div class="font-medium">{formatCurrency(movie.budget)}</div>
						</div>
					{/if}

					{#if movie.revenue > 0}
						<div>
							<div class="text-sm text-base-content/50">{m.hero_metadata_revenue()}</div>
							<div class="font-medium">{formatCurrency(movie.revenue)}</div>
						</div>
					{/if}
				{:else}
					{@const tv = item as TVShowDetails}

					{#if tvRating}
						<div>
							<div class="text-sm text-base-content/50">{m.hero_metadata_rated()}</div>
							<div><span class="badge badge-outline badge-sm">{tvRating}</span></div>
						</div>
					{/if}

					{#if tv.networks && tv.networks.length > 0}
						<div>
							<div class="text-sm text-base-content/50">{m.hero_metadata_network()}</div>
							<div class="font-medium">{tv.networks[0].name}</div>
						</div>
					{/if}

					<div>
						<div class="text-sm text-base-content/50">{m.hero_metadata_seasons()}</div>
						<div class="font-medium">{tv.number_of_seasons}</div>
					</div>

					<div>
						<div class="text-sm text-base-content/50">{m.hero_metadata_episodes()}</div>
						<div class="font-medium">{tv.number_of_episodes}</div>
					</div>

					{#if tv.first_air_date}
						<div>
							<div class="text-sm text-base-content/50">{m.hero_metadata_firstAired()}</div>
							<div class="font-medium">{formatDisplayDateShort(tv.first_air_date)}</div>
						</div>
					{/if}

					{#if tv.next_episode_to_air}
						<div>
							<div class="text-sm text-base-content/50">{m.hero_metadata_nextEpisode()}</div>
							<div class="font-medium text-primary">
								S{tv.next_episode_to_air.season_number}E{tv.next_episode_to_air.episode_number}
							</div>
						</div>
					{/if}
				{/if}

				{#if item.production_companies && item.production_companies.length > 0}
					<div class="col-span-2">
						<div class="text-sm text-base-content/50">{m.hero_metadata_studio()}</div>
						<div class="font-medium">{item.production_companies[0].name}</div>
					</div>
				{/if}
			</div>

			{#if item['watch/providers']}
				<div class="mt-4 border-t border-base-content/10 pt-4">
					<div class="mb-2 text-sm text-base-content/50">{m.hero_metadata_whereToWatch()}</div>
					<WatchProviders providers={item['watch/providers']} {countryCode} />
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- Video player modal -->
{#if activeVideo}
	<div
		role="dialog"
		aria-modal="true"
		aria-label={activeVideo.name}
		tabindex="-1"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
		onclick={() => (activeVideo = null)}
		onkeydown={(e) => e.key === 'Escape' && (activeVideo = null)}
	>
		<div role="presentation" class="w-full max-w-4xl" onclick={(e) => e.stopPropagation()}>
			<div class="mb-3 flex items-center justify-between gap-4">
				<div>
					<p class="font-semibold text-white">{activeVideo.name}</p>
					<p class="text-sm text-white/50">{activeVideo.type}</p>
				</div>
				<button
					class="btn btn-circle btn-ghost text-white/70 btn-sm hover:text-white"
					onclick={() => (activeVideo = null)}
				>
					<X size={18} />
				</button>
			</div>
			<div class="relative w-full overflow-hidden rounded-xl" style="aspect-ratio: 16/9">
				<iframe
					src="https://www.youtube-nocookie.com/embed/{activeVideo.key}?autoplay=1"
					title={activeVideo.name}
					class="absolute inset-0 h-full w-full"
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
					allowfullscreen
				></iframe>
			</div>
		</div>
	</div>
{/if}

<!-- Backdrop lightbox -->
{#if activeBackdrop}
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Backdrop image"
		tabindex="-1"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
		onclick={() => (activeBackdrop = null)}
		onkeydown={(e) => e.key === 'Escape' && (activeBackdrop = null)}
	>
		<button
			class="btn absolute top-4 right-4 btn-circle btn-ghost text-white/70 btn-sm hover:text-white"
			onclick={() => (activeBackdrop = null)}
		>
			<X size={18} />
		</button>
		<div role="presentation" onclick={(e) => e.stopPropagation()}>
			<TmdbImage
				path={activeBackdrop}
				size="original"
				alt="Backdrop"
				class="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
			/>
		</div>
	</div>
{/if}

<!-- Add to Library Modal -->
<AddToLibraryModal
	open={showAddModal}
	{mediaType}
	tmdbId={item.id}
	{title}
	{year}
	posterPath={item.poster_path}
	onClose={() => (showAddModal = false)}
	onSuccess={handleAddSuccess}
/>

<ConfirmationModal
	open={showBlockConfirm}
	onCancel={() => (showBlockConfirm = false)}
	onConfirm={handleBlock}
	title={m.blockedMedia_confirmBlockTitle()}
	message={m.blockedMedia_confirmBlockMessage({ title })}
	confirmLabel={m.blockedMedia_confirmBlockLabel()}
	confirmVariant="error"
/>

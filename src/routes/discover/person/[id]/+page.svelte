<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { SvelteSet } from 'svelte/reactivity';
	import type { PageData } from './$types';
	import type { PersonCastCredit, PersonCrewCredit } from '#lib/types/tmdb.js';
	import PersonHero from '#lib/components/tmdb/PersonHero.svelte';
	import FilmographyCard from '#lib/components/tmdb/FilmographyCard.svelte';
	import { Film, Tv, Clapperboard } from '@lucide/svelte';
	import { getPersonCredits } from '#lib/api/index.js';

	type CreditWithStatus = (PersonCastCredit | PersonCrewCredit) & {
		inLibrary?: boolean;
		hasFile?: boolean;
	};

	let { data }: { data: PageData } = $props();

	// Tab state
	let activeTab = $state<'movies' | 'tv' | 'crew'>('movies');

	// Credits data with pagination info
	let movieCredits = $state<CreditWithStatus[]>([]);
	let tvCredits = $state<CreditWithStatus[]>([]);
	let crewCredits = $state<CreditWithStatus[]>([]);

	// Pagination state per tab
	let moviePage = $state(1);
	let tvPage = $state(1);
	let crewPage = $state(1);
	let movieTotalPages = $state(1);
	let tvTotalPages = $state(1);
	let crewTotalPages = $state(1);
	let movieTotal = $state(0);
	let tvTotal = $state(0);
	let crewTotal = $state(0);

	let loading = $state(true);
	let loadingMore = $state(false);
	let sentinel = $state<HTMLElement | null>(null);

	// Deduplicate credits by ID (actor may have multiple roles in same media)
	function dedupeById<T extends { id: number }>(items: T[]): T[] {
		const seen = new SvelteSet<number>();
		return items.filter((item) => {
			if (seen.has(item.id)) return false;
			seen.add(item.id);
			return true;
		});
	}

	// Get active tab's data (deduplicated)
	const activeCredits = $derived(
		dedupeById(activeTab === 'movies' ? movieCredits : activeTab === 'tv' ? tvCredits : crewCredits)
	);
	const activePage = $derived(
		activeTab === 'movies' ? moviePage : activeTab === 'tv' ? tvPage : crewPage
	);
	const activeTotalPages = $derived(
		activeTab === 'movies' ? movieTotalPages : activeTab === 'tv' ? tvTotalPages : crewTotalPages
	);
	const hasMore = $derived(activePage < activeTotalPages);

	// Fetch initial credits
	$effect(() => {
		const personId = data.person.id;
		loading = true;

		getPersonCredits(personId).then((response) => {
			const credits = response as unknown as {
				movies?: { results?: CreditWithStatus[]; total_pages?: number; total_results?: number };
				tv?: { results?: CreditWithStatus[]; total_pages?: number; total_results?: number };
				crew?: { results?: CreditWithStatus[]; total_pages?: number; total_results?: number };
			};
			movieCredits = credits.movies?.results ?? [];
			tvCredits = credits.tv?.results ?? [];
			crewCredits = credits.crew?.results ?? [];

			movieTotalPages = credits.movies?.total_pages ?? 1;
			tvTotalPages = credits.tv?.total_pages ?? 1;
			crewTotalPages = credits.crew?.total_pages ?? 1;

			movieTotal = credits.movies?.total_results ?? 0;
			tvTotal = credits.tv?.total_results ?? 0;
			crewTotal = credits.crew?.total_results ?? 0;

			// Auto-select first non-empty tab
			if (movieCredits.length > 0) {
				activeTab = 'movies';
			} else if (tvCredits.length > 0) {
				activeTab = 'tv';
			} else if (crewCredits.length > 0) {
				activeTab = 'crew';
			}

			loading = false;
		});
	});

	// Infinite scroll observer
	$effect(() => {
		if (!sentinel) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting && hasMore && !loadingMore && !loading) {
					loadMore();
				}
			},
			{ rootMargin: '200px' }
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
	});

	async function loadMore() {
		if (loadingMore || !hasMore) return;
		loadingMore = true;

		const type = activeTab === 'movies' ? 'movie' : activeTab;
		const nextPage = activePage + 1;

		try {
			const raw = await getPersonCredits(data.person.id, {
				type,
				page: String(nextPage)
			});
			const result = raw as unknown as { results?: CreditWithStatus[]; total_pages?: number };
			const newItems = result.results ?? [];

			if (activeTab === 'movies') {
				movieCredits = [...movieCredits, ...newItems];
				moviePage = nextPage;
			} else if (activeTab === 'tv') {
				tvCredits = [...tvCredits, ...newItems];
				tvPage = nextPage;
			} else {
				crewCredits = [...crewCredits, ...newItems];
				crewPage = nextPage;
			}
		} catch {
			loadingMore = false;
		}
	}
</script>

<svelte:head>
	<title>{m.discover_person_pageTitle({ name: data.person.name })}</title>
</svelte:head>

<div class="flex w-full flex-col gap-8 px-4 pb-20 lg:px-8">
	<!-- Hero Section -->
	<PersonHero person={data.person} />

	<!-- Filmography Section -->
	<div class="space-y-6">
		<h2 class="flex items-center gap-2 text-xl font-bold text-base-content">
			<span class="h-6 w-1 rounded-full bg-primary"></span>
			{m.discover_person_filmography()}
		</h2>

		<!-- Tabs -->
		{#if loading}
			<div class="flex gap-2">
				<div class="h-10 w-28 skeleton"></div>
				<div class="h-10 w-28 skeleton"></div>
				<div class="h-10 w-28 skeleton"></div>
			</div>
		{:else}
			<div role="tablist" class="tabs-boxed tabs w-fit bg-base-200">
				{#if movieTotal > 0}
					<button
						type="button"
						role="tab"
						class="tab gap-2"
						class:tab-active={activeTab === 'movies'}
						onclick={() => {
							activeTab = 'movies';
						}}
					>
						<Film class="h-4 w-4" />
						{m.discover_person_tabMovies()}
						<span class="badge badge-sm">{movieTotal}</span>
					</button>
				{/if}
				{#if tvTotal > 0}
					<button
						type="button"
						role="tab"
						class="tab gap-2"
						class:tab-active={activeTab === 'tv'}
						onclick={() => {
							activeTab = 'tv';
						}}
					>
						<Tv class="h-4 w-4" />
						{m.discover_person_tabTvShows()}
						<span class="badge badge-sm">{tvTotal}</span>
					</button>
				{/if}
				{#if crewTotal > 0}
					<button
						type="button"
						role="tab"
						class="tab gap-2"
						class:tab-active={activeTab === 'crew'}
						onclick={() => {
							activeTab = 'crew';
						}}
					>
						<Clapperboard class="h-4 w-4" />
						{m.discover_person_tabCrew()}
						<span class="badge badge-sm">{crewTotal}</span>
					</button>
				{/if}
			</div>
		{/if}

		<!-- Grid -->
		{#if loading}
			<div class="grid grid-cols-3 gap-3 sm:gap-4 lg:grid-cols-9">
				{#each Array(14) as _, i (i)}
					<div class="aspect-[2/3] animate-pulse rounded-lg bg-base-300"></div>
				{/each}
			</div>
		{:else if activeCredits.length > 0}
			<div class="grid grid-cols-3 gap-3 sm:gap-4 lg:grid-cols-9">
				{#each activeCredits as credit (credit.id)}
					<FilmographyCard {credit} showRole={activeTab === 'crew'} />
				{/each}
			</div>

			<!-- Infinite scroll sentinel -->
			<div bind:this={sentinel} class="flex justify-center py-4">
				{#if loadingMore}
					<span class="loading loading-md loading-spinner text-primary"></span>
				{:else if !hasMore}
					<span class="text-sm text-base-content/50">
						{m.discover_person_showingAll({
							count: activeCredits.length,
							type:
								activeTab === 'movies'
									? m.discover_person_tabMovies()
									: activeTab === 'tv'
										? m.discover_person_tabTvShows()
										: m.discover_person_tabCrew()
						})}
					</span>
				{/if}
			</div>
		{:else}
			<div class="flex items-center justify-center py-12 text-base-content/50">
				{activeTab === 'movies'
					? m.discover_person_noMoviesFound()
					: activeTab === 'tv'
						? m.discover_person_noTvShowsFound()
						: m.discover_person_noCrewCreditsFound()}
			</div>
		{/if}
	</div>
</div>

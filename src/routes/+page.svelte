<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Plus } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { UnifiedActivity } from '#lib/types/activity.js';
	import type {
		RecentlyAddedData,
		MissingEpisode,
		UpcomingItem,
		DashboardStats
	} from '#lib/types/dashboard.js';
	import { createSSE } from '#lib/sse/index.js';
	import { layoutState, deriveMobileSseStatus } from '#lib/layout.svelte.js';
	import {
		DashboardStatsGrid,
		QuickActions,
		RecentlyAddedMovies,
		RecentlyAddedSeries,
		MissingEpisodesList,
		ComingUpList,
		RecentHistorySidebar,
		DashboardEmptyState
	} from '#lib/components/dashboard/index.js';

	let { data } = $props();

	type DashboardSSEEvents = {
		'dashboard:stats': DashboardStats;
		'dashboard:recentlyAdded': RecentlyAddedData;
		'dashboard:missingEpisodes': MissingEpisode[];
		'dashboard:recentActivity': UnifiedActivity[];
		'dashboard:upcoming': UpcomingItem[];
	};

	let recentlyAddedResolved = $state<RecentlyAddedData>({ movies: [], series: [] });
	let missingEpisodesResolved = $state<MissingEpisode[]>([]);
	let recentActivityResolved = $state<UnifiedActivity[]>([]);
	let upcomingResolved = $state<UpcomingItem[]>([]);
	let isRecentlyAddedLoading = $state(true);
	let isMissingEpisodesLoading = $state(true);
	let isActivityLoading = $state(true);
	let isUpcomingLoading = $state(true);

	let statsState = $state<typeof data.stats | null>(null);
	let recentActivityState = $state<UnifiedActivity[] | null>(null);
	let recentlyAddedState = $state<typeof recentlyAddedResolved | null>(null);
	let missingEpisodesState = $state<typeof missingEpisodesResolved | null>(null);
	let upcomingState = $state<UpcomingItem[] | null>(null);

	const stats = $derived(statsState ?? data.stats);
	const recentActivity = $derived(recentActivityState ?? recentActivityResolved);
	const recentlyAdded = $derived(recentlyAddedState ?? recentlyAddedResolved);
	const missingEpisodes = $derived(missingEpisodesState ?? missingEpisodesResolved);
	const upcoming = $derived(upcomingState ?? upcomingResolved);

	$effect(() => {
		if (data.recentlyAdded instanceof Promise) {
			data.recentlyAdded
				.then((result: RecentlyAddedData) => {
					recentlyAddedResolved = result;
					isRecentlyAddedLoading = false;
				})
				.catch(() => {
					isRecentlyAddedLoading = false;
				});
		} else {
			recentlyAddedResolved = data.recentlyAdded;
			isRecentlyAddedLoading = false;
		}

		if (data.missingEpisodes instanceof Promise) {
			data.missingEpisodes
				.then((result: MissingEpisode[]) => {
					missingEpisodesResolved = result;
					isMissingEpisodesLoading = false;
				})
				.catch(() => {
					isMissingEpisodesLoading = false;
				});
		} else {
			missingEpisodesResolved = data.missingEpisodes;
			isMissingEpisodesLoading = false;
		}

		if (data.recentActivity instanceof Promise) {
			data.recentActivity
				.then((result: UnifiedActivity[]) => {
					recentActivityResolved = result;
					isActivityLoading = false;
				})
				.catch(() => {
					isActivityLoading = false;
				});
		} else {
			recentActivityResolved = data.recentActivity;
			isActivityLoading = false;
		}

		if (data.upcoming instanceof Promise) {
			data.upcoming
				.then((result: UpcomingItem[]) => {
					upcomingResolved = result;
					isUpcomingLoading = false;
				})
				.catch(() => {
					isUpcomingLoading = false;
				});
		} else {
			upcomingResolved = data.upcoming;
			isUpcomingLoading = false;
		}
	});

	$effect(() => {
		statsState = data.stats;
	});

	const sse = createSSE<DashboardSSEEvents>(resolvePath('/api/dashboard/stream'), {
		'dashboard:stats': (newStats) => {
			statsState = newStats;
		},
		'dashboard:recentlyAdded': (newRecentlyAdded) => {
			recentlyAddedState = newRecentlyAdded;
		},
		'dashboard:missingEpisodes': (newMissingEpisodes) => {
			missingEpisodesState = newMissingEpisodes;
		},
		'dashboard:recentActivity': (newRecentActivity) => {
			recentActivityState = newRecentActivity;
		},
		'dashboard:upcoming': (newUpcoming) => {
			upcomingState = newUpcoming;
		}
	});

	$effect(() => {
		layoutState.setMobileSseStatus(deriveMobileSseStatus(sse));
		return () => {
			layoutState.clearMobileSseStatus();
		};
	});
</script>

<svelte:head>
	<title>{m.dashboard_pageTitle()}</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold">{m.dashboard_title()}</h1>
			<p class="text-base-content/70">{m.dashboard_subtitle()}</p>
		</div>
		<div class="flex items-center gap-2">
			<a href={resolve('discover')} class="btn gap-2 btn-primary btn-sm sm:w-auto"
				><Plus class="h-4 w-4" />{m.dashboard_addContent()}</a
			>
		</div>
	</div>

	<DashboardStatsGrid
		{stats}
		missingEpisodesCount={missingEpisodes.length}
		{isMissingEpisodesLoading}
	/>

	<QuickActions
		config={stats.config}
		hasLibraryContent={stats.movies.total > 0 || stats.series.total > 0}
		hasMissingEpisodes={stats.episodes.missing > 0}
	/>

	<div class="grid gap-6 lg:grid-cols-3">
		<div class="space-y-6 lg:col-span-2">
			<RecentlyAddedMovies movies={recentlyAdded.movies} isLoading={isRecentlyAddedLoading} />
			<RecentlyAddedSeries series={recentlyAdded.series} isLoading={isRecentlyAddedLoading} />
			<MissingEpisodesList episodes={missingEpisodes} isLoading={isMissingEpisodesLoading} />
			<ComingUpList items={upcoming} isLoading={isUpcomingLoading} />

			{#if !isRecentlyAddedLoading && recentlyAdded.movies.length === 0 && recentlyAdded.series.length === 0}
				<DashboardEmptyState />
			{/if}
		</div>

		<RecentHistorySidebar activities={recentActivity} isLoading={isActivityLoading} />
	</div>
</div>

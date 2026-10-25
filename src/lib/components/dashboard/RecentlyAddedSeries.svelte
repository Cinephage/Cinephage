<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Tv } from '@lucide/svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import Skeleton from '#lib/components/ui/Skeleton.svelte';
	import { resolve } from '$app/paths';
	import type { RecentlyAddedSeries } from '#lib/types/dashboard.js';

	interface Props {
		series: RecentlyAddedSeries[];
		isLoading: boolean;
	}

	let { series, isLoading }: Props = $props();
</script>

{#if isLoading}
	<div class="card bg-base-200">
		<div class="card-body">
			<div class="flex items-center justify-between">
				<h2 class="card-title">
					<Tv class="h-5 w-5" />
					{m.dashboard_recentTvShows_title()}
				</h2>
				<Skeleton variant="text" class="h-8 w-20" />
			</div>
			<div class="grid grid-cols-3 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-6">
				{#each Array.from({ length: 6 }, (_, index) => index) as index (index)}
					<div class="aspect-2/3 overflow-hidden rounded-lg">
						<Skeleton class="h-full w-full" />
					</div>
				{/each}
			</div>
		</div>
	</div>
{:else if series.length > 0}
	<div class="card bg-base-200">
		<div class="card-body">
			<div class="flex items-center justify-between">
				<h2 class="card-title">
					<Tv class="h-5 w-5" />
					{m.dashboard_recentTvShows_title()}
				</h2>

				<a href={resolve('library/tv')} class="btn btn-ghost btn-sm"
					>{m.dashboard_recentTvShows_viewAll()}</a
				>
			</div>
			<div class="grid grid-cols-3 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-6">
				{#each series as show (show.id)}
					<a
						href={resolve(`library/tv/${show.id}`)}
						class="group relative aspect-2/3 overflow-hidden rounded-lg"
					>
						<TmdbImage
							path={show.posterPath}
							alt={show.title}
							size="w185"
							class="h-full w-full object-cover transition-transform group-hover:scale-105"
						/>
						<div
							class="absolute inset-0 bg-linear-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100"
						>
							<div class="absolute right-0 bottom-0 left-0 p-2">
								<p class="truncate text-xs font-medium text-white">{show.title}</p>
								<p class="text-xs text-white/70">
									{m.dashboard_recentTvShows_episodes({
										fileCount: show.episodeFileCount ?? 0,
										totalCount: show.episodeCount ?? 0
									})}
								</p>
							</div>
						</div>
						{#if (show.airedMissingCount ?? 0) > 0}
							<div class="absolute top-1 right-1">
								<span class="badge badge-xs badge-warning">
									{m.dashboard_recentTvShows_missingCount({
										count: show.airedMissingCount
									})}
								</span>
							</div>
						{/if}
					</a>
				{/each}
			</div>
		</div>
	</div>
{/if}

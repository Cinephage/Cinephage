<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Clapperboard } from '@lucide/svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import Skeleton from '#lib/components/ui/Skeleton.svelte';
	import { resolve } from '$app/paths';
	import type { RecentlyAddedMovie } from '#lib/types/dashboard.js';

	interface Props {
		movies: RecentlyAddedMovie[];
		isLoading: boolean;
	}

	let { movies, isLoading }: Props = $props();
</script>

{#if isLoading}
	<div class="card bg-base-200">
		<div class="card-body">
			<div class="flex items-center justify-between">
				<h2 class="card-title">
					<Clapperboard class="h-5 w-5" />
					{m.dashboard_recentMovies_title()}
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
{:else if movies.length > 0}
	<div class="card bg-base-200">
		<div class="card-body">
			<div class="flex items-center justify-between">
				<h2 class="card-title">
					<Clapperboard class="h-5 w-5" />
					{m.dashboard_recentMovies_title()}
				</h2>

				<a href={resolve('library/movies')} class="btn btn-ghost btn-sm"
					>{m.dashboard_recentMovies_viewAll()}</a
				>
			</div>
			<div class="grid grid-cols-3 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-6">
				{#each movies as movie (movie.id)}
					<a
						href={resolve(`library/movie/${movie.id}`)}
						class="group relative aspect-2/3 overflow-hidden rounded-lg"
					>
						<TmdbImage
							path={movie.posterPath}
							alt={movie.title}
							size="w185"
							class="h-full w-full object-cover transition-transform group-hover:scale-105"
						/>
						<div
							class="absolute inset-0 bg-linear-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100"
						>
							<div class="absolute right-0 bottom-0 left-0 p-2">
								<p class="truncate text-xs font-medium text-white">{movie.title}</p>
								<p class="text-xs text-white/70">{movie.year}</p>
							</div>
						</div>
						{#if !movie.hasFile && movie.monitored}
							<div class="absolute top-1 right-1">
								<span
									class="badge badge-xs {movie.isReleased ? 'badge-warning' : 'badge-secondary'}"
								>
									{movie.isReleased ? m.common_missing() : m.common_unreleased()}
								</span>
							</div>
						{/if}
					</a>
				{/each}
			</div>
		</div>
	</div>
{/if}

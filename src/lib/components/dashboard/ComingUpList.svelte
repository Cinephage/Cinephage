<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Calendar, Clapperboard, Tv, ArrowRight } from '@lucide/svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import Skeleton from '#lib/components/ui/Skeleton.svelte';
	import { resolvePath } from '#lib/utils/routing.js';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import type { UpcomingItem } from '#lib/types/dashboard.js';

	interface Props {
		items: UpcomingItem[];
		isLoading: boolean;
	}

	let { items, isLoading }: Props = $props();
</script>

{#if isLoading}
	<div class="card bg-base-200">
		<div class="card-body">
			<h2 class="card-title">
				<Calendar class="h-5 w-5" />
				{m.calendar_comingUp()}
			</h2>
			<div class="divide-y divide-base-300">
				{#each Array.from({ length: 5 }, (_, index) => index) as index (index)}
					<div class="flex items-center gap-3 py-2">
						<Skeleton variant="rect" class="h-12 w-8 shrink-0" />
						<div class="min-w-0 flex-1">
							<Skeleton variant="text" class="mb-1 w-32" />
							<Skeleton variant="text" class="w-24" />
						</div>
						<Skeleton variant="text" class="w-16" />
					</div>
				{/each}
			</div>
		</div>
	</div>
{:else if items.length > 0}
	<div class="card bg-base-200">
		<div class="card-body">
			<div class="flex items-center justify-between">
				<h2 class="card-title">
					<Calendar class="h-5 w-5" />
					{m.calendar_comingUp()}
				</h2>
				<a href={resolvePath('/calendar')} class="btn gap-1 btn-ghost btn-xs">
					{m.calendar_viewAll()}
					<ArrowRight class="h-3 w-3" />
				</a>
			</div>
			<div class="divide-y divide-base-300">
				{#each items as item (`${item.type}:${item.episodeId ?? item.movieId ?? item.tmdbId ?? `${item.date}-${item.title}`}`)}
					{@const href =
						item.type === 'movie'
							? item.movieId
								? resolvePath(`/library/movie/${item.movieId}`)
								: item.tmdbId
									? resolvePath(`/discover/movie/${item.tmdbId}`)
									: null
							: item.seriesId
								? resolvePath(`/library/tv/${item.seriesId}`)
								: item.tmdbId
									? resolvePath(`/discover/tv/${item.tmdbId}`)
									: null}
					<a
						href={href ?? '#'}
						class="flex items-center gap-3 rounded-lg px-1 py-2 transition-colors hover:bg-base-300"
					>
						{#if item.posterPath}
							<div class="h-12 w-8 shrink-0 overflow-hidden rounded">
								<TmdbImage
									path={item.posterPath}
									alt={item.title}
									size="w92"
									class="h-full w-full object-cover"
								/>
							</div>
						{:else}
							<div class="flex h-12 w-8 shrink-0 items-center justify-center rounded bg-base-300">
								{#if item.type === 'movie'}
									<Clapperboard class="h-4 w-4 text-base-content/50" />
								{:else}
									<Tv class="h-4 w-4 text-base-content/50" />
								{/if}
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<p class="font-medium wrap-break-word whitespace-normal">{item.title}</p>
							<p class="wrap-break-words text-sm whitespace-normal text-base-content/70">
								{item.subtitle ?? (item.type === 'movie' ? m.common_movie() : m.common_episode())}
							</p>
						</div>
						<div class="flex flex-col items-end gap-1">
							<span class="text-sm text-base-content/50">{formatDisplayDate(item.date)}</span>
							<span
								class="badge badge-xs {item.type === 'movie' ? 'badge-primary' : 'badge-secondary'}"
							>
								{item.type === 'movie' ? m.common_movie() : m.common_episode()}
							</span>
						</div>
					</a>
				{/each}
			</div>
		</div>
	</div>
{/if}

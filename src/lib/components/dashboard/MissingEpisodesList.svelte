<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Calendar } from '@lucide/svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import Skeleton from '#lib/components/ui/Skeleton.svelte';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import type { MissingEpisode } from '#lib/types/dashboard.js';

	interface Props {
		episodes: MissingEpisode[];
		isLoading: boolean;
	}

	let { episodes, isLoading }: Props = $props();
</script>

{#if isLoading}
	<div class="card bg-base-200">
		<div class="card-body">
			<h2 class="card-title">
				<Calendar class="h-5 w-5" />
				{m.dashboard_missingEpisodes_title()}
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
{:else if episodes.length > 0}
	<div class="card bg-base-200">
		<div class="card-body">
			<h2 class="card-title">
				<Calendar class="h-5 w-5" />
				{m.dashboard_missingEpisodes_title()}
			</h2>
			<div class="divide-y divide-base-300">
				{#each episodes.slice(0, 5) as episode (episode.id)}
					<div class="flex items-center gap-3 py-2">
						{#if episode.series?.posterPath}
							<div class="h-12 w-8 shrink-0 overflow-hidden rounded">
								<TmdbImage
									path={episode.series.posterPath}
									alt={episode.series.title || ''}
									size="w92"
									class="h-full w-full object-cover"
								/>
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<p class="font-medium wrap-break-word whitespace-normal">
								{episode.series?.title || m.dashboard_missingEpisodes_unknownSeries()}
							</p>
							<p class="wrap-break-words text-sm whitespace-normal text-base-content/70">
								S{String(episode.seasonNumber).padStart(2, '0')}E{String(
									episode.episodeNumber
								).padStart(2, '0')}
								{episode.title ? ` - ${episode.title}` : ''}
							</p>
						</div>
						<div class="text-right text-sm text-base-content/50">
							{formatDisplayDate(episode.airDate)}
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

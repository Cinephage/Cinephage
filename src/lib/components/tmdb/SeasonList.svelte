<script lang="ts">
	import type { Season } from '#lib/types/tmdb.js';
	import TmdbImage from './TmdbImage.svelte';
	import * as m from '#lib/paraglide/messages.js';

	let { seasons }: { seasons: Season[] } = $props();

	// Filter out season 0 (specials) usually, or keep it? Let's keep it but maybe sort it.
	// Usually Season 0 is specials.
</script>

<div class="flex flex-col gap-4">
	{#each seasons as season (season.season_number)}
		<div class="flex gap-4 rounded-lg bg-base-200 p-4 shadow-sm transition-all hover:bg-base-300">
			<div class="w-24 shrink-0 md:w-32">
				<div class="aspect-[2/3] overflow-hidden rounded-md">
					<TmdbImage
						path={season.poster_path}
						size="w185"
						alt={season.name}
						class="h-full w-full object-cover"
					/>
				</div>
			</div>
			<div class="flex flex-col justify-center">
				<h3 class="text-xl font-bold">{season.name}</h3>
				<div class="flex items-center gap-2 text-sm text-base-content/70">
					{#if season.air_date}
						<span>{new Date(season.air_date).getFullYear()}</span>
						<span>•</span>
					{/if}
					<span>{season.episode_count} {m.common_episodes()}</span>
				</div>
				{#if season.overview}
					<p class="mt-2 line-clamp-3 text-sm text-base-content/80">{season.overview}</p>
				{:else}
					<p class="mt-2 text-sm text-base-content/50 italic">{m.tmdb_seasonList_noOverview()}</p>
				{/if}
			</div>
		</div>
	{/each}
</div>

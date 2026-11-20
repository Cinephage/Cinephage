<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Disc3 } from '@lucide/svelte';
	import Skeleton from '#lib/components/ui/Skeleton.svelte';
	import LibraryMediaCard from '#lib/components/library/LibraryMediaCard.svelte';
	import { albumCardView } from '#lib/components/library/media-view.js';
	import { resolve } from '$app/paths';
	import type { RecentlyAddedAlbum } from '#lib/types/dashboard.js';

	interface Props {
		albums: RecentlyAddedAlbum[];
		isLoading: boolean;
	}

	let { albums, isLoading }: Props = $props();
</script>

{#if isLoading}
	<div class="card bg-base-200">
		<div class="card-body">
			<div class="flex items-center justify-between">
				<h2 class="card-title">
					<Disc3 class="h-5 w-5" />
					{m.dashboard_recentMusic_title()}
				</h2>
				<Skeleton variant="text" class="h-8 w-20" />
			</div>
			<div class="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 md:grid-cols-5 lg:grid-cols-6">
				{#each Array.from({ length: 6 }, (_, index) => index) as index (index)}
					<div class="aspect-square overflow-hidden rounded-lg">
						<Skeleton class="h-full w-full" />
					</div>
				{/each}
			</div>
		</div>
	</div>
{:else if albums.length > 0}
	<div class="card bg-base-200">
		<div class="card-body">
			<div class="flex items-center justify-between">
				<h2 class="card-title">
					<Disc3 class="h-5 w-5" />
					{m.dashboard_recentMusic_title()}
				</h2>

				<a href={resolve('library/music')} class="btn btn-ghost btn-sm">
					{m.dashboard_recentMovies_viewAll()}
				</a>
			</div>
			<div class="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 md:grid-cols-5 lg:grid-cols-6">
				{#each albums as album (album.id)}
					<LibraryMediaCard view={albumCardView(album)} />
				{/each}
			</div>
		</div>
	</div>
{/if}

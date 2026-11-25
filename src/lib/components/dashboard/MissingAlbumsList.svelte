<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Disc3 } from '@lucide/svelte';
	import Skeleton from '#lib/components/ui/Skeleton.svelte';
	import { resolve } from '$app/paths';
	import type { MissingAlbum } from '#lib/types/dashboard.js';

	interface Props {
		albums: MissingAlbum[];
		isLoading: boolean;
	}

	let { albums, isLoading }: Props = $props();
</script>

{#if isLoading}
	<div class="card bg-base-200">
		<div class="card-body">
			<h2 class="card-title">
				<Disc3 class="h-5 w-5" />
				{m.dashboard_missingAlbums_title()}
			</h2>
			<div class="divide-y divide-base-300">
				{#each Array.from({ length: 5 }, (_, index) => index) as index (index)}
					<div class="flex items-center gap-3 py-2">
						<Skeleton variant="rect" class="h-12 w-12 shrink-0" />
						<div class="min-w-0 flex-1">
							<Skeleton variant="text" class="mb-1 w-32" />
							<Skeleton variant="text" class="w-24" />
						</div>
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
					{m.dashboard_missingAlbums_title()}
				</h2>
				<a
					href={resolve('library/music') + '?type=albums&file=missing'}
					class="btn btn-ghost btn-sm"
				>
					{m.dashboard_recentMovies_viewAll()}
				</a>
			</div>
			<div class="divide-y divide-base-300">
				{#each albums.slice(0, 5) as album (album.id)}
					<a
						href={resolve(`library/music/${album.id}`)}
						class="flex items-center gap-3 py-2 transition-colors hover:bg-base-300/50"
					>
						<div class="h-12 w-12 shrink-0 overflow-hidden rounded bg-base-300">
							{#if album.hasCover}
								<img
									src="/api/music/albums/{album.id}/cover"
									alt={album.title}
									class="h-full w-full object-cover"
									loading="lazy"
								/>
							{:else}
								<div class="flex h-full w-full items-center justify-center">
									<Disc3 class="h-5 w-5 text-base-content/25" />
								</div>
							{/if}
						</div>
						<div class="min-w-0 flex-1">
							<p class="truncate font-medium">{album.title}</p>
							<p class="truncate text-sm text-base-content/70">
								{album.artistName}{album.year ? ` · ${album.year}` : ''}{album.trackCount
									? ` · ${m.music_tracksShort({ count: album.trackCount })}`
									: ''}
							</p>
						</div>
					</a>
				{/each}
			</div>
		</div>
	</div>
{/if}

<script lang="ts">
	import { ChevronDown, Disc3, Eye, EyeOff } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { AlbumWithTracks } from './music-card.js';
	import TrackList from './TrackList.svelte';

	type Props = {
		/** Albums in display order; each expands to its own tracklist. */
		albums: AlbumWithTracks[];
		openAlbumId: string | null;
		onToggle: (albumId: string) => void;
	};

	let { albums, openAlbumId, onToggle }: Props = $props();
</script>

<ul class="space-y-2">
	{#each albums as album (album.id)}
		{@const open = openAlbumId === album.id}
		<li class="overflow-hidden rounded-xl border border-base-content/10 bg-base-100">
			<div class="flex items-center gap-3 p-3">
				<button
					class="flex min-w-0 flex-1 items-center gap-3 text-left"
					onclick={() => onToggle(album.id)}
					aria-expanded={open}
				>
					<div class="h-12 w-12 shrink-0 overflow-hidden rounded bg-base-300">
						{#if album.hasCover}
							<img
								src={`/api/music/albums/${album.id}/cover`}
								alt=""
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
						<p class="truncate text-xs text-base-content/50">
							{[album.year, album.primaryType, m.music_tracksShort({ count: album.tracks.length })]
								.filter(Boolean)
								.join(' · ')}
						</p>
					</div>

					<div class="hidden shrink-0 items-center gap-2 sm:flex">
						{#if album.hasFile}
							<span class="badge badge-sm border-none bg-success/15 text-success">{m.common_downloaded()}</span>
						{:else}
							<span class="badge badge-sm border-none bg-warning/15 text-warning">{m.common_missing()}</span>
						{/if}
						<span
							class="flex h-6 w-6 items-center justify-center rounded-full {album.monitored
								? 'bg-success/15 text-success'
								: 'bg-base-content/10 text-base-content/40'}"
							title={album.monitored ? m.common_monitored() : m.common_unmonitored()}
						>
							{#if album.monitored}
								<Eye class="h-3.5 w-3.5" />
							{:else}
								<EyeOff class="h-3.5 w-3.5" />
							{/if}
						</span>
					</div>

					<ChevronDown
						class="h-4 w-4 shrink-0 text-base-content/40 transition-transform {open ? 'rotate-180' : ''}"
					/>
				</button>
				<a
					class="hidden shrink-0 text-xs font-medium text-base-content/45 hover:text-primary sm:block"
					href={resolvePath(`/library/music/${album.id}`)}
				>
					{m.common_details()}
				</a>
			</div>

			{#if open}
				<div class="border-t border-base-content/10 p-3">
					{#if album.tracks.length === 0}
						<p class="px-2 py-6 text-center text-sm text-base-content/50">{m.music_noTracks()}</p>
					{:else}
						<TrackList tracks={album.tracks} artistName={album.artistName} />
					{/if}
				</div>
			{/if}
		</li>
	{/each}
</ul>

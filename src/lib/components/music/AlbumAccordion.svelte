<script lang="ts">
	import {
		ChevronDown,
		Eye,
		EyeOff,
		LoaderCircle,
		MoreVertical,
		Search,
		Trash2,
		Zap
	} from '@lucide/svelte';
	import AlbumCover from './AlbumCover.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import { trackAvailability, type AlbumWithTracks } from './music-card.js';
	import TrackList from './TrackList.svelte';

	type Props = {
		/** Albums in display order; each expands to its own tracklist. */
		albums: AlbumWithTracks[];
		openAlbumId: string | null;
		onToggle: (albumId: string) => void;
		/** Row actions: the album is the unit that searches and grabs, like a season. */
		onMonitorToggle?: (album: AlbumWithTracks) => void;
		onAutoSearch?: (album: AlbumWithTracks) => void;
		onRemove?: (album: AlbumWithTracks) => void;
		/** Albums with a request in flight (search, monitor, delete). */
		busyAlbumIds?: Set<string>;
		/** Per-track action: grab the best release for the track's album. */
		onAutoSearchTrack?: (track: AlbumWithTracks['tracks'][number], album: AlbumWithTracks) => void;
		/** Per-track action: open the interactive search for the track. */
		onOpenSearchTrack?: (track: AlbumWithTracks['tracks'][number], album: AlbumWithTracks) => void;
	};

	let {
		albums,
		openAlbumId,
		onToggle,
		onMonitorToggle,
		onAutoSearch,
		onRemove,
		busyAlbumIds = new Set(),
		onAutoSearchTrack,
		onOpenSearchTrack
	}: Props = $props();
</script>

<ul class="space-y-2">
	{#each albums as album (album.id)}
		{@const open = openAlbumId === album.id}
		{@const busy = busyAlbumIds.has(album.id)}
		{@const availability = trackAvailability(album)}
		<li class="overflow-hidden rounded-xl border border-base-content/10 bg-base-100">
			<div class="flex items-center gap-2 p-3">
				<button
					class="flex min-w-0 flex-1 items-center gap-3 text-left"
					onclick={() => onToggle(album.id)}
					aria-expanded={open}
				>
					<div class="h-12 w-12 shrink-0 overflow-hidden rounded bg-base-300">
						<AlbumCover albumId={album.id} hasCover={album.hasCover} />
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
						{#if availability === 'downloaded'}
							<span class="badge border-none bg-success/15 badge-sm text-success"
								>{m.common_downloaded()}</span
							>
						{:else if availability === 'streaming'}
							<span class="badge border-none bg-info/15 badge-sm text-info"
								>{m.library_fileCard_streaming()}</span
							>
						{:else}
							<span class="badge border-none bg-warning/15 badge-sm text-warning"
								>{m.common_missing()}</span
							>
						{/if}
					</div>

					<ChevronDown
						class="h-4 w-4 shrink-0 text-base-content/40 transition-transform {open
							? 'rotate-180'
							: ''}"
					/>
				</button>

				<!-- Row actions: monitor, search, more — the season row's set. -->
				{#if onMonitorToggle}
					<button
						class="btn btn-ghost btn-xs {album.monitored ? 'text-success' : 'text-base-content/40'}"
						title={album.monitored ? m.common_monitored() : m.common_unmonitored()}
						disabled={busy}
						onclick={() => onMonitorToggle(album)}
					>
						{#if album.monitored}
							<Eye class="h-4 w-4" />
						{:else}
							<EyeOff class="h-4 w-4" />
						{/if}
					</button>
				{/if}

				{#if onAutoSearch}
					<button
						class="btn btn-ghost btn-xs"
						title={m.music_findReleases()}
						disabled={busy}
						onclick={() => onAutoSearch(album)}
					>
						{#if busy}
							<LoaderCircle class="h-4 w-4 animate-spin" />
						{:else}
							<Zap class="h-4 w-4" />
						{/if}
					</button>
				{/if}

				{#if onRemove || album.id}
					<div class="dropdown dropdown-end">
						<div tabindex="0" role="button" class="btn btn-ghost btn-xs">
							<MoreVertical class="h-4 w-4" />
						</div>
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<ul
							tabindex="0"
							class="dropdown-content menu z-50 w-44 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg"
						>
							<li>
								<a href={resolvePath(`/library/music/${album.id}`)}>
									<Search class="h-4 w-4" />
									{m.common_details()}
								</a>
							</li>
							{#if onRemove}
								<li>
									<button class="text-error" onclick={() => onRemove(album)}>
										<Trash2 class="h-4 w-4" />
										{m.music_removeAlbum()}
									</button>
								</li>
							{/if}
						</ul>
					</div>
				{/if}
			</div>

			{#if open}
				<div class="border-t border-base-content/10 p-3">
					{#if album.tracks.length === 0}
						<p class="px-2 py-6 text-center text-sm text-base-content/50">{m.music_noTracks()}</p>
					{:else}
						<TrackList
							tracks={album.tracks}
							artistName={album.artistName}
							onAutoSearch={onAutoSearchTrack
								? (track) => onAutoSearchTrack(track, album)
								: undefined}
							onOpenSearch={onOpenSearchTrack
								? (track) => onOpenSearchTrack(track, album)
								: undefined}
						/>
					{/if}
				</div>
			{/if}
		</li>
	{/each}
</ul>

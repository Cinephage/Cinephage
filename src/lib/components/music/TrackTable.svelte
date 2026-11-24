<script lang="ts">
	import {
		ChevronDown,
		CircleCheck,
		CircleDashed,
		Disc3,
		LoaderCircle,
		Search,
		Zap
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { TrackTableRow } from './music-card.js';

	type Props = {
		tracks: TrackTableRow[];
		/** The library songs list shows both columns; an artist's list drops the artist. */
		showArtist?: boolean;
		showAlbum?: boolean;
		/** Rows link to their album. Off for embeded lists that already do. */
		linkAlbums?: boolean;
		/** Row action: grab the best release for this song's album. */
		onAutoSearch?: (track: TrackTableRow) => void;
		/** Row action: open the interactive search for this song. */
		onOpenSearch?: (track: TrackTableRow) => void;
		/** Song ids with a request in flight. */
		busyTrackIds?: Set<string>;
	};

	let {
		tracks,
		showArtist = true,
		showAlbum = true,
		linkAlbums = true,
		onAutoSearch,
		onOpenSearch,
		busyTrackIds = new Set()
	}: Props = $props();

	function clock(seconds: number | null | undefined): string {
		if (!seconds) return '–';
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${String(secs).padStart(2, '0')}`;
	}
</script>

<div class="overflow-hidden rounded-xl border border-base-content/10">
	<table class="table table-sm">
		<thead>
			<tr class="border-base-content/10 bg-base-200/50">
				<th class="w-10 text-right">#</th>
				<th>{m.common_title()}</th>
				{#if showArtist}
					<th class="hidden w-48 sm:table-cell">{m.music_tabArtists()}</th>
				{/if}
				{#if showAlbum}
					<th class="hidden w-56 md:table-cell">{m.music_albumColumn()}</th>
				{/if}
				<th class="w-20 text-right">{m.music_durationLabel()}</th>
				<th class="w-16">{m.common_status()}</th>
				{#if onAutoSearch || onOpenSearch}
					<th class="w-10"></th>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#each tracks as track (track.id)}
				<tr
					class="border-base-content/5 hover:bg-base-200/40"
					class:opacity-45={track.monitored === false}
					title={track.monitored === false ? m.music_trackNotMonitored() : undefined}
				>
					<td class="text-right font-mono text-xs text-base-content/40">
						{#if track.trackNumber === null}
							–
						{:else if (track.discNumber ?? 1) > 1}
							{track.discNumber}.{track.trackNumber}
						{:else}
							{track.trackNumber}
						{/if}
					</td>
					<td class="max-w-0">
						<p class="truncate font-medium" title={track.title}>{track.title}</p>
						{#if track.artistCredit && track.artistCredit !== track.artistName}
							<p class="truncate text-xs text-base-content/45">{track.artistCredit}</p>
						{/if}
					</td>
					{#if showArtist}
						<td class="hidden max-w-0 truncate text-base-content/65 sm:table-cell">
							<a href={resolvePath(`/library/music/artist/${track.artistId}`)} class="hover:text-primary">
								{track.artistName}
							</a>
						</td>
					{/if}
					{#if showAlbum}
						<td class="hidden max-w-0 truncate text-base-content/55 md:table-cell">
							{#if linkAlbums}
								<a href={resolvePath(`/library/music/${track.albumId}`)} class="hover:text-primary">
									{track.albumTitle}
								</a>
							{:else}
								{track.albumTitle}
							{/if}
						</td>
					{/if}
					<td class="text-right font-mono text-xs text-base-content/55 tabular-nums">
						{clock(track.duration)}
					</td>
					<td>
						{#if track.hasFile}
							<span class="badge gap-1 badge-sm border-none bg-success/15 text-success">
								<CircleCheck class="h-3 w-3" />{m.common_downloaded()}
							</span>
						{:else}
							<span class="badge gap-1 badge-sm border-none bg-base-content/10 text-base-content/50">
								<CircleDashed class="h-3 w-3" />{m.common_missing()}
							</span>
						{/if}
					</td>
					{#if onAutoSearch || onOpenSearch}
						<td class="text-right">
							<!-- The episode row's search control: auto-grab or pick a release. -->
							<div class="dropdown dropdown-end">
								<div
									tabindex={busyTrackIds.has(track.id) ? -1 : 0}
									role="button"
									class="btn btn-ghost btn-xs"
									class:btn-disabled={busyTrackIds.has(track.id)}
									title={m.music_searchTrack()}
									aria-label={m.music_searchTrack()}
									aria-haspopup="menu"
								>
									{#if busyTrackIds.has(track.id)}
										<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
									{:else}
										<Search class="h-3.5 w-3.5" />
									{/if}
									<ChevronDown class="h-2.5 w-2.5" />
								</div>
								<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
								<ul
									tabindex="0"
									class="menu dropdown-content z-50 w-56 rounded-box bg-base-200 p-2 shadow-lg"
								>
									{#if onAutoSearch}
										<li>
											<button
												disabled={busyTrackIds.has(track.id)}
												onclick={() => onAutoSearch(track)}
											>
												<Zap class="h-4 w-4" />
												{m.music_grabBest()}
											</button>
										</li>
									{/if}
									{#if onOpenSearch}
										<li>
											<button onclick={() => onOpenSearch(track)}>
												<Search class="h-4 w-4" />
												{m.music_interactiveSearch()}
											</button>
										</li>
									{/if}
								</ul>
							</div>
						</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>

	{#if tracks.length === 0}
		<div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
			<Disc3 class="h-8 w-8 text-base-content/20" />
			<p class="text-sm text-base-content/55">{m.music_noSongs()}</p>
		</div>
	{/if}
</div>

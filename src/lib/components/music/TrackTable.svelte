<script lang="ts">
	import { CircleCheck, CircleDashed, Disc3 } from '@lucide/svelte';
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
	};

	let { tracks, showArtist = true, showAlbum = true, linkAlbums = true }: Props = $props();

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
			</tr>
		</thead>
		<tbody>
			{#each tracks as track (track.id)}
				<tr class="border-base-content/5 hover:bg-base-200/40">
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

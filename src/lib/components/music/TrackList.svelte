<script lang="ts">
	import { ChevronDown, CircleCheck, CircleDashed, Clock, LoaderCircle, Search, Zap } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { TrackListTrack } from './music-card.js';

	type Props = {
		tracks: TrackListTrack[];
		/** Album artist — a per-track credit repeating it is noise, so it is hidden. */
		artistName?: string | null;
		/** False on discovery pages, where "have we got the file" has no meaning. */
		showFileState?: boolean;
		/** Row action: grab the best release for this track's album. */
		onAutoSearch?: (track: TrackListTrack) => void;
		/** Row action: open the interactive search for this track. */
		onOpenSearch?: (track: TrackListTrack) => void;
		/** Track ids with a request in flight. */
		busyTrackIds?: Set<string>;
	};

	let {
		tracks,
		artistName = null,
		showFileState = true,
		onAutoSearch,
		onOpenSearch,
		busyTrackIds = new Set()
	}: Props = $props();

	const discs = $derived.by(() => {
		const groups = new Map<number, TrackListTrack[]>();
		for (const track of tracks) {
			const disc = track.discNumber ?? 1;
			groups.set(disc, [...(groups.get(disc) ?? []), track]);
		}
		return [...groups.entries()].sort((a, b) => a[0] - b[0]);
	});

	const multiDisc = $derived(discs.length > 1);
	const totalRuntime = $derived(
		Math.round(tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0))
	);

	function clock(seconds: number | null | undefined): string {
		if (!seconds) return '–';
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${String(secs).padStart(2, '0')}`;
	}
</script>

<div class="overflow-hidden rounded-xl border border-base-content/10 bg-base-100">
	<div class="flex items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3">
		<p class="text-sm font-medium">
			{m.music_tracksShort({ count: tracks.length })}
			{#if totalRuntime > 0}
				<span class="text-base-content/45"> · {clock(totalRuntime)}</span>
			{/if}
		</p>
		{#if showFileState}
			<p class="flex items-center gap-3 text-xs text-base-content/45">
				<span class="flex items-center gap-1"><CircleCheck class="h-3.5 w-3.5 text-success" />{m.common_downloaded()}</span>
				<span class="flex items-center gap-1"><CircleDashed class="h-3.5 w-3.5" />{m.common_missing()}</span>
			</p>
		{/if}
	</div>

	{#each discs as [disc, discTracks] (disc)}
		{#if multiDisc}
			<div class="flex items-center gap-2 bg-base-200/60 px-4 py-1.5">
				<Clock class="h-3 w-3 text-base-content/40" />
				<span class="text-[11px] font-semibold tracking-wide uppercase text-base-content/50">
					{m.music_disc({ number: disc })}
				</span>
			</div>
		{/if}
		<table class="table table-sm">
			<thead>
				<tr class="border-none bg-base-200/30 text-[11px] text-base-content/45">
					<th class="w-12 text-right font-medium">#</th>
					<th class="font-medium">{m.common_title()}</th>
					<th class="w-20 text-right font-medium">{m.music_durationLabel()}</th>
					{#if onAutoSearch || onOpenSearch}
						<th class="w-10"></th>
					{/if}
				</tr>
			</thead>
			<tbody>
				{#each discTracks as track (track.id)}
					{@const busy = busyTrackIds.has(track.id)}
					<tr
						class="group border-none hover:bg-base-200/50"
						class:opacity-45={track.monitored === false}
						title={track.monitored === false ? m.music_trackNotMonitored() : undefined}
					>
						<td class="w-12 text-right font-mono text-xs text-base-content/40">
							{track.trackNumber ?? '–'}
						</td>
						<td class="min-w-0 py-2">
							<p class="truncate font-medium">{track.title}</p>
							{#if track.artistCredit && track.artistCredit !== artistName}
								<p class="truncate text-xs text-base-content/50">{track.artistCredit}</p>
							{/if}
							{#if showFileState}
								<span
									class="mt-1 inline-flex items-center gap-1 badge badge-sm border-none {track.hasFile
										? 'bg-success/15 text-success'
										: 'bg-warning/15 text-warning'}"
								>
									{#if track.hasFile}
										<CircleCheck class="h-3 w-3" />{m.common_downloaded()}
									{:else}
										<CircleDashed class="h-3 w-3" />{m.common_missing()}
									{/if}
								</span>
							{/if}
						</td>
						<td class="w-20 text-right font-mono text-xs text-base-content/50 tabular-nums">
							{clock(track.duration)}
						</td>
						{#if onAutoSearch || onOpenSearch}
							<td class="w-10">
								<!-- The episode row's search control: auto-grab or pick a release. -->
								<div class="dropdown dropdown-end">
									<div
										tabindex={busy ? -1 : 0}
										role="button"
										class="btn btn-ghost btn-xs"
										class:btn-disabled={busy}
										title={m.music_searchTrack()}
										aria-label={m.music_searchTrack()}
										aria-haspopup="menu"
									>
										{#if busy}
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
												<button disabled={busy} onclick={() => onAutoSearch(track)}>
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
	{/each}
</div>

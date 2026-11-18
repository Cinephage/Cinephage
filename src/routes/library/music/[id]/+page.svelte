<script lang="ts">
	import {
		Clock,
		Disc3,
		CircleCheck,
		CircleDashed,
		Search,
		LoaderCircle,
		Download
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	let { data } = $props<{
		data: {
			album: {
				id: string;
				title: string;
				artistName: string;
				year: number | null;
				primaryType: string | null;
				secondaryTypes: string[] | null;
				status: string | null;
				labelName: string | null;
				catalogNumber: string | null;
				barcode: string | null;
				country: string | null;
				mediaCount: number | null;
				trackCount: number | null;
				duration: number | null;
				hasFile: boolean | null;
				monitored: boolean | null;
				hasCover: boolean;
				tracks: Array<{
					id: string;
					title: string;
					artistCredit: string | null;
					discNumber: number | null;
					trackNumber: number | null;
					duration: number | null;
					hasFile: boolean | null;
				}>;
			};
		};
	}>();

	const album = $derived(data.album);

	function clock(seconds: number | null | undefined): string {
		if (!seconds) return '–';
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${String(secs).padStart(2, '0')}`;
	}

	type Candidate = {
		guid: string | null;
		title: string;
		indexerName: string | null;
		size: number | null;
		seeders: number | null;
		protocol: string | null;
		isAudioCategory: boolean;
		format?: string;
		bitDepth?: number | null;
		sampleRateKhz?: number | null;
		score?: number;
		accepted?: boolean;
		tierLabel?: string | null;
		reasons?: string[];
	};

	function qualityLabel(candidate: Candidate): string {
		const format = (candidate.format ?? 'unknown').toUpperCase();
		const depth = candidate.bitDepth ? ` ${candidate.bitDepth}-bit` : '';
		const rate = candidate.sampleRateKhz ? `/${candidate.sampleRateKhz}` : '';
		return `${format}${depth}${rate}`;
	}

	let searchingReleases = $state(false);
	let grabError = $state<string | null>(null);
	let grabbed = $state<string | null>(null);
	let grabbingGuid = $state<string | 'best' | null>(null);
	let candidates = $state<Candidate[]>([]);
	let releaseError = $state<string | null>(null);

	async function findReleases() {
		if (searchingReleases) return;
		searchingReleases = true;
		releaseError = null;
		try {
			const response = await fetch(`/api/music/albums/${album.id}/search`, { method: 'POST' });
			const body = await response.json();
			if (!response.ok) {
				releaseError = body.details ?? body.error ?? m.music_searchFailed();
				return;
			}
			candidates = body.candidates ?? [];
			if (candidates.length === 0) releaseError = m.music_noReleases();
		} catch (err) {
			releaseError = err instanceof Error ? err.message : m.music_searchFailed();
		} finally {
			searchingReleases = false;
		}
	}

	async function grab(candidate: Candidate | null) {
		if (grabbingGuid) return;
		grabbingGuid = candidate?.guid ?? 'best';
		grabError = null;
		grabbed = null;
		try {
			const response = await fetch(`/api/music/albums/${album.id}/grab`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(candidate?.guid ? { releaseGuid: candidate.guid } : {})
			});
			const body = await response.json();
			if (!response.ok) {
				grabError = body.details ?? body.error ?? m.music_grabFailed();
				return;
			}
			grabbed = body.title ?? candidate?.title ?? '';
			// The accepted set changes once a download is in flight.
			candidates = candidates.map((entry) =>
				entry.guid === (candidate?.guid ?? null)
					? { ...entry, accepted: false, reasons: [m.music_grabInFlight()] }
					: entry
			);
		} catch (err) {
			grabError = err instanceof Error ? err.message : m.music_grabFailed();
		} finally {
			grabbingGuid = null;
		}
	}

	function gib(bytes: number | null): string {
		if (!bytes) return '–';
		return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
	}

	const discs = $derived.by(() => {
		const groups = new Map<number, typeof album.tracks>();
		for (const track of album.tracks) {
			const disc = track.discNumber ?? 1;
			groups.set(disc, [...(groups.get(disc) ?? []), track]);
		}
		return [...groups.entries()].sort((a, b) => a[0] - b[0]);
	});
</script>

<div class="mx-auto max-w-5xl p-4 sm:p-6">
	<a class="mb-4 inline-block link text-sm link-hover opacity-60" href="/library/music">
		← {m.nav_music()}
	</a>

	<header class="mb-6 flex flex-col gap-5 sm:flex-row">
		<div class="w-44 shrink-0 overflow-hidden rounded-lg bg-base-300">
			{#if album.hasCover}
				<img
					src={`/api/music/albums/${album.id}/cover`}
					alt={album.title}
					class="aspect-square h-full w-full object-cover"
				/>
			{:else}
				<div class="flex aspect-square items-center justify-center">
					<Disc3 class="h-12 w-12 opacity-30" />
				</div>
			{/if}
		</div>

		<div class="min-w-0">
			<h1 class="text-2xl font-semibold">{album.title}</h1>
			<p class="mt-1 text-lg opacity-80">{album.artistName}</p>

			<div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
				{#if album.year}<span class="badge badge-ghost">{album.year}</span>{/if}
				{#if album.primaryType}<span class="badge badge-ghost">{album.primaryType}</span>{/if}
				{#each album.secondaryTypes ?? [] as type (type)}
					<span class="badge badge-ghost">{type}</span>
				{/each}
				{#if album.status}<span class="badge badge-ghost">{album.status}</span>{/if}
				{#if album.hasFile}
					<span class="badge gap-1 badge-success">
						<CircleCheck class="h-3 w-3" />{m.music_inLibrary()}
					</span>
				{:else}
					<span class="badge gap-1 badge-ghost">
						<CircleDashed class="h-3 w-3" />{m.music_missingFiles()}
					</span>
				{/if}
			</div>

			<dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
				<div class="flex gap-2">
					<dt class="opacity-50">{m.music_tracksLabel()}</dt>
					<dd>{album.trackCount ?? album.tracks.length}</dd>
				</div>
				<div class="flex gap-2">
					<dt class="opacity-50">{m.music_durationLabel()}</dt>
					<dd class="flex items-center gap-1"><Clock class="h-3 w-3" />{clock(album.duration)}</dd>
				</div>
				{#if album.mediaCount && album.mediaCount > 1}
					<div class="flex gap-2">
						<dt class="opacity-50">{m.music_discsLabel()}</dt>
						<dd class="flex items-center gap-1"><Disc3 class="h-3 w-3" />{album.mediaCount}</dd>
					</div>
				{/if}
				{#if album.labelName}
					<div class="flex gap-2">
						<dt class="opacity-50">{m.music_labelLabel()}</dt>
						<dd class="truncate">
							{album.labelName}{#if album.catalogNumber}<span class="opacity-50">
									· {album.catalogNumber}</span
								>{/if}
						</dd>
					</div>
				{/if}
			</dl>
		</div>
	</header>

	<section class="card mb-6 bg-base-200">
		<div class="card-body gap-3">
			<div class="flex items-center justify-between gap-3">
				<h2 class="card-title text-base">{m.music_releasesTitle()}</h2>
				<button class="btn btn-outline btn-sm" disabled={searchingReleases} onclick={findReleases}>
					{#if searchingReleases}
						<LoaderCircle class="h-4 w-4 animate-spin" />
					{:else}
						<Search class="h-4 w-4" />
					{/if}
					{m.music_findReleases()}
				</button>
				{#if candidates.some((candidate) => candidate.accepted)}
					<button
						class="btn btn-primary btn-sm"
						disabled={grabbingGuid !== null}
						onclick={() => grab(null)}
					>
						{#if grabbingGuid === 'best'}
							<LoaderCircle class="h-4 w-4 animate-spin" />
						{:else}
							<Download class="h-4 w-4" />
						{/if}
						{m.music_grabBest()}
					</button>
				{/if}
			</div>
			{#if grabError}
				<p class="text-sm text-error">{grabError}</p>
			{/if}
			{#if grabbed}
				<p class="text-sm text-success">{m.music_grabbed({ title: grabbed })}</p>
			{/if}
			{#if releaseError}
				<p class="text-sm opacity-70">{releaseError}</p>
			{/if}
			{#if candidates.length > 0}
				<table class="table table-sm">
					<thead>
						<tr>
							<th>{m.music_titleHeader()}</th>
							<th class="w-32">{m.music_indexer()}</th>
							<th class="w-24 text-right">{m.music_size()}</th>
							<th class="w-24">{m.music_quality()}</th>
							<th class="w-20 text-right">{m.music_seeders()}</th>
							<th class="w-16"></th>
						</tr>
					</thead>
					<tbody>
						{#each candidates as candidate (candidate.title + (candidate.indexerName ?? ''))}
							<tr class="hover">
								<td class="truncate">{candidate.title}</td>
								<td class="text-xs opacity-60">{candidate.indexerName ?? '–'}</td>
								<td class="text-right tabular-nums opacity-70">{gib(candidate.size)}</td>
								<td>
									<span class="badge badge-sm" class:badge-ghost={candidate.accepted === false}>
										{qualityLabel(candidate)}
									</span>
									{#if candidate.accepted === false && candidate.reasons?.length}
										<span class="ml-1 text-xs opacity-50">{candidate.reasons[0]}</span>
									{/if}
								</td>
								<td class="text-right tabular-nums">{candidate.seeders ?? '–'}</td>
								<td class="text-right">
									<button
										class="btn btn-ghost btn-xs"
										disabled={grabbingGuid !== null || candidate.accepted === false}
										title={candidate.accepted === false
											? (candidate.reasons?.[0] ?? m.music_grabFailed())
											: (candidate.tierLabel ?? '')}
										onclick={() => grab(candidate)}
									>
										{#if grabbingGuid === candidate.guid}
											<LoaderCircle class="h-3 w-3 animate-spin" />
										{:else}
											{m.music_grab()}
										{/if}
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</section>

	{#each discs as [disc, discTracks] (disc)}
		{#if discs.length > 1}
			<h2 class="mb-1 text-xs font-semibold tracking-wide uppercase opacity-50">
				{m.music_disc({ number: disc })}
			</h2>
		{/if}
		<table class="table table-sm">
			<thead>
				<tr>
					<th class="w-12">{m.music_trackHeader()}</th>
					<th>{m.music_titleHeader()}</th>
					<th class="w-20 text-right">{m.music_durationLabel()}</th>
					<th class="w-8"></th>
				</tr>
			</thead>
			<tbody>
				{#each discTracks as track (track.id)}
					<tr class="hover">
						<td class="opacity-50">{track.trackNumber ?? '–'}</td>
						<td>
							<p class="font-medium">{track.title}</p>
							{#if track.artistCredit && track.artistCredit !== album.artistName}
								<p class="text-xs opacity-50">{track.artistCredit}</p>
							{/if}
						</td>
						<td class="text-right tabular-nums opacity-60">{clock(track.duration)}</td>
						<td>
							{#if track.hasFile}
								<CircleCheck class="h-4 w-4 text-success" />
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/each}
</div>

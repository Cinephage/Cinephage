<script lang="ts">
	import { goto } from '$app/navigation';
	import { ArrowLeft, Check, Clock, Disc3, LoaderCircle, Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';

	type Track = {
		title: string;
		artistCredit?: string | null;
		discNumber: number;
		trackNumber: number | null;
		duration?: number | null;
	};

	type Release = {
		labelName?: string | null;
		catalogNumber?: string | null;
		barcode?: string | null;
		country?: string | null;
		mediaCount: number;
		trackCount: number;
		duration: number;
		tracks: Track[];
	} | null;

	let {
		data
	}: {
		data: {
			group: {
				mbid: string;
				title: string;
				primaryType?: string | null;
				secondaryTypes: string[];
				firstReleaseDate?: string | null;
				year?: number | null;
				artist: { mbid: string; name: string };
			};
			release: Release;
			libraryAlbumId: string | null;
		};
	} = $props();

	const group = $derived(data.group);
	const release = $derived(data.release);
	const artistHref = $derived(`/discover/music/artist/${group.artist.mbid}`);

	let busy = $state(false);
	let coverError = $state(false);

	function clock(seconds?: number | null): string {
		if (!seconds) return '–';
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${String(secs).padStart(2, '0')}`;
	}

	const discs = $derived.by(() => {
		const tracks = release?.tracks ?? [];
		const groups = new Map<number, Track[]>();
		for (const track of tracks) {
			const disc = track.discNumber ?? 1;
			groups.set(disc, [...(groups.get(disc) ?? []), track]);
		}
		return [...groups.entries()].sort((a, b) => a[0] - b[0]);
	});

	/** Same contract as the Music library page: one POST, idempotent server-side. */
	async function addToLibrary() {
		if (busy) return;
		busy = true;
		try {
			const response = await fetch('/api/music/albums', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ releaseGroupMbid: group.mbid, libraryId: null })
			});
			const body = await response.json();
			if (!response.ok) {
				toasts.error(body.details ?? body.error ?? m.music_addFailed());
				return;
			}
			toasts.success(
				body.created
					? m.music_addedAlbum({ title: body.album?.title ?? group.title })
					: m.music_alreadyInLibrary({ title: body.album?.title ?? group.title })
			);
			if (typeof body.album?.id === 'string') {
				await goto(`/library/music/${body.album.id}`);
			} else {
				await goto('/library/music');
			}
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.music_addFailed());
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{group.title} · Cinephage</title></svelte:head>

<div class="mx-auto max-w-5xl p-4 sm:p-6">
	<a class="link link-hover mb-4 inline-flex items-center gap-1.5 text-sm opacity-60" href="/discover?type=music">
		<ArrowLeft class="h-4 w-4" />
		{m.nav_music()}
	</a>

	<header class="mb-6 flex flex-col gap-5 sm:flex-row">
		<div class="w-44 shrink-0">
			{#if !coverError}
				<img
					src={`https://coverartarchive.org/release-group/${group.mbid}/front-250`}
					alt={group.title}
					class="aspect-square h-full w-full rounded-lg object-cover shadow-md"
					onerror={() => (coverError = true)}
				/>
			{:else}
				<div class="flex aspect-square items-center justify-center rounded-lg bg-base-300">
					<Disc3 class="h-12 w-12 opacity-40" />
				</div>
			{/if}
		</div>

		<div class="min-w-0">
			<h1 class="text-2xl font-semibold">{group.title}</h1>
			<a class="link link-hover mt-1 inline-block text-lg opacity-80" href={artistHref}>
				{group.artist.name}
			</a>

			<div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
				{#if group.year}<span class="badge badge-ghost">{group.year}</span>{/if}
				{#if group.primaryType}<span class="badge badge-ghost">{group.primaryType}</span>{/if}
				{#each group.secondaryTypes as type (type)}
					<span class="badge badge-ghost">{type}</span>
				{/each}
				{#if data.libraryAlbumId}
					<a class="badge badge-success gap-1" href={`/library/music/${data.libraryAlbumId}`}>
						<Check class="h-3 w-3" />{m.music_inLibrary()}
					</a>
				{/if}
			</div>

			{#if release}
				<dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
					{#if release.tracks.length}
						<div class="flex gap-2">
							<dt class="opacity-50">{m.music_tracksLabel()}</dt>
							<dd>{release.tracks.length}</dd>
						</div>
					{/if}
					{#if release.duration}
						<div class="flex gap-2">
							<dt class="opacity-50">{m.music_durationLabel()}</dt>
							<dd class="flex items-center gap-1"><Clock class="h-3 w-3" />{clock(release.duration)}</dd>
						</div>
					{/if}
					{#if release.mediaCount > 1}
						<div class="flex gap-2">
							<dt class="opacity-50">{m.music_discsLabel()}</dt>
							<dd class="flex items-center gap-1"><Disc3 class="h-3 w-3" />{release.mediaCount}</dd>
						</div>
					{/if}
					{#if release.labelName}
						<div class="flex gap-2">
							<dt class="opacity-50">{m.music_labelLabel()}</dt>
							<dd class="truncate">
								{release.labelName}{#if release.catalogNumber}<span class="opacity-50"> · {release.catalogNumber}</span>{/if}
							</dd>
						</div>
					{/if}
				</dl>
			{/if}

			<div class="mt-4">
				{#if data.libraryAlbumId}
					<a class="btn btn-sm btn-primary" href={`/library/music/${data.libraryAlbumId}`}>
						{m.music_inLibrary()}
					</a>
				{:else}
					<button class="btn btn-sm btn-primary gap-1.5" onclick={addToLibrary} disabled={busy}>
						{#if busy}
							<LoaderCircle class="h-4 w-4 animate-spin" />
						{:else}
							<Plus class="h-4 w-4" />
						{/if}
						{m.music_addAlbum()}
					</button>
				{/if}
			</div>
		</div>
	</header>

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
				</tr>
			</thead>
			<tbody>
				{#each discTracks as track (track.title + track.trackNumber)}
					<tr class="hover">
						<td class="opacity-50">{track.trackNumber ?? '–'}</td>
						<td>
							<p class="font-medium">{track.title}</p>
							{#if track.artistCredit && track.artistCredit !== group.artist.name}
								<p class="text-xs opacity-50">{track.artistCredit}</p>
							{/if}
						</td>
						<td class="text-right tabular-nums opacity-60">{clock(track.duration)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/each}

	{#if !release?.tracks.length}
		<p class="opacity-50">{m.music_noResults()}</p>
	{/if}
</div>

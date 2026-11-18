<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Disc3, Search, Plus, LoaderCircle, User, ListMusic } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type {
		MusicArtistSearchResult,
		MusicRecordingHit,
		MusicReleaseGroup
	} from '#lib/server/music/types.js';

	type Kind = 'artist' | 'album' | 'song';

	let { data } = $props<{
		data: {
			library: {
				id: string;
				name: string;
				slug: string;
				rootFolderPath: string | null;
				rootFolderCount: number;
			} | null;
			albums: Array<{
				id: string;
				title: string;
				artistName: string;
				year: number | null;
				trackCount: number | null;
				hasFile: boolean | null;
				monitored: boolean | null;
				coverPath: string | null;
				path: string | null;
				hasCover: boolean;
			}>;
		};
	}>();

	let kind = $state<Kind>('artist');
	let artistQuery = $state('');
	let albumQuery = $state('');
	let songQuery = $state('');
	let searching = $state(false);
	let busy = $state<string | null>(null);
	let artistResults = $state<MusicArtistSearchResult[]>([]);
	let albumResults = $state<MusicReleaseGroup[]>([]);
	let songResults = $state<MusicRecordingHit[]>([]);
	let message = $state<{ kind: 'error' | 'info'; text: string } | null>(null);

	const canSearch = $derived(
		kind === 'artist'
			? artistQuery.trim().length > 0
			: kind === 'album'
				? artistQuery.trim().length > 0 || albumQuery.trim().length > 0
				: artistQuery.trim().length > 0 || songQuery.trim().length > 0
	);

	function resetResults() {
		artistResults = [];
		albumResults = [];
		songResults = [];
		message = null;
	}

	function setKind(next: Kind) {
		if (kind === next) return;
		kind = next;
		resetResults();
	}

	async function search() {
		if (!canSearch || searching) return;
		searching = true;
		resetResults();
		try {
			const params = new URLSearchParams({ type: kind });
			if (kind === 'artist') params.set('q', artistQuery.trim());
			if (kind === 'album') {
				if (artistQuery.trim()) params.set('artist', artistQuery.trim());
				if (albumQuery.trim()) params.set('album', albumQuery.trim());
			}
			if (kind === 'song') {
				if (artistQuery.trim()) params.set('artist', artistQuery.trim());
				if (songQuery.trim()) params.set('q', songQuery.trim());
			}

			const response = await fetch(`/api/music/search?${params}`);
			const body = await response.json();
			if (!response.ok) {
				message = { kind: 'error', text: body.details ?? body.error ?? m.music_searchFailed() };
				return;
			}
			if (kind === 'artist') artistResults = body.results ?? [];
			if (kind === 'album') albumResults = body.results ?? [];
			if (kind === 'song') songResults = body.results ?? [];

			const count = (body.results ?? []).length;
			if (count === 0) message = { kind: 'info', text: m.music_noResults() };
		} catch (err) {
			message = {
				kind: 'error',
				text: err instanceof Error ? err.message : m.music_searchFailed()
			};
		} finally {
			searching = false;
		}
	}

	async function addReleaseGroup(group: MusicReleaseGroup | { mbid: string }) {
		if (busy) return;
		busy = group.mbid;
		message = null;
		try {
			const response = await fetch('/api/music/albums', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ releaseGroupMbid: group.mbid, libraryId: data.library?.id ?? null })
			});
			const body = await response.json();
			if (!response.ok) {
				message = { kind: 'error', text: body.details ?? body.error ?? m.music_addFailed() };
				return;
			}
			albumResults = albumResults.filter((entry) => entry.mbid !== group.mbid);
			songResults = songResults.filter((entry) => entry.releaseGroup?.mbid !== group.mbid);
			message = {
				kind: 'info',
				text: body.created
					? m.music_addedAlbum({ title: body.album?.title ?? '' })
					: m.music_alreadyInLibrary({ title: body.album?.title ?? '' })
			};
			await invalidateAll();
		} catch (err) {
			message = { kind: 'error', text: err instanceof Error ? err.message : m.music_addFailed() };
		} finally {
			busy = null;
		}
	}

	/**
	 * A discography is added in batches: each album costs a few MusicBrainz
	 * requests at ~1.2 s, so the server writes up to 25 and reports what is left.
	 * We keep calling until it says zero, showing progress rather than hanging.
	 */
	async function addArtist(artist: MusicArtistSearchResult) {
		if (busy) return;
		busy = artist.mbid;
		message = null;
		let added = 0;
		let batches = 0;
		try {
			for (;;) {
				const response = await fetch('/api/music/artists', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						artist: { mbid: artist.mbid, name: artist.name, sortName: artist.sortName ?? null },
						limit: 25,
						libraryId: data.library?.id ?? null
					})
				});
				const body = await response.json();
				if (!response.ok) {
					message = { kind: 'error', text: body.details ?? body.error ?? m.music_addFailed() };
					return;
				}
				batches += 1;
				added += body.added ?? 0;
				message = {
					kind: 'info',
					text: m.music_addingArtist({
						artist: artist.name,
						added,
						remaining: body.remaining ?? 0
					})
				};
				await invalidateAll();
				if (!body.remaining || batches >= 12) break;
			}
		} catch (err) {
			message = { kind: 'error', text: err instanceof Error ? err.message : m.music_addFailed() };
		} finally {
			busy = null;
		}
	}
</script>

<div class="mx-auto max-w-7xl p-4 sm:p-6">
	<header class="mb-6 flex flex-wrap items-center justify-between gap-3">
		<div class="flex items-center gap-3">
			<Disc3 class="h-7 w-7 opacity-70" />
			<div>
				<h1 class="text-2xl font-semibold">{data.library?.name ?? m.nav_music()}</h1>
				<p class="text-sm opacity-60">
					{data.albums.length === 1
						? m.music_oneAlbum()
						: m.music_albumsCount({ count: data.albums.length })}
					{#if data.library && data.library.rootFolderCount === 0}
						· <span class="text-warning">{m.music_noRootFolder()}</span>
					{/if}
				</p>
			</div>
		</div>
	</header>

	<section class="card mb-6 bg-base-200">
		<div class="card-body gap-3">
			<div class="tabs tabs-box w-fit tabs-sm">
				<button class="tab" class:tab-active={kind === 'artist'} onclick={() => setKind('artist')}>
					<User class="mr-1 h-3.5 w-3.5" />{m.music_tabArtist()}
				</button>
				<button class="tab" class:tab-active={kind === 'album'} onclick={() => setKind('album')}>
					<Disc3 class="mr-1 h-3.5 w-3.5" />{m.music_tabAlbum()}
				</button>
				<button class="tab" class:tab-active={kind === 'song'} onclick={() => setKind('song')}>
					<ListMusic class="mr-1 h-3.5 w-3.5" />{m.music_tabSong()}
				</button>
			</div>

			<div class="flex flex-wrap items-end gap-3">
				<label class="form-control">
					<span class="label-text pb-1 text-xs uppercase opacity-60">{m.music_artistLabel()}</span>
					<input
						class="input-bordered input w-56 input-sm"
						bind:value={artistQuery}
						placeholder={m.music_artistPlaceholder()}
						onkeydown={(event) => event.key === 'Enter' && search()}
					/>
				</label>
				{#if kind === 'album'}
					<label class="form-control">
						<span class="label-text pb-1 text-xs uppercase opacity-60">{m.music_albumLabel()}</span>
						<input
							class="input-bordered input w-56 input-sm"
							bind:value={albumQuery}
							placeholder={m.music_albumPlaceholder()}
							onkeydown={(event) => event.key === 'Enter' && search()}
						/>
					</label>
				{/if}
				{#if kind === 'song'}
					<label class="form-control">
						<span class="label-text pb-1 text-xs uppercase opacity-60">{m.music_songLabel()}</span>
						<input
							class="input-bordered input w-56 input-sm"
							bind:value={songQuery}
							placeholder={m.music_songPlaceholder()}
							onkeydown={(event) => event.key === 'Enter' && search()}
						/>
					</label>
				{/if}
				<button class="btn btn-primary btn-sm" disabled={!canSearch || searching} onclick={search}>
					{#if searching}
						<LoaderCircle class="h-4 w-4 animate-spin" />
					{:else}
						<Search class="h-4 w-4" />
					{/if}
					{m.music_search()}
				</button>
			</div>

			{#if message}
				<p
					class="text-sm"
					class:opacity-70={message.kind === 'info'}
					class:text-error={message.kind === 'error'}
				>
					{message.text}
				</p>
			{/if}

			{#if artistResults.length > 0}
				<ul class="mt-2 divide-y divide-base-300">
					{#each artistResults as artist (artist.mbid)}
						<li class="flex items-center justify-between gap-3 py-2">
							<div class="min-w-0">
								<p class="truncate font-medium">{artist.name}</p>
								<p class="truncate text-sm opacity-60">
									{[artist.type, artist.country, artist.disambiguation].filter(Boolean).join(' · ')}
								</p>
							</div>
							<button
								class="btn btn-outline btn-sm"
								disabled={busy !== null}
								onclick={() => addArtist(artist)}
							>
								{#if busy === artist.mbid}
									<LoaderCircle class="h-4 w-4 animate-spin" />
								{:else}
									<Plus class="h-4 w-4" />
								{/if}
								{m.music_addArtist()}
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if albumResults.length > 0}
				<ul class="mt-2 divide-y divide-base-300">
					{#each albumResults as group (group.mbid)}
						<li class="flex items-center justify-between gap-3 py-2">
							<div class="min-w-0">
								<p class="truncate font-medium">
									{group.title}
									{#if group.year}<span class="opacity-60">({group.year})</span>{/if}
								</p>
								<p class="truncate text-sm opacity-60">
									{group.artist.name}
									{#if group.primaryType}· {group.primaryType}{/if}
									{#if group.secondaryTypes.length}· {group.secondaryTypes.join(', ')}{/if}
								</p>
							</div>
							<button
								class="btn btn-outline btn-sm"
								disabled={busy !== null}
								onclick={() => addReleaseGroup(group)}
							>
								{#if busy === group.mbid}
									<LoaderCircle class="h-4 w-4 animate-spin" />
								{:else}
									<Plus class="h-4 w-4" />
								{/if}
								{m.music_add()}
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if songResults.length > 0}
				<ul class="mt-2 divide-y divide-base-300">
					{#each songResults as song (song.mbid)}
						<li class="flex items-center justify-between gap-3 py-2">
							<div class="min-w-0">
								<p class="truncate font-medium">{song.title}</p>
								<p class="truncate text-sm opacity-60">
									{song.artistCredit}
									{#if song.releaseGroup}· {song.releaseGroup.title}{/if}
								</p>
							</div>
							{#if song.releaseGroup}
								<button
									class="btn btn-outline btn-sm"
									disabled={busy !== null}
									onclick={() => addReleaseGroup({ mbid: song.releaseGroup!.mbid })}
								>
									{#if busy === song.releaseGroup.mbid}
										<LoaderCircle class="h-4 w-4 animate-spin" />
									{:else}
										<Plus class="h-4 w-4" />
									{/if}
									{m.music_addAlbumContaining()}
								</button>
							{:else}
								<span class="text-xs opacity-50">{m.music_noAlbumForSong()}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	{#if data.albums.length === 0}
		<div class="rounded-box border border-dashed border-base-300 p-10 text-center">
			<Disc3 class="mx-auto mb-3 h-8 w-8 opacity-40" />
			<p class="font-medium">{m.music_emptyTitle()}</p>
			<p class="text-sm opacity-60">{m.music_emptyHint()}</p>
		</div>
	{:else}
		<ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
			{#each data.albums as album (album.id)}
				<li>
					<a class="group block" href={`/library/music/${album.id}`}>
						<div class="relative aspect-square overflow-hidden rounded-lg bg-base-300">
							{#if album.hasCover}
								<img
									src={`/api/music/albums/${album.id}/cover`}
									alt={album.title}
									class="h-full w-full object-cover transition group-hover:scale-105"
									loading="lazy"
								/>
							{:else}
								<div class="flex h-full w-full items-center justify-center">
									<Disc3 class="h-10 w-10 opacity-30" />
								</div>
							{/if}
						</div>
						<p class="mt-2 truncate text-sm font-medium">{album.title}</p>
						<p class="truncate text-xs opacity-60">
							{album.artistName}{#if album.year}
								· {album.year}{/if}
						</p>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

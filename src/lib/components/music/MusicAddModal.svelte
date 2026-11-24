<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Disc3, ListMusic, LoaderCircle, Plus, Search, User } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';
	import type {
		MusicArtistSearchResult,
		MusicRecordingHit,
		MusicReleaseGroup
	} from '#lib/server/music/types.js';

	type Kind = 'artist' | 'album' | 'song';

	type Props = {
		open: boolean;
		onClose: () => void;
		libraryId?: string | null;
		/** What "default" resolves to here: the library's profile, or the instance default. */
		defaultProfileName?: string | null;
		/** The library's search-on-add default, the same setting the video add uses. */
		defaultSearchOnAdd?: boolean;
	};

	let {
		open,
		onClose,
		libraryId = null,
		defaultProfileName = null,
		defaultSearchOnAdd = true
	}: Props = $props();

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
	/** Assignment at the door: artist rows carry it, single albums carry it. */
	let qualityProfiles = $state<Array<{ id: string; name: string }>>([]);
	let qualityProfileId = $state('');
	let searchOnAdd = $state(true);

	// Every open starts from the library's setting, like the video add does.
	$effect(() => {
		if (open) searchOnAdd = defaultSearchOnAdd;
	});

	onMount(() => {
		void (async () => {
			try {
				const response = await fetch('/api/scoring-profiles?mediaKind=music');
				if (!response.ok) return;
				const body = (await response.json()) as {
					profiles?: Array<{ id: string; name: string }>;
				};
				qualityProfiles = (body.profiles ?? []).map((profile) => ({
					id: profile.id,
					name: profile.name
				}));
			} catch {
				qualityProfiles = [];
			}
		})();
	});

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

			if ((body.results ?? []).length === 0) message = { kind: 'info', text: m.music_noResults() };
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
				body: JSON.stringify({
					releaseGroupMbid: group.mbid,
					libraryId,
					qualityProfileId: qualityProfileId || null,
					searchOnAdd
				})
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
						libraryId,
						qualityProfileId: qualityProfileId || null,
						searchOnAdd
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

<ModalWrapper {open} onClose={onClose} maxWidth="2xl">
	<div class="mb-1 flex items-start justify-between gap-4">
		<div>
			<h2 class="text-lg font-bold">{m.music_addMusic()}</h2>
			<p class="mt-0.5 text-sm text-base-content/55">{m.music_addMusicHint()}</p>
		</div>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose} aria-label={m.action_close()}>✕</button>
	</div>

	<div class="tabs tabs-box tabs-sm mt-3 w-fit">
		<button class="tab gap-1.5" class:tab-active={kind === 'artist'} onclick={() => setKind('artist')}>
			<User class="h-3.5 w-3.5" />{m.music_tabArtist()}
		</button>
		<button class="tab gap-1.5" class:tab-active={kind === 'album'} onclick={() => setKind('album')}>
			<Disc3 class="h-3.5 w-3.5" />{m.music_tabAlbum()}
		</button>
		<button class="tab gap-1.5" class:tab-active={kind === 'song'} onclick={() => setKind('song')}>
			<ListMusic class="h-3.5 w-3.5" />{m.music_tabSong()}
		</button>
	</div>

	<div class="mt-4 flex flex-wrap items-end gap-2">
		<label class="form-control w-full sm:w-80">
			<span class="mb-1 text-xs text-base-content/55">{m.common_qualityProfile()}</span>
			<select class="select-bordered select select-sm" bind:value={qualityProfileId}>
				<option value="">
					{defaultProfileName
						? m.music_useDefaultProfile({ name: defaultProfileName })
						: m.common_default()}
				</option>
				{#each qualityProfiles as profile (profile.id)}
					<option value={profile.id}>{profile.name}</option>
				{/each}
			</select>
		</label>
		<label class="flex cursor-pointer items-center gap-3 pb-1">
			<input type="checkbox" class="toggle toggle-sm toggle-success" bind:checked={searchOnAdd} />
			<span class="flex items-center gap-1.5 text-sm">
				<Search class="h-4 w-4 shrink-0" />
				{m.library_add_searchImmediately()}
			</span>
		</label>
	</div>

	<form
		class="mt-4 flex flex-col gap-2 sm:flex-row"
		onsubmit={(event) => {
			event.preventDefault();
			search();
		}}
	>
		<label class="input w-full">
			<input
				class="grow"
				placeholder={m.music_artistPlaceholder()}
				bind:value={artistQuery}
				aria-label={m.music_tabArtist()}
			/>
		</label>
		{#if kind === 'album'}
			<input
				class="input w-full"
				placeholder={m.music_albumPlaceholder()}
				bind:value={albumQuery}
				aria-label={m.music_tabAlbum()}
			/>
		{/if}
		{#if kind === 'song'}
			<input
				class="input w-full"
				placeholder={m.music_songPlaceholder()}
				bind:value={songQuery}
				aria-label={m.music_songLabel()}
			/>
		{/if}
		<button class="btn gap-1.5 btn-primary" type="submit" disabled={!canSearch || searching}>
			{#if searching}
				<LoaderCircle class="h-4 w-4 animate-spin" />
			{:else}
				<Search class="h-4 w-4" />
			{/if}
			{m.music_search()}
		</button>
	</form>

	{#if message}
		<p class="mt-3 text-sm {message.kind === 'error' ? 'text-error' : 'text-base-content/70'}">
			{message.text}
		</p>
	{/if}

	<div class="mt-4 max-h-[55vh] overflow-y-auto pr-1">
		{#if artistResults.length > 0}
			<ul class="divide-y divide-base-content/10">
				{#each artistResults as artist (artist.mbid)}
					<li class="flex items-center justify-between gap-3 py-2.5">
						<div class="min-w-0">
							<p class="truncate font-medium">{artist.name}</p>
							<p class="truncate text-xs text-base-content/55">
								{[artist.type, artist.country, artist.disambiguation].filter(Boolean).join(' · ')}
							</p>
						</div>
						<button
							class="btn gap-1.5 btn-outline btn-sm"
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
			<ul class="divide-y divide-base-content/10">
				{#each albumResults as group (group.mbid)}
					<li class="flex items-center justify-between gap-3 py-2.5">
						<div class="min-w-0">
							<p class="truncate font-medium">
								{group.title}
								{#if group.year}<span class="text-base-content/45">({group.year})</span>{/if}
							</p>
							<p class="truncate text-xs text-base-content/55">
								{[group.artist.name, group.primaryType, ...(group.secondaryTypes ?? [])]
									.filter(Boolean)
									.join(' · ')}
							</p>
						</div>
						<button
							class="btn gap-1.5 btn-outline btn-sm"
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
			<ul class="divide-y divide-base-content/10">
				{#each songResults as song (song.mbid)}
					<li class="flex items-center justify-between gap-3 py-2.5">
						<div class="min-w-0">
							<p class="truncate font-medium">{song.title}</p>
							<p class="truncate text-xs text-base-content/55">
								{song.artistCredit}
								{#if song.releaseGroup}· {song.releaseGroup.title}{/if}
							</p>
						</div>
						{#if song.releaseGroup}
							<button
								class="btn gap-1.5 btn-outline btn-sm"
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
							<span class="text-xs text-base-content/40">{m.music_noAlbumForSong()}</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if !searching && !message && artistResults.length === 0 && albumResults.length === 0 && songResults.length === 0}
			<div class="rounded-box border border-dashed border-base-content/15 px-6 py-10 text-center">
				<Search class="mx-auto mb-2 h-6 w-6 text-base-content/25" />
				<p class="text-sm text-base-content/55">{m.music_addMusicHint()}</p>
			</div>
		{/if}
	</div>
</ModalWrapper>

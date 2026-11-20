<script lang="ts">
	import { Check, LoaderCircle, Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { invalidateAll } from '$app/navigation';
	import LibraryMediaCard from '#lib/components/library/LibraryMediaCard.svelte';
	import MusicAddConfirmModal from '#lib/components/music/MusicAddConfirmModal.svelte';
	import { albumCardView, artistCardView } from '#lib/components/library/media-view.js';
	import type { MusicRowItem } from './music-row-item.js';

	let { item, onAdded }: { item: MusicRowItem; onAdded?: () => void } = $props();

	type AddState = 'idle' | 'added' | 'exists' | 'missing' | 'failed';

	let busy = $state(false);
	let confirmOpen = $state(false);
	// Not named `state`: it collides with svelte-check's generated component
	// scope and breaks the TS transform for the whole file.
	let addState = $state<AddState>('idle');

	const title = $derived(item.title ?? '');
	const done = $derived(addState === 'added' || addState === 'exists');
	const isArtist = $derived(item.musicKind === 'artist');
	const isSong = $derived(item.musicKind === 'song');
	/** A song opens and adds its album — that is the unit acquisition acts on. */
	const albumLabel = $derived(isSong ? (item.album_title ?? item.title ?? '') : title);

	// A row links to the page its provider can render: a MusicBrainz id opens the
	// canonical page, a Deezer row opens the provider-backed one. There is no
	// resolver hop any more — that used to cost a rate-gated lookup per click
	// before anything painted (2.8 s for an album, 3.4 s for an artist).
	const target = $derived.by(() => {
		if (item.mbid) {
			return isArtist ? `/discover/music/artist/${item.mbid}` : `/discover/music/${item.mbid}`;
		}
		const deezerId = isSong ? item.deezerAlbumId : item.deezerId;
		if (typeof deezerId === 'number') {
			return isArtist
				? `/discover/music/artist/deezer-artist-${deezerId}`
				: `/discover/music/deezer-album-${deezerId}`;
		}
		return null;
	});

	/** The same tile the library uses — music's grid is a grid, not a row list. */
	const href = $derived(target ?? '/discover?type=music');

	const view = $derived(
		isArtist
			? artistCardView(
					{
						id: item.id,
						name: title,
						albumCount: 0,
						inLibraryCount: 0,
						monitored: null,
						mbid: item.mbid ?? null
					},
					{
						artUrl: item.image_url ?? null,
						href,
						hideState: true,
						hideMonitored: true
					}
				)
			: albumCardView(
					{
						id: item.id,
						title,
						artistName: item.subtitle ?? '',
						year: null,
						primaryType: null,
						hasFile: false,
						monitored: null,
						mbid: item.mbid ?? null
					},
					{
						artUrl: item.image_url ?? null,
						href,
						hideState: true,
						hideMonitored: true,
						label: isSong ? m.music_tabSong() : undefined
					}
				)
	);

	async function resolveTarget(): Promise<string | null> {
		// An artist row resolves as an artist; albums and songs resolve through
		// the album — a song's own title is not a release group.
		const params = isArtist
			? new URLSearchParams({ type: 'artist', q: title })
			: new URLSearchParams({ type: 'album' });
		if (!isArtist) {
			if (item.subtitle) params.set('artist', item.subtitle);
			if (albumLabel) params.set('album', albumLabel);
		}
		const search = await fetch(`/api/music/search?${params}`).then((r) => r.json());
		const hit = (search.results ?? [])[0] as { mbid?: string } | undefined;
		return hit?.mbid ?? null;
	}

	/**
	 * Quick add without leaving the grid: the plus opens the same profile
	 * choice every other add surface has, then resolves the release group and
	 * adds the top hit.
	 */
	function openConfirm(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		if (busy || done || isArtist) return;
		confirmOpen = true;
	}

	async function add(profileId: string | null) {
		if (busy || done) return;
		busy = true;
		addState = 'idle';
		try {
			const mbid = await resolveTarget();
			if (!mbid) {
				addState = 'missing';
				return;
			}
			const response = await fetch('/api/music/albums', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					releaseGroupMbid: mbid,
					libraryId: null,
					qualityProfileId: profileId
				})
			});
			const body = await response.json();
			if (!response.ok) {
				addState = 'failed';
				return;
			}
			addState = body.created ? 'added' : 'exists';
			await invalidateAll();
			onAdded?.();
		} catch {
			addState = 'failed';
		} finally {
			busy = false;
		}
	}
</script>

<div class="relative">
	<LibraryMediaCard {view} />

	{#if !isArtist}
		<button
			class="btn absolute right-2 bottom-2 z-20 btn-circle shadow-lg btn-xs {done
				? 'btn-success'
				: 'btn-primary'}"
			onclick={openConfirm}
			disabled={busy || done}
			title={done ? m.music_inLibrary() : m.music_addAlbum()}
			aria-label={done ? m.music_inLibrary() : m.music_addAlbum()}
		>
			{#if busy}
				<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
			{:else if done}
				<Check class="h-3.5 w-3.5" />
			{:else}
				<Plus class="h-3.5 w-3.5" />
			{/if}
		</button>
	{/if}

	<MusicAddConfirmModal
		open={confirmOpen}
		kind="album"
		title={albumLabel}
		subtitle={item.subtitle ?? null}
		onAdd={add}
		onClose={() => (confirmOpen = false)}
	/>
</div>

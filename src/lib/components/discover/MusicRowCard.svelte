<script lang="ts">
	import { Check, LoaderCircle, Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { invalidateAll } from '$app/navigation';
	import LibraryMediaCard from '#lib/components/library/LibraryMediaCard.svelte';
	import { albumCardView, artistCardView } from '#lib/components/library/media-view.js';
	import type { MusicRowItem } from './music-row-item.js';

	let { item, onAdded }: { item: MusicRowItem; onAdded?: () => void } = $props();

	type AddState = 'idle' | 'added' | 'exists' | 'missing' | 'failed';

	let busy = $state(false);
	// Not named `state`: it collides with svelte-check's generated component
	// scope and breaks the TS transform for the whole file.
	let addState = $state<AddState>('idle');

	const title = $derived(item.title ?? '');
	const done = $derived(addState === 'added' || addState === 'exists');
	const isArtist = $derived(item.musicKind === 'artist');
	const isSong = $derived(item.musicKind === 'song');
	/** A song opens and adds its album — that is the unit acquisition acts on. */
	const albumLabel = $derived(isSong ? (item.album_title ?? item.title ?? '') : title);

	// Search rows carry a MusicBrainz id; chart rows do not. A row without one
	// links to the resolver, so the tile is a real link the moment it renders —
	// the server pays the rate gate, not the click.
	const target = $derived.by(() => {
		const mbid = item.mbid;
		if (!mbid) return null;
		return isArtist ? `/discover/music/artist/${mbid}` : `/discover/music/${mbid}`;
	});

	/** The same tile the library uses — music's grid is a grid, not a row list. */
	const fallbackHref = $derived.by(() => {
		const params = new URLSearchParams({
			kind: isArtist ? 'artist' : 'album',
			title
		});
		if (!isArtist) {
			if (item.subtitle) params.set('artist', item.subtitle);
			params.set('album', albumLabel);
		}
		return `/discover/music/resolve?${params}`;
	});

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
						href: target ?? fallbackHref,
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
						href: target ?? fallbackHref,
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
	 * Quick add without leaving the grid: resolve the release group the same
	 * way the Music library page does, then add the top hit.
	 */
	async function add(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		if (busy || done || isArtist) return;
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
				body: JSON.stringify({ releaseGroupMbid: mbid, libraryId: null })
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
			class="absolute right-2 bottom-2 z-20 btn btn-circle btn-xs shadow-lg {done
				? 'btn-success'
				: 'btn-primary'}"
			onclick={add}
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

</div>

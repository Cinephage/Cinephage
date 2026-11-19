<script lang="ts">
	import { Check, LoaderCircle, Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { goto, invalidateAll } from '$app/navigation';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import LibraryMediaCard from '#lib/components/library/LibraryMediaCard.svelte';
	import { albumCardView, artistCardView } from '#lib/components/library/media-view.js';
	import type { MusicRowItem } from './music-row-item.js';

	let { item, onAdded }: { item: MusicRowItem; onAdded?: () => void } = $props();

	type AddState = 'idle' | 'added' | 'exists' | 'missing' | 'failed';

	let busy = $state(false);
	// Not named `state`: it collides with svelte-check's generated component
	// scope and breaks the TS transform for the whole file.
	let addState = $state<AddState>('idle');
	let resolving = $state(false);

	const title = $derived(item.title ?? '');
	const done = $derived(addState === 'added' || addState === 'exists');
	const isArtist = $derived(item.musicKind === 'artist');

	// Search rows resolve a MusicBrainz id on open; chart rows do not carry one
	// until the resolver runs, so the card navigates through this handler.
	const target = $derived.by(() => {
		if (!item.mbid) return null;
		return isArtist ? `/discover/music/artist/${item.mbid}` : `/discover/music/${item.mbid}`;
	});

	/** The same tile the library uses — music's grid is a grid, not a row list. */
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
						href: target ?? '/discover?type=music',
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
						href: target ?? '/discover?type=music',
						hideState: true,
						hideMonitored: true
					}
				)
	);

	async function resolveTarget(): Promise<string | null> {
		const params = new URLSearchParams({ type: 'album' });
		if (item.subtitle && !isArtist) params.set('artist', item.subtitle);
		if (item.title) params.set('album', item.title);
		const search = await fetch(`/api/music/search?${params}`).then((r) => r.json());
		const group = (search.results ?? [])[0] as { mbid?: string } | undefined;
		return group?.mbid ?? null;
	}

	async function open(event: MouseEvent) {
		if (target) return;
		event.preventDefault();
		if (resolving) return;
		resolving = true;
		try {
			const mbid = await resolveTarget();
			if (!mbid) {
				toasts.error(m.music_noResults());
				return;
			}
			await goto(isArtist ? `/discover/music/artist/${mbid}` : `/discover/music/${mbid}`);
		} catch {
			toasts.error(m.music_noResults());
		} finally {
			resolving = false;
		}
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
	<LibraryMediaCard {view} onActivate={open} />

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

	{#if resolving}
		<div class="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-base-100/60">
			<LoaderCircle class="h-6 w-6 animate-spin text-primary" />
		</div>
	{/if}
</div>

<script lang="ts">
	import { Check, Disc3, LoaderCircle, Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { goto, invalidateAll } from '$app/navigation';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import type { MusicRowItem } from './music-row-item.js';

	let { item, onAdded }: { item: MusicRowItem; onAdded?: () => void } = $props();

	type AddState = 'idle' | 'added' | 'exists' | 'missing' | 'failed';

	let busy = $state(false);
	// Not named `state`: it collides with svelte-check's generated component
	// scope and breaks the TS transform for the whole file.
	let addState = $state<AddState>('idle');
	let resolving = $state(false);
	let errored = $state(false);

	const title = $derived(item.title ?? '');
	const done = $derived(addState === 'added' || addState === 'exists');
	const isArtist = $derived(item.musicKind === 'artist');
	const badge = $derived(isArtist ? m.music_artistLabel() : m.nav_music());

	// Search rows carry their MusicBrainz id and link straight to the detail
	// pages; Deezer chart rows resolve on click and navigate.
	const target = $derived.by(() => {
		if (!item.mbid) return null;
		return isArtist ? `/discover/music/artist/${item.mbid}` : `/discover/music/${item.mbid}`;
	});

	async function open() {
		if (resolving || target) return;
		resolving = true;
		try {
			const params = new URLSearchParams({ type: 'album' });
			if (item.subtitle && !isArtist) params.set('artist', item.subtitle);
			if (item.title) params.set('album', item.title);
			const search = await fetch(`/api/music/search?${params}`).then((r) => r.json());
			const group = (search.results ?? [])[0] as { mbid?: string } | undefined;
			if (group?.mbid) {
				await goto(`/discover/music/${group.mbid}`);
				return;
			}
			toasts.error(m.music_noResults());
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
	async function add(event?: Event) {
		event?.preventDefault();
		event?.stopPropagation();
		if (busy || done || isArtist) return;
		busy = true;
		addState = 'idle';
		try {
			const params = new URLSearchParams({ type: 'album' });
			if (item.subtitle) params.set('artist', item.subtitle);
			if (item.title) params.set('album', item.title);
			const search = await fetch(`/api/music/search?${params}`).then((r) => r.json());
			const group = (search.results ?? [])[0] as { mbid?: string } | undefined;
			if (!group?.mbid) {
				addState = 'missing';
				return;
			}
			const response = await fetch('/api/music/albums', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ releaseGroupMbid: group.mbid, libraryId: null })
			});
			const body = await response.json();
			if (!response.ok) {
				addState = 'failed';
				return;
			}
			addState = body.created ? 'added' : 'exists';
			onAdded?.();
			await invalidateAll();
		} catch {
			addState = 'failed';
		} finally {
			busy = false;
		}
	}
</script>

{#snippet chrome()}
	{#if item.image_url && !errored}
		<img
			src={item.image_url}
			alt={title}
			loading="lazy"
			class="h-full w-full object-cover"
			onerror={() => (errored = true)}
		/>
	{:else}
		<div class="flex h-full w-full items-center justify-center">
			<Disc3 class="h-12 w-12 opacity-40" />
		</div>
	{/if}

	<!-- Top-right: quick add (albums only) + kind badge -->
	<div class="absolute top-2 right-2 z-10 flex items-center gap-1">
		{#if !isArtist}
			<button
				type="button"
				class="flex h-8 w-8 items-center justify-center rounded-full shadow-lg transition-all
					{addState === 'failed' || addState === 'missing'
					? 'bg-error/90 text-error-content'
					: done
						? 'bg-success/90 text-success-content'
						: 'bg-primary text-primary-content opacity-0 group-hover:opacity-100 hover:scale-110 focus-visible:opacity-100 active:scale-95'}"
				title={done ? m.music_inLibrary() : m.tmdb_addToLibrary()}
				aria-label={done ? m.music_inLibrary() : m.tmdb_addToLibrary()}
				disabled={busy || done}
				onclick={add}
			>
				{#if busy}
					<LoaderCircle class="h-4 w-4 animate-spin" />
				{:else if done}
					<Check class="h-4 w-4" strokeWidth={3} />
				{:else}
					<Plus class="h-5 w-5" strokeWidth={2.5} />
				{/if}
			</button>
		{/if}
		<span class="badge border-none badge-sm font-semibold shadow-sm backdrop-blur-sm badge-neutral/80">
			{badge}
		</span>
	</div>

	<!-- Hover overlay, same grammar as the movie/TV card -->
	<div
		class="absolute inset-0 flex flex-col justify-end bg-linear-to-t from-black/90 via-black/20 to-transparent p-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
	>
		<div class="translate-y-4 transform transition-transform duration-300 group-hover:translate-y-0">
			<h3 class="line-clamp-2 text-sm leading-tight font-bold text-white">{title}</h3>
			{#if item.subtitle}
				<p class="mt-0.5 line-clamp-1 text-xs font-medium text-white/70">{item.subtitle}</p>
			{/if}
			{#if addState === 'missing'}
				<p class="mt-0.5 text-xs font-medium text-white/50">{m.music_noResults()}</p>
			{:else if addState === 'failed'}
				<p class="mt-0.5 text-xs font-medium text-white/50">{m.music_addFailed()}</p>
			{:else if resolving}
				<p class="mt-0.5 text-xs font-medium text-white/50">{m.common_searching()}</p>
			{/if}
		</div>
	</div>
{/snippet}

{#if target}
	<a
		href={target}
		class="group relative block aspect-square overflow-hidden rounded-lg bg-base-300 shadow-md transition-all duration-300 hover:scale-105"
	>
		{@render chrome()}
	</a>
{:else}
	<button
		type="button"
		onclick={() => open()}
		class="group relative block aspect-square overflow-hidden rounded-lg bg-base-300 shadow-md transition-all duration-300 hover:scale-105"
	>
		{@render chrome()}
	</button>
{/if}

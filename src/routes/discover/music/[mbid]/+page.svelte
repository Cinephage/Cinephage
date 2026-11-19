<script lang="ts">
	import { goto } from '$app/navigation';
	import { Check, Plus } from '@lucide/svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import AlbumHero from '#lib/components/music/AlbumHero.svelte';
	import TrackList from '#lib/components/music/TrackList.svelte';
	import type { AlbumHeroAlbum, TrackListTrack } from '#lib/components/music/music-card.js';

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
		status?: string | null;
		year?: number | null;
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
				/** Null when the page came from Deezer; the id is then `deezerId`. */
				mbid: string | null;
				deezerId: number | null;
				title: string;
				primaryType?: string | null;
				secondaryTypes: string[];
				firstReleaseDate?: string | null;
				year?: number | null;
				artist: { mbid: string | null; deezerId: number | null; name: string };
			};
			release: Release;
			libraryAlbumId: string | null;
			featured: string[];
			/** Deezer cover; null on a MusicBrainz page, which uses the archive. */
			artworkUrl: string | null;
		};
	} = $props();

	const group = $derived(data.group);
	const release = $derived(data.release);
	// The release group is the album. Missing edition details simply drop out of
	// the hero rather than blanking the page.
	const album = $derived<AlbumHeroAlbum>({
		id: group.mbid ?? `deezer-album-${group.deezerId ?? ''}`,
		title: group.title,
		artistName: group.artist.name,
		artistMbid: group.artist.mbid,
		year: group.year ?? release?.year ?? null,
		primaryType: group.primaryType ?? null,
		secondaryTypes: group.secondaryTypes,
		status: release?.status ?? null,
		labelName: release?.labelName ?? null,
		catalogNumber: release?.catalogNumber ?? null,
		barcode: release?.barcode ?? null,
		country: release?.country ?? null,
		mediaCount: release?.mediaCount ?? null,
		trackCount: release?.trackCount ?? null,
		duration: release?.duration ?? null,
		// Null on a catalog page: no library row means no file state to report.
		hasFile: data.libraryAlbumId ? true : null,
		mbid: group.mbid
	});

	/** The provider that answered this page owns the art and the artist link. */
	const coverUrl = $derived(
		data.artworkUrl ??
			(group.mbid ? `https://coverartarchive.org/release-group/${group.mbid}/front-500` : null)
	);
	const artistHref = $derived(
		group.artist.mbid
			? `/discover/music/artist/${group.artist.mbid}`
			: typeof group.artist.deezerId === 'number'
				? `/discover/music/artist/deezer-artist-${group.artist.deezerId}`
				: null
	);

	const tracks = $derived<TrackListTrack[]>(
		(release?.tracks ?? []).map((track, index) => ({
			id: `${track.discNumber}-${track.trackNumber ?? index}-${track.title}`,
			title: track.title,
			artistCredit: track.artistCredit ?? null,
			discNumber: track.discNumber,
			trackNumber: track.trackNumber,
			duration: track.duration ?? null,
			hasFile: null
		}))
	);

	let busy = $state(false);

	/**
	 * A Deezer page carries no MusicBrainz id, and adding is the one action that
	 * needs it. Resolve here, behind the spinner — never in the page load, which
	 * is what made every click wait on the rate gate.
	 */
	async function resolveMbid(): Promise<string | null> {
		if (group.mbid) return group.mbid;
		const params = new SvelteURLSearchParams({ type: 'album', album: group.title });
		if (group.artist.name) params.set('artist', group.artist.name);
		const body = await fetch(`/api/music/search?${params}`).then((r) => r.json());
		const hit = (body.results ?? [])[0] as { mbid?: string } | undefined;
		return hit?.mbid ?? null;
	}

	/** Same contract as the library page: one POST, idempotent server-side. */
	async function addToLibrary() {
		if (busy) return;
		busy = true;
		try {
			const mbid = await resolveMbid();
			if (!mbid) {
				toasts.error(m.music_addFailed());
				return;
			}
			const response = await fetch('/api/music/albums', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ releaseGroupMbid: mbid, libraryId: null })
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

<div class="w-full px-4 pt-4 pb-20 md:px-6 lg:px-8">
	<AlbumHero
		{album}
		{coverUrl}
		{artistHref}
		backHref="/discover?type=music"
		backLabel={m.nav_music()}
		readOnly
		featured={data.featured}
		extraActions={data.libraryAlbumId
			? [
					{
						key: 'in-library',
						icon: Check,
						label: m.music_inLibrary(),
						href: `/library/music/${data.libraryAlbumId}`,
						tone: 'success'
					}
				]
			: [
					{
						key: 'add',
						icon: Plus,
						label: m.music_addAlbum(),
						emphasis: 'primary',
						busy,
						onSelect: addToLibrary
					}
				]}
	/>

	{#if tracks.length > 0}
		<div class="mt-5">
			<TrackList {tracks} artistName={group.artist.name} showFileState={false} />
		</div>
	{:else}
		<div class="mt-5 rounded-xl border border-dashed border-base-content/15 px-6 py-12 text-center text-sm text-base-content/55">
			{m.music_noTracks()}
		</div>
	{/if}
</div>
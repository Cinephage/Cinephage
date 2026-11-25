<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Plus } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import * as m from '#lib/paraglide/messages.js';
	import { releaseGroupCoverUrl } from '#lib/music/cover-art.js';
	import ArtistHero from '#lib/components/music/ArtistHero.svelte';
	import MusicAddConfirmModal from '#lib/components/music/MusicAddConfirmModal.svelte';
	import LibraryMediaCard from '#lib/components/library/LibraryMediaCard.svelte';
	import { albumCardView } from '#lib/components/library/media-view.js';
	import { toasts } from '#lib/stores/toast.svelte.js';

	type ReleaseGroupRow = {
		/** Null on a Deezer discography: the row links by `deezerId` instead. */
		mbid: string | null;
		deezerId: number | null;
		title: string;
		primaryType?: string | null;
		secondaryTypes: string[];
		year?: number | null;
		artworkUrl: string | null;
	};

	let {
		data
	}: {
		data: {
			artist: {
				mbid: string | null;
				deezerId: number | null;
				name: string;
				disambiguation?: string | null;
				type?: string | null;
				country?: string | null;
				genres: string[];
			};
			releaseGroups: ReleaseGroupRow[];
			storedMbids: string[];
			artworkUrl: string | null;
		};
	} = $props();

	const artist = $derived(data.artist);
	const stored = $derived(new SvelteSet(data.storedMbids));

	// A discography reads oldest-first, like every track listing in the app.
	const discography = $derived(
		[...data.releaseGroups].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
	);

	let busy = $state(false);
	let addOpen = $state(false);

	function rowKey(group: ReleaseGroupRow): string {
		return group.mbid ?? `deezer-${group.deezerId ?? group.title}`;
	}

	function rowHref(group: ReleaseGroupRow): string {
		if (group.mbid) return `/discover/music/${group.mbid}`;
		return `/discover/music/deezer-album-${group.deezerId}`;
	}

	function rowCover(group: ReleaseGroupRow): string | null {
		if (group.artworkUrl) return group.artworkUrl;
		return group.mbid ? releaseGroupCoverUrl(group.mbid, 250) : null;
	}

	/** Only a MusicBrainz row can be in the library by id; a Deezer row cannot. */
	function inLibrary(group: ReleaseGroupRow): boolean {
		return group.mbid ? stored.has(group.mbid) : false;
	}

	const heroArt = $derived(data.artworkUrl ?? (discography[0] ? rowCover(discography[0]) : null));

	const sourceUrl = $derived(
		artist.mbid
			? `https://musicbrainz.org/artist/${artist.mbid}`
			: typeof artist.deezerId === 'number'
				? `https://www.deezer.com/artist/${artist.deezerId}`
				: undefined
	);

	/**
	 * The add flow is keyed by MBID, so a Deezer artist resolves one first. That
	 * lookup is rate-gated — it belongs behind this button, never in the load.
	 */
	async function resolveArtistMbid(): Promise<string | null> {
		if (artist.mbid) return artist.mbid;
		const params = new URLSearchParams({ type: 'artist', q: artist.name });
		const body = await fetch(`/api/music/search?${params}`).then((r) => r.json());
		const hit = (body.results ?? [])[0] as { mbid?: string } | undefined;
		return hit?.mbid ?? null;
	}

	/**
	 * Add the rest of the discography. The server writes a bounded batch and
	 * reports what it left, so this loops until nothing remains.
	 */
	async function addDiscography(profileId: string | null) {
		if (busy) return;
		busy = true;
		let added = 0;
		let batches = 0;
		try {
			const mbid = await resolveArtistMbid();
			if (!mbid) {
				toasts.error(m.music_addFailed());
				return;
			}
			for (;;) {
				const response = await fetch('/api/music/artists', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						artist: { mbid, name: artist.name },
						limit: 25,
						qualityProfileId: profileId,
						searchOnAdd: true
					})
				});
				const body = await response.json();
				if (!response.ok) {
					toasts.error(body.details ?? body.error ?? m.music_addFailed());
					return;
				}
				batches += 1;
				added += body.added ?? 0;
				toasts.info(
					m.music_addingArtist({ artist: artist.name, added, remaining: body.remaining ?? 0 })
				);
				await invalidateAll();
				if (!body.remaining || batches >= 12) break;
			}
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.music_addFailed());
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{artist.name} · Cinephage</title></svelte:head>

<div class="w-full px-4 pt-4 pb-20 md:px-6 lg:px-8">
	<ArtistHero
		artist={{
			...artist,
			monitored: null
		}}
		backdropUrl={heroArt}
		albumCount={discography.length}
		inLibraryCount={discography.filter(inLibrary).length}
		backHref="/discover?type=music"
		backLabel={m.nav_music()}
		{sourceUrl}
		sourceLabel={artist.mbid ? 'MusicBrainz' : 'Deezer'}
		readOnly
		extraActions={[
			{
				key: 'add',
				icon: Plus,
				label: m.music_addArtist(),
				emphasis: 'primary',
				busy,
				onSelect: () => (addOpen = true)
			}
		]}
	/>

	<div class="mt-6">
		<h2 class="mb-3 text-sm font-semibold tracking-wide text-base-content/50 uppercase">
			{m.music_discography()}
		</h2>

		{#if discography.length === 0}
			<p class="text-sm text-base-content/55">{m.music_noResults()}</p>
		{:else}
			<ul
				class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
			>
				{#each discography as group (rowKey(group))}
					<li>
						<LibraryMediaCard
							view={albumCardView(
								{
									id: rowKey(group),
									title: group.title,
									artistName: artist.name,
									year: group.year ?? null,
									primaryType: group.primaryType ?? null,
									mbid: group.mbid,
									hasFile: inLibrary(group)
								},
								{ artUrl: rowCover(group), href: rowHref(group) }
							)}
						/>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<MusicAddConfirmModal
		open={addOpen}
		kind="artist"
		title={artist.name}
		subtitle={m.music_addArtist()}
		onAdd={addDiscography}
		onClose={() => (addOpen = false)}
	/>
</div>

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { musicBrainz, pickPrimaryRelease } from '#lib/server/music/musicbrainz.js';
import type { MusicRelease } from '#lib/server/music/types.js';
import { db } from '#lib/server/db/index.js';
import { albums } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { deriveFeaturedArtists } from '#lib/components/music/music-card.js';
import { cachedByKey } from '#lib/server/music/pageCache.js';

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One album before (or after) it joins the library: MusicBrainz is the source,
 * exactly as TMDB is for a movie detail page. The tracklist and label details
 * come from the primary edition — the same preference the add flow uses.
 */
export const load: PageServerLoad = async ({ params }) => {
	const mbid = params.mbid;
	if (!MBID.test(mbid)) throw error(400, 'Invalid album id');

	return cachedByKey(`album:${mbid}`, async () => {
		// Group and editions arrive together, so the page costs two gated lookups
		// instead of three: the primary edition, then its tracklist.
		let group: Awaited<ReturnType<typeof musicBrainz.getReleaseGroupWithReleases>>['group'];
		let release: MusicRelease | null = null;
		try {
			const found = await musicBrainz.getReleaseGroupWithReleases(mbid);
			group = found.group;
			const primary = pickPrimaryRelease(found.releases);
			if (primary) release = await musicBrainz.getRelease(primary.mbid);
		} catch {
			throw error(404, 'Album not found on MusicBrainz');
		}

		// Already added? The page links straight into the library copy.
		const stored = await db.query.albums.findFirst({ where: eq(albums.mbid, mbid) });

		return {
			group,
			release,
			libraryAlbumId: stored?.id ?? null,
		// Collaborators from the edition's credits — the album hero's cast row,
		// the same furniture a movie hero carries.
			featured: deriveFeaturedArtists(
				(release?.tracks ?? []).map((track) => track.artistCredit ?? null),
				group.artist.name
			)
		};
	});
};
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { musicBrainz, pickPrimaryRelease } from '#lib/server/music/musicbrainz.js';
import type { MusicRelease } from '#lib/server/music/types.js';
import { db } from '#lib/server/db/index.js';
import { albums } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One album before (or after) it joins the library: MusicBrainz is the source,
 * exactly as TMDB is for a movie detail page. The tracklist and label details
 * come from the primary edition — the same preference the add flow uses.
 */
export const load: PageServerLoad = async ({ params }) => {
	const mbid = params.mbid;
	if (!MBID.test(mbid)) throw error(400, 'Invalid album id');

	let group;
	try {
		group = await musicBrainz.getReleaseGroup(mbid);
	} catch {
		throw error(404, 'Album not found on MusicBrainz');
	}

	let release: MusicRelease | null = null;
	try {
		const editions = await musicBrainz.getReleaseGroupReleases(mbid);
		const primary = pickPrimaryRelease(editions);
		if (primary) release = await musicBrainz.getRelease(primary.mbid);
	} catch {
		// The tracklist is extra; the page works from the release group alone.
	}

	// Already added? The page links straight into the library copy.
	const stored = await db.query.albums.findFirst({ where: eq(albums.mbid, mbid) });

	return {
		group,
		release,
		libraryAlbumId: stored?.id ?? null
	};
};

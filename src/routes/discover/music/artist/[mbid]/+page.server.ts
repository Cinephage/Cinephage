import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { musicBrainz } from '#lib/server/music/musicbrainz.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { cachedByKey } from '#lib/server/music/pageCache.js';

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One artist: the MusicBrainz entity plus its release groups, each linking to
 * its own album page. `storedMbids` marks the ones already in the library —
 * the same in-library signal every other kind's pages carry.
 */
export const load: PageServerLoad = async ({ params }) => {
	const mbid = params.mbid;
	if (!MBID.test(mbid)) throw error(400, 'Invalid artist id');

	return cachedByKey(`artist:${mbid}`, async () => {
		let artist;
		try {
			artist = await musicBrainz.getArtist(mbid);
		} catch {
			throw error(404, 'Artist not found on MusicBrainz');
		}

		// One page of 100 release groups covers any realistic discography the page
		// needs; deeper browsing belongs to the add-artist flow, not this page.
		let releaseGroups: Awaited<
			ReturnType<typeof musicBrainz.getArtistReleaseGroups>
		>['releaseGroups'] = [];
		try {
			({ releaseGroups } = await musicBrainz.getArtistReleaseGroups(
				mbid,
				{ mbid, name: artist.name },
				{ limit: 100 }
			));
		} catch {
			// The page still shows the artist header.
		}

		return {
			artist,
			releaseGroups,
			storedMbids: [...musicAlbumService.existingReleaseGroupMbids()]
		};
	});
};
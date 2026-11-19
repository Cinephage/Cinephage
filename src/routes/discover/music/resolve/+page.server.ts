import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { musicBrainz } from '#lib/server/music/musicbrainz.js';

/**
 * The bridge between a catalog row and a MusicBrainz page.
 *
 * Deezer (the chart, and music search) knows albums and artists by its own ids,
 * so a tile cannot link to a MusicBrainz page directly. Rather than resolve in
 * the browser and leave a card that looks dead until the rate gate answers,
 * the tile links here: one server request resolves the id and redirects, and
 * the browser shows its normal navigation the whole time.
 */
export const load: PageServerLoad = async ({ url }) => {
	const kind = url.searchParams.get('kind') === 'artist' ? 'artist' : 'album';
	const title = url.searchParams.get('title')?.trim() ?? '';
	const artist = url.searchParams.get('artist')?.trim() ?? '';
	// A song row opens the album it sits on, never the track itself.
	const album = url.searchParams.get('album')?.trim() || title;

	if (!title && !artist && !album) throw error(400, 'Nothing to resolve');

	if (kind === 'artist') {
		const name = title || artist;
		const artists = await musicBrainz.searchArtists(name, 1);
		const artistMbid = artists[0]?.mbid;
		if (!artistMbid) throw error(404, `No artist found for "${name}"`);
		throw redirect(307, `/discover/music/artist/${artistMbid}`);
	}

	const groups = await musicBrainz.searchReleaseGroups({
		artist: artist || undefined,
		album: album || undefined,
		limit: 1
	});
	const mbid = groups[0]?.mbid;
	if (!mbid) throw error(404, `No album found for "${album || title}"`);
	throw redirect(307, `/discover/music/${mbid}`);
};

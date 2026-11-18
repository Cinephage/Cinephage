import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicArtistService } from '#lib/server/music/MusicArtistService.js';

/**
 * One artist's shelf: the artist row plus its albums.
 *
 * The artist is a library entity here, not a MusicBrainz lookup — this page is
 * reached from the library grid, and a slow upstream must never stand between
 * the owner and their own records. The MusicBrainz link in the hero is how you
 * get to the catalogue side.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	requireAdminPage(locals);

	const artist = musicArtistService.getArtist(params.id);
	if (!artist) error(404, 'Artist not found');

	const albums = musicAlbumService.listAlbums({ artistId: artist.id });

	return {
		artist,
		albums,
		counts: {
			albums: albums.length,
			inLibrary: albums.filter((album) => album.hasFile).length
		}
	};
};

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { MUSIC_PROFILE_OPTIONS } from '#lib/server/music/profiles.js';
import { deriveFeaturedArtists } from '#lib/components/music/music-card.js';

/** One album with its tracklist, and the collaborators its credits name. */
export const load: PageServerLoad = async ({ locals, params }) => {
	requireAdminPage(locals);

	const album = musicAlbumService.getAlbum(params.id);
	if (!album) error(404, 'Album not found');

	return {
		album,
		qualityProfiles: MUSIC_PROFILE_OPTIONS,
		featured: deriveFeaturedArtists(
			album.tracks.map((track) => track.artistCredit),
			album.artistName
		)
	};
};

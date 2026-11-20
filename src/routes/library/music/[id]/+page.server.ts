import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';
import { deriveFeaturedArtists } from '#lib/components/music/music-card.js';

/** One album with its tracklist, and the collaborators its credits name. */
export const load: PageServerLoad = async ({ locals, params }) => {
	requireAdminPage(locals);

	const album = musicAlbumService.getAlbum(params.id);
	if (!album) error(404, 'Album not found');

	return {
		album,
		qualityProfiles: musicProfileService.list().map((profile) => ({
			id: profile.id,
			name: profile.name,
			isDefault: profile.isDefault
		})),
		// What "inherit" resolves to for this album: the artist's profile, or
		// the install default when the artist has none.
		inheritedProfileName: musicProfileService.resolveForArtist(album.artistId).name,
		// The album's related row: the rest of this artist's discography. Music
		// has no TMDB-style "similar" endpoint, and the artist's own catalogue is
		// the honest neighbour set.
		moreFromArtist: musicAlbumService
			.listAlbums({ artistId: album.artistId })
			.filter((entry) => entry.id !== album.id)
			.slice(0, 6),
		featured: deriveFeaturedArtists(
			album.tracks.map((track) => track.artistCredit),
			album.artistName
		)
	};
};

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';

/** One album with its tracklist. */
export const load: PageServerLoad = async ({ locals, params }) => {
	requireAdminPage(locals);

	const album = musicAlbumService.getAlbum(params.id);
	if (!album) error(404, 'Album not found');

	return { album };
};

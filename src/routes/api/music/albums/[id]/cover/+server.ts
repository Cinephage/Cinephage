import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicBrainz } from '#lib/server/music/musicbrainz.js';
import { isPathInsideManagedRoot } from '#lib/server/filesystem/path-guard.js';

const CONTENT_TYPES: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp'
};

/**
 * GET /api/music/albums/[id]/cover
 *
 * Serves the album's artwork. A local `coverPath` wins; otherwise the chosen
 * MusicBrainz edition is proxied through the Cover Art Archive. This reads two
 * fields, not the album and its whole tracklist — a grid asks for dozens of
 * these on one render.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const info = musicAlbumService.getAlbumCoverInfo(event.params.id);
	if (!info) return new Response('No cover for this album', { status: 404 });

	if (info.coverPath) {
		const path = isAbsolute(info.coverPath)
			? info.coverPath
			: join(info.albumPath ?? '', info.coverPath);
		if (await isPathInsideManagedRoot(path)) {
			const data = await readFile(path).catch(() => null);
			if (data) {
				return new Response(data, {
					headers: {
						'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
						'cache-control': 'public, max-age=86400'
					}
				});
			}
		}
	}

	if (!info.releaseMbid) return new Response('No cover for this album', { status: 404 });
	return new Response(null, {
		status: 302,
		headers: { location: musicBrainz.coverArtUrl(info.releaseMbid, 500) }
	});
};

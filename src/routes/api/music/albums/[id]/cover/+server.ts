import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { getCover } from '#lib/server/music/cover-cache.js';
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
 * Serves the album's artwork. A local `coverPath` wins; otherwise the album's
 * release is served through the cover cache, which walks the Cover Art
 * Archive redirect chain once instead of once per tile per load. This reads
 * two fields, not the album and its whole tracklist — a grid asks for dozens
 * of these on one render.
 *
 * The URL is keyed by album id, not by release id, so a rematch can change the
 * bytes behind it: a day of caching, not `immutable`.
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

	// The edition the album was imported from can have no front image while the
	// release group does: fall back rather than show a blank tile.
	const cover =
		(info.releaseMbid ? await getCover('release', info.releaseMbid, 500) : null) ??
		(info.releaseGroupMbid ? await getCover('release-group', info.releaseGroupMbid, 500) : null);
	if (!cover) return new Response('No cover for this album', { status: 404 });

	return new Response(cover.body, {
		headers: {
			'content-type': cover.contentType,
			'cache-control': 'public, max-age=86400'
		}
	});
};

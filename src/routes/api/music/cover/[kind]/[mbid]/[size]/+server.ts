/**
 * GET /api/music/cover/[kind]/[mbid]/[size]
 *
 * The one way the browser asks for Cover Art Archive art. The server keeps a
 * copy, so a grid costs file reads instead of three archive redirects per
 * tile (see #lib/server/music/cover-cache.js). The URL is keyed by the
 * archive id, so its bytes never change: it is safe to call it immutable.
 */

import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { isCoverKind, isCoverMbid, isCoverSize } from '#lib/music/cover-art.js';
import { getCover } from '#lib/server/music/cover-cache.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const { kind, mbid } = event.params;
	const size = Number(event.params.size);
	if (!isCoverKind(kind) || !isCoverMbid(mbid) || !isCoverSize(size)) {
		return new Response('Unknown cover', { status: 404 });
	}

	const cover = await getCover(kind, mbid, size);
	if (!cover) return new Response('No cover for this release', { status: 404 });

	return new Response(cover.body, {
		headers: {
			'content-type': cover.contentType,
			'cache-control': 'public, max-age=31536000, immutable'
		}
	});
};

import type { RequestHandler } from './$types';
import {
	TMDB_IMAGE_ORIGIN,
	getTmdbImage,
	isValidTmdbImageRequest
} from '#lib/server/tmdb-image-cache.js';

/**
 * GET /api/images/tmdb/{size}/{file}
 *
 * A TMDB image served from Cinephage's local cache (see tmdb-image-cache.ts).
 * TMDB file names are content-addressed, so the response is immutable. When
 * TMDB cannot be reached from the server, the browser is sent to TMDB
 * directly, which is no worse than loading it from there in the first place.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { size, file } = params;
	if (!isValidTmdbImageRequest(size, file)) {
		return new Response('Not found', { status: 404 });
	}

	const image = await getTmdbImage(size, file);
	if (!image) {
		return new Response(null, {
			status: 302,
			headers: { Location: `${TMDB_IMAGE_ORIGIN}/${size}/${file}`, 'Cache-Control': 'no-store' }
		});
	}

	return new Response(image.body as BodyInit, {
		headers: {
			'Content-Type': image.contentType,
			'Content-Length': String(image.body.byteLength),
			'Cache-Control': 'private, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff',
			// Served from the app's own origin, so an SVG must not be able to run
			// script or load anything if opened directly.
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
		}
	});
};

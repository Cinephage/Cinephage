/**
 * Local cache for TMDB images (posters, backdrops, profile photos, logos).
 *
 * The UI used to point every <img> straight at image.tmdb.org, so each
 * browser fetched each poster from TMDB's CDN on its own. On a network where
 * that CDN is slow to reach (a VPN exit far away, broken IPv6, a congested
 * route) a page of posters stalled for many seconds even though the page
 * itself was fast. Serving them from Cinephage instead means one fetch from
 * TMDB per image, kept on disk, and every browser loads it over the
 * connection it already has to the app.
 *
 * TMDB image paths are content-addressed (a changed image gets a new file
 * name), so a cached file never goes stale and can be served as immutable.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'TmdbImageCache', logDomain: 'system' });

export const TMDB_IMAGE_ORIGIN = 'https://image.tmdb.org/t/p';

/** The sizes TMDB serves (configuration endpoint), and nothing else. */
const ALLOWED_SIZES = new Set([
	'w45',
	'w92',
	'w154',
	'w185',
	'w300',
	'w342',
	'w500',
	'w780',
	'w1280',
	'h632',
	'original'
]);

/** A bare TMDB file name: no separators, no traversal, a known image type. */
const FILE_PATTERN = /^[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp|svg)$/;

const CONTENT_TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	svg: 'image/svg+xml'
};

const FETCH_TIMEOUT_MS = 15_000;

export interface TmdbImage {
	body: Uint8Array;
	contentType: string;
}

export function isValidTmdbImageRequest(size: string, file: string): boolean {
	return ALLOWED_SIZES.has(size) && FILE_PATTERN.test(file);
}

export function tmdbImageContentType(file: string): string {
	const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
	return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function cacheRoot(): string {
	return join(process.env.DATA_DIR || 'data', 'cache', 'tmdb-images');
}

const inFlight = new Map<string, Promise<TmdbImage | null>>();

/**
 * The image from the local cache, fetching and storing it on a miss.
 * Concurrent requests for the same image share one TMDB fetch. Returns null
 * when TMDB could not be reached or answered with an error; the caller can
 * then send the browser to TMDB directly.
 *
 * Callers must validate `size` and `file` with isValidTmdbImageRequest first.
 */
export async function getTmdbImage(
	size: string,
	file: string,
	fetchImpl: typeof fetch = fetch
): Promise<TmdbImage | null> {
	const contentType = tmdbImageContentType(file);
	const dir = join(cacheRoot(), size);
	const path = join(dir, file);

	try {
		const cached = await readFile(path);
		return {
			body: new Uint8Array(cached.buffer, cached.byteOffset, cached.byteLength),
			contentType
		};
	} catch {
		// Not cached yet.
	}

	const key = `${size}/${file}`;
	const pending = inFlight.get(key);
	if (pending) return pending;

	const request = (async (): Promise<TmdbImage | null> => {
		try {
			const response = await fetchImpl(`${TMDB_IMAGE_ORIGIN}/${size}/${file}`, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
			});
			if (!response.ok) {
				logger.debug({ size, file, status: response.status }, 'TMDB image fetch failed');
				return null;
			}
			const body = new Uint8Array(await response.arrayBuffer());
			try {
				await mkdir(dir, { recursive: true });
				const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
				await writeFile(tmp, body);
				await rename(tmp, path);
			} catch (err) {
				// Serving the image matters more than caching it.
				logger.warn({ err, size, file }, 'Could not store TMDB image in the cache');
			}
			return { body, contentType };
		} catch (err) {
			logger.debug({ err, size, file }, 'TMDB image fetch error');
			return null;
		} finally {
			inFlight.delete(key);
		}
	})();

	inFlight.set(key, request);
	return request;
}

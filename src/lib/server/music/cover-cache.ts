/**
 * Album artwork, fetched once and kept.
 *
 * The Cover Art Archive serves its front images through two redirects to an
 * archive.org download node. Measured from this LAN: 1.5–4.1 s per image, and
 * the archive sends no cache headers on the redirects, so a 60-tile grid asked
 * for 60 of those on every render. The browser's own cache could not help —
 * the redirect had to be walked again before the cached file could be used.
 *
 * This module is the one place that walks the chain: it stores the bytes under
 * DATA_DIR and every later request is a file read. The archive is also told
 * "no" politely — misses are cached for a week, and at most MAX_CONCURRENT_
 * FETCHES requests are in flight at once, so a page of uncached covers cannot
 * turn into a burst against archive.org.
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '#lib/logging/index.js';
import type { CoverKind, CoverSize } from '#lib/music/cover-art.js';

const logger = createChildLogger({ module: 'MusicCoverCache', logDomain: 'system' });

const COVER_ARCHIVE = 'https://coverartarchive.org';
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_FETCHES = 6;
/** An album without art today usually has none next week either. */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MISS_SUFFIX = '.missing';

export interface Cover {
	/**
	 * `Uint8Array`, not `Buffer`: a Response body accepts an ArrayBuffer view
	 * over an ArrayBuffer, and Node's Buffer is typed over ArrayBufferLike,
	 * which includes SharedArrayBuffer and is refused by BodyInit.
	 */
	body: Uint8Array<ArrayBuffer>;
	contentType: string;
}

/**
 * Resolved per call, not once at import: the tests point DATA_DIR at a temp
 * directory, and an install can move it without a rebuild.
 */
let resolved: { key: string; dir: string } | null = null;
function cacheDir(): string {
	const key = process.env.DATA_DIR || 'data';
	if (resolved?.key !== key) {
		resolved = { key, dir: join(key, 'music-covers') };
	}
	return resolved.dir;
}

function cacheKey(kind: CoverKind, mbid: string, size: CoverSize): string {
	return `${kind}-${mbid}-${size}`;
}

/** Sniffing beats a sidecar file: the archive answers jpeg, png or webp. */
function sniffContentType(body: Uint8Array): string | null {
	if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
	if (
		body.length >= 8 &&
		body[0] === 0x89 &&
		body[1] === 0x50 &&
		body[2] === 0x4e &&
		body[3] === 0x47
	) {
		return 'image/png';
	}
	if (body.length >= 12) {
		const head = Buffer.from(body.buffer, body.byteOffset, 12).toString('ascii', 0, 12);
		if (head.startsWith('RIFF') && head.endsWith('WEBP')) return 'image/webp';
	}
	return null;
}

async function readCached(key: string): Promise<Cover | null> {
	try {
		const body = new Uint8Array(await readFile(join(cacheDir(), key)));
		const contentType = sniffContentType(body);
		return contentType ? { body, contentType } : null;
	} catch {
		return null;
	}
}

async function isKnownMissing(key: string): Promise<boolean> {
	try {
		const info = await stat(join(cacheDir(), key + MISS_SUFFIX));
		return Date.now() - info.mtimeMs < MISS_TTL_MS;
	} catch {
		return false;
	}
}

async function rememberMissing(key: string): Promise<void> {
	try {
		await mkdir(cacheDir(), { recursive: true });
		await writeFile(join(cacheDir(), key + MISS_SUFFIX), '');
	} catch (err) {
		logger.warn({ err, key }, 'Could not record a missing cover');
	}
}

async function forgetMissing(key: string): Promise<void> {
	await unlink(join(cacheDir(), key + MISS_SUFFIX)).catch(() => {});
}

// A page of uncached covers must not become a burst against the archive.
let active = 0;
const waiting: Array<() => void> = [];

async function withFetchSlot<T>(run: () => Promise<T>): Promise<T> {
	if (active >= MAX_CONCURRENT_FETCHES) {
		await new Promise<void>((resolve) => waiting.push(resolve));
	}
	active++;
	try {
		return await run();
	} finally {
		active--;
		waiting.shift()?.();
	}
}

async function download(
	kind: CoverKind,
	mbid: string,
	size: CoverSize,
	key: string
): Promise<Cover | null> {
	const url = `${COVER_ARCHIVE}/${kind}/${mbid}/front-${size}`;

	return withFetchSlot(async () => {
		let response: Response;
		try {
			response = await fetch(url, {
				redirect: 'follow',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { accept: 'image/*' }
			});
		} catch (err) {
			logger.warn({ err, url }, 'Cover Art Archive request failed');
			return null;
		}

		if (response.status === 404 || response.status === 410) {
			await rememberMissing(key);
			return null;
		}
		if (!response.ok) {
			// A 5xx or a timeout is the archive's problem, not the album's:
			// do not mark it missing, the next page load retries.
			logger.warn({ status: response.status, url }, 'Cover Art Archive answered an error');
			return null;
		}

		const declared = Number(response.headers.get('content-length') ?? 0);
		if (declared > MAX_BYTES) {
			logger.warn({ url, declared }, 'Cover Art Archive image is too large');
			return null;
		}

		const body = new Uint8Array(await response.arrayBuffer());
		const contentType = sniffContentType(body);
		if (!contentType || body.length === 0 || body.length > MAX_BYTES) {
			logger.warn({ url, bytes: body.length }, 'Cover Art Archive answered something that is not art');
			return null;
		}

		try {
			await mkdir(cacheDir(), { recursive: true });
			const temp = join(cacheDir(), `${key}.${randomUUID()}.part`);
			await writeFile(temp, body);
			await rename(temp, join(cacheDir(), key));
			await forgetMissing(key);
		} catch (err) {
			// The bytes are still good for this response; only the next read
			// pays for the archive again.
			logger.warn({ err, key }, 'Could not cache album art');
		}

		return { body, contentType };
	});
}

/** One fetch per image even when a grid asks for the same cover six times. */
const inflight = new Map<string, Promise<Cover | null>>();

export function getCover(kind: CoverKind, mbid: string, size: CoverSize): Promise<Cover | null> {
	const key = cacheKey(kind, mbid, size);
	const running = inflight.get(key);
	if (running) return running;

	const task = (async () => {
		const cached = await readCached(key);
		if (cached) return cached;
		if (await isKnownMissing(key)) return null;
		return download(kind, mbid, size, key);
	})().catch((err) => {
		logger.warn({ err, key }, 'Album art lookup failed');
		return null;
	});

	inflight.set(key, task);
	void task.finally(() => inflight.delete(key));
	return task;
}

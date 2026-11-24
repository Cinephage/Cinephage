import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCover } from './cover-cache.js';

const MBID = 'dd09ed39-6869-42a5-91f5-5c695cef41f6';
/** Enough of a JPEG for the sniffer; the bytes are never decoded. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'cinephage-covers-'));
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	vi.unstubAllGlobals();
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

function imageResponse(body: Buffer = JPEG): Response {
	return new Response(new Uint8Array(body), {
		status: 200,
		headers: { 'content-type': 'image/jpeg' }
	});
}

describe('music cover cache', () => {
	it('walks the archive once, then answers from disk', async () => {
		const fetchMock = vi.fn((_url: string) => Promise.resolve(imageResponse()));
		vi.stubGlobal('fetch', fetchMock);

		const first = await getCover('release', MBID, 500);
		const second = await getCover('release', MBID, 500);

		expect(first?.contentType).toBe('image/jpeg');
		expect(Buffer.from(second?.body ?? []).equals(JPEG)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			`https://coverartarchive.org/release/${MBID}/front-500`
		);
		// The image itself is what the second call read.
		expect(await readdir(join(dataDir, 'music-covers'))).toEqual([`release-${MBID}-500`]);
	});

	it('fetches once when a grid asks for the same tile six times', async () => {
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal('fetch', fetchMock);

		const covers = await Promise.all(
			Array.from({ length: 6 }, () => getCover('release-group', MBID, 250))
		);

		expect(covers.every((cover) => cover?.contentType === 'image/jpeg')).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('remembers a missing cover instead of asking again on every load', async () => {
		const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
		vi.stubGlobal('fetch', fetchMock);

		expect(await getCover('release', MBID, 500)).toBeNull();
		expect(await getCover('release', MBID, 500)).toBeNull();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await readdir(join(dataDir, 'music-covers'))).toEqual([
			`release-${MBID}-500.missing`
		]);
	});

	it('does not cache an archive error, so the next load retries', async () => {
		const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }));
		vi.stubGlobal('fetch', fetchMock);

		expect(await getCover('release', MBID, 500)).toBeNull();
		expect(await getCover('release', MBID, 500)).toBeNull();

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('refuses a body that is not an image', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('<html>maintenance</html>', {
						status: 200,
						headers: { 'content-type': 'text/html' }
					})
			)
		);

		expect(await getCover('release', MBID, 500)).toBeNull();
		await expect(readdir(join(dataDir, 'music-covers'))).rejects.toThrow();
	});
});

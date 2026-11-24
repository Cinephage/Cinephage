import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callHandlerRaw } from '../../../../../../../test/api-helper.js';

const { getCoverMock } = vi.hoisted(() => ({ getCoverMock: vi.fn() }));

vi.mock('#lib/server/music/cover-cache.js', () => ({ getCover: getCoverMock }));

const { GET } = await import('./+server.js');

const MBID = 'dd09ed39-6869-42a5-91f5-5c695cef41f6';
const PARAMS = { kind: 'release', mbid: MBID, size: '500' };

beforeEach(() => {
	getCoverMock.mockReset();
});

describe('GET /api/music/cover/[kind]/[mbid]/[size]', () => {
	it('serves the cached image as immutable', async () => {
		getCoverMock.mockResolvedValue({
			body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
			contentType: 'image/jpeg'
		});

		const { status, response } = await callHandlerRaw(GET, 'GET', undefined, {
			auth: 'user',
			params: PARAMS
		});

		expect(status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(getCoverMock).toHaveBeenCalledWith('release', MBID, 500);
	});

	it('answers 404 for an unknown kind, size or id without touching the archive', async () => {
		for (const params of [
			{ ...PARAMS, kind: 'artist' },
			{ ...PARAMS, size: '333' },
			{ ...PARAMS, mbid: '../../etc/passwd' }
		]) {
			const { status } = await callHandlerRaw(GET, 'GET', undefined, { auth: 'user', params });
			expect(status).toBe(404);
		}

		expect(getCoverMock).not.toHaveBeenCalled();
	});

	it('answers 404 when the archive has no art for the release', async () => {
		getCoverMock.mockResolvedValue(null);

		const { status } = await callHandlerRaw(GET, 'GET', undefined, {
			auth: 'user',
			params: PARAMS
		});

		expect(status).toBe(404);
	});

	it('requires a session', async () => {
		const { status } = await callHandlerRaw(GET, 'GET', undefined, {
			auth: false,
			params: PARAMS
		});

		expect(status).toBe(401);
		expect(getCoverMock).not.toHaveBeenCalled();
	});
});

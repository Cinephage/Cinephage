/**
 * The proxy's upstream request shape.
 *
 * googlevideo throttles a plain GET to ~30 KB/s but serves `bytes=0-` at line
 * speed, and Jellyfin's .strm audio plugin never asks for a range. What the
 * route sends upstream is therefore the difference between a track that starts
 * after a few seconds and one that starts at once, so it is pinned here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { callHandlerRaw } from '../../../../../../../test/api-helper.js';
import { GET } from './+server.js';

vi.mock('#lib/logging/index.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	createChildLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
	createRequestLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
	runWithLogContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn())
}));

const resolver = vi.hoisted(() => ({
	resolveTrackStream: vi.fn(),
	invalidateTrackStream: vi.fn()
}));

vi.mock('#lib/server/music/playback/resolver.js', () => resolver);

const warmer = vi.hoisted(() => ({ warmAlbum: vi.fn() }));

vi.mock('#lib/server/music/playback/warmer.js', () => warmer);

const fetchMock = vi.hoisted(() => vi.fn());

const STREAM = {
	source: 'youtube' as const,
	url: 'https://rr1---sn-test.googlevideo.com/videoplayback?expire=1',
	contentType: 'audio/mp4',
	expiresAt: null
};

function upstream(status: number, headers: Record<string, string>): Response {
	return new Response('payload', { status, headers });
}

function upstreamHeaders(): Headers {
	return fetchMock.mock.calls[0][1].headers as Headers;
}

beforeEach(() => {
	resolver.resolveTrackStream.mockReset();
	resolver.invalidateTrackStream.mockReset();
	warmer.warmAlbum.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	resolver.resolveTrackStream.mockResolvedValue({ status: 'ok', stream: STREAM, albumId: 'al-1' });
});

describe('GET /api/streaming/music/track/{id}/stream', () => {
	it('asks the provider for a range when the client sent none, and answers 200', async () => {
		fetchMock.mockResolvedValue(
			upstream(206, {
				'content-type': 'audio/mp4',
				'content-length': '7',
				'content-range': 'bytes 0-6/7'
			})
		);

		const { status, response } = await callHandlerRaw(GET, 'GET', undefined, {
			params: { id: 't-1' },
			auth: 'user'
		});

		expect(upstreamHeaders().get('range')).toBe('bytes=0-');
		expect(status).toBe(200);
		expect(response.headers.get('content-range')).toBeNull();
		expect(response.headers.get('content-type')).toBe('audio/mp4');
		expect(await response.text()).toBe('payload');
	});

	it('forwards the client range untouched and keeps 206', async () => {
		fetchMock.mockResolvedValue(
			upstream(206, {
				'content-type': 'audio/mp4',
				'content-range': 'bytes 100-200/1000'
			})
		);

		const { status, response } = await callHandlerRaw(GET, 'GET', undefined, {
			params: { id: 't-1' },
			auth: 'user',
			headers: { Range: 'bytes=100-200' }
		});

		expect(upstreamHeaders().get('range')).toBe('bytes=100-200');
		expect(status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 100-200/1000');
	});

	it('queues the rest of the album once a provider track resolves', async () => {
		fetchMock.mockResolvedValue(upstream(206, { 'content-type': 'audio/mp4' }));

		await callHandlerRaw(GET, 'GET', undefined, { params: { id: 't-1' }, auth: 'user' });

		expect(warmer.warmAlbum).toHaveBeenCalledWith('al-1');
	});

	it('refuses an unauthenticated request without touching the provider', async () => {
		const { status } = await callHandlerRaw(GET, 'GET', undefined, { params: { id: 't-1' } });

		expect(status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

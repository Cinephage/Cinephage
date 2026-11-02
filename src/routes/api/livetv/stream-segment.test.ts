import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeoutMock = vi.fn();
const resolveAndValidateUrlMock = vi.fn();
const refreshStreamMock = vi.fn();

vi.mock('#lib/server/http/ssrf-protection.js', () => ({
	resolveAndValidateUrl: resolveAndValidateUrlMock,
	fetchWithTimeout: fetchWithTimeoutMock
}));

vi.mock('#lib/server/livetv/streaming/StreamUrlCache.js', () => ({
	HLS_STREAM_TIMEOUT_MS: 20_000,
	getStreamUrlCache: () => ({
		getCached: vi.fn(),
		isValid: vi.fn().mockReturnValue(true),
		refreshStream: refreshStreamMock,
		// These tests exercise proxy mechanics against provider.test; the
		// host-binding rule has its own coverage in livetv-host-binding.test.ts.
		allowHost: vi.fn(),
		hasAllowedHosts: vi.fn().mockReturnValue(true),
		isHostAllowed: vi.fn().mockReturnValue(true)
	})
}));

vi.mock('#lib/server/streaming/url.js', () => ({
	getBaseUrlAsync: vi.fn().mockResolvedValue('http://cinephage.test')
}));

describe('Live TV segment proxy', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resolveAndValidateUrlMock.mockResolvedValue({ safe: true });
	});

	it('passes through a TS response body without buffering when the path looks like HLS', async () => {
		// Two well-formed TS packets — the smallest body the camo sniff chain
		// accepts as valid MPEG-TS and streams through unmodified.
		const segment = new Uint8Array(376);
		for (let packet = 0; packet < 2; packet++) {
			segment[packet * 188] = 0x47;
			segment.fill(0x10, packet * 188 + 1, (packet + 1) * 188);
		}
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(segment, {
				status: 200,
				headers: { 'Content-Type': 'application/octet-stream' }
			})
		);

		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await GET({
			params: { lineupId: 'lineup-1', path: 'playlist.m3u8' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/playlist.m3u8?url=https%3A%2F%2Fprovider.test%2Fstream'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/playlist.m3u8')
		} as Parameters<typeof GET>[0]);

		expect(response.headers.get('Content-Type')).toBe('video/mp2t');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(segment);
	});

	it('unwraps a camouflaged PNG-wrapped TS segment and reports video/mp2t', async () => {
		const ts = new Uint8Array(376);
		for (let packet = 0; packet < 2; packet++) {
			ts[packet * 188] = 0x47;
			ts.fill(0x20, packet * 188 + 1, (packet + 1) * 188);
		}
		const pngChunk = (type: string, data: Uint8Array) => {
			const header = new Uint8Array(8);
			header.set(new TextEncoder().encode(type), 4);
			new DataView(header.buffer).setUint32(0, data.byteLength);
			const out = new Uint8Array(12 + data.byteLength);
			out.set(header, 0);
			out.set(data, 8);
			return out;
		};
		const ihdr = new Uint8Array(13);
		new DataView(ihdr.buffer).setUint32(0, 4);
		new DataView(ihdr.buffer).setUint32(4, 4);
		ihdr[8] = 8;
		ihdr[9] = 2;
		const container = new Uint8Array(8 + 25 + 12 + ts.byteLength);
		container.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
		container.set(pngChunk('IHDR', ihdr), 8);
		container.set(pngChunk('IEND', new Uint8Array(0)), 8 + 25);
		container.set(ts, 8 + 25 + 12);
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(container, {
				status: 200,
				headers: { 'Content-Type': 'image/png' }
			})
		);

		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await GET({
			params: { lineupId: 'lineup-1', path: 'segment.ts' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/segment.ts?url=https%3A%2F%2Fprovider.test%2Fsegment'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/segment.ts')
		} as Parameters<typeof GET>[0]);

		// The upstream image/* content type must not leak through: the payload
		// delivered is the unwrapped MPEG-TS.
		expect(response.headers.get('Content-Type')).toBe('video/mp2t');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(ts);
	});

	it('passes the incoming request signal to upstream segment fetches', async () => {
		fetchWithTimeoutMock.mockResolvedValue(new Response(new Uint8Array([0x47]), { status: 200 }));
		const controller = new AbortController();
		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		await GET({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel', {
				signal: controller.signal
			})
		} as Parameters<typeof GET>[0]);

		expect(fetchWithTimeoutMock.mock.calls[0][1].signal).not.toBe(controller.signal);
		controller.abort();
		expect(fetchWithTimeoutMock.mock.calls[0][1].signal.aborted).toBe(true);
	});

	it('cancels a chunked segment body when it exceeds 50 MiB', async () => {
		const cancelMock = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(25 * 1024 * 1024));
				if (controller.desiredSize !== null && controller.desiredSize < 0) controller.close();
			},
			cancel: cancelMock
		});
		fetchWithTimeoutMock.mockResolvedValue(new Response(body, { status: 200 }));

		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await GET({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel')
		} as Parameters<typeof GET>[0]);

		await expect(response.arrayBuffer()).rejects.toThrow();
		expect(cancelMock).toHaveBeenCalled();
	});

	it('rejects a redirect loop after cancelling each redirect response', async () => {
		const cancelMock = vi.fn();
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(new ReadableStream<Uint8Array>({ cancel: cancelMock }), {
				status: 302,
				headers: { Location: 'https://provider.test/live/channel' }
			})
		);

		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await GET({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel')
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(508);
		expect(cancelMock).toHaveBeenCalled();
	});

	it('cancels the body when a redirect Location is malformed', async () => {
		const cancelMock = vi.fn();
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(new ReadableStream<Uint8Array>({ cancel: cancelMock }), {
				status: 302,
				headers: { Location: 'http://[' }
			})
		);
		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await GET({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel')
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(502);
		expect(cancelMock).toHaveBeenCalled();
	});

	it('does not wait through retry backoff after the client disconnects', async () => {
		vi.useFakeTimers();
		try {
			fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 503 }));
			const controller = new AbortController();
			const request = new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel', {
				signal: controller.signal
			});
			let settled = false;
			const { GET } = await import('./stream/[lineupId]/[...path]/+server');
			const responsePromise = Promise.resolve(
				GET({
					params: { lineupId: 'lineup-1', path: 'channel' },
					url: new URL(
						'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
					),
					request
				} as Parameters<typeof GET>[0])
			).then(() => {
				settled = true;
			});
			await vi.waitFor(() => expect(fetchWithTimeoutMock).toHaveBeenCalled());
			controller.abort();
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(true);
			await responsePromise;
		} finally {
			vi.useRealTimers();
		}
	});

	it('validates a refreshed URL before retrying after a 403', async () => {
		fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 403 }));
		refreshStreamMock.mockResolvedValue({
			url: 'http://127.0.0.1:8080/private.ts',
			providerHeaders: {}
		});
		resolveAndValidateUrlMock.mockImplementation(async (value: string) =>
			value.includes('127.0.0.1') ? { safe: false, reason: 'private address' } : { safe: true }
		);

		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await GET({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel')
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(403);
		expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
		expect(resolveAndValidateUrlMock).toHaveBeenCalledWith('http://127.0.0.1:8080/private.ts');
	});

	it('closes a terminal upstream error body before returning it', async () => {
		const cancelMock = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel: cancelMock
		});
		fetchWithTimeoutMock.mockResolvedValue(new Response(body, { status: 503 }));

		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await GET({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel')
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(503);
		expect(cancelMock).toHaveBeenCalled();
	});

	it('closes an oversized upstream body before returning 413', async () => {
		const cancelMock = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel: cancelMock });
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(body, {
				status: 200,
				headers: { 'Content-Length': String(50 * 1024 * 1024 + 1) }
			})
		);

		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await GET({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel')
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(413);
		expect(cancelMock).toHaveBeenCalled();
	});

	it.each(['application/octet-stream', null])(
		'rewrites an HLS playlist with %s content type',
		async (contentType) => {
			const playlist = '#EXTM3U\n#EXTINF:6,Channel\nsegment.ts\n';
			fetchWithTimeoutMock.mockResolvedValue(
				new Response(playlist, {
					status: 200,
					headers: contentType ? { 'Content-Type': contentType } : undefined
				})
			);

			const { GET } = await import('./stream/[lineupId]/[...path]/+server');
			const response = await GET({
				params: { lineupId: 'lineup-1', path: 'channel' },
				url: new URL(
					'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
				),
				request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel')
			} as Parameters<typeof GET>[0]);

			expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
			expect(await response.text()).toContain('#EXTM3U');
		}
	);

	it('validates the source during HEAD and preserves upstream response metadata', async () => {
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(null, {
				status: 200,
				headers: {
					'Content-Type': 'application/vnd.apple.mpegurl',
					'Content-Length': '128'
				}
			})
		);

		const { HEAD } = await import('./stream/[lineupId]/[...path]/+server');
		const sourceUrl = 'https://provider.test/live/channel';
		const response = await HEAD({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				`http://cinephage.test/api/livetv/stream/lineup-1/channel?url=${encodeURIComponent(sourceUrl)}`
			)
		} as Parameters<typeof HEAD>[0]);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
		expect(response.headers.get('Content-Length')).toBe('128');
		expect(resolveAndValidateUrlMock).toHaveBeenCalledWith(sourceUrl);
		expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
			sourceUrl,
			expect.objectContaining({ method: 'HEAD' }),
			expect.any(Number)
		);
	});

	it('returns the upstream failure status during HEAD validation', async () => {
		fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 503 }));

		const { HEAD } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await HEAD({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			)
		} as Parameters<typeof HEAD>[0]);

		expect(response.status).toBe(503);
	});

	it('rejects a private redirect during HEAD validation', async () => {
		const privateUrl = 'http://127.0.0.1:8080/private.ts';
		resolveAndValidateUrlMock.mockImplementation(async (url: string) =>
			url === privateUrl ? { safe: false, reason: 'private address' } : { safe: true }
		);
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { Location: privateUrl }
			})
		);

		const { HEAD } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await HEAD({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			)
		} as Parameters<typeof HEAD>[0]);

		expect(response.status).toBe(403);
		expect(resolveAndValidateUrlMock).toHaveBeenCalledWith(privateUrl);
	});

	it('fails safely when a sniffed HLS playlist exceeds the response limit', async () => {
		const oversizedPlaylist = '#EXTM3U\n' + 'x'.repeat(5 * 1024 * 1024 + 1);
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(oversizedPlaylist, {
				status: 200,
				headers: { 'Content-Type': 'application/octet-stream' }
			})
		);

		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		const response = await GET({
			params: { lineupId: 'lineup-1', path: 'channel' },
			url: new URL(
				'http://cinephage.test/api/livetv/stream/lineup-1/channel?url=https%3A%2F%2Fprovider.test%2Flive%2Fchannel'
			),
			request: new Request('http://cinephage.test/api/livetv/stream/lineup-1/channel')
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(502);
	});
});

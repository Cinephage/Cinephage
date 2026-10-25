import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStreamMock = vi.fn();
const invalidateMock = vi.fn();
const fetchFromUrlMock = vi.fn();
const createHlsToTsStreamMock = vi.fn();

vi.mock('./StreamUrlCache.js', () => ({
	getStreamUrlCache: () => ({
		getStream: getStreamMock,
		invalidate: invalidateMock
	})
}));

vi.mock('./LiveTvStreamService.js', () => ({
	getLiveTvStreamService: () => ({ fetchFromUrl: fetchFromUrlMock })
}));

vi.mock('./HlsToTsConverter.js', () => ({
	createHlsToTsStream: createHlsToTsStreamMock
}));

vi.mock('#lib/server/streaming/url.js', () => ({
	getBaseUrlAsync: vi.fn().mockResolvedValue('http://cinephage.test')
}));

describe('Live TV stream request handler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getStreamMock.mockResolvedValue({
			url: 'https://provider.test/live/channel',
			type: 'unknown',
			providerType: 'm3u',
			providerHeaders: {}
		});
		createHlsToTsStreamMock.mockReturnValue(new ReadableStream<Uint8Array>());
	});

	function createTrackedBody(chunks: Uint8Array[], close = true) {
		const cancelMock = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				if (close) controller.close();
			},
			cancel: cancelMock
		});
		return { body, cancelMock };
	}

	it('validates the configured source during HEAD instead of returning route metadata', async () => {
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(null, {
				status: 200,
				headers: { 'Content-Type': 'video/mp2t' }
			}),
			finalUrl: 'https://provider.test/live/channel'
		});

		const { handleStreamHead } = await import('./StreamRequestHandler');
		const response = await handleStreamHead('lineup-1', new URL('http://cinephage.test/stream'));

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('video/mp2t');
		expect(getStreamMock).toHaveBeenCalledWith('lineup-1', 'hls');
		expect(fetchFromUrlMock).toHaveBeenCalledWith(
			'https://provider.test/live/channel',
			'm3u',
			{},
			undefined
		);
	});

	it('closes the upstream body after successful HEAD validation', async () => {
		const { body, cancelMock } = createTrackedBody([new Uint8Array([1, 2, 3])], false);
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'video/mp2t' }
			}),
			finalUrl: 'https://provider.test/live/channel'
		});

		const { handleStreamHead } = await import('./StreamRequestHandler');
		const response = await handleStreamHead('lineup-1', new URL('http://cinephage.test/stream'));

		expect(response.status).toBe(200);
		expect(cancelMock).toHaveBeenCalled();
	});

	it('passes the HEAD request signal through to upstream validation', async () => {
		const controller = new AbortController();
		fetchFromUrlMock.mockImplementation(
			(_url: string, _provider: string, _headers: Record<string, string>, signal?: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{
							once: true
						}
					);
				})
		);

		const { handleStreamHead } = await import('./StreamRequestHandler');
		const pending = handleStreamHead(
			'lineup-1',
			new URL('http://cinephage.test/stream'),
			controller.signal
		);
		await vi.waitFor(() => expect(fetchFromUrlMock).toHaveBeenCalled());
		expect(fetchFromUrlMock.mock.calls[0][3]).toBe(controller.signal);
		controller.abort();
		await expect(pending).resolves.toMatchObject({ status: 502 });
	});

	it('returns an error and closes the upstream body when HEAD validation is non-2xx', async () => {
		const { body, cancelMock } = createTrackedBody([new Uint8Array([1, 2, 3])]);
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(body, {
				status: 503,
				headers: { 'Content-Type': 'text/plain' }
			}),
			finalUrl: 'https://provider.test/live/channel'
		});

		const { handleStreamHead } = await import('./StreamRequestHandler');
		const response = await handleStreamHead('lineup-1', new URL('http://cinephage.test/stream'));

		expect(response.status).not.toBe(200);
		expect(cancelMock).toHaveBeenCalled();
	});

	it('uses the upstream response to select HLS-to-TS for extensionless HLS sources', async () => {
		fetchFromUrlMock.mockResolvedValue({
			response: new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n', {
				status: 200,
				headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
			}),
			finalUrl: 'https://provider.test/live/channel'
		});

		const { handleStreamGet } = await import('./StreamRequestHandler');
		const response = await handleStreamGet(
			'lineup-1',
			new Request('http://cinephage.test/stream'),
			new URL('http://cinephage.test/stream')
		);

		expect(response.headers.get('Content-Type')).toBe('video/mp2t');
		expect(createHlsToTsStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({ lineupItemId: 'lineup-1', signal: expect.any(AbortSignal) })
		);
	});

	it.each(['application/octet-stream', null])(
		'uses a bounded body prefix for explicit HLS responses with %s content type',
		async (contentType) => {
			const playlist = '#EXTM3U\n#EXTINF:6,Channel\nsegment.ts\n';
			fetchFromUrlMock.mockResolvedValue({
				response: new Response(playlist, {
					status: 200,
					headers: contentType ? { 'Content-Type': contentType } : undefined
				}),
				finalUrl: 'https://provider.test/live/channel/index'
			});

			const { handleStreamGet } = await import('./StreamRequestHandler');
			const response = await handleStreamGet(
				'lineup-1',
				new Request('http://cinephage.test/stream?format=hls'),
				new URL('http://cinephage.test/stream?format=hls')
			);

			expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
			expect(await response.text()).toContain('#EXTM3U');
		}
	);

	it('fails safely when an explicit HLS playlist exceeds the response limit', async () => {
		const oversizedPlaylist = '#EXTM3U\n' + 'x'.repeat(5 * 1024 * 1024 + 1);
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(oversizedPlaylist, {
				status: 200,
				headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
			}),
			finalUrl: 'https://provider.test/live/channel/index'
		});

		const { handleStreamGet } = await import('./StreamRequestHandler');
		const response = await handleStreamGet(
			'lineup-1',
			new Request('http://cinephage.test/stream?format=hls'),
			new URL('http://cinephage.test/stream?format=hls')
		);

		expect(response.status).toBe(502);
	});

	it('closes a non-HLS retry body before rejecting explicit HLS mode', async () => {
		const { body, cancelMock } = createTrackedBody([new Uint8Array([0x47])], false);
		fetchFromUrlMock
			.mockResolvedValueOnce({
				response: new Response(null, { status: 503 }),
				finalUrl: 'https://provider.test/live/channel'
			})
			.mockResolvedValueOnce({
				response: new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp2t' } }),
				finalUrl: 'https://provider.test/live/channel'
			});

		const { handleStreamGet } = await import('./StreamRequestHandler');
		const response = await handleStreamGet(
			'lineup-1',
			new Request('http://cinephage.test/stream?format=hls'),
			new URL('http://cinephage.test/stream?format=hls')
		);

		expect(response.status).toBe(502);
		expect(cancelMock).toHaveBeenCalled();
	});

	it.each([
		['application/octet-stream', 'octet-stream'],
		[null, 'missing content type']
	])('detects an HLS playlist from a bounded body prefix with %s', async (contentType, _label) => {
		const { body, cancelMock } = createTrackedBody(
			[new TextEncoder().encode('#EXTM3U\n#EXT-X-TARGETDURATION:6\n')],
			false
		);
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(body, {
				status: 200,
				headers: contentType ? { 'Content-Type': contentType } : undefined
			}),
			finalUrl: 'https://provider.test/live/channel'
		});

		const { handleStreamGet } = await import('./StreamRequestHandler');
		await handleStreamGet(
			'lineup-1',
			new Request('http://cinephage.test/stream'),
			new URL('http://cinephage.test/stream')
		);

		expect(createHlsToTsStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({
				lineupItemId: 'lineup-1',
				signal: expect.any(AbortSignal),
				initialPlaylist: expect.objectContaining({ body: expect.any(ReadableStream) })
			})
		);
		expect(createHlsToTsStreamMock.mock.calls[0][0].initialPlaylist.body).not.toBe(body);
		expect(cancelMock).not.toHaveBeenCalled();
	});

	it('fetches the default HLS playlist once and hands its body to the converter', async () => {
		const { body, cancelMock } = createTrackedBody(
			[new TextEncoder().encode('#EXTM3U\n#EXTINF:6,Channel\nsegment.ts\n')],
			false
		);
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'application/octet-stream' }
			}),
			finalUrl: 'https://provider.test/live/channel/index'
		});

		const { handleStreamGet } = await import('./StreamRequestHandler');
		await handleStreamGet(
			'lineup-1',
			new Request('http://cinephage.test/stream'),
			new URL('http://cinephage.test/stream')
		);

		expect(fetchFromUrlMock).toHaveBeenCalledTimes(1);
		expect(createHlsToTsStreamMock.mock.calls[0][0].initialPlaylist).toEqual(
			expect.objectContaining({
				body: expect.any(ReadableStream),
				finalUrl: 'https://provider.test/live/channel/index',
				providerHeaders: {}
			})
		);
		expect(createHlsToTsStreamMock.mock.calls[0][0].initialPlaylist.body).not.toBe(body);
		expect(cancelMock).not.toHaveBeenCalled();
	});

	it('preserves a direct MPEG-TS response body without probing it', async () => {
		const segment = new Uint8Array([0x47, 0x00, 0x01, 0x02]);
		const { body, cancelMock } = createTrackedBody([segment]);
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'video/mp2t' }
			}),
			finalUrl: 'https://provider.test/live/channel'
		});

		const { handleStreamGet } = await import('./StreamRequestHandler');
		const response = await handleStreamGet(
			'lineup-1',
			new Request('http://cinephage.test/stream'),
			new URL('http://cinephage.test/stream')
		);

		expect(createHlsToTsStreamMock).not.toHaveBeenCalled();
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(segment);
		expect(cancelMock).not.toHaveBeenCalled();
	});

	it('preserves streaming behavior for explicit TS format', async () => {
		const segment = new Uint8Array([0x47, 0x10, 0x11, 0x12]);
		const { body, cancelMock } = createTrackedBody([segment]);
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'video/mp2t' }
			}),
			finalUrl: 'https://provider.test/live/channel'
		});

		const { handleStreamGet } = await import('./StreamRequestHandler');
		const response = await handleStreamGet(
			'lineup-1',
			new Request('http://cinephage.test/stream?format=ts'),
			new URL('http://cinephage.test/stream?format=ts')
		);

		expect(getStreamMock).toHaveBeenCalledWith('lineup-1', 'ts');
		expect(response.headers.get('Content-Type')).toBe('video/mp2t');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(segment);
		expect(cancelMock).not.toHaveBeenCalled();
	});

	it('propagates the request signal to every initial Live TV fetch mode', async () => {
		for (const format of ['hls', 'ts', undefined]) {
			vi.clearAllMocks();
			getStreamMock.mockResolvedValue({
				url: 'https://provider.test/live/channel',
				type: 'unknown',
				providerType: 'm3u',
				providerHeaders: {}
			});
			fetchFromUrlMock.mockResolvedValue({
				response: new Response(new Uint8Array([0x47]), {
					status: 200,
					headers: { 'Content-Type': 'video/mp2t' }
				}),
				finalUrl: 'https://provider.test/live/channel'
			});
			const controller = new AbortController();
			const requestUrl = `http://cinephage.test/stream${format ? `?format=${format}` : ''}`;
			await handleStreamGetForTest(controller.signal, requestUrl);

			expect(fetchFromUrlMock).toHaveBeenCalledWith(
				'https://provider.test/live/channel',
				'm3u',
				{},
				expect.anything()
			);
		}
	});

	it('aborts an active initial Live TV fetch when the request disconnects', async () => {
		const controller = new AbortController();
		fetchFromUrlMock.mockImplementation(
			(_url: string, _provider: string, _headers: Record<string, string>, signal?: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{
							once: true
						}
					);
				})
		);

		const pending = handleStreamGetForTest(controller.signal, 'http://cinephage.test/stream');
		await vi.waitFor(() => expect(fetchFromUrlMock).toHaveBeenCalled());
		controller.abort();

		const response = await pending;
		expect(response.status).toBe(502);
	});
});

async function handleStreamGetForTest(signal: AbortSignal, requestUrl: string): Promise<Response> {
	const { handleStreamGet } = await import('./StreamRequestHandler');
	return handleStreamGet('lineup-1', new Request(requestUrl, { signal }), new URL(requestUrl));
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStreamMock = vi.fn();
const invalidateMock = vi.fn();
const fetchFromUrlMock = vi.fn();
const resolveAndValidateUrlMock = vi.fn();

vi.mock('./StreamUrlCache.js', () => ({
	getStreamUrlCache: () => ({ getStream: getStreamMock, invalidate: invalidateMock })
}));

vi.mock('./LiveTvStreamService.js', () => ({
	getLiveTvStreamService: () => ({ fetchFromUrl: fetchFromUrlMock })
}));

vi.mock('#lib/server/http/ssrf-protection.js', () => ({
	resolveAndValidateUrl: resolveAndValidateUrlMock
}));

describe('HlsToTsConverter URL safety', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getStreamMock.mockResolvedValue({
			url: 'https://provider.test/live/master',
			type: 'hls',
			providerType: 'm3u',
			providerHeaders: {}
		});
		resolveAndValidateUrlMock.mockResolvedValue({ safe: true });
	});

	it('uses an inspected initial playlist body without fetching it again', async () => {
		const controller = new AbortController();
		const playlistBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(
					new TextEncoder().encode('#EXTM3U\n#EXTINF:6,Channel\nhttps://cdn.test/segment.ts\n')
				);
				streamController.close();
			}
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(new Uint8Array([0x47, 0x00, 0x01]), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const { createHlsToTsStream } = await import('./HlsToTsConverter');
		const stream = createHlsToTsStream({
			lineupItemId: 'lineup-1',
			signal: controller.signal,
			initialPlaylist: {
				body: playlistBody,
				finalUrl: 'https://provider.test/live/channel/index',
				providerHeaders: {}
			}
		});

		const reader = stream.getReader();
		await expect(reader.read()).resolves.toEqual({
			done: false,
			value: new Uint8Array([0x47, 0x00, 0x01])
		});
		controller.abort();

		expect(fetchFromUrlMock).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects a private HLS variant URL before fetching it', async () => {
		const controller = new AbortController();
		const privateVariant = 'http://127.0.0.1:8080/private.m3u8';
		resolveAndValidateUrlMock.mockImplementation(async (url: string) => {
			if (url === privateVariant) {
				controller.abort();
				return { safe: false, reason: 'private address' };
			}
			return { safe: true };
		});
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${privateVariant}\n`, {
				status: 200
			}),
			finalUrl: 'https://provider.test/live/master'
		});

		const { createHlsToTsStream } = await import('./HlsToTsConverter');
		const stream = createHlsToTsStream({
			lineupItemId: 'lineup-1',
			maxConsecutiveErrors: 1,
			signal: controller.signal
		});
		await stream.getReader().read();

		expect(resolveAndValidateUrlMock).toHaveBeenCalledWith(privateVariant);
		expect(fetchFromUrlMock).toHaveBeenCalledTimes(1);
	});

	it('validates every variant redirect hop before following it', async () => {
		const controller = new AbortController();
		const privateRedirect = 'http://127.0.0.1:8080/private.m3u8';
		resolveAndValidateUrlMock.mockImplementation(async (url: string) => {
			if (url === privateRedirect) {
				controller.abort();
				return { safe: false, reason: 'private address' };
			}
			return { safe: true };
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(null, { status: 302, headers: { Location: privateRedirect } })
			);
		vi.stubGlobal('fetch', fetchMock);
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(
				'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://cdn.test/media.m3u8\n',
				{
					status: 200
				}
			),
			finalUrl: 'https://provider.test/live/master'
		});

		const { createHlsToTsStream } = await import('./HlsToTsConverter');
		await createHlsToTsStream({ lineupItemId: 'lineup-1', signal: controller.signal })
			.getReader()
			.read();

		expect(resolveAndValidateUrlMock).toHaveBeenCalledWith(privateRedirect);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('validates segment URLs and propagates the request signal to network fetches', async () => {
		const controller = new AbortController();
		const privateSegment = 'http://127.0.0.1:8080/private.ts';
		resolveAndValidateUrlMock.mockImplementation(async (url: string) => {
			if (url === privateSegment) {
				controller.abort();
				return { safe: false, reason: 'private address' };
			}
			return { safe: true };
		});
		fetchFromUrlMock.mockResolvedValue({
			response: new Response(`#EXTM3U\n#EXTINF:6,Channel\n${privateSegment}\n`, {
				status: 200
			}),
			finalUrl: 'https://provider.test/live/media.m3u8'
		});

		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const { createHlsToTsStream } = await import('./HlsToTsConverter');
		const stream = createHlsToTsStream({ lineupItemId: 'lineup-1', signal: controller.signal });
		await stream.getReader().read();

		expect(resolveAndValidateUrlMock).toHaveBeenCalledWith(privateSegment);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(fetchFromUrlMock).toHaveBeenCalledWith(
			'https://provider.test/live/master',
			'm3u',
			{},
			expect.any(AbortSignal)
		);
	});

	it('does not start network work for an already-aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();
		const { createHlsToTsStream } = await import('./HlsToTsConverter');

		createHlsToTsStream({ lineupItemId: 'lineup-1', signal: controller.signal });
		await Promise.resolve();

		expect(getStreamMock).not.toHaveBeenCalled();
		expect(fetchFromUrlMock).not.toHaveBeenCalled();
	});

	it('aborts an active playlist fetch when the signal is cancelled', async () => {
		const controller = new AbortController();
		fetchFromUrlMock.mockImplementation(
			(
				_url: string,
				_providerType: string,
				_headers: Record<string, string>,
				signal?: AbortSignal
			) =>
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

		const { createHlsToTsStream } = await import('./HlsToTsConverter');
		const stream = createHlsToTsStream({ lineupItemId: 'lineup-1', signal: controller.signal });
		await vi.waitFor(() => expect(fetchFromUrlMock).toHaveBeenCalled());
		controller.abort();

		await expect(stream.getReader().read()).resolves.toEqual({ done: true, value: undefined });
	});

	it('cancels the upstream segment body when the declared size is too large', async () => {
		const cancelMock = vi.fn();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(new ReadableStream<Uint8Array>({ cancel: cancelMock }), {
					status: 200,
					headers: { 'Content-Length': String(50 * 1024 * 1024 + 1) }
				})
			)
		);

		const { fetchSegment } = await import('./HlsToTsConverter');
		await expect(fetchSegment('https://cdn.test/segment.ts', {}, 1000)).rejects.toThrow();
		expect(cancelMock).toHaveBeenCalled();
	});

	it('cancels the upstream segment body when a chunked download exceeds the limit', async () => {
		const cancelMock = vi.fn();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.enqueue(new Uint8Array(25 * 1024 * 1024));
						},
						cancel: cancelMock
					}),
					{ status: 200 }
				)
			)
		);

		const { fetchSegment } = await import('./HlsToTsConverter');
		await expect(fetchSegment('https://cdn.test/segment.ts', {}, 1000)).rejects.toThrow();
		expect(cancelMock).toHaveBeenCalled();
	});

	it('aborts an active upstream fetch when the consumer cancels the converter', async () => {
		let upstreamAbort: AbortSignal | undefined;
		fetchFromUrlMock.mockImplementation(
			(_url: string, _provider: string, _headers: Record<string, string>, signal?: AbortSignal) => {
				upstreamAbort = signal;
				return new Promise((_resolve, reject) => {
					signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{
							once: true
						}
					);
				});
			}
		);

		const { createHlsToTsStream } = await import('./HlsToTsConverter');
		const reader = createHlsToTsStream({ lineupItemId: 'lineup-1' }).getReader();
		await vi.waitFor(() => expect(fetchFromUrlMock).toHaveBeenCalled());
		await reader.cancel();

		expect(upstreamAbort?.aborted).toBe(true);
	});

	it('does not wait through playlist backoff after the request is aborted', async () => {
		vi.useFakeTimers();
		try {
			getStreamMock.mockRejectedValue(new Error('temporary failure'));
			const controller = new AbortController();
			const { createHlsToTsStream } = await import('./HlsToTsConverter');
			const reader = createHlsToTsStream({
				lineupItemId: 'lineup-1',
				signal: controller.signal
			}).getReader();
			const read = reader.read();
			await vi.waitFor(() => expect(getStreamMock).toHaveBeenCalled());
			controller.abort();
			await read;
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not start a segment fetch if the signal aborts during URL validation', async () => {
		const controller = new AbortController();
		let releaseValidation!: (result: { safe: boolean }) => void;
		resolveAndValidateUrlMock.mockReturnValue(
			new Promise<{ safe: boolean }>((resolve) => {
				releaseValidation = resolve;
			})
		);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const { fetchSegment } = await import('./HlsToTsConverter');
		const segmentPromise = fetchSegment('https://cdn.test/segment.ts', {}, 1000, controller.signal);
		await vi.waitFor(() => expect(resolveAndValidateUrlMock).toHaveBeenCalled());
		controller.abort();
		releaseValidation({ safe: true });

		await expect(segmentPromise).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

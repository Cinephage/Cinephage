import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveAndValidateUrlMock = vi.fn(async () => ({ safe: true }));
const fetchWithTimeoutMock = vi.fn();

vi.mock('#lib/server/http/ssrf-protection.js', () => ({
	resolveAndValidateUrl: resolveAndValidateUrlMock,
	fetchWithTimeout: fetchWithTimeoutMock,
	MAX_REDIRECTS: 5
}));

const BASE_URL = 'https://media.example.com';

describe('SessionProxyService.renderLaunchMedia', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		resolveAndValidateUrlMock.mockResolvedValue({ safe: true });
		const { getPlaybackSessionStore } = await import('./session-store');
		getPlaybackSessionStore().clear();
	});

	it('streams an mp4 source as progressive mp4 with range passthrough', async () => {
		const body = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(body, {
				status: 206,
				headers: {
					'Content-Type': 'video/mp4',
					'Content-Range': 'bytes 0-3/1000',
					'Accept-Ranges': 'bytes'
				}
			})
		);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');

		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/movie.mp4',
			sourceType: 'mp4',
			requestHeaders: { Referer: 'https://player.example.com/' },
			attempts: []
		});

		const request = new Request(`${BASE_URL}/api/streaming/session/movie/541134`, {
			headers: { Range: 'bytes=0-3' }
		});
		const response = await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			'api-key',
			request
		);

		expect(response.status).toBe(206);
		expect(response.headers.get('Content-Type')).toBe('video/mp4');
		expect(response.headers.get('Content-Range')).toBe('bytes 0-3/1000');
		expect(new Uint8Array(await new Response(response.body).arrayBuffer())).toEqual(body);

		// Upstream request must include the session's referer and the range.
		const [upstreamUrl, upstreamInit] = fetchWithTimeoutMock.mock.calls[0];
		expect(upstreamUrl).toBe('https://cdn.example.com/movie.mp4');
		expect(upstreamInit.headers.Referer).toBe('https://player.example.com/');
		expect(upstreamInit.headers.range).toBe('bytes=0-3');
	});

	it('does not forward the browser-only Origin header upstream', async () => {
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(new Uint8Array([0x00, 0x01]), {
				status: 200,
				headers: { 'Content-Type': 'video/mp4' }
			})
		);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');

		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541135,
			entryUrl: 'https://cdn.example.com/movie.mp4',
			sourceType: 'mp4',
			requestHeaders: {
				Origin: 'https://cinema.army',
				Referer: 'https://cinema.army/',
				'User-Agent': 'player-agent'
			},
			attempts: []
		});

		await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			'api-key',
			new Request(`${BASE_URL}/api/streaming/session/movie/541135`)
		);

		const [, upstreamInit] = fetchWithTimeoutMock.mock.calls[0];
		expect(upstreamInit.headers.Origin).toBeUndefined();
		expect(upstreamInit.headers.origin).toBeUndefined();
		expect(upstreamInit.headers.Referer).toBe('https://cinema.army/');
		expect(upstreamInit.headers['User-Agent']).toBe('player-agent');
	});

	it('returns the upstream error when an mp4 source fails', async () => {
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(JSON.stringify({ error: 'gone' }), { status: 404 })
		);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');

		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/dead.mp4',
			sourceType: 'mp4',
			requestHeaders: {},
			attempts: []
		});

		const response = await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			'api-key',
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(response.status).toBe(404);
	});

	it('rewrites an hls source playlist at the extension-less path', async () => {
		const upstreamPlaylist = [
			'#EXTM3U',
			'#EXT-X-VERSION:3',
			'#EXT-X-TARGETDURATION:10',
			'#EXTINF:10.0,',
			'segment0.ts',
			'#EXT-X-ENDLIST'
		].join('\n');

		fetchWithTimeoutMock.mockResolvedValue(
			new Response(upstreamPlaylist, {
				status: 200,
				headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
			})
		);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');

		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/master.m3u8',
			sourceType: 'hls',
			requestHeaders: {},
			attempts: []
		});

		const response = await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			'api-key',
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
		expect(response.headers.get('Cache-Control')).toBe('no-cache');
		const playlist = await response.text();
		expect(playlist).toContain('#EXTM3U');
		expect(playlist).toContain(`${BASE_URL}/api/streaming/session/${session.token}/segment/`);
	});

	it('cancels a redirect response body before following the redirect', async () => {
		const cancelMock = vi.fn();
		const redirectResponse = {
			status: 302,
			headers: new Headers({ Location: 'https://cdn.example.com/final.m3u8' }),
			body: { cancel: cancelMock }
		} as unknown as Response;
		fetchWithTimeoutMock
			.mockResolvedValueOnce(redirectResponse)
			.mockResolvedValueOnce(new Response('#EXTM3U\n#EXT-X-ENDLIST\n', { status: 200 }));

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/master.m3u8',
			sourceType: 'hls',
			requestHeaders: {},
			attempts: []
		});

		await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			'api-key',
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(cancelMock).toHaveBeenCalled();
	});

	it.each([
		['releases the reader lock after success', false, false],
		['releases the reader lock after overflow', true, false],
		['releases the reader lock after a read error', false, true]
	])('%s', async (_name, overflow, readError) => {
		const releaseLockMock = vi.fn();
		const cancelMock = vi.fn();
		const reader = {
			read: vi
				.fn()
				.mockImplementationOnce(async () => {
					if (readError) throw new Error('read failed');
					return {
						done: false,
						value: overflow ? new Uint8Array(5 * 1024 * 1024 + 1) : new Uint8Array([0x23])
					};
				})
				.mockResolvedValueOnce({ done: true, value: undefined }),
			cancel: cancelMock,
			releaseLock: releaseLockMock
		};
		const upstream = new Response(null, {
			status: 200,
			headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
		});
		Object.defineProperty(upstream, 'body', { value: { getReader: () => reader } });
		fetchWithTimeoutMock.mockResolvedValue(upstream);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/master.m3u8',
			sourceType: 'hls',
			requestHeaders: {},
			attempts: []
		});

		const render = getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			'api-key',
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);
		if (overflow || readError) await expect(render).rejects.toThrow();
		else await render;
		expect(releaseLockMock).toHaveBeenCalled();
	});

	it('overrides an obfuscated image type with authoritative container metadata', async () => {
		const body = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'image/jpeg' }
			})
		);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/obfuscated.jpeg',
			sourceType: 'file',
			sourceFormat: 'mkv',
			sourceContentType: 'video/x-matroska',
			requestHeaders: {},
			attempts: []
		});

		const response = await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			'api-key',
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('video/x-matroska');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
	});

	it('sniffs a disguised Matroska stream without buffering the whole response', async () => {
		const body = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(body, { status: 200, headers: { 'Content-Type': 'image/png' } })
		);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/obfuscated.png',
			sourceType: 'file',
			requestHeaders: {},
			attempts: []
		});

		const response = await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			undefined,
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(response.headers.get('Content-Type')).toBe('video/x-matroska');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
	});

	it('preserves a 416 response and its Content-Range header', async () => {
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(null, {
				status: 416,
				headers: { 'Content-Range': 'bytes */1000' }
			})
		);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/movie.mp4',
			sourceType: 'mp4',
			requestHeaders: {},
			attempts: []
		});

		const response = await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			undefined,
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`, {
				headers: { Range: 'bytes=2000-' }
			})
		);

		expect(response.status).toBe(416);
		expect(response.headers.get('Content-Range')).toBe('bytes */1000');
	});

	it('passes a conditional 304 response through without a body', async () => {
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(null, { status: 304, headers: { ETag: '"stream-v1"' } })
		);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/movie.mp4',
			sourceType: 'mp4',
			requestHeaders: {},
			attempts: []
		});

		const response = await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			undefined,
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`, {
				headers: { 'If-None-Match': '"stream-v1"' }
			})
		);

		expect(response.status).toBe(304);
		expect(response.headers.get('ETag')).toBe('"stream-v1"');
		expect(await response.text()).toBe('');
	});
});

describe('SessionProxyService.renderHeadResponse', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		resolveAndValidateUrlMock.mockResolvedValue({ safe: true });
		const { getPlaybackSessionStore } = await import('./session-store');
		getPlaybackSessionStore().clear();
	});

	async function createSession(sourceType: 'mp4' | 'hls' | 'dash' | 'file') {
		const { getPlaybackSessionStore } = await import('./session-store');
		return getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: `https://cdn.example.com/stream.${sourceType === 'dash' ? 'mpd' : sourceType === 'hls' ? 'm3u8' : 'mp4'}`,
			sourceType,
			requestHeaders: {},
			attempts: []
		});
	}

	it('probes the upstream with HEAD and returns status without a body', async () => {
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(null, {
				status: 200,
				headers: {
					'Content-Type': 'video/mp4',
					'Content-Length': '12345',
					'Accept-Ranges': 'bytes'
				}
			})
		);

		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = await createSession('mp4');

		const response = await getSessionProxyService().renderHeadResponse(
			session,
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('video/mp4');
		expect(response.headers.get('Content-Length')).toBe('12345');
		expect(response.headers.get('Accept-Ranges')).toBe('bytes');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(await response.text()).toBe('');

		const [, upstreamInit] = fetchWithTimeoutMock.mock.calls[0];
		expect(upstreamInit.method).toBe('HEAD');
	});

	it('sets the manifest content type for hls sources', async () => {
		fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 200 }));

		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = await createSession('hls');

		const response = await getSessionProxyService().renderHeadResponse(
			session,
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
	});

	it('sets the dash content type for dash sources', async () => {
		fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 200 }));

		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = await createSession('dash');

		const response = await getSessionProxyService().renderHeadResponse(
			session,
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/dash+xml');
	});

	it('preserves the upstream content type for an unknown direct container', async () => {
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(null, { status: 200, headers: { 'Content-Type': 'video/x-matroska' } })
		);

		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = await createSession('file');
		const response = await getSessionProxyService().renderHeadResponse(
			session,
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(response.headers.get('Content-Type')).toBe('video/x-matroska');
	});

	it('forwards the upstream status on failure', async () => {
		fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 404 }));

		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = await createSession('mp4');

		const response = await getSessionProxyService().renderHeadResponse(
			session,
			new Request(`${BASE_URL}/api/streaming/session/movie/541134`)
		);

		expect(response.status).toBe(404);
	});
});

describe('SessionProxyService.renderRegisteredResource', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		resolveAndValidateUrlMock.mockResolvedValue({ safe: true });
		const { getPlaybackSessionStore } = await import('./session-store');
		getPlaybackSessionStore().clear();
	});

	it('materializes a cross-origin DASH template with the player-provided value', async () => {
		fetchWithTimeoutMock.mockResolvedValue(
			new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { 'Content-Type': 'video/mp4' }
			})
		);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');
		const store = getPlaybackSessionStore();
		const session = store.createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/manifest.mpd',
			sourceType: 'dash',
			requestHeaders: {},
			attempts: []
		});
		const resource = store.registerResource(
			session.token,
			'https://segments.example.com/video-$Number%05d$.m4s?token=signed',
			'segment',
			'm4s'
		);
		expect(resource).not.toBeNull();

		await getSessionProxyService().renderRegisteredResource(
			session,
			resource!.id,
			BASE_URL,
			undefined,
			new Request(
				`${BASE_URL}/api/streaming/session/${session.token}/segment/${resource!.id}.m4s?dash_Number=00042`
			)
		);

		expect(fetchWithTimeoutMock.mock.calls[0][0]).toBe(
			'https://segments.example.com/video-00042.m4s?token=signed'
		);
	});

	it('uses a .vtt URL for extensionless segments in native subtitle renditions', async () => {
		fetchWithTimeoutMock
			.mockResolvedValueOnce(
				new Response(
					[
						'#EXTM3U',
						'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subtitles.m3u8"',
						'#EXT-X-STREAM-INF:BANDWIDTH=1000000,SUBTITLES="subs"',
						'video.m3u8'
					].join('\n'),
					{ status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }
				)
			)
			.mockResolvedValueOnce(
				new Response('#EXTM3U\n#EXTINF:10.0,\nsubtitle-segment\n#EXT-X-ENDLIST', {
					status: 200,
					headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
				})
			);

		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');
		const store = getPlaybackSessionStore();
		const session = store.createSession({
			mediaType: 'tv',
			tmdbId: 615,
			season: 11,
			episode: 6,
			entryUrl: 'https://cdn.example.com/master.m3u8',
			sourceType: 'hls',
			requestHeaders: {},
			attempts: []
		});

		const masterResponse = await getSessionProxyService().renderLaunchMedia(
			session,
			BASE_URL,
			'api-key',
			new Request(`${BASE_URL}/api/streaming/session/tv/615/11/6`)
		);
		const master = await masterResponse.text();
		const subtitlePlaylistId = master.match(/\/playlist\/([^/.]+)\.m3u8/)?.[1];
		expect(subtitlePlaylistId).toBeDefined();

		const subtitleResponse = await getSessionProxyService().renderRegisteredResource(
			session,
			subtitlePlaylistId!,
			BASE_URL,
			'api-key',
			new Request(
				`${BASE_URL}/api/streaming/session/${session.token}/playlist/${subtitlePlaylistId}.m3u8`
			)
		);
		const subtitlePlaylist = await subtitleResponse.text();

		expect(subtitlePlaylist).toContain('/segment/');
		expect(subtitlePlaylist).toContain('.vtt?api_key=api-key');
		expect(subtitlePlaylist).not.toContain('.ts?api_key=api-key');
	});
});

describe('SessionProxyService.renderSubtitlePlaylist', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		resolveAndValidateUrlMock.mockResolvedValue({ safe: true });
		const { getPlaybackSessionStore } = await import('./session-store');
		getPlaybackSessionStore().clear();
	});

	it('does not cache subtitle playlists and preserves the base path', async () => {
		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');
		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 541134,
			entryUrl: 'https://cdn.example.com/master.m3u8',
			sourceType: 'hls',
			requestHeaders: {},
			attempts: [],
			subtitles: [
				{
					id: 'sub-1',
					url: 'https://cdn.example.com/subtitles.vtt',
					label: 'English',
					language: 'en',
					isDefault: true
				}
			]
		});

		const response = await getSessionProxyService().renderSubtitlePlaylist(
			session,
			'sub-1',
			'https://media.example.com/cinephage'
		);

		expect(response.headers.get('Cache-Control')).toBe('no-cache');
		expect(await response.text()).toContain(
			`https://media.example.com/cinephage/api/streaming/session/${session.token}/subtitle/sub-1.vtt`
		);
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const solverFetch = vi.fn();
const solverAvailable = vi.fn(() => true);

vi.mock('#lib/server/captcha/index.js', () => ({
	getCaptchaSolver: () => ({ isAvailable: solverAvailable, fetch: solverFetch }),
	captchaSolverSettingsService: { isEnabled: () => true }
}));

vi.mock('#lib/logging/index.js', () => {
	const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
	return { logger, createChildLogger: () => logger };
});

const { cloudflareFetch } = await import('./cloudflare-fetch.js');

const CHALLENGE_BODY =
	'<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
	'<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' +
	'<script>window._cf_chl_opt={};</script></head><body>Checking your browser</body></html>';

function protectFetchWith(body: string, status: number) {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			status,
			headers: new Headers(),
			url: 'https://rutracker.org/forum/viewtopic.php?t=1',
			arrayBuffer: async () => Buffer.from(body, 'utf-8')
		})
	);
}

describe('cloudflareFetch', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		solverFetch.mockReset();
		solverAvailable.mockReturnValue(true);
	});

	it('carries the session cookies into the browser that takes over', async () => {
		// The plain fetch holds the tracker session; the browser starts with an
		// empty jar and is answered as an anonymous visitor, so a details page
		// comes back as a login stub and every selector misses (#663).
		protectFetchWith(CHALLENGE_BODY, 403);
		solverFetch.mockResolvedValue({
			success: true,
			status: 200,
			body: '<html>topic</html>',
			headers: {},
			cookies: [],
			userAgent: 'ua',
			url: 'https://rutracker.org/forum/viewtopic.php?t=1',
			timeMs: 10
		});

		await cloudflareFetch('https://rutracker.org/forum/viewtopic.php?t=1', {
			headers: { Cookie: 'bb_session=abc123; bb_guid=def456', Referer: 'https://rutracker.org/' }
		});

		expect(solverFetch).toHaveBeenCalledTimes(1);
		const passedCookies = solverFetch.mock.calls[0][0].cookies;
		expect(passedCookies).toHaveLength(2);
		expect(passedCookies).toMatchObject([
			{ name: 'bb_session', value: 'abc123', domain: 'rutracker.org', path: '/' },
			{ name: 'bb_guid', value: 'def456', domain: 'rutracker.org', path: '/' }
		]);
	});

	it('does not launch a browser for a page that is not challenged', async () => {
		protectFetchWith('<html><body>plain page</body></html>', 200);

		const result = await cloudflareFetch('https://example.test/page', {
			headers: { Cookie: 'a=1' }
		});

		expect(solverFetch).not.toHaveBeenCalled();
		expect(result.status).toBe(200);
		expect(result.usedBrowser).toBe(false);
	});
	it('returns raw bytes when a binary fetch is challenged', async () => {
		// A `.torrent` is not a document: decoding it as text mangles it, and the
		// browser fetch has to be asked for the payload as bytes (#663).
		const bytes = Buffer.from('d8:announce23:http://bt4.t-ru.org/ann', 'latin1');
		protectFetchWith(CHALLENGE_BODY, 403);
		solverFetch.mockResolvedValue({
			success: true,
			status: 200,
			body: '',
			data: bytes,
			headers: {},
			cookies: [],
			userAgent: 'ua',
			url: 'https://rutracker.org/forum/dl.php?t=1',
			timeMs: 10
		});

		const result = await cloudflareFetch('https://rutracker.org/forum/dl.php?t=1', {
			headers: { Referer: 'https://rutracker.org/forum/viewtopic.php?t=1' },
			binary: true
		});

		expect(solverFetch.mock.calls[0][0]).toMatchObject({
			binary: true,
			referer: 'https://rutracker.org/forum/viewtopic.php?t=1'
		});
		expect(result.usedBrowser).toBe(true);
		expect(result.data).toEqual(bytes);
	});

	it('returns raw bytes on the plain path without launching a browser', async () => {
		const bytes = 'd8:announce23:http://bt4.t-ru.org/ann';
		protectFetchWith(bytes, 200);

		const result = await cloudflareFetch('https://rutracker.org/forum/dl.php?t=1', {
			headers: { Referer: 'https://rutracker.org/' },
			binary: true
		});

		expect(solverFetch).not.toHaveBeenCalled();
		expect(result.usedBrowser).toBe(false);
		expect(result.data?.toString('latin1')).toBe(bytes);
	});
});

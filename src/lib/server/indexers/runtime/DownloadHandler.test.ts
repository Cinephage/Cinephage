/**
 * DownloadHandler torrent-link validation.
 *
 * The validation probe used to be a plain Node fetch, which RuTracker's dl.php
 * challenges on TLS fingerprint however valid the session is. Every candidate
 * was therefore rejected, the definition's `a.magnet-link` selector won, and a
 * season pack was added as a magnet with no file list - so the per-episode
 * selection the grab existed for silently did not happen (#663).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { YamlDefinition } from '../schema/yamlDefinition.js';

const solverFetch = vi.fn();
const solverAvailable = vi.fn(() => true);

vi.mock('#lib/server/captcha/index.js', () => ({
	getCaptchaSolver: () => ({ isAvailable: solverAvailable, fetch: solverFetch }),
	captchaSolverSettingsService: { isEnabled: () => true }
}));

const logWarn = vi.fn();
vi.mock('#lib/logging/index.js', () => {
	const logger = { info: vi.fn(), debug: vi.fn(), warn: logWarn, error: vi.fn() };
	return { logger, createChildLogger: () => logger };
});

const { DownloadHandler } = await import('./DownloadHandler.js');
const { createTemplateEngine } = await import('../engine/TemplateEngine.js');
const { createFilterEngine } = await import('../engine/FilterEngine.js');
const { createSelectorEngine } = await import('../engine/SelectorEngine.js');

const CHALLENGE_BODY =
	'<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
	'<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' +
	'<script>window._cf_chl_opt={};</script></head><body>Checking your browser</body></html>';

// A real RuTracker .torrent begins `d8:announce23:http://bt4.t-ru.org/ann...`.
const TORRENT_BYTES = Buffer.from(
	'd8:announce23:http://bt4.t-ru.org/ann7:comment28:https://rutracker.org/forum/viewe',
	'latin1'
);
const PAGE_BYTES = Buffer.from('<!DOCTYPE html><html lang="ru"><head>', 'latin1');

const DOWNLOAD_URL = 'https://rutracker.org/forum/dl.php?t=6926974';

function plainFetchReturns(body: string | Buffer, status: number) {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			status,
			ok: status < 400,
			headers: new Headers(),
			url: DOWNLOAD_URL,
			arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8'))
		})
	);
}

function createHandler(): InstanceType<typeof DownloadHandler> {
	const definition = {
		id: 'rutracker',
		name: 'RuTracker.org',
		links: ['https://rutracker.org/'],
		settings: [],
		search: { fields: {} },
		download: { selectors: [{ selector: '{{ .Variables.downloadUrl }}' }] }
	} as unknown as YamlDefinition;

	const templateEngine = createTemplateEngine();
	const filterEngine = createFilterEngine();
	return new DownloadHandler(
		definition,
		templateEngine,
		filterEngine,
		createSelectorEngine(templateEngine, filterEngine)
	);
}

type Probe = {
	testTorrentLink(
		url: string,
		headers: Record<string, string>
	): Promise<{ valid: boolean; data?: Buffer }>;
};

function probe(): Probe {
	return createHandler() as unknown as Probe;
}

describe('DownloadHandler.testTorrentLink', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		solverFetch.mockReset();
		solverAvailable.mockReset();
		solverAvailable.mockReturnValue(true);
		logWarn.mockReset();
	});

	it('accepts a link the browser fetch passes after a plain fetch is challenged', async () => {
		plainFetchReturns(CHALLENGE_BODY, 403);
		solverFetch.mockResolvedValue({
			success: true,
			status: 200,
			body: '',
			data: TORRENT_BYTES,
			headers: {},
			cookies: [],
			userAgent: 'ua',
			url: DOWNLOAD_URL,
			timeMs: 10
		});

		const result = await probe().testTorrentLink(DOWNLOAD_URL, {
			Cookie: 'bb_session=abc',
			Referer: 'https://rutracker.org/forum/viewtopic.php?t=6926974'
		});

		expect(result.valid).toBe(true);
		expect(result.data?.length).toBe(TORRENT_BYTES.length);
		// The payload must be pulled as bytes through the browser context, not as
		// a document - that is the route that passes the fingerprint gate.
		expect(solverFetch).toHaveBeenCalledTimes(1);
		expect(solverFetch.mock.calls[0][0]).toMatchObject({
			url: DOWNLOAD_URL,
			binary: true,
			referer: 'https://rutracker.org/forum/viewtopic.php?t=6926974'
		});
		expect(logWarn).not.toHaveBeenCalled();
	});

	it('reports a page served instead of a torrent instead of skipping quietly', async () => {
		plainFetchReturns(CHALLENGE_BODY, 403);
		solverFetch.mockResolvedValue({
			success: true,
			status: 200,
			body: '',
			data: PAGE_BYTES,
			headers: {},
			cookies: [],
			userAgent: 'ua',
			url: DOWNLOAD_URL,
			timeMs: 10
		});

		const result = await probe().testTorrentLink(DOWNLOAD_URL, { Cookie: 'bb_session=abc' });

		expect(result.valid).toBe(false);
		expect(logWarn).toHaveBeenCalledTimes(1);
		expect(String(logWarn.mock.calls[0][1])).toContain('non-bencoded');
		expect(logWarn.mock.calls[0][0]).toMatchObject({
			status: 200,
			dataLength: PAGE_BYTES.length
		});
	});

	it('caps the URL it logs when a candidate arrives as a whole page', async () => {
		// Without the extraction the candidate URL can carry a full page; one grab
		// must not write kilobytes into the log.
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

		const result = await probe().testTorrentLink(
			`https://rutracker.org/forum/${'x'.repeat(5000)}`,
			{}
		);

		expect(result.valid).toBe(false);
		expect(String(logWarn.mock.calls[0][0].url).length).toBeLessThan(300);
	});

	it('does not launch a browser when the plain fetch already returns torrent bytes', async () => {
		plainFetchReturns(TORRENT_BYTES, 200);

		const result = await probe().testTorrentLink(DOWNLOAD_URL, { Cookie: 'bb_session=abc' });

		expect(result.valid).toBe(true);
		expect(solverFetch).not.toHaveBeenCalled();
	});
});

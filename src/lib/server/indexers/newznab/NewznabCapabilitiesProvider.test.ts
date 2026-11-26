import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.hoisted(() => vi.fn());
const createIndexerHttpMock = vi.hoisted(() => vi.fn(() => ({ get: getMock })));

vi.mock('../http/IndexerHttp.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../http/IndexerHttp.js')>();
	return { ...actual, createIndexerHttp: createIndexerHttpMock };
});

import { CloudflareProtectedError } from '../http/CloudflareDetection.js';
import { HttpError } from '../http/IndexerHttp.js';
import {
	CapabilitiesFetchError,
	NewznabCapabilitiesProvider
} from './NewznabCapabilitiesProvider.js';

const CAPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
\t<server version="1.0" title="JacRed" />
\t<limits default="100" max="100" />
\t<searching>
\t\t<search available="yes" supportedParams="q" />
\t\t<tv-search available="yes" supportedParams="q,season,ep" />
\t\t<movie-search available="yes" supportedParams="q,imdbid" />
\t\t<audio-search available="no" supportedParams="" />
\t\t<book-search available="no" supportedParams="" />
\t</searching>
\t<categories>
\t\t<category id="2000" name="Movies" />
\t\t<category id="5000" name="TV" />
\t</categories>
</caps>`;

function response(body: string, contentType = 'application/xml; charset=utf-8', status = 200) {
	return { body, status, headers: new Headers({ 'content-type': contentType }), url: '' };
}

beforeEach(() => {
	getMock.mockReset();
	createIndexerHttpMock.mockClear();
	// A regression to bare fetch() fails here instead of reaching the network.
	vi.stubGlobal(
		'fetch',
		vi.fn().mockRejectedValue(new Error('bare fetch() used for capabilities'))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('NewznabCapabilitiesProvider HTTP path', () => {
	it('fetches capabilities through the shared indexer client, never bare fetch', async () => {
		getMock.mockResolvedValue(response(CAPS_XML));

		const provider = new NewznabCapabilitiesProvider();
		const caps = await provider.validateCapabilitiesEndpoint('https://jacred.stream/torznab/api');

		expect(caps.server.title).toBe('JacRed');
		expect(caps.categories).toHaveLength(2);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(createIndexerHttpMock).toHaveBeenCalledWith(
			expect.objectContaining({
				indexerId: 'capabilities:jacred.stream',
				retry: { maxRetries: 0, initialDelayMs: 1000 }
			})
		);
		expect(getMock.mock.calls[0][0]).toBe('https://jacred.stream/torznab/api?t=caps');
	});

	it('reports an HTTP failure with its status', async () => {
		getMock.mockRejectedValue(new HttpError(403, 'Forbidden', new Headers()));
		const provider = new NewznabCapabilitiesProvider();

		await expect(
			provider.validateCapabilitiesEndpoint('https://x.example/api')
		).rejects.toMatchObject({ name: 'CapabilitiesFetchError', statusCode: 403 });
	});

	it('names an unsolved Cloudflare challenge instead of a bare 403', async () => {
		getMock.mockRejectedValue(new CloudflareProtectedError('x.example', 403));
		const provider = new NewznabCapabilitiesProvider();

		const error = await provider
			.validateCapabilitiesEndpoint('https://x.example/api')
			.catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(CapabilitiesFetchError);
		expect((error as CapabilitiesFetchError).statusCode).toBe(403);
		expect((error as CapabilitiesFetchError).message).toMatch(
			/Cloudflare challenge on x\.example was not solved/
		);
	});

	it('probes endpoint candidates through the shared client', async () => {
		getMock.mockResolvedValue(response(CAPS_XML));
		const provider = new NewznabCapabilitiesProvider();

		await expect(provider.resolveTorznabBaseUrl('https://host.example/')).resolves.toBe(
			'https://host.example/torznab/all/api'
		);
		expect(createIndexerHttpMock).toHaveBeenCalled();
	});

	it('rejects a Cloudflare HTML block page and falls back to /api', async () => {
		getMock.mockResolvedValue(
			response('<html>Attention Required! | Cloudflare</html>', 'text/html')
		);
		const provider = new NewznabCapabilitiesProvider();

		await expect(provider.resolveTorznabBaseUrl('https://host.example/')).resolves.toBe(
			'https://host.example/api'
		);
	});
});

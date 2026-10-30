import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGatewaySigningState } from '#lib/server/cinephage/core/signing.js';

const settingsMocks = vi.hoisted(() => ({
	getStreamingIndexerSettings: vi.fn()
}));

const coreMocks = vi.hoisted(() => ({
	refreshLatestIdentity: vi.fn()
}));

vi.mock('#lib/server/streaming/settings.js', () => ({
	getStreamingIndexerSettings: settingsMocks.getStreamingIndexerSettings
}));

vi.mock('#lib/server/cinephage/core/CinephageCore.js', () => ({
	getCinephageCore: () => coreMocks
}));

const SECRET = 'a'.repeat(64);
const COUNTRIES_BODY = { countries: [{ code: 'de', name: 'Germany' }] };

/** Import a fresh route module (clears the module-level countries cache). */
async function importRoute() {
	vi.resetModules();
	return import('./+server.js');
}

function jsonResponse(body: unknown, status: number, date?: string): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: date ? { date } : {}
	});
}

describe('cinephage-iptv countries route', () => {
	beforeEach(() => {
		resetGatewaySigningState();
		settingsMocks.getStreamingIndexerSettings.mockResolvedValue({
			cinephageVersion: '0.18.0',
			cinephageCommit: 'feedface'
		});
	});

	afterEach(() => {
		delete process.env.CINEPHAGE_SIGNING_SECRET;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		resetGatewaySigningState();
	});

	it('sends identity + signature headers on the outbound gateway request', async () => {
		process.env.CINEPHAGE_SIGNING_SECRET = SECRET;
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(COUNTRIES_BODY, 200));
		vi.stubGlobal('fetch', fetchMock);

		const { GET } = await importRoute();
		const response = await GET({} as Parameters<typeof GET>[0]);
		const body = (await response.json()) as { success: boolean; count: number };

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.count).toBe(1);

		const headers = (fetchMock.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
		expect(headers['X-Cinephage-Version']).toBe('0.18.0');
		expect(headers['X-Cinephage-Commit']).toBe('feedface');
		expect(headers['X-Cinephage-Signature']).toMatch(/^[0-9a-f]{64}$/);
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.cinephage.net/api/v1/iptv/countries');
	});

	it('omits signature headers when no signing secret is configured', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(COUNTRIES_BODY, 200));
		vi.stubGlobal('fetch', fetchMock);

		const { GET } = await importRoute();
		const response = await GET({} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		const headers = (fetchMock.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
		expect(headers['X-Cinephage-Version']).toBe('0.18.0');
		expect(headers['X-Cinephage-Signature']).toBeUndefined();
	});

	it('retries once with a fresh signature after an invalid_signature 401', async () => {
		process.env.CINEPHAGE_SIGNING_SECRET = SECRET;
		const rejectionDate = new Date(Date.now() + 400_000);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(
					{ error: { details: { code: 'invalid_signature' } } },
					401,
					rejectionDate.toUTCString()
				)
			)
			.mockResolvedValueOnce(jsonResponse(COUNTRIES_BODY, 200));
		vi.stubGlobal('fetch', fetchMock);

		const { GET } = await importRoute();
		const response = await GET({} as Parameters<typeof GET>[0]);
		const body = (await response.json()) as { success: boolean };

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const firstTs = Number(
			(fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['X-Cinephage-Timestamp']
		);
		const secondTs = Number(
			(fetchMock.mock.calls[1][1]?.headers as Record<string, string>)['X-Cinephage-Timestamp']
		);
		expect(secondTs - firstTs).toBeGreaterThanOrEqual(399);
		// A signature rejection must not trigger an identity re-sync.
		expect(coreMocks.refreshLatestIdentity).not.toHaveBeenCalled();
	});

	it('treats a non-signature 401 as an identity rejection', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ error: { details: { code: 'unknown_release' } } }, 401));
		vi.stubGlobal('fetch', fetchMock);

		const { GET } = await importRoute();
		const response = await GET({} as Parameters<typeof GET>[0]);
		const body = (await response.json()) as { success: boolean; error: string };

		expect(response.status).toBe(500);
		expect(body.success).toBe(false);
		expect(body.error).toBe('Cinephage API rejected authentication');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(coreMocks.refreshLatestIdentity).toHaveBeenCalled();
	});

	it('reports a signature-specific error when the secret is missing after enforcement', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ error: { details: { code: 'signature_required' } } }, 401));
		vi.stubGlobal('fetch', fetchMock);

		const { GET } = await importRoute();
		const response = await GET({} as Parameters<typeof GET>[0]);
		const body = (await response.json()) as { success: boolean; error: string };

		expect(response.status).toBe(500);
		expect(body.error).toContain('CINEPHAGE_SIGNING_SECRET');
		// The retry with the same (missing) signature cannot succeed.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(coreMocks.refreshLatestIdentity).not.toHaveBeenCalled();
	});
});

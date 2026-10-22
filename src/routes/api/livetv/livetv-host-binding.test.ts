import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeoutMock = vi.fn();
const resolveAndValidateUrlMock = vi.fn();
const isHostAllowedMock = vi.fn();

vi.mock('#lib/server/http/ssrf-protection.js', () => ({
	resolveAndValidateUrl: resolveAndValidateUrlMock,
	fetchWithTimeout: fetchWithTimeoutMock,
	UnsafeUrlError: class UnsafeUrlError extends Error {}
}));

vi.mock('#lib/server/livetv/streaming/StreamUrlCache.js', () => ({
	HLS_STREAM_TIMEOUT_MS: 20_000,
	getStreamUrlCache: () => ({
		getCached: vi.fn(),
		isValid: vi.fn().mockReturnValue(true),
		refreshStream: vi.fn(),
		allowHost: vi.fn(),
		hasAllowedHosts: vi.fn().mockReturnValue(true),
		isHostAllowed: isHostAllowedMock
	})
}));

vi.mock('#lib/server/streaming/url.js', () => ({
	getBaseUrlAsync: vi.fn().mockResolvedValue('http://cinephage.test')
}));

/**
 * The segment proxy accepts the upstream URL as a query parameter, and every
 * streaming API key is deliberately embedded in .m3u/.strm files. Without
 * binding the URL to the lineup, any key holder gets an arbitrary outbound
 * proxy. These tests pin the binding rule.
 */
describe('Live TV segment proxy host binding', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resolveAndValidateUrlMock.mockResolvedValue({ safe: true });
		fetchWithTimeoutMock.mockResolvedValue(new Response(new Uint8Array([0x47]), { status: 200 }));
	});

	async function callSegment(lineupId: string, target: string): Promise<Response> {
		const { GET } = await import('./stream/[lineupId]/[...path]/+server');
		return GET({
			params: { lineupId, path: 'segment.ts' },
			url: new URL(
				`http://cinephage.test/api/livetv/stream/${lineupId}/segment.ts?url=${encodeURIComponent(target)}`
			),
			request: new Request('http://cinephage.test/api/livetv/stream/x')
		} as Parameters<typeof GET>[0]);
	}

	it('rejects a URL whose host this lineup does not stream from', async () => {
		isHostAllowedMock.mockReturnValue(false);

		const response = await callSegment('lineup-1', 'https://attacker.example/x');

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ reason: 'unbound-host' });
		// Never reaches the network.
		expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
	});

	it('allows a URL whose host was learned for the lineup', async () => {
		isHostAllowedMock.mockReturnValue(true);

		const response = await callSegment('lineup-1', 'https://provider.test/live/channel');

		expect(response.status).toBe(200);
		expect(fetchWithTimeoutMock).toHaveBeenCalled();
	});

	it('consults the binding for the requesting lineup, not another one', async () => {
		isHostAllowedMock.mockReturnValue(false);

		await callSegment('lineup-2', 'https://provider.test/live/channel');

		expect(isHostAllowedMock).toHaveBeenCalledWith('lineup-2', 'provider.test');
	});
});

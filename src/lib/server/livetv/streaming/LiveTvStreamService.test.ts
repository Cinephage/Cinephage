import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveAndValidateUrlMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/http/ssrf-protection.js', () => ({
	resolveAndValidateUrl: resolveAndValidateUrlMock
}));

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

describe('LiveTvStreamService.fetchFromUrl', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resolveAndValidateUrlMock.mockResolvedValue({ safe: true });
	});

	it('validates the initial URL before the first fetch', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		resolveAndValidateUrlMock.mockResolvedValue({ safe: false, reason: 'private address' });
		const { LiveTvStreamService } = await import('./LiveTvStreamService');

		await expect(
			new LiveTvStreamService().fetchFromUrl('http://127.0.0.1/private.ts', 'm3u')
		).rejects.toThrow('Stream URL blocked');
		expect(resolveAndValidateUrlMock).toHaveBeenCalledWith('http://127.0.0.1/private.ts');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('still validates redirect targets after validating the initial URL', async () => {
		resolveAndValidateUrlMock.mockImplementation(async (url: string) =>
			url.includes('cdn.test') ? { safe: false, reason: 'private address' } : { safe: true }
		);
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(null, { status: 302, headers: { Location: 'https://cdn.test/live.ts' } })
			);
		vi.stubGlobal('fetch', fetchMock);
		const { LiveTvStreamService } = await import('./LiveTvStreamService');

		await expect(
			new LiveTvStreamService().fetchFromUrl('https://provider.test/live.ts', 'm3u')
		).rejects.toThrow('Stream redirect blocked');
		expect(resolveAndValidateUrlMock).toHaveBeenNthCalledWith(1, 'https://provider.test/live.ts');
		expect(resolveAndValidateUrlMock).toHaveBeenNthCalledWith(2, 'https://cdn.test/live.ts');
	});
});

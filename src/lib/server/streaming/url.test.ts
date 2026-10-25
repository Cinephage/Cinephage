import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStreamingIndexerSettingsMock = vi.hoisted(() => vi.fn());
const isTrustedOriginMock = vi.hoisted(() => vi.fn());

vi.mock('./settings', () => ({
	getStreamingIndexerSettings: getStreamingIndexerSettingsMock
}));

vi.mock('#lib/server/utils/origin.js', () => ({
	isTrustedOrigin: isTrustedOriginMock
}));

import { getBaseUrl, getBaseUrlAsync } from './url';

describe('getBaseUrl', () => {
	beforeEach(() => {
		getStreamingIndexerSettingsMock.mockReset();
		isTrustedOriginMock.mockImplementation((origin: string) =>
			origin.startsWith('http://internal')
		);
	});

	it('includes the forwarded path prefix in generated URLs', () => {
		const request = new Request('http://internal:3000/api/streaming/session/movie/1', {
			headers: {
				'X-Forwarded-Host': 'media.example.com',
				'X-Forwarded-Proto': 'https',
				'X-Forwarded-Prefix': '/cinephage'
			}
		});

		expect(getBaseUrl(request)).toBe('https://media.example.com/cinephage');
	});

	it('uses the first comma-separated forwarded host and proto values', () => {
		const request = new Request('http://internal:3000/api/streaming/proxy', {
			headers: {
				'X-Forwarded-Host': 'media.example.com, internal.example.com',
				'X-Forwarded-Proto': 'https, http',
				'X-Forwarded-Prefix': '/cinephage, /ignored'
			}
		});

		expect(getBaseUrl(request)).toBe('https://media.example.com/cinephage');
	});

	it('falls back to https for an invalid forwarded proto', () => {
		const request = new Request('http://internal:3000/api/streaming/proxy', {
			headers: {
				'X-Forwarded-Host': 'media.example.com',
				'X-Forwarded-Proto': 'ftp'
			}
		});

		expect(getBaseUrl(request)).toBe('https://media.example.com');
	});

	it('ignores forwarded URL headers from an untrusted request origin', () => {
		const request = new Request('https://untrusted.example/api/streaming/proxy', {
			headers: {
				'X-Forwarded-Host': 'attacker.example.com',
				'X-Forwarded-Proto': 'https',
				'X-Forwarded-Prefix': '/attacker'
			}
		});

		expect(getBaseUrl(request)).toBe('https://untrusted.example');
	});

	it('applies the forwarded prefix to a configured base URL', async () => {
		getStreamingIndexerSettingsMock.mockResolvedValue({
			baseUrl: 'https://configured.example.com'
		});
		const request = new Request('http://internal:3000/api/streaming/proxy', {
			headers: {
				'X-Forwarded-Host': 'media.example.com',
				'X-Forwarded-Proto': 'https',
				'X-Forwarded-Prefix': '/cinephage'
			}
		});

		expect(await getBaseUrlAsync(request)).toBe('https://configured.example.com/cinephage');
	});

	it('applies the forwarded prefix when the configured base URL is cached', async () => {
		getStreamingIndexerSettingsMock.mockResolvedValue({
			baseUrl: 'https://configured.example.com'
		});
		await getBaseUrlAsync(
			new Request('http://internal:3000/api/streaming/proxy', {
				headers: { 'X-Forwarded-Host': 'media.example.com', 'X-Forwarded-Prefix': '/cinephage' }
			})
		);

		getStreamingIndexerSettingsMock.mockResolvedValue(undefined);
		expect(
			getBaseUrl(
				new Request('http://internal:3000/api/streaming/proxy', {
					headers: {
						'X-Forwarded-Host': 'media.example.com',
						'X-Forwarded-Prefix': '/cinephage'
					}
				})
			)
		).toBe('https://configured.example.com/cinephage');
	});
});

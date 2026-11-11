import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getStreamingBaseUrlMock } = vi.hoisted(() => ({ getStreamingBaseUrlMock: vi.fn() }));

vi.mock('#lib/server/streaming/settings.js', () => ({
	getStreamingBaseUrl: getStreamingBaseUrlMock
}));

import {
	STRM_PROBE_ALLOWED_HOSTS_ENV,
	describeStrmTargetRejection,
	getStrmProbeTrustedHosts,
	parseTrustedHostList,
	resetStrmProbeTrustCache
} from './strm-probe-trust';

describe('parseTrustedHostList', () => {
	it('returns nothing for an unset or blank value', () => {
		expect(parseTrustedHostList(undefined)).toEqual([]);
		expect(parseTrustedHostList('   ')).toEqual([]);
	});

	it('splits, trims, lowercases and deduplicates', () => {
		expect(parseTrustedHostList(' Jellyfin , 192.168.1.10,jellyfin ')).toEqual([
			'jellyfin',
			'192.168.1.10'
		]);
	});
});

describe('getStrmProbeTrustedHosts', () => {
	beforeEach(() => {
		resetStrmProbeTrustCache();
		getStreamingBaseUrlMock.mockReset();
		delete process.env[STRM_PROBE_ALLOWED_HOSTS_ENV];
		delete process.env.PUBLIC_BASE_URL;
	});

	afterEach(() => {
		resetStrmProbeTrustCache();
		delete process.env[STRM_PROBE_ALLOWED_HOSTS_ENV];
		delete process.env.PUBLIC_BASE_URL;
	});

	it('trusts the host of the configured streaming origin', async () => {
		getStreamingBaseUrlMock.mockResolvedValue('http://cinephage:3000');

		await expect(getStrmProbeTrustedHosts()).resolves.toEqual(['cinephage']);
	});

	it('trusts PUBLIC_BASE_URL alongside the configured origin', async () => {
		process.env.PUBLIC_BASE_URL = 'http://192.168.11.50:3000';
		getStreamingBaseUrlMock.mockResolvedValue('http://cinephage:3000');

		await expect(getStrmProbeTrustedHosts()).resolves.toEqual(['cinephage', '192.168.11.50']);
	});

	it('merges env entries with the origin host without duplicating it', async () => {
		process.env[STRM_PROBE_ALLOWED_HOSTS_ENV] = 'Jellyfin, 192.168.1.10, cinephage';
		getStreamingBaseUrlMock.mockResolvedValue('http://cinephage:3000');

		await expect(getStrmProbeTrustedHosts()).resolves.toEqual([
			'jellyfin',
			'192.168.1.10',
			'cinephage'
		]);
	});

	it('trusts nothing when no origin is configured', async () => {
		getStreamingBaseUrlMock.mockResolvedValue('');

		await expect(getStrmProbeTrustedHosts()).resolves.toEqual([]);
	});

	it('survives an unparseable origin instead of failing the probe', async () => {
		getStreamingBaseUrlMock.mockResolvedValue('not a url');

		await expect(getStrmProbeTrustedHosts()).resolves.toEqual([]);
	});

	it('survives a settings lookup that throws', async () => {
		getStreamingBaseUrlMock.mockRejectedValue(new Error('settings unavailable'));

		await expect(getStrmProbeTrustedHosts()).resolves.toEqual([]);
	});

	it('reuses the resolved list inside the cache window', async () => {
		getStreamingBaseUrlMock.mockResolvedValue('http://cinephage:3000');

		await getStrmProbeTrustedHosts();
		await getStrmProbeTrustedHosts();

		expect(getStreamingBaseUrlMock).toHaveBeenCalledTimes(1);
	});
});

describe('describeStrmTargetRejection', () => {
	it('names the env var when the target only resolves privately', () => {
		expect(
			describeStrmTargetRejection("Hostname 'cinephage' resolves to private IP: 172.19.0.5")
		).toContain(`Declare the host in ${STRM_PROBE_ALLOWED_HOSTS_ENV}`);
	});

	it('leaves unrelated rejections untouched', () => {
		expect(describeStrmTargetRejection('Invalid scheme: file:')).toBe('Invalid scheme: file:');
	});
});

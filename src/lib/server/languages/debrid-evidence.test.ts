import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderFile } from '#lib/server/downloadClients/debrid/debrid-adapter.js';

const { getClientMock } = vi.hoisted(() => ({
	getClientMock: vi.fn()
}));

vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: vi.fn(async () => ({
		getDebridClientForAcquisition: getClientMock
	}))
}));

import { clearInstantEvidenceCache, getInstantFileEvidence } from './debrid-evidence';

const HASH = 'a'.repeat(40);

function files(list: Array<Partial<ProviderFile>>): ProviderFile[] {
	return list.map((file, index) => ({
		providerFileId: String(index),
		path: file.path ?? file.name ?? `file-${index}`,
		name: file.name ?? `file-${index}`,
		sizeBytes: file.sizeBytes ?? 1000
	}));
}

function adapterWith(instant: ProviderFile[] | null | Error) {
	return {
		provider: 'realdebrid',
		checkInstantFiles: vi.fn(async () => {
			if (instant instanceof Error) throw instant;
			return instant;
		})
	};
}

beforeEach(() => {
	clearInstantEvidenceCache();
	getClientMock.mockReset();
});

describe('getInstantFileEvidence', () => {
	it('unions language tokens from video file names only', async () => {
		getClientMock.mockResolvedValue({
			adapter: adapterWith(
				files([
					{ name: 'Movie.2026.1080p.ENG.mkv' },
					{ name: 'Movie.2026.1080p.ESP.mkv' },
					{ name: 'Movie.2026.es.srt' }
				])
			)
		});

		const evidence = await getInstantFileEvidence(HASH);

		expect(evidence?.languages).toEqual(['en', 'es']);
		// The subtitle sidecar is still listed per-file but excluded from the
		// headline audio union.
		expect(evidence?.perFile).toHaveLength(3);
		expect(evidence?.provider).toBe('realdebrid');
	});

	it('caches per infohash — one probe for repeated calls', async () => {
		const adapter = adapterWith(files([{ name: 'Movie.2026.GERMAN.mkv' }]));
		getClientMock.mockResolvedValue({ adapter });

		await getInstantFileEvidence(HASH);
		await getInstantFileEvidence(HASH);

		expect(adapter.checkInstantFiles).toHaveBeenCalledTimes(1);
	});

	it('returns null for uncached torrents and negative-caches the answer', async () => {
		const adapter = adapterWith(null);
		getClientMock.mockResolvedValue({ adapter });

		expect(await getInstantFileEvidence(HASH)).toBeNull();
		await getInstantFileEvidence(HASH);
		expect(adapter.checkInstantFiles).toHaveBeenCalledTimes(1);
	});

	it('returns null when no debrid client or no instant support', async () => {
		getClientMock.mockResolvedValue(undefined);
		expect(await getInstantFileEvidence(HASH)).toBeNull();

		getClientMock.mockResolvedValue({ adapter: { provider: 'torbox' } });
		expect(await getInstantFileEvidence('b'.repeat(40))).toBeNull();
	});

	it('never throws — transport failures become null evidence', async () => {
		getClientMock.mockResolvedValue({ adapter: adapterWith(new Error('provider down')) });
		expect(await getInstantFileEvidence(HASH)).toBeNull();
	});
});

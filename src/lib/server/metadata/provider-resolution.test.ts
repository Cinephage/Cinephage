import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MetadataDetails } from './providers/types.js';

vi.mock('./provider-registry.js', () => ({
	buildMetadataProviderRegistry: vi.fn()
}));

vi.mock('#lib/server/services/AlternateTitleService.js', () => ({
	storeProviderTitleVariants: vi.fn().mockResolvedValue(0)
}));

const { buildMetadataProviderRegistry } = await import('./provider-registry.js');
const { storeProviderTitleVariants } =
	await import('#lib/server/services/AlternateTitleService.js');
const { persistEnrichmentTitleVariants, persistLinkedProviderTitleVariants } =
	await import('./provider-resolution.js');

const mockedRegistryBuild = vi.mocked(buildMetadataProviderRegistry);
const mockedStore = vi.mocked(storeProviderTitleVariants);

function anilistDetails(overrides: Partial<MetadataDetails> = {}): MetadataDetails {
	return {
		id: '1',
		title: 'Cowboy Bebop',
		mediaType: 'anime',
		provider: 'anilist',
		alternateTitles: [
			{ title: 'Cowboy Bebop', language: null, country: null },
			{ title: 'カウボーイビバップ', language: null, country: 'JP' }
		],
		...overrides
	};
}

function fakeProvider(details: MetadataDetails | null) {
	return { isConfigured: () => true, getDetails: vi.fn().mockResolvedValue(details) };
}

describe('persistEnrichmentTitleVariants', () => {
	beforeEach(() => {
		mockedStore.mockReset();
		mockedStore.mockResolvedValue(0);
	});

	it('forwards each provider\u2019s variants to the alternate-title store', async () => {
		await persistEnrichmentTitleVariants('series', 'series-1', {
			anilist: anilistDetails(),
			mal: {
				id: '437',
				title: 'Cowboy Bebop',
				mediaType: 'anime',
				provider: 'mal',
				alternateTitles: [{ title: 'カウボーイビバップ', language: null, country: null }]
			}
		});

		expect(mockedStore).toHaveBeenCalledTimes(2);
		expect(mockedStore).toHaveBeenCalledWith('series', 'series-1', 'anilist', [
			{ title: 'Cowboy Bebop', language: null, country: null },
			{ title: 'カウボーイビバップ', language: null, country: 'JP' }
		]);
		expect(mockedStore).toHaveBeenCalledWith('series', 'series-1', 'mal', [
			{ title: 'カウボーイビバップ', language: null, country: null }
		]);
	});

	it('stores nothing when providers returned no variants', async () => {
		await persistEnrichmentTitleVariants('movie', 'movie-1', {
			anilist: anilistDetails({ alternateTitles: [] })
		});
		expect(mockedStore).not.toHaveBeenCalled();
	});
});

describe('persistLinkedProviderTitleVariants (manual link path)', () => {
	beforeEach(() => {
		mockedStore.mockReset();
		mockedStore.mockResolvedValue(0);
		mockedRegistryBuild.mockReset();
	});

	it('fetches details for each linked ref and stores its variants', async () => {
		const anilistProvider = fakeProvider(anilistDetails());
		mockedRegistryBuild.mockResolvedValue({
			providers: new Map([
				['anilist', anilistProvider as never],
				['mal', fakeProvider(null) as never]
			]),
			enrichmentEnabled: true
		});

		await persistLinkedProviderTitleVariants('movie', 'movie-1', {
			anilist: '1',
			mal: '999'
		});

		expect(anilistProvider.getDetails).toHaveBeenCalledWith('1', 'anime');
		expect(mockedStore).toHaveBeenCalledWith('movie', 'movie-1', 'anilist', [
			{ title: 'Cowboy Bebop', language: null, country: null },
			{ title: 'カウボーイビバップ', language: null, country: 'JP' }
		]);
	});

	it('does nothing when no anime provider refs are linked', async () => {
		mockedRegistryBuild.mockResolvedValue({ providers: new Map(), enrichmentEnabled: true });

		await persistLinkedProviderTitleVariants('movie', 'movie-1', { tmdb: '123' });
		await persistLinkedProviderTitleVariants('movie', 'movie-1', null);

		expect(mockedRegistryBuild).not.toHaveBeenCalled();
		expect(mockedStore).not.toHaveBeenCalled();
	});

	it('swallows provider failures without storing partial rows', async () => {
		mockedRegistryBuild.mockResolvedValue({
			providers: new Map([
				['anilist', fakeProvider(anilistDetails()) as never],
				[
					'mal',
					{
						isConfigured: () => true,
						getDetails: vi.fn().mockRejectedValue(new Error('Jikan down'))
					} as never
				]
			]),
			enrichmentEnabled: true
		});

		await expect(
			persistLinkedProviderTitleVariants('series', 'series-1', { anilist: '1', mal: '999' })
		).resolves.toBe(0); // mocked store returns 0; the point is: no throw, one store call

		expect(mockedStore).toHaveBeenCalledTimes(1);
	});
});

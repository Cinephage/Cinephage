import { describe, expect, it } from 'vitest';
import type { IndexerCapabilities, IndexerConfig } from '../types';
import { Category } from '../types';
import { evaluateIndexerSearchAvailability } from './availability';

const movieCapabilities: IndexerCapabilities = {
	search: { available: true, supportedParams: ['q'] },
	movieSearch: { available: true, supportedParams: ['q', 'year'] },
	tvSearch: { available: true, supportedParams: ['q', 'season', 'ep'] },
	categories: new Map([[Category.MOVIES_HD, 'Movies/HD']]),
	supportsPagination: false,
	supportsInfoHash: false,
	limitMax: 100,
	limitDefault: 50
};

function config(id: string, overrides: Partial<IndexerConfig> = {}): IndexerConfig {
	return {
		id,
		name: id,
		definitionId: 'torznab',
		enabled: true,
		protocol: 'torrent',
		baseUrl: 'https://example.test',
		priority: 25,
		enableAutomaticSearch: true,
		enableInteractiveSearch: true,
		...overrides
	} as unknown as IndexerConfig;
}

const getDefinitionCapabilities = () => movieCapabilities;

describe('evaluateIndexerSearchAvailability indexer allowlist', () => {
	it('passes when no allowlist is set', () => {
		const result = evaluateIndexerSearchAvailability([config('a'), config('b')], {
			searchType: 'movie',
			searchSource: 'automatic',
			allowedIndexerIds: null,
			getDefinitionCapabilities
		});

		expect(result.ok).toBe(true);
	});

	it('passes when a selected indexer is enabled and compatible', () => {
		const result = evaluateIndexerSearchAvailability(
			[config('a', { enabled: false }), config('b')],
			{
				searchType: 'movie',
				searchSource: 'automatic',
				allowedIndexerIds: ['b'],
				getDefinitionCapabilities
			}
		);

		expect(result.ok).toBe(true);
	});

	it('reports NO_INDEXER_ALLOWED when every selected indexer is disabled', () => {
		const result = evaluateIndexerSearchAvailability(
			[config('a'), config('b', { enabled: false })],
			{
				searchType: 'movie',
				searchSource: 'automatic',
				allowedIndexerIds: ['b'],
				profileName: 'My Profile',
				getDefinitionCapabilities
			}
		);

		expect(result.ok).toBe(false);
		expect(result.code).toBe('NO_INDEXER_ALLOWED');
		expect(result.message).toContain('My Profile');
	});

	it('reports NO_INDEXER_ALLOWED when the allowlist matches no configured indexer', () => {
		const result = evaluateIndexerSearchAvailability([config('a')], {
			searchType: 'movie',
			searchSource: 'automatic',
			allowedIndexerIds: ['deleted-indexer'],
			getDefinitionCapabilities
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe('NO_INDEXER_ALLOWED');
	});

	it('reports NO_INDEXER_COMPATIBLE when the selected indexer cannot do this search type', () => {
		const result = evaluateIndexerSearchAvailability([config('a'), config('b')], {
			searchType: 'movie',
			searchSource: 'automatic',
			allowedIndexerIds: ['a'],
			getDefinitionCapabilities: (definitionId: string) =>
				definitionId === 'torznab'
					? { ...movieCapabilities, movieSearch: { available: false, supportedParams: [] } }
					: undefined
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe('NO_INDEXER_COMPATIBLE');
	});
});

describe('resolveAllowedIndexerIds default-profile fallback', () => {
	it('honours the default profile allowlist when no profile id is given', async () => {
		// The enricher scores with the default profile in this case, so the search
		// scope must follow the same profile or the two would disagree.
		const { resolveAllowedIndexerIds } = await import('./profile-indexer-filter.js');
		const { qualityFilter } = await import('#lib/server/quality/index.js');

		const originalDefault = qualityFilter.getDefaultScoringProfile;
		const originalGet = qualityFilter.getProfile;
		qualityFilter.getDefaultScoringProfile = async () =>
			({
				id: 'balanced',
				name: 'Balanced',
				allowedIndexerIds: ['ix-a']
			}) as never;
		qualityFilter.getProfile = async () => null;

		try {
			expect(await resolveAllowedIndexerIds(undefined)).toEqual(['ix-a']);
			expect(await resolveAllowedIndexerIds(null)).toEqual(['ix-a']);
		} finally {
			qualityFilter.getDefaultScoringProfile = originalDefault;
			qualityFilter.getProfile = originalGet;
		}
	});
});

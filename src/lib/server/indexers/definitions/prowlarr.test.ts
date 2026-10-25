/**
 * Prowlarr Definition Request Tests
 *
 * Prowlarr's /api/v1/search ignores imdbId/tmdbId/season/episode query params;
 * it only reads IDs embedded in the query as tokens ({ImdbId:tt…}), and only for
 * the movie and tvsearch types. It also skips a tracker outright when asked for
 * an ID the tracker doesn't support. These tests guard the requests built from
 * data/indexers/definitions/prowlarr.yaml against those rules.
 */

import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFilterEngine } from '../engine/FilterEngine.js';
import { createTemplateEngine } from '../engine/TemplateEngine.js';
import { RequestBuilder } from '../runtime/RequestBuilder.js';
import { YamlDefinitionLoader } from '../loader/YamlDefinitionLoader.js';
import type { SearchCriteria } from '../types';

const definitionPath = resolve('data/indexers/definitions/prowlarr.yaml');
const BASE_URL = 'http://prowlarr.local:9696/5';

async function createBuilder(
	supportedParams?: {
		movie?: string[];
		tvsearch?: string[];
	},
	settings: Record<string, unknown> = { apikey: 'secret', indexerId: '5' },
	baseUrl = BASE_URL
): Promise<RequestBuilder> {
	const loader = new YamlDefinitionLoader(dirname(definitionPath));
	const result = await loader.loadOne(definitionPath);
	expect(result).not.toBeNull();
	const definition = result!.definition;

	const templateEngine = createTemplateEngine();
	templateEngine.setConfigWithDefaults(settings, definition.settings ?? []);
	const builder = new RequestBuilder(definition, templateEngine, createFilterEngine());
	builder.setBaseUrl(baseUrl);
	if (supportedParams?.movie) builder.setSupportedParams('movie', supportedParams.movie);
	if (supportedParams?.tvsearch) builder.setSupportedParams('tvsearch', supportedParams.tvsearch);
	return builder;
}

function params(url: string) {
	return new URL(url).searchParams;
}

describe('Prowlarr definition requests', () => {
	it('sends a movie ID search as query tokens only', async () => {
		const builder = await createBuilder({ movie: ['q', 'imdbid', 'tmdbid'] });
		const criteria: SearchCriteria = {
			searchType: 'movie',
			query: 'Una notte da leoni',
			year: 2009,
			imdbId: 'tt1119646',
			tmdbId: 18785
		};

		const requests = builder.buildSearchRequests(criteria);

		expect(requests).toHaveLength(1);
		const search = params(requests[0].url);
		expect(search.get('query')).toBe('{ImdbId:tt1119646} {TmdbId:18785}');
		expect(search.get('type')).toBe('movie');
		expect(search.get('indexerIds')).toBe('5');
		expect(search.has('imdbId')).toBe(false);
		expect(search.has('tmdbId')).toBe(false);
	});

	it('only sends IDs the tracker supports', async () => {
		const builder = await createBuilder({ movie: ['q', 'imdbid'] });
		const criteria: SearchCriteria = {
			searchType: 'movie',
			query: 'Una notte da leoni',
			imdbId: 'tt1119646',
			tmdbId: 18785
		};

		const requests = builder.buildSearchRequests(criteria);

		expect(params(requests[0].url).get('query')).toBe('{ImdbId:tt1119646}');
	});

	it('falls back to keywords when the tracker supports none of the IDs', async () => {
		const builder = await createBuilder({ movie: ['q'] });
		const criteria: SearchCriteria = {
			searchType: 'movie',
			query: 'The Hangover',
			year: 2009,
			imdbId: 'tt1119646'
		};

		const requests = builder.buildSearchRequests(criteria);

		expect(params(requests[0].url).get('query')).toBe('The Hangover 2009');
	});

	it('sends keywords when the tracker caps are unknown', async () => {
		const builder = await createBuilder();
		const criteria: SearchCriteria = {
			searchType: 'movie',
			query: 'The Hangover',
			imdbId: 'tt1119646'
		};

		const requests = builder.buildSearchRequests(criteria);

		expect(params(requests[0].url).get('query')).toBe('The Hangover');
	});

	it('sends a movie text search as keywords', async () => {
		const builder = await createBuilder({ movie: ['q', 'imdbid'] });
		const criteria: SearchCriteria = { searchType: 'movie', query: 'The Hangover', year: 2009 };

		const requests = builder.buildSearchRequests(criteria);

		const search = params(requests[0].url);
		expect(search.get('query')).toBe('The Hangover 2009');
		expect(search.get('type')).toBe('movie');
	});

	it('sends a TV ID search as a tvsearch with season and episode tokens', async () => {
		const builder = await createBuilder({ tvsearch: ['q', 'tvdbid', 'imdbid', 'season', 'ep'] });
		const criteria: SearchCriteria = {
			searchType: 'tv',
			query: 'Il trono di spade',
			tvdbId: 121361,
			imdbId: 'tt0944947',
			season: 1,
			episode: 5
		};

		const requests = builder.buildSearchRequests(criteria);

		expect(requests).toHaveLength(1);
		const search = params(requests[0].url);
		expect(search.get('query')).toBe('{ImdbId:tt0944947} {TvdbId:121361} {Season:1} {Episode:5}');
		expect(search.get('type')).toBe('tvsearch');
	});

	it('searches every tracker by title through the aggregate endpoint', async () => {
		// The aggregate indexer has no per-tracker caps, so it never sends ID tokens
		// (Prowlarr would drop every tracker lacking that ID) and no indexerIds filter.
		const builder = await createBuilder(
			undefined,
			{ apikey: 'secret', aggregate: true },
			'http://prowlarr.local:9696'
		);
		const criteria: SearchCriteria = {
			searchType: 'movie',
			query: 'The Hangover',
			year: 2009,
			imdbId: 'tt1119646',
			tmdbId: 18785
		};

		const requests = builder.buildSearchRequests(criteria);

		expect(requests).toHaveLength(1);
		const search = params(requests[0].url);
		expect(search.get('query')).toBe('The Hangover 2009');
		expect(search.get('type')).toBe('movie');
		expect(search.has('indexerIds')).toBe(false);
		expect(search.has('imdbId')).toBe(false);
	});

	it('sends a TV text search as a basic search with the episode token', async () => {
		const builder = await createBuilder({ tvsearch: ['q', 'tvdbid', 'season', 'ep'] });
		const criteria: SearchCriteria = {
			searchType: 'tv',
			query: 'Game of Thrones',
			season: 1,
			episode: 5
		};

		const requests = builder.buildSearchRequests(criteria);

		const search = params(requests[0].url);
		expect(search.get('query')).toBe('Game of Thrones S01E05');
		expect(search.get('type')).toBe('search');
	});
});

/**
 * Usenet-Crawler definition tests.
 *
 * Usenet-Crawler's Newznab API ignores title queries on t=movie/t=tvsearch, so
 * this definition searches through t=search and pages two 100-result windows.
 * These tests guard the Cinephage-specific parts of that definition: the
 * usenet protocol, the .Query.Season/.Query.Ep template variables (Prowlarr's
 * .Season/.Ep do not exist here), and the newznab attribute extraction.
 */

import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFilterEngine } from '../engine/FilterEngine.js';
import { createSelectorEngine } from '../engine/SelectorEngine.js';
import { createTemplateEngine } from '../engine/TemplateEngine.js';
import { RequestBuilder } from '../runtime/RequestBuilder.js';
import { ResponseParser } from '../runtime/ResponseParser.js';
import { detectNewznabApiError } from '../runtime/UnifiedIndexer.js';
import { YamlDefinitionLoader } from '../loader/YamlDefinitionLoader.js';
import type { SearchCriteria } from '../types/search.js';

const definitionPath = resolve('data/indexers/definitions/usenet-crawler.yaml');
const BASE_URL = 'https://www.usenet-crawler.com/';

async function loadDefinition() {
	const loader = new YamlDefinitionLoader(dirname(definitionPath));
	const result = await loader.loadOne(definitionPath);
	expect(result).not.toBeNull();
	return result!.definition;
}

async function createBuilder(): Promise<RequestBuilder> {
	const definition = await loadDefinition();
	const templateEngine = createTemplateEngine();
	templateEngine.setConfigWithDefaults({ apikey: 'secret-key' }, definition.settings ?? []);
	const builder = new RequestBuilder(definition, templateEngine, createFilterEngine());
	builder.setBaseUrl(BASE_URL);
	return builder;
}

function buildRequests(criteria: SearchCriteria) {
	return createBuilder().then((builder) =>
		builder.buildSearchRequests(criteria).map((request) => new URL(request.url).searchParams)
	);
}

function newznabXml(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
  <channel>
    <title>usenet-crawler</title>
    <item>
      <title>Inception.2010.1080p.BluRay.x264-GROUP</title>
      <guid isPermaLink="true">https://www.usenet-crawler.com/details/abc123</guid>
      <link>https://www.usenet-crawler.com/getnzb/abc123.nzb&amp;i=1&amp;r=KEY</link>
      <comments>https://www.usenet-crawler.com/details/abc123</comments>
      <pubDate>Mon, 06 Oct 2025 12:00:00 +0000</pubDate>
      <enclosure url="https://www.usenet-crawler.com/getnzb/abc123.nzb" length="2147483648" type="application/x-nzb"/>
      <newznab:attr name="category" value="2040"/>
      <newznab:attr name="grabs" value="120"/>
      <newznab:attr name="imdb" value="tt1375666"/>
      <newznab:attr name="tmdbid" value="27205"/>
    </item>
  </channel>
</rss>`;
}

describe('Usenet-Crawler definition', () => {
	it('loads as a private usenet indexer', async () => {
		const definition = await loadDefinition();
		expect(definition.protocol).toBe('usenet');
		expect(definition.type).toBe('private');
		expect(definition.search.paths).toHaveLength(2);
	});

	it('declares text-only search modes so ID searches never build an empty query', async () => {
		const definition = await loadDefinition();
		expect(definition.caps.modes?.['movie-search']).toEqual(['q']);
		expect(definition.caps.modes?.['search']).toEqual(['q']);
	});

	it('requests two 100-result offset pages for a movie title search', async () => {
		const params = await buildRequests({
			searchType: 'movie',
			query: 'Inception',
			year: 2010
		});

		expect(params).toHaveLength(2);
		expect(params[0].get('t')).toBe('search');
		expect(params[0].get('apikey')).toBe('secret-key');
		expect(params[0].get('q')).toBe('Inception 2010');
		expect(params[0].get('limit')).toBe('100');
		expect(params[0].get('offset')).toBe('0');
		expect(params[1].get('offset')).toBe('100');
		// Movie categories only: the TV roots must not leak into a movie search.
		expect(params[0].get('cat')).toContain('2040');
		expect(params[0].get('cat')).not.toContain('5040');
		// Season/episode are TV-only; a movie search must not send empty ones.
		expect(params[0].has('season')).toBe(false);
		expect(params[0].has('ep')).toBe(false);
	});

	it('sends season and episode through .Query.Season/.Query.Ep for TV searches', async () => {
		const params = await buildRequests({
			searchType: 'tv',
			query: 'Breaking Bad',
			season: 1,
			episode: 5
		});

		expect(params).toHaveLength(2);
		expect(params[0].get('q')).toBe('Breaking Bad S01E05');
		expect(params[0].get('season')).toBe('1');
		expect(params[0].get('ep')).toBe('5');
		expect(params[0].get('cat')).toContain('5040');
		expect(params[0].get('cat')).not.toContain('2040');
	});

	it('omits cat= entirely for an open search', async () => {
		const params = await buildRequests({ searchType: 'basic', query: 'Inception' });

		expect(params).toHaveLength(2);
		expect(params[0].get('q')).toBe('Inception');
		expect(params[0].has('cat')).toBe(false);
	});

	it('parses newznab items into releases', async () => {
		const definition = await loadDefinition();
		const templateEngine = createTemplateEngine();
		const filterEngine = createFilterEngine();
		const parser = new ResponseParser(
			definition,
			templateEngine,
			filterEngine,
			createSelectorEngine(templateEngine, filterEngine)
		);

		const result = parser.parse(newznabXml(), definition.search.paths?.[0], {
			indexerId: 'usenet-crawler-test',
			indexerName: 'Usenet-Crawler Test',
			protocol: 'usenet',
			baseUrl: BASE_URL
		});

		expect(result.errors).toEqual([]);
		expect(result.releases).toHaveLength(1);

		const release = result.releases[0];
		expect(release.title).toBe('Inception.2010.1080p.BluRay.x264-GROUP');
		expect(release.size).toBe(2147483648);
		expect(release.grabs).toBe(120);
		expect(release.imdbId).toBe('tt1375666');
		expect(release.tmdbId).toBe(27205);
		expect(release.categories).toEqual([2040]);
		expect(release.downloadUrl).toContain('/getnzb/abc123.nzb');
		expect(release.commentsUrl).toBe('https://www.usenet-crawler.com/details/abc123');
		expect(release.protocol).toBe('usenet');
		expect(release.publishDate?.toISOString()).toBe('2025-10-06T12:00:00.000Z');
	});

	it('keeps the API key out of the release GUID', async () => {
		const definition = await loadDefinition();
		const templateEngine = createTemplateEngine();
		const filterEngine = createFilterEngine();
		const parser = new ResponseParser(
			definition,
			templateEngine,
			filterEngine,
			createSelectorEngine(templateEngine, filterEngine)
		);

		const result = parser.parse(newznabXml(), definition.search.paths?.[0], {
			indexerId: 'usenet-crawler-test',
			indexerName: 'Usenet-Crawler Test',
			protocol: 'usenet',
			baseUrl: BASE_URL
		});

		expect(result.releases[0].guid).toBe('https://www.usenet-crawler.com/details/abc123');
	});

	it('surfaces a root-level Newznab <error> instead of an empty successful search', () => {
		// The live API returns this with HTTP 200 for a bad key. Without detection
		// the feed parses to zero releases, so a dead key looks like "no matches".
		const body =
			'<?xml version="1.0" encoding="UTF-8"?>\n' +
			'<error code="100" description="Incorrect user credentials"/>';

		expect(detectNewznabApiError(body)).toBe('Indexer API error 100: Incorrect user credentials');
	});

	it('does not flag a normal feed or an HTML challenge page as an API error', () => {
		expect(detectNewznabApiError(newznabXml())).toBeNull();
		expect(detectNewznabApiError('<html><body>Just a moment...</body></html>')).toBeNull();
	});
});

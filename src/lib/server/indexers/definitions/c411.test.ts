import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilterEngine } from '../engine/FilterEngine.js';
import { SelectorEngine } from '../engine/SelectorEngine.js';
import { TemplateEngine } from '../engine/TemplateEngine.js';
import { ResponseParser } from '../runtime/ResponseParser.js';
import { YamlDefinitionLoader } from '../loader/YamlDefinitionLoader.js';
import type { SearchCriteria } from '../types/search.js';

const definitionPath = resolve('data/indexers/definitions/c411.yaml');

async function loadDefinition() {
	const loader = new YamlDefinitionLoader(dirname(definitionPath));
	const result = await loader.loadOne(definitionPath);
	expect(result).not.toBeNull();
	return result!.definition;
}

function buildParser(
	definition: Awaited<ReturnType<typeof loadDefinition>>,
	config: Record<string, unknown> = {}
) {
	const templateEngine = new TemplateEngine();
	templateEngine.setConfig({ vostfr: false, multilang: false, multilanguage: 'FRENCH', ...config });
	const filterEngine = new FilterEngine(templateEngine);
	const selectorEngine = new SelectorEngine(templateEngine, filterEngine);
	return new ResponseParser(definition, templateEngine, filterEngine, selectorEngine);
}

const context = {
	indexerId: 'c411-test',
	indexerName: 'C411 Test',
	protocol: 'torrent' as const,
	baseUrl: 'https://c411.org/'
};

function c411Xml(title: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>${title}</title>
      <guid>https://c411.org/torrents/abc123</guid>
      <link>https://c411.org/torrents/abc123</link>
      <pubDate>Sun, 18 Jan 2026 04:05:41 +0000</pubDate>
      <size>2000000000</size>
      <enclosure url="https://c411.org/api/torznab/download/abc123?apikey=KEY" length="2000000000" type="application/x-bittorrent"/>
      <torznab:attr name="category" value="2000"/>
      <torznab:attr name="seeders" value="42"/>
      <torznab:attr name="peers" value="3"/>
      <torznab:attr name="grabs" value="120"/>
      <torznab:attr name="infohash" value="0123456789abcdef0123456789abcdef01234567"/>
      <torznab:attr name="imdbid" value="tt1234567"/>
      <torznab:attr name="downloadvolumefactor" value="0"/>
      <torznab:attr name="uploadvolumefactor" value="1"/>
    </item>
  </channel>
</rss>`;
}

describe('C411 definition', () => {
	it('parses torznab items', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition);

		const result = parser.parse(
			c411Xml('Some.Movie.2026.MULTi.1080p.WEB-DL.x264-GROUP'),
			definition.search.paths?.[0],
			context
		);

		expect(result.errors).toEqual([]);
		expect(result.releases).toHaveLength(1);
		const release = result.releases[0];
		expect(release.title).toBe('Some.Movie.2026.MULTi.1080p.WEB-DL.x264-GROUP');
		expect(release.seeders).toBe(42);
		expect(release.leechers).toBe(3);
		expect(release.size).toBe(2000000000);
		expect(release.infoHash?.toLowerCase()).toBe('0123456789abcdef0123456789abcdef01234567');
		expect(release.downloadUrl).toContain('/api/torznab/download/abc123');
	});

	it('replaces MULTi with the configured language when enabled', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition, { multilang: true, multilanguage: 'MULTi.FRENCH' });

		const result = parser.parse(
			c411Xml('Some.Movie.2026.MULTi.1080p.WEB-DL.x264-GROUP'),
			definition.search.paths?.[0],
			context
		);

		expect(result.releases[0].title).toBe('Some.Movie.2026.MULTi.FRENCH.1080p.WEB-DL.x264-GROUP');
	});

	it('keeps MULTi when a language tag is already present', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition, { multilang: true });

		const result = parser.parse(
			c411Xml('Some.Movie.2026.MULTi.VFF.1080p.WEB-DL.x264-GROUP'),
			definition.search.paths?.[0],
			context
		);

		expect(result.releases[0].title).toBe('Some.Movie.2026.MULTi.VFF.1080p.WEB-DL.x264-GROUP');
	});

	it('replaces VOSTFR with ENGLISH when enabled', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition, { vostfr: true });

		const result = parser.parse(
			c411Xml('Some.Show.S01E01.VOSTFR.1080p.WEB-DL.x264-GROUP'),
			definition.search.paths?.[0],
			context
		);

		expect(result.releases[0].title).toBe('Some.Show.S01E01.ENGLISH.1080p.WEB-DL.x264-GROUP');
	});

	it.each([
		['basic', 'search'],
		['movie', 'movie'],
		['tv', 'tvsearch'],
		['music', 'music'],
		['book', 'book']
	] as const)('maps search type %s to torznab t=%s', async (searchType, expected) => {
		const definition = await loadDefinition();
		const templateEngine = new TemplateEngine();
		templateEngine.setQuery({ searchType } as SearchCriteria);

		const tTemplate = String(definition.search.inputs?.t);
		expect(templateEngine.expand(tTemplate)).toBe(expected);
	});
});

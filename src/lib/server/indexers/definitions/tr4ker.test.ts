import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilterEngine } from '../engine/FilterEngine.js';
import { SelectorEngine } from '../engine/SelectorEngine.js';
import { TemplateEngine } from '../engine/TemplateEngine.js';
import { ResponseParser } from '../runtime/ResponseParser.js';
import { YamlDefinitionLoader } from '../loader/YamlDefinitionLoader.js';
import { resolveCategoryId } from '../schema/yamlDefinition.js';
import type { SearchCriteria } from '../types/search.js';

const definitionPath = resolve('data/indexers/definitions/tr4ker.yaml');

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
	indexerId: 'tr4ker-test',
	indexerName: 'TR4KER Test',
	protocol: 'torrent' as const,
	baseUrl: 'https://tr4ker.net/'
};

function tr4kerXml(title: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>${title}</title>
      <guid>https://tr4ker.net/torrents/abc123</guid>
      <comments>https://tr4ker.net/torrents/abc123</comments>
      <pubDate>Tue, 02 Jun 2026 19:24:18 +0000</pubDate>
      <enclosure url="https://tr4ker.net/api/torznab/download/abc123?apikey=KEY" type="application/x-bittorrent"/>
      <torznab:attr name="category" value="5000"/>
      <torznab:attr name="size" value="1500000000"/>
      <torznab:attr name="seeders" value="12"/>
      <torznab:attr name="peers" value="2"/>
      <torznab:attr name="tvdbid" value="371980"/>
    </item>
  </channel>
</rss>`;
}

describe('TR4KER definition', () => {
	it('parses torznab items', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition);

		const result = parser.parse(
			tr4kerXml('Some.Show.S01E01.MULTi.1080p.WEB-DL.x264-GROUP'),
			definition.search.paths?.[0],
			context
		);

		expect(result.errors).toEqual([]);
		expect(result.releases).toHaveLength(1);
		const release = result.releases[0];
		expect(release.title).toBe('Some.Show.S01E01.MULTi.1080p.WEB-DL.x264-GROUP');
		expect(release.seeders).toBe(12);
		expect(release.leechers).toBe(2);
		// size comes from the torznab attr, not a <size> element
		expect(release.size).toBe(1500000000);
		expect(release.downloadUrl).toContain('/api/torznab/download/abc123');
		// details link is rewritten from /torrents/ to /torrent/
		expect(release.commentsUrl).toBe('https://tr4ker.net/torrent/abc123');
	});

	it('applies the MULTi and VOSTFR title rewrites when enabled', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition, { multilang: true, vostfr: true });

		const multi = parser.parse(
			tr4kerXml('Some.Movie.2026.MULTi.1080p.WEB-DL.x264-GROUP'),
			definition.search.paths?.[0],
			context
		);
		expect(multi.releases[0].title).toBe('Some.Movie.2026.FRENCH.1080p.WEB-DL.x264-GROUP');

		const vostfr = parser.parse(
			tr4kerXml('Some.Show.S01E01.VOSTFR.1080p.WEB-DL.x264-GROUP'),
			definition.search.paths?.[0],
			context
		);
		expect(vostfr.releases[0].title).toBe('Some.Show.S01E01.ENGLISH.1080p.WEB-DL.x264-GROUP');
	});

	it('uses the feed guid so the API key in the download URL is never exposed', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition);

		const result = parser.parse(
			tr4kerXml('Some.Movie.2026.MULTi.1080p.WEB-DL.x264-GROUP'),
			definition.search.paths?.[0],
			context
		);

		expect(result.releases[0].guid).toBe('https://tr4ker.net/torrents/abc123');
		expect(result.releases[0].guid).not.toContain('apikey');
	});

	it('has no login block, so searches do not trigger a login probe', async () => {
		const definition = await loadDefinition();
		expect(definition.login).toBeUndefined();
	});

	it('maps every category to a known newznab category', async () => {
		const definition = await loadDefinition();
		const unknown = (definition.caps.categorymappings ?? []).filter(
			(m) => !String(m.cat).startsWith('Other') && resolveCategoryId(String(m.cat)) === 8000
		);
		expect(unknown).toEqual([]);
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

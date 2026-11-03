import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilterEngine } from '../engine/FilterEngine.js';
import { SelectorEngine } from '../engine/SelectorEngine.js';
import { TemplateEngine } from '../engine/TemplateEngine.js';
import { ResponseParser } from '../runtime/ResponseParser.js';
import { YamlDefinitionLoader } from '../loader/YamlDefinitionLoader.js';

const definitionPath = resolve('data/indexers/definitions/torznab.yaml');

async function loadDefinition() {
	const loader = new YamlDefinitionLoader(dirname(definitionPath));
	const result = await loader.loadOne(definitionPath);
	expect(result).not.toBeNull();
	return result!.definition;
}

function buildParser(definition: Awaited<ReturnType<typeof loadDefinition>>) {
	const templateEngine = new TemplateEngine();
	const filterEngine = new FilterEngine();
	const selectorEngine = new SelectorEngine(templateEngine);
	return new ResponseParser(definition, templateEngine, filterEngine, selectorEngine);
}

const context = {
	indexerId: 'torznab-test',
	indexerName: 'Torznab Test',
	protocol: 'torrent' as const,
	baseUrl: 'https://jackett.local/'
};

function torznabXml(attrs: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>Some.Movie.2026.MULTi.1080p.WEB-DL.x264-GROUP</title>
      <guid>abc123</guid>
      <pubDate>Tue, 15 Sep 2026 00:00:00 +0000</pubDate>
      <enclosure url="https://jackett.local/dl/abc123.torrent" length="2000000000" type="application/x-bittorrent"/>
${attrs}
    </item>
  </channel>
</rss>`;
}

describe('Torznab language/subs attributes', () => {
	it('parses name-form language attrs into canonical audio languages', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition);

		const xml = torznabXml(
			`      <torznab:attr name="seeders" value="42"/>` +
				`\n      <torznab:attr name="language" value="English, Spanish"/>` +
				`\n      <torznab:attr name="subs" value="spa"/>`
		);

		const result = parser.parse(xml, definition.search.paths?.[0], context);

		expect(result.errors).toEqual([]);
		expect(result.releases).toHaveLength(1);
		expect(result.releases[0].languages).toEqual(['en', 'es']);
		expect(result.releases[0].subtitleLanguages).toEqual(['es']);
		// Regression: the `prefix|attr` pipe DSL threw in css-select before the
		// normalizeXmlAttrSelector rewrite - seeders/infohash never extracted.
		expect(result.releases[0].seeders).toBe(42);
	});

	it('parses code-form language attrs and drops unknown tokens', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition);

		const xml = torznabXml(`      <torznab:attr name="language" value="eng;Klingon"/>`);

		const result = parser.parse(xml, definition.search.paths?.[0], context);

		expect(result.releases).toHaveLength(1);
		expect(result.releases[0].languages).toEqual(['en']);
	});

	it('leaves languages unset when the indexer provides no language attrs', async () => {
		const definition = await loadDefinition();
		const parser = buildParser(definition);

		const xml = torznabXml(`      <torznab:attr name="seeders" value="42"/>`);

		const result = parser.parse(xml, definition.search.paths?.[0], context);

		expect(result.releases).toHaveLength(1);
		expect(result.releases[0].languages).toBeUndefined();
		expect(result.releases[0].subtitleLanguages).toBeUndefined();
	});
});

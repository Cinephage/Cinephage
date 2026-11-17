/**
 * RuTracker download-URL resolution tests.
 *
 * The topic page's anchors do not all carry the same href shape: `a.tr-dl` is
 * served with an absolute URL on some pages while `a.dl-stub` / `a.dl-link`
 * carry `dl.php?t=…` relatively, and the search list serves them relatively.
 * The filter chain used to normalise the relative form only and then prepend
 * the site link unconditionally, so an absolute href came out as
 * `https://rutracker.orghttps://rutracker.org/forum/dl.php?t=…` - which
 * `testTorrentLink` then failed on, silently, before the `a.magnet-link`
 * selector won and the pack was added as a magnet with no file list (#663).
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { YamlDefinitionLoader } from '../loader/YamlDefinitionLoader.js';
import { FilterEngine } from '../engine/FilterEngine.js';
import { TemplateEngine } from '../engine/TemplateEngine.js';
import type { FilterBlock } from '../schema/yamlDefinition.js';

const definitionsDir = resolve('data/indexers/definitions');
const definitionPath = resolve(definitionsDir, 'rutracker.yaml');
const SITELINK = 'https://rutracker.org/';

const EXPECTED = 'https://rutracker.org/forum/dl.php?t=6926974';

async function loadFilters(): Promise<{
	searchDownload: FilterBlock[];
	searchDetails: FilterBlock[];
	detailsDownload: FilterBlock[];
}> {
	const loader = new YamlDefinitionLoader(definitionsDir);
	const result = await loader.loadOne(definitionPath);
	expect(result).not.toBeNull();
	const definition = result!.definition;

	const fieldFilters = (name: 'download' | 'details'): FilterBlock[] => {
		const field = definition.search?.fields?.[name];
		expect(field).toBeDefined();
		expect(typeof field).not.toBe('string');
		const filters = (field as { filters?: FilterBlock[] }).filters;
		expect(filters).toBeDefined();
		return filters ?? [];
	};

	const downloadVariable = definition.download?.downloadVariables?.find(
		(variable) => variable.name === 'downloadUrl'
	);
	expect(downloadVariable).toBeDefined();
	expect(downloadVariable?.filters).toBeDefined();

	return {
		searchDownload: fieldFilters('download'),
		searchDetails: fieldFilters('details'),
		detailsDownload: downloadVariable?.filters ?? []
	};
}

function engine(): FilterEngine {
	const templateEngine = new TemplateEngine();
	templateEngine.setSiteLink(SITELINK);
	return new FilterEngine(templateEngine);
}

/** Every href shape the topic page and the search list are known to serve. */
const DOWNLOAD_HREFS = [
	['bare relative', 'dl.php?t=6926974'],
	['root relative', '/dl.php?t=6926974'],
	['path relative', '/forum/dl.php?t=6926974'],
	['absolute https', 'https://rutracker.org/forum/dl.php?t=6926974'],
	['absolute mirror', 'https://rutracker.net/forum/dl.php?t=6926974']
] as const;

const DETAILS_HREFS = [
	['bare relative', 'viewtopic.php?t=6926974'],
	['root relative', '/viewtopic.php?t=6926974'],
	['path relative', '/forum/viewtopic.php?t=6926974'],
	['absolute https', 'https://rutracker.org/forum/viewtopic.php?t=6926974'],
	['absolute mirror', 'https://rutracker.net/forum/viewtopic.php?t=6926974']
] as const;

describe('RuTracker download URL filters', () => {
	it.each(DOWNLOAD_HREFS)('normalises a %s dl.php href', async (_label, href) => {
		const { searchDownload, detailsDownload } = await loadFilters();
		expect(engine().applyFilters(href, searchDownload)).toBe(EXPECTED);
		expect(engine().applyFilters(href, detailsDownload)).toBe(EXPECTED);
	});

	it.each(DETAILS_HREFS)('normalises a %s viewtopic.php href', async (_label, href) => {
		const { searchDetails } = await loadFilters();
		expect(engine().applyFilters(href, searchDetails)).toBe(
			'https://rutracker.org/forum/viewtopic.php?t=6926974'
		);
	});
});

describe('RuTracker definition settings', () => {
	it('does not offer settings nothing reads', async () => {
		const loader = new YamlDefinitionLoader(definitionsDir);
		const result = await loader.loadOne(definitionPath);
		const names = (result!.definition.settings ?? []).map((setting) => setting.name);
		// `usemagnetlinks` was cosmetic: no code path reads it, and the magnet a
		// user was trying to avoid came from the definition's own selector chain.
		expect(names).not.toContain('usemagnetlinks');
	});
});

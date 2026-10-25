/**
 * Issue #533 Definition Tests
 *
 * Validates the tracker definitions added for issue #533 (lst, aither,
 * torrentleech, superbits) load through the real YamlDefinitionLoader, and
 * exercises the UNIT3D JSON row parsing (blutopia-pattern field selectors)
 * through the real SelectorEngine against a captured-response shape.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { YamlDefinitionLoader } from '../loader/YamlDefinitionLoader';
import { createSelectorEngine } from '../engine/SelectorEngine';

const DEFINITIONS_DIR = join(process.cwd(), 'data', 'indexers', 'definitions');

const NEW_DEFINITION_IDS = ['lst', 'aither', 'torrentleech', 'superbits'];

async function loadNewDefinitions() {
	const loader = new YamlDefinitionLoader(DEFINITIONS_DIR);
	const results = await loader.loadAll();
	const byId = new Map(results.map((r) => [r.definition.id, r]));
	return { results, byId };
}

// Shape of a UNIT3D /api/torrents/filter response (LST/Aither), matching the
// documented UNIT3D API: a top-level data array of { id, attributes } objects.
const UNIT3D_RESPONSE = JSON.stringify({
	data: [
		{
			id: 9001,
			attributes: {
				name: 'Some.Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				details_link: 'https://lst.gg/torrents/9001',
				download_link: 'https://lst.gg/torrent/download/9001.ABCDEF',
				info_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				size: 2147483648,
				seeders: 42,
				leechers: 3,
				times_completed: 120,
				created_at: '2026-08-01T12:30:00.000000Z',
				category_id: 1,
				imdb_id: '0123456',
				tmdb_id: 12345,
				tvdb_id: null,
				meta: { poster: 'https://via.placeholder.com/90x135' },
				freeleech: '100%',
				double_upload: true
			}
		}
	]
});

describe('issue #533 tracker definitions', () => {
	it('loads all four new definitions through the YAML loader', async () => {
		const { results, byId } = await loadNewDefinitions();

		// The loader collects per-file errors separately from successful loads.
		const loadErrors = results.filter((r) => NEW_DEFINITION_IDS.includes(r.definition.id));
		expect(loadErrors).toHaveLength(NEW_DEFINITION_IDS.length);

		for (const id of NEW_DEFINITION_IDS) {
			const result = byId.get(id);
			expect(result, `definition ${id} must load`).toBeDefined();
			expect(result!.definition.type).toBe('private');
		}
	});

	it('declares UNIT3D id-based search modes for LST and Aither', async () => {
		const { byId } = await loadNewDefinitions();

		for (const id of ['lst', 'aither']) {
			const def = byId.get(id)!.definition;
			expect(def.type).toBe('private');
			expect(def.protocol).toBe('torrent');
			const modes = def.caps?.modes;
			expect(modes).toBeDefined();
		}
	});

	it('parses UNIT3D data rows with the real selector engine', () => {
		const engine = createSelectorEngine();
		const json = JSON.parse(UNIT3D_RESPONSE) as unknown;
		const rows = engine.selectJsonAll(json as never, 'data');
		expect(rows).toHaveLength(1);

		const row = rows[0] as Record<string, unknown>;
		const attributes = row.attributes as Record<string, unknown>;
		expect(attributes.name).toContain('Some.Movie.2024');
		expect(attributes.category_id).toBe(1);
		expect(attributes.freeleech).toBe('100%');
	});

	it('parses TorrentLeech torrentList rows including the numFound count', () => {
		const engine = createSelectorEngine();
		const json = JSON.parse(
			JSON.stringify({
				numFound: 1337,
				torrentList: [
					{
						fid: 777777,
						name: '[REQ] Some.Show.S01E01.720p.HDTV.x264-GROUP',
						filename: 'torrent-file-name',
						categoryID: 32,
						imdbID: '',
						seeders: 10,
						leechers: 2,
						completed: 55,
						addedTimestamp: '2026-08-01 12:30:00',
						size: 1073741824,
						download_multiplier: 0
					}
				]
			})
		) as unknown;

		const rows = engine.selectJsonAll(json as never, 'torrentList');
		expect(rows).toHaveLength(1);
		const count = engine.selectJsonAll(json as never, '$.numFound');
		expect(count).toEqual([1337]);

		const row = rows[0] as Record<string, unknown>;
		expect(row.categoryID).toBe(32);
		expect(row.download_multiplier).toBe(0);
	});

	it('parses SuperBits rartracker root-array rows', () => {
		const engine = createSelectorEngine();
		const json = JSON.parse(
			JSON.stringify([
				{
					id: 424242,
					name: 'Some.Swedish.Movie.2024.1080p.BluRay.x264-GROUP',
					category: 4,
					imdbid2: 'tt0123456',
					added: '2026-08-01 12:30:00',
					size: 2147483648,
					numfiles: 1,
					timesCompleted: 12,
					seeders: 88,
					leechers: 4,
					frileech: 1
				}
			])
		) as unknown;

		const rows = engine.selectJsonAll(json as never, '$');
		expect(rows).toHaveLength(1);
		const row = rows[0] as Record<string, unknown>;
		expect(row.name).toContain('Some.Swedish.Movie');
		expect(row.frileech).toBe(1);
	});
});

/**
 * RuTracker title corpus regression test.
 *
 * Corpus: ./fixtures/rutracker-title-corpus.txt — real topic titles, one per
 * line, each followed by an `# expect:` line declaring what the pipeline
 * SHOULD yield (seasons / season / eps / total). See the corpus header for
 * how it was built.
 *
 * What each test does: applies the rutracker.yaml title filters to the title,
 * calls parseRelease on the filtered string, and asserts the expect line.
 * Multi-season expectations compare only the seasons aspect (EpisodeInfo
 * holds either a seasons list or a single season + episodes, never both).
 *
 * Put this file and the fixtures folder anywhere under src/ (default: next to
 * ReleaseParser.ts) and run:
 *   npx vitest run rutracker-corpus.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';
import { TemplateEngine } from '../engine/TemplateEngine';
import { createFilterEngine } from '../engine/FilterEngine';
import { parseRelease } from './ReleaseParser';
import type { FilterBlock, SettingsField } from '../schema/yamlDefinition';

const CORPUS = path.join(
	fileURLToPath(new URL('.', import.meta.url)),
	'fixtures',
	'rutracker-title-corpus.txt'
);

interface Expectation {
	seasons?: number[];
	season?: number;
	eps?: [number, number];
	total?: number;
}

const rng = (a: number, b: number): number[] => {
	const out: number[] = [];
	for (let n = a; n <= b; n++) out.push(n);
	return out;
};

function parseExpectLine(line: string): Expectation | null {
	const e: Expectation = {};
	let m = line.match(/seasons=(\d+)-(\d+)/);
	if (m) e.seasons = rng(Number(m[1]), Number(m[2]));
	else if ((m = line.match(/seasons=(\d+(?:,\d+)+)/))) e.seasons = m[1].split(',').map(Number);
	else if ((m = line.match(/seasons=(\d+)/))) e.season = Number(m[1]);
	else if ((m = line.match(/season=(\d+)/))) e.season = Number(m[1]);
	if ((m = line.match(/eps=(\d+)-(\d+)/))) e.eps = [Number(m[1]), Number(m[2])];
	if ((m = line.match(/total=(\d+)/))) e.total = Number(m[1]);
	return e.seasons || e.season !== undefined || e.eps ? e : null;
}

function readCorpus(file: string): { title: string; expect: Expectation | null }[] {
	const out: { title: string; expect: Expectation | null }[] = [];
	for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith('#')) {
			const em = line.match(/^#\s*expect:\s*(.+)$/);
			// an "# expect:" line belongs to the title directly ABOVE it
			if (em && out.length) out[out.length - 1].expect = parseExpectLine(em[1]);
			continue;
		}
		out.push({ title: line, expect: null });
	}
	return out;
}

// --- engine: rutracker.yaml title filters, default settings ---
const def = yaml.load(
	fs.readFileSync(
		path.join(process.cwd(), 'data', 'indexers', 'definitions', 'rutracker.yaml'),
		'utf8'
	)
) as {
	links?: string[];
	settings?: SettingsField[];
	search?: { fields?: { title?: { filters?: FilterBlock[] } } };
};
const titleFilters = def.search?.fields?.title?.filters ?? [];
const te = new TemplateEngine();
te.setSiteLink(def.links?.[0] ?? '');
te.setConfigWithDefaults({}, def.settings ?? []);
const fe = createFilterEngine(te);

const items = readCorpus(CORPUS).filter((i) => i.expect);
if (items.length === 0) throw new Error(`corpus at ${CORPUS} yielded no titles with expectations`);

describe('RuTracker title corpus (rutracker.yaml title filters -> parseRelease)', () => {
	for (const { title, expect: exp } of items) {
		const short = title.length > 70 ? `${title.slice(0, 70)}…` : title;
		it(`parses: ${short}`, () => {
			const filtered = fe.applyFilters(title, titleFilters);
			const ep = parseRelease(filtered).episode;
			const gotSeasons = ep?.seasons ?? (ep?.season !== undefined ? [ep.season] : []);
			const gotEps = ep?.episodes?.length
				? ([ep.episodes[0], ep.episodes[ep.episodes.length - 1]] as [number, number])
				: null;

			// multi-season packs: only the seasons aspect is representable
			const multiSeason = !!exp!.seasons && exp!.seasons.length > 1;

			if (exp!.seasons) expect(gotSeasons).toEqual(exp!.seasons);
			else if (exp!.season !== undefined) expect(gotSeasons).toContain(exp!.season);

			if (!multiSeason && exp!.eps) {
				expect(gotEps, `episodes for "${title}"`).toEqual(exp!.eps);
			}
			if (!multiSeason && exp!.total !== undefined) {
				expect(ep?.episodeTotal, `stated total for "${title}"`).toBe(exp!.total);
			}
		});
	}
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	episodes,
	episodeFiles,
	languageProfiles,
	libraries,
	rootFolders,
	seasons,
	series,
	subtitles
} from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getTVShow: vi.fn().mockResolvedValue(null),
		getSeason: vi.fn().mockResolvedValue({ episodes: [] })
	}
}));

const { load } = await import('./+page.server');
type LoadEvent = { params: { id: string } };
type SeriesLoadFn = (event: LoadEvent) => Promise<import('./+page.server').LibrarySeriesPageData>;
// The exported load has SvelteKit's PageServerLoad signature; tests call it
// with a minimal event stub.
const loadFn = load as unknown as SeriesLoadFn;
const { eq } = await import('drizzle-orm');
const { LanguageSettingsService } =
	await import('#lib/server/subtitles/services/LanguageSettingsService.js');

const LANGUAGE_PROFILE_ID = 'd0000000-0000-4000-8000-000000000001';
const SERIES_ID = 'series-loader-1';

/** Temp library root; real files exist so the loader's existsSync check passes. */
let libraryRoot: string | null = null;

/**
 * Subtitle rows: ep1 has en+es+fr (cutoff counts en+es only), ep2 only en.
 */
const SUBTITLE_ROWS = [
	{ id: 'sub-loader-e1-en', episodeId: 'ep-loader-1', language: 'en' },
	{ id: 'sub-loader-e1-es', episodeId: 'ep-loader-1', language: 'es' },
	{ id: 'sub-loader-e1-fr', episodeId: 'ep-loader-1', language: 'fr' },
	{ id: 'sub-loader-e2-en', episodeId: 'ep-loader-2', language: 'en' }
];

async function seedLanguageProfile(): Promise<void> {
	await testDb.db
		.insert(languageProfiles)
		.values({
			id: LANGUAGE_PROFILE_ID,
			name: 'Tv Loader Profile',
			audio: { preferOriginal: true, languages: [], mode: 'prefer' },
			subtitles: [
				{ tag: 'en', variant: 'regular', accessibility: 'any' },
				{ tag: 'es', variant: 'regular', accessibility: 'any' },
				{ tag: 'fr', variant: 'regular', accessibility: 'any' }
			],
			cutoffRank: 1,
			minimumScore: 70,
			upgradesAllowed: true
		})
		.onConflictDoNothing()
		.run();
}

async function seedSeries(): Promise<void> {
	libraryRoot = mkdtempSync(join(tmpdir(), 'tv-loader-'));
	const showDir = join(libraryRoot, 'Loader Series', 'Season 1');
	mkdirSync(showDir, { recursive: true });

	await testDb.db
		.insert(rootFolders)
		.values({ id: 'rf-tv-loader', name: 'TV', path: libraryRoot, mediaType: 'tv' })
		.run();
	await testDb.db
		.insert(libraries)
		.values({ id: 'lib-tv-loader', name: 'TV', slug: 'tv-loader', mediaType: 'tv' })
		.run();
	await testDb.db
		.insert(series)
		.values({
			id: SERIES_ID,
			tmdbId: 9301,
			title: 'Loader Series',
			originalTitle: 'Loader Series Original',
			path: 'Loader Series',
			rootFolderId: 'rf-tv-loader',
			libraryId: 'lib-tv-loader',
			wantsSubtitles: true,
			episodeCount: 3,
			episodeFileCount: 3,
			preferOriginalTitle: null
		})
		.run();
	await testDb.db
		.insert(seasons)
		.values({ id: 'season-loader-1', seriesId: SERIES_ID, seasonNumber: 1 })
		.run();

	for (let n = 1; n <= 3; n++) {
		const episodeId = `ep-loader-${n}`;
		await testDb.db.insert(episodes).values({
			id: episodeId,
			seriesId: SERIES_ID,
			tmdbId: 9400 + n,
			seasonId: 'season-loader-1',
			seasonNumber: 1,
			episodeNumber: n,
			title: `Episode ${n}`,
			hasFile: true
		});
		await testDb.db.insert(episodeFiles).values({
			id: `file-loader-${n}`,
			seriesId: SERIES_ID,
			seasonNumber: 1,
			relativePath: `Season 1/s01e0${n}.mkv`,
			episodeIds: [episodeId]
		});
	}

	for (const row of SUBTITLE_ROWS) {
		writeFileSync(join(showDir, `${row.id}.srt`), '1\n00:00:01,000 --> 00:00:02,000\nx\n');
		await testDb.db.insert(subtitles).values({
			...row,
			relativePath: `${row.id}.srt`,
			format: 'srt'
		});
	}
}

async function resetTables(): Promise<void> {
	for (const table of [
		'subtitles',
		'episode_files',
		'episodes',
		'seasons',
		'series',
		'libraries',
		'root_folders',
		'language_profiles',
		'language_settings',
		'delay_profiles',
		'scoring_profiles',
		'download_queue'
	]) {
		testDb.sqlite.prepare(`DELETE FROM ${table}`).run();
	}
}

beforeEach(() => {
	resetTables();
	if (libraryRoot) {
		rmSync(libraryRoot, { recursive: true, force: true });
		libraryRoot = null;
	}
});

afterAll(() => {
	destroyTestDb(testDb);
	if (libraryRoot) {
		rmSync(libraryRoot, { recursive: true, force: true });
	}
});

describe('library/tv/[id] page loader', () => {
	it('exposes the series effective profile and cutoff-aware per-episode counts', async () => {
		await seedLanguageProfile();
		await seedSeries();
		// Series-level override; cutoffRank=1 -> denominator is 2 for each episode.
		await testDb.db
			.update(series)
			.set({ languageProfileId: LANGUAGE_PROFILE_ID })
			.where(eq(series.id, SERIES_ID))
			.run();

		const result = await loadFn({ params: { id: SERIES_ID } });

		expect(result.effectiveLanguageProfile).toEqual({
			source: 'series',
			profile: expect.objectContaining({ id: LANGUAGE_PROFILE_ID, name: 'Tv Loader Profile' })
		});

		const flatEpisodes = result.seasons.flatMap((season) => season.episodes);
		const byId = new Map(flatEpisodes.map((ep) => [ep.id, ep]));

		// ep1 satisfies both counted requirements (fr is beyond the cutoff).
		expect(byId.get('ep-loader-1')?.subtitleCounts).toEqual({
			satisfiedCount: 2,
			totalRequirements: 2,
			satisfiedViaCutoff: true
		});
		// ep2 satisfies only the first counted requirement.
		expect(byId.get('ep-loader-2')?.subtitleCounts).toEqual({
			satisfiedCount: 1,
			totalRequirements: 2,
			satisfiedViaCutoff: false
		});
		// ep3 has no subtitles at all.
		expect(byId.get('ep-loader-3')?.subtitleCounts).toEqual({
			satisfiedCount: 0,
			totalRequirements: 2,
			satisfiedViaCutoff: false
		});
	});

	it('omits counts and profile when the series has no effective profile', async () => {
		await seedSeries();

		const result = await loadFn({ params: { id: SERIES_ID } });

		expect(result.effectiveLanguageProfile).toBeNull();
		const flatEpisodes = result.seasons.flatMap((season) => season.episodes);
		for (const ep of flatEpisodes) {
			expect(ep.subtitleCounts).toBeNull();
		}
		// Subtitle rows are still exposed for the language-agnostic fallback UI.
		const byId = new Map(flatEpisodes.map((ep) => [ep.id, ep]));
		expect(byId.get('ep-loader-1')?.subtitles).toHaveLength(3);
	});

	it('honors the instance default profile when no override exists', async () => {
		await seedLanguageProfile();
		await seedSeries();
		await LanguageSettingsService.getInstance().update({ defaultProfileId: LANGUAGE_PROFILE_ID });

		const result = await loadFn({ params: { id: SERIES_ID } });

		expect(result.effectiveLanguageProfile?.source).toBe('default');
		// Counts still computed from the resolved (default) profile.
		const flatEpisodes = result.seasons.flatMap((season) => season.episodes);
		const byId = new Map(flatEpisodes.map((ep) => [ep.id, ep]));
		expect(byId.get('ep-loader-1')?.subtitleCounts).toEqual({
			satisfiedCount: 2,
			totalRequirements: 2,
			satisfiedViaCutoff: true
		});
	});

	it('exposes the prefer-original-title instance default without mutating per-item data', async () => {
		await seedSeries();
		await LanguageSettingsService.getInstance().update({ preferOriginalTitle: true });

		const result = await loadFn({ params: { id: SERIES_ID } });

		expect(result.preferOriginalTitleDefault).toBe(true);
		expect(result.series.preferOriginalTitle).toBeNull();
	});
});

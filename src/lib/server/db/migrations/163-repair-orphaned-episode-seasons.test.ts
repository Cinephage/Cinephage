import { randomUUID } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import { migration_v163 } from './163-repair-orphaned-episode-seasons.js';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper.js';

const databases: TestDatabase[] = [];

function makeTestDb(): TestDatabase {
	const testDb = createTestDb();
	databases.push(testDb);
	return testDb;
}

afterEach(() => {
	while (databases.length) destroyTestDb(databases.pop()!);
});

function insertSeries(sqlite: TestDatabase['sqlite'], id: string): void {
	sqlite
		.prepare(`INSERT INTO series (id, tmdb_id, title, path, monitored) VALUES (?, ?, ?, ?, 1)`)
		.run(id, Math.floor(Math.random() * 1_000_000), 'Test Series', '/tv/test');
}

function insertSeason(
	sqlite: TestDatabase['sqlite'],
	id: string,
	seriesId: string,
	seasonNumber: number,
	monitored: boolean
): void {
	sqlite
		.prepare(
			`INSERT INTO seasons (id, series_id, season_number, monitored, name)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(id, seriesId, seasonNumber, monitored ? 1 : 0, `Season ${seasonNumber}`);
}

function insertOrphanedEpisode(
	sqlite: TestDatabase['sqlite'],
	id: string,
	seriesId: string,
	seasonNumber: number,
	episodeNumber: number,
	seasonId: string | null,
	hasFile: boolean
): void {
	sqlite
		.prepare(
			`INSERT INTO episodes (id, series_id, season_id, season_number, episode_number, monitored, has_file)
			 VALUES (?, ?, ?, ?, ?, 1, ?)`
		)
		.run(id, seriesId, seasonId, seasonNumber, episodeNumber, hasFile ? 1 : 0);
}

describe('migration_v163 (repair orphaned episode-season links)', () => {
	it('relinks episodes with a null seasonId to the existing season row', () => {
		const { sqlite } = makeTestDb();
		const seriesId = randomUUID();
		const seasonId = randomUUID();
		insertSeries(sqlite, seriesId);
		insertSeason(sqlite, seasonId, seriesId, 1, false);
		const episodeId = randomUUID();
		insertOrphanedEpisode(sqlite, episodeId, seriesId, 1, 1, null, false);

		migration_v163.apply(sqlite);

		const row = sqlite.prepare('SELECT season_id FROM episodes WHERE id = ?').get(episodeId) as {
			season_id: string;
		};
		expect(row.season_id).toBe(seasonId);
	});

	it('relinks episodes pointing at a season row that no longer exists', () => {
		const { sqlite } = makeTestDb();
		const seriesId = randomUUID();
		const realSeasonId = randomUUID();
		const danglingSeasonId = randomUUID();
		insertSeries(sqlite, seriesId);
		insertSeason(sqlite, realSeasonId, seriesId, 2, true);
		const episodeId = randomUUID();
		// A dangling (non-null, points-at-nothing) season_id can't arise under
		// normal FK enforcement - seasons.id has onDelete: 'set null', so a
		// season row being deleted would null this out automatically. It can
		// only happen the way applyMigration() itself can produce it: FK
		// enforcement disabled for the duration of a migration (every
		// migration does this for schema surgery), while something deletes
		// the season row without also nulling/updating dependent episodes.
		sqlite.pragma('foreign_keys = OFF');
		insertOrphanedEpisode(sqlite, episodeId, seriesId, 2, 5, danglingSeasonId, false);
		sqlite.pragma('foreign_keys = ON');

		migration_v163.apply(sqlite);

		const row = sqlite.prepare('SELECT season_id FROM episodes WHERE id = ?').get(episodeId) as {
			season_id: string;
		};
		expect(row.season_id).toBe(realSeasonId);
	});

	it('creates a missing season row, defaulting it to unmonitored, when none exists for that number', () => {
		const { sqlite } = makeTestDb();
		const seriesId = randomUUID();
		insertSeries(sqlite, seriesId);
		const ep1 = randomUUID();
		const ep2 = randomUUID();
		insertOrphanedEpisode(sqlite, ep1, seriesId, 3, 1, null, true);
		insertOrphanedEpisode(sqlite, ep2, seriesId, 3, 2, null, false);

		migration_v163.apply(sqlite);

		const episodeRows = sqlite
			.prepare('SELECT id, season_id FROM episodes WHERE series_id = ?')
			.all(seriesId) as { id: string; season_id: string }[];
		expect(episodeRows).toHaveLength(2);
		const seasonId = episodeRows[0].season_id;
		expect(episodeRows.every((row) => row.season_id === seasonId)).toBe(true);

		const season = sqlite
			.prepare(
				'SELECT monitored, season_number, episode_count, episode_file_count FROM seasons WHERE id = ?'
			)
			.get(seasonId) as {
			monitored: number;
			season_number: number;
			episode_count: number;
			episode_file_count: number;
		};
		expect(season.season_number).toBe(3);
		expect(season.monitored).toBe(0);
		expect(season.episode_count).toBe(2);
		expect(season.episode_file_count).toBe(1);
	});

	it('names a newly created season 0 "Specials"', () => {
		const { sqlite } = makeTestDb();
		const seriesId = randomUUID();
		insertSeries(sqlite, seriesId);
		insertOrphanedEpisode(sqlite, randomUUID(), seriesId, 0, 1, null, false);

		migration_v163.apply(sqlite);

		const season = sqlite.prepare('SELECT name FROM seasons WHERE series_id = ?').get(seriesId) as {
			name: string;
		};
		expect(season.name).toBe('Specials');
	});

	it('leaves correctly-linked episodes untouched', () => {
		const { sqlite } = makeTestDb();
		const seriesId = randomUUID();
		const seasonId = randomUUID();
		insertSeries(sqlite, seriesId);
		insertSeason(sqlite, seasonId, seriesId, 1, true);
		const episodeId = randomUUID();
		insertOrphanedEpisode(sqlite, episodeId, seriesId, 1, 1, seasonId, true);

		expect(() => migration_v163.apply(sqlite)).not.toThrow();

		const row = sqlite.prepare('SELECT season_id FROM episodes WHERE id = ?').get(episodeId) as {
			season_id: string;
		};
		expect(row.season_id).toBe(seasonId);
	});

	it('is a no-op when there are no orphaned links at all', () => {
		const { sqlite } = makeTestDb();
		expect(() => migration_v163.apply(sqlite)).not.toThrow();
	});
});

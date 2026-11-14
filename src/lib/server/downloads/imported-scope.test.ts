import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/db-helper.js';
import { downloadHistory, episodeFiles, movies, series } from '#lib/server/db/schema.js';

const testDb = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const { resolveImportedScope } = await import('./imported-scope.js');

let sequence = 0;

function addHistory(row: {
	infoHash?: string;
	downloadId?: string;
	status?: string;
	episodeIds?: string[] | null;
	episodeFileIds?: string[] | null;
	seriesId?: string;
	movieId?: string;
}) {
	sequence += 1;
	testDb.db
		.insert(downloadHistory)
		.values({
			id: `history-${sequence}`,
			title: 'Some.Release-GRP',
			infoHash: row.infoHash ?? null,
			downloadId: row.downloadId ?? null,
			status: row.status ?? 'imported',
			episodeIds: row.episodeIds ?? null,
			episodeFileIds: row.episodeFileIds ?? null,
			seriesId: row.seriesId ?? null,
			movieId: row.movieId ?? null
		})
		.run();
}

/** A library file, as the import records it when it hands one over. */
function addEpisodeFile(id: string, episodeIds: string[]) {
	testDb.db
		.insert(episodeFiles)
		.values({
			id,
			seriesId: 'series-1',
			seasonNumber: 1,
			episodeIds,
			relativePath: `Season 01/${id}.mkv`
		})
		.run();
}

/** The history rows point at real media rows; the schema enforces the links. */
function seedParents() {
	testDb.db
		.insert(series)
		.values([
			{ id: 'series-1', tmdbId: 990001, title: 'Show', path: 'Show' },
			{ id: 'series-2', tmdbId: 990003, title: 'Other Show', path: 'OtherShow' }
		])
		.run();
	testDb.db
		.insert(movies)
		.values({ id: 'movie-1', tmdbId: 990002, title: 'Movie', path: 'Movie' })
		.run();
}

describe('resolveImportedScope', () => {
	beforeEach(() => {
		testDb.sqlite.exec('DELETE FROM download_history; DELETE FROM series; DELETE FROM movies;');
		seedParents();
	});

	it('reports the whole request missing when the hash was never imported', async () => {
		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1', 'ep-2']
		});

		expect(scope.imported).toBe(false);
		expect(scope.missingEpisodeIds).toEqual(['ep-1', 'ep-2']);
		expect(scope.satisfied).toBe(false);
	});

	it('covers only the episodes an imported pack actually delivered', async () => {
		addHistory({ infoHash: 'abc', seriesId: 'series-1', episodeIds: ['ep-1', 'ep-2', 'ep-3'] });

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-3', 'ep-4']
		});

		expect(scope.imported).toBe(true);
		expect(scope.coveredEpisodeIds).toEqual(['ep-3']);
		expect(scope.missingEpisodeIds).toEqual(['ep-4']);
		expect(scope.satisfied).toBe(false);
	});

	it('is satisfied when the imported pack covers the whole request', async () => {
		addHistory({ infoHash: 'abc', seriesId: 'series-1', episodeIds: ['ep-1', 'ep-2'] });

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-2']
		});

		expect(scope.missingEpisodeIds).toEqual([]);
		expect(scope.satisfied).toBe(true);
	});

	it('unions the scope of several imported rows for the same hash', async () => {
		addHistory({ infoHash: 'abc', seriesId: 'series-1', episodeIds: ['ep-1'] });
		addHistory({ infoHash: 'abc', seriesId: 'series-1', episodeIds: ['ep-2'] });

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1', 'ep-2']
		});

		expect(scope.satisfied).toBe(true);
	});

	it('keeps a hash imported for another series a duplicate', async () => {
		// A release belongs to one series; finding it under a different one is a
		// misidentification, not a re-grab, so the pre-scope block stays.
		addHistory({ infoHash: 'abc', seriesId: 'series-2', episodeIds: ['ep-1'] });

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1']
		});

		expect(scope.imported).toBe(true);
		expect(scope.satisfied).toBe(true);
	});

	it('keeps a hash imported for another movie a duplicate', async () => {
		addHistory({ infoHash: 'abc', movieId: 'movie-1' });

		const scope = await resolveImportedScope({ infoHash: 'abc', movieId: 'movie-2' });

		expect(scope.satisfied).toBe(true);
	});

	it('treats a row without an episode scope as covering the request', async () => {
		addHistory({ infoHash: 'abc', seriesId: 'series-1', episodeIds: null });

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-9']
		});

		expect(scope.coveredEpisodeIds).toEqual(['ep-9']);
		expect(scope.satisfied).toBe(true);
	});

	it('treats an imported movie release as a duplicate regardless of scope', async () => {
		addHistory({ infoHash: 'abc', movieId: 'movie-1' });

		const scope = await resolveImportedScope({ infoHash: 'abc', movieId: 'movie-1' });

		expect(scope.satisfied).toBe(true);
	});

	it('matches history by downloadId when no info hash was recorded', async () => {
		addHistory({ downloadId: 'abc', seriesId: 'series-1', episodeIds: ['ep-1'] });

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1']
		});

		expect(scope.satisfied).toBe(true);
	});

	it('reports the episodes an import did not land, whatever the grab asked for', async () => {
		// The reported case: a pack grab scoped to five missing episodes imported
		// one file. The history row still carries all five as its requested scope,
		// so reading that as delivery claimed the pack had already delivered
		// episodes it never dropped on disk (#663).
		addEpisodeFile('file-1', ['ep-1']);
		addHistory({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1', 'ep-2', 'ep-3'],
			episodeFileIds: ['file-1']
		});

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1', 'ep-2', 'ep-3']
		});

		expect(scope.coveredEpisodeIds).toEqual(['ep-1']);
		expect(scope.missingEpisodeIds).toEqual(['ep-2', 'ep-3']);
		expect(scope.satisfied).toBe(false);
	});

	it('treats an import that recorded no files as delivering nothing', async () => {
		addHistory({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1', 'ep-2'],
			episodeFileIds: []
		});

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1', 'ep-2']
		});

		expect(scope.missingEpisodeIds).toEqual(['ep-1', 'ep-2']);
		expect(scope.satisfied).toBe(false);
	});

	it('counts a multi-episode file as delivering every episode it holds', async () => {
		addEpisodeFile('file-1', ['ep-1', 'ep-2']);
		addHistory({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1'],
			episodeFileIds: ['file-1']
		});

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1', 'ep-2']
		});

		expect(scope.satisfied).toBe(true);
	});

	it('ignores history rows that did not import', async () => {
		addHistory({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1'],
			status: 'failed'
		});

		const scope = await resolveImportedScope({
			infoHash: 'abc',
			seriesId: 'series-1',
			episodeIds: ['ep-1']
		});

		expect(scope.imported).toBe(false);
		expect(scope.satisfied).toBe(false);
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDatabase } from '../../../test/db-helper.js';
import {
	movies,
	movieFiles,
	alternateTitles,
	rootFolders,
	scoringProfiles
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
		searchMovies: vi.fn(),
		getMovie: vi.fn()
	}
}));

const { buildMovies, buildMovieByArrId } = await import('./movies.js');

const MOVIE_ID = 'movie-1';
const ROOT_FOLDER_ID = 'root-1';
const PROFILE_ID = 'profile-1';

beforeEach(() => {
	testDb.db.delete(movieFiles).run();
	testDb.db.delete(alternateTitles).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(rootFolders).run();
	testDb.db.delete(scoringProfiles).run();

	testDb.db
		.insert(rootFolders)
		.values({ id: ROOT_FOLDER_ID, name: 'Movies', path: '/movies', mediaType: 'movie' })
		.run();
	testDb.db.insert(scoringProfiles).values({ id: PROFILE_ID, name: 'HD' }).run();
});

describe('buildMovies', () => {
	it('maps a movie without a file to the expected shape', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: MOVIE_ID,
				tmdbId: 100,
				title: 'Some Movie',
				path: '/movies/some-movie',
				rootFolderId: ROOT_FOLDER_ID,
				scoringProfileId: PROFILE_ID,
				hasFile: false,
				monitored: true,
				year: 2024
			})
			.run();

		const [movie] = await buildMovies();
		expect(movie.title).toBe('Some Movie');
		expect(movie.tmdbId).toBe(100);
		expect(movie.hasFile).toBe(false);
		expect(movie.monitored).toBe(true);
		expect(movie.rootFolderPath).toBe('/movies');
		expect(Number.isInteger(movie.id)).toBe(true);
		expect(Number.isInteger(movie.qualityProfileId)).toBe(true);
		expect(movie.movieFile).toBeUndefined();
		expect(movie.collection).toBeUndefined();
		expect(movie.status).toBe('tba'); // no releaseDate set
	});

	it('includes movieFile and derives sizeOnDisk/statistics when a file exists', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: MOVIE_ID,
				tmdbId: 101,
				title: 'Movie With File',
				path: '/movies/movie-with-file',
				hasFile: true
			})
			.run();
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'file-1',
				movieId: MOVIE_ID,
				relativePath: 'movie.mkv',
				size: 5_000_000_000,
				releaseGroup: 'GROUP'
			})
			.run();

		const [movie] = await buildMovies();
		expect(movie.hasFile).toBe(true);
		expect(movie.sizeOnDisk).toBe(5_000_000_000);
		expect(movie.status).toBe('released');
		expect(movie.movieFile).toBeDefined();
		expect((movie.statistics as { releaseGroups: string[] }).releaseGroups).toEqual(['GROUP']);
	});

	it('includes a collection field only when tmdbCollectionId is set', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: MOVIE_ID,
				tmdbId: 102,
				title: 'Collection Movie',
				path: '/movies/collection-movie',
				tmdbCollectionId: 999,
				collectionName: 'Some Franchise'
			})
			.run();

		const [movie] = await buildMovies();
		expect(movie.collection).toEqual({ title: 'Some Franchise', tmdbId: 999 });
	});

	it('buildMovieByArrId finds the same record buildMovies returns', async () => {
		testDb.db
			.insert(movies)
			.values({ id: MOVIE_ID, tmdbId: 103, title: 'Lookup Me', path: '/movies/lookup-me' })
			.run();

		const [movie] = await buildMovies();
		const found = await buildMovieByArrId(movie.id as number);
		expect(found).toEqual(movie);
	});

	it('returns null from buildMovieByArrId for an unknown id', async () => {
		expect(await buildMovieByArrId(999999)).toBeNull();
	});
});

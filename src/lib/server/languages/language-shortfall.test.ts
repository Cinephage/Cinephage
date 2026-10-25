import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../../../test/db-helper';

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

const { evaluateShortfall, recalculateMovieShortfall } = await import('./language-shortfall');
const { DEFAULT_EFFECTIVE_AUDIO_PREFERENCE } = await import('./audio-preference');

function preference(overrides: Partial<typeof DEFAULT_EFFECTIVE_AUDIO_PREFERENCE> = {}) {
	return { ...DEFAULT_EFFECTIVE_AUDIO_PREFERENCE, ...overrides };
}

describe('evaluateShortfall (truth table)', () => {
	it('returns unknown when no usable audio languages were probed', () => {
		expect(evaluateShortfall(preference({ languages: ['es'] }), [])).toBe('unknown');
		expect(evaluateShortfall(preference({ languages: ['es'] }), ['und', undefined, ''])).toBe(
			'unknown'
		);
	});

	it('returns satisfied under a neutral preference (no expectation)', () => {
		expect(evaluateShortfall(preference(), ['de'])).toBe('satisfied');
	});

	it('matches preferred languages with base-tag fallback (eng → en)', () => {
		expect(evaluateShortfall(preference({ languages: ['es', 'en'] }), ['eng'])).toBe('satisfied');
	});

	it('matches the original language when preferOriginal is on', () => {
		expect(
			evaluateShortfall(
				preference({ preferOriginal: true, originalLanguage: 'ja', languages: [] }),
				['jpn']
			)
		).toBe('satisfied');
	});

	it('flags a shortfall when probed audio matches nothing preferred', () => {
		expect(evaluateShortfall(preference({ languages: ['es', 'en'] }), ['ita'])).toBe('shortfall');
	});

	it('ignores the original language when preferOriginal is off', () => {
		expect(
			evaluateShortfall(
				preference({ preferOriginal: false, originalLanguage: 'en', languages: ['es'] }),
				['en']
			)
		).toBe('shortfall');
	});
});

describe('recalculateMovieShortfall (persistence)', () => {
	beforeEach(() => {
		testDb.db.run('DELETE FROM movie_files');
		testDb.db.run('DELETE FROM movies');
		testDb.db.run('DELETE FROM language_profiles');
		testDb.db.run('DELETE FROM language_settings');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('flags a movie whose only file contradicts the preference', async () => {
		const movieId = 'movie-1';
		testDb.db
			.insert((await import('#lib/server/db/schema.js')).movies)
			.values({
				id: movieId,
				title: 'Dual Audio Dream',
				tmdbId: 900001,
				path: '/movies/dual-audio-dream',
				monitored: true,
				hasFile: true
			})
			.run();
		testDb.db
			.insert((await import('#lib/server/db/schema.js')).movieFiles)
			.values({
				id: 'file-1',
				movieId,
				relativePath: 'Dual.Audio.Dream.2026.mkv',
				size: 1000,
				mediaInfo: { audioLanguages: ['ita'] }
			})
			.run();

		// Preference: es+en via an instance-default profile
		testDb.db
			.insert((await import('#lib/server/db/schema.js')).languageProfiles)
			.values({
				id: 'profile-es',
				name: 'ES First',
				audio: { preferOriginal: false, languages: ['es', 'en'], mode: 'prefer' },
				subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
				cutoffRank: null,
				minimumScore: 70,
				upgradesAllowed: true
			})
			.run();
		testDb.db
			.insert((await import('#lib/server/db/schema.js')).languageSettings)
			.values({ id: 'singleton', defaultProfileId: 'profile-es' })
			.onConflictDoUpdate({
				target: (await import('#lib/server/db/schema.js')).languageSettings.id,
				set: { defaultProfileId: 'profile-es' }
			})
			.run();

		const flagged = await recalculateMovieShortfall(movieId);
		expect(flagged).toBe(true);
		const row = testDb.db
			.select()
			.from((await import('#lib/server/db/schema.js')).movies)
			.all()
			.find((m) => m.id === movieId);
		expect(row?.languageShortfall).toBe(true);
	});

	it('leaves the flag off when the audio satisfies the preference', async () => {
		const movieId = 'movie-2';
		const schema = await import('#lib/server/db/schema.js');
		testDb.db
			.insert(schema.movies)
			.values({
				id: movieId,
				title: 'Good Audio',
				tmdbId: 900002,
				path: '/movies/good-audio',
				monitored: true,
				hasFile: true
			})
			.run();
		testDb.db
			.insert(schema.movieFiles)
			.values({
				id: 'file-2',
				movieId,
				relativePath: 'Good.Audio.2026.mkv',
				size: 1000,
				mediaInfo: { audioLanguages: ['eng'] }
			})
			.run();

		const flagged = await recalculateMovieShortfall(movieId);
		expect(flagged).toBe(false);
	});

	it('never flags unprobed files (absence of evidence is not a shortfall)', async () => {
		const movieId = 'movie-3';
		const schema = await import('#lib/server/db/schema.js');
		testDb.db
			.insert(schema.movies)
			.values({
				id: movieId,
				title: 'Unknown Audio',
				tmdbId: 900003,
				path: '/movies/unknown-audio',
				monitored: true,
				hasFile: true
			})
			.run();
		testDb.db
			.insert(schema.movieFiles)
			.values({
				id: 'file-3',
				movieId,
				relativePath: 'Unknown.Audio.2026.mkv',
				size: 1000,
				mediaInfo: { audioLanguages: [] }
			})
			.run();

		// movie-1's instance-default profile (es+en) may still be set from a
		// prior test in this file's shared db — re-seed to be explicit.
		testDb.db
			.insert(schema.languageProfiles)
			.values({
				id: 'profile-es',
				name: 'ES First',
				audio: { preferOriginal: false, languages: ['es', 'en'], mode: 'prefer' },
				subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
				cutoffRank: null,
				minimumScore: 70,
				upgradesAllowed: true
			})
			.run();
		testDb.db
			.insert(schema.languageSettings)
			.values({ id: 'singleton', defaultProfileId: 'profile-es' })
			.onConflictDoUpdate({
				target: schema.languageSettings.id,
				set: { defaultProfileId: 'profile-es' }
			})
			.run();

		expect(await recalculateMovieShortfall(movieId)).toBe(false);
	});
});

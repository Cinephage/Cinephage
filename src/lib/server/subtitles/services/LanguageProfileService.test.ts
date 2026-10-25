import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { eq } from 'drizzle-orm';
import {
	episodes,
	episodeFiles,
	languageProfiles,
	libraries,
	movies,
	rootFolders,
	series,
	subtitles
} from '#lib/server/db/schema.js';
import type { LanguageProfile } from './LanguageProfileService';
import type { SubtitleStatus } from '../types';

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

const {
	LanguageProfileService,
	getLanguageProfileService,
	parseAudioPreference,
	parseSubtitleRequirements
} = await import('./LanguageProfileService');
const { LanguageSettingsService } = await import('./LanguageSettingsService');

const TABLES_TO_CLEAR = [
	'language_settings',
	'language_profiles',
	'movies',
	'series',
	'libraries',
	'smart_lists',
	'subtitles',
	'episode_files',
	'episodes',
	'root_folders'
];

/**
 * Fixed profile ids (UUID-shaped: languageSettingsSchema validates
 * defaultProfileId as a uuid, and migration 140 gives the profile reference
 * columns real FKs). Insert profiles BEFORE rows that reference them.
 */
const PROFILE_OVERRIDE = 'a0000000-0000-4000-8000-000000000001';
const PROFILE_LIBRARY = 'a0000000-0000-4000-8000-000000000002';
const PROFILE_DEFAULT = 'a0000000-0000-4000-8000-000000000003';
const PROFILE_SERIES = 'a0000000-0000-4000-8000-000000000004';
const PROFILE_COUNTS = 'a0000000-0000-4000-8000-000000000005';
const PROFILE_CUTOFF = 'a0000000-0000-4000-8000-000000000006';
const PROFILE_EMBEDDED = 'a0000000-0000-4000-8000-000000000007';

/** Insert a profile row directly (bypasses create validation, keeps ids fixed). */
async function seedProfile(id: string, name: string): Promise<void> {
	await testDb.db.insert(languageProfiles).values({
		id,
		name,
		audio: { preferOriginal: true, languages: [], mode: 'prefer' },
		subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
		cutoffRank: null,
		minimumScore: 70,
		upgradesAllowed: true
	});
}

/** Seed a library row with an optional language profile assignment. */
async function seedLibrary(id: string, languageProfileId: string | null = null): Promise<void> {
	await testDb.db
		.insert(libraries)
		.values({ id, name: `L-${id}`, slug: `lib-${id}`, mediaType: 'movie', languageProfileId })
		.run();
}

/** Seed a series + root folder; returns the series id. */
async function seedSeries(
	seriesId: string,
	libraryId: string | null = null,
	languageProfileId: string | null = null
): Promise<string> {
	await testDb.db
		.insert(rootFolders)
		.values({ id: `rf-${seriesId}`, name: 'TV', path: `/media/${seriesId}`, mediaType: 'tv' })
		.run();
	await testDb.db
		.insert(series)
		.values({
			id: seriesId,
			tmdbId: 5000,
			title: 'Series',
			path: 'Series',
			rootFolderId: `rf-${seriesId}`,
			libraryId,
			languageProfileId
		})
		.run();
	return seriesId;
}

/** Seed an episode (and an episode file so subtitle rows resolve to a path). */
async function seedEpisode(
	episodeId: string,
	seriesId: string,
	episodeNumber: number
): Promise<void> {
	await testDb.db
		.insert(episodes)
		.values({
			id: episodeId,
			seriesId,
			tmdbId: 6000 + episodeNumber,
			seasonNumber: 1,
			episodeNumber,
			title: `E${episodeNumber}`,
			hasFile: true
		})
		.run();
	await testDb.db.insert(episodeFiles).values({
		id: `file-${episodeId}`,
		seriesId,
		seasonNumber: 1,
		relativePath: `Season 1/s01e${String(episodeNumber).padStart(2, '0')}.mkv`,
		episodeIds: [episodeId]
	});
}

/** Complete v2 profile fixture with overrides. */
function makeProfile(overrides: Partial<LanguageProfile> = {}): LanguageProfile {
	return {
		id: 'test-profile',
		name: 'Test Profile',
		audio: { preferOriginal: true, languages: [], mode: 'prefer' },
		subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
		cutoffRank: null,
		minimumScore: 70,
		upgradesAllowed: true,
		...overrides
	};
}

/** Create-body for the service with canonical tags. */
function makeCreateBody(
	overrides: Partial<Omit<LanguageProfile, 'id' | 'createdAt' | 'updatedAt'>> = {}
): Omit<LanguageProfile, 'id' | 'createdAt' | 'updatedAt'> {
	return {
		name: 'Created Profile',
		audio: { preferOriginal: true, languages: ['ja'], mode: 'prefer' },
		subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
		cutoffRank: null,
		minimumScore: 70,
		upgradesAllowed: true,
		...overrides
	};
}

/** Partial subtitle row for the private status-method tests. */
function subtitleRecord(overrides: Record<string, unknown>): never {
	return {
		id: 'sub-1',
		language: 'en',
		relativePath: 'Movie.Name.en.srt',
		format: 'srt',
		isForced: false,
		isHearingImpaired: false,
		matchScore: 90,
		movieId: 'movie-status',
		...overrides
	} as never;
}

/**
 * Seed a movie + root folder so resolveStoredSubtitlePaths can build a real
 * absolute path for movie-scoped subtitle rows. Returns the movie id.
 */
let movieFixtureCounter = 0;
function seedMovieFixture(movieId = 'movie-status', rootPath = '/media/movies'): string {
	testDb.db
		.insert(rootFolders)
		.values({ id: `rf-${movieId}`, name: 'Movies', path: rootPath, mediaType: 'movie' })
		.run();
	testDb.db
		.insert(movies)
		.values({
			id: movieId,
			tmdbId: ++movieFixtureCounter,
			title: 'Status Movie',
			path: 'Status Movie (2020)',
			rootFolderId: `rf-${movieId}`
		})
		.run();
	return movieId;
}

/** Call the private async status calculator with an injected existence predicate. */
async function calculate(
	service: ReturnType<typeof LanguageProfileService.getInstance>,
	profile: LanguageProfile,
	rows: never[],
	exists: (path: string) => boolean
): Promise<SubtitleStatus> {
	// @ts-expect-error accessing private async method for testing
	return service.calculateStatus(
		profile.subtitles,
		rows,
		{ rank: profile.cutoffRank, applies: true },
		exists
	);
}

describe('LanguageProfileService', () => {
	let profileService: ReturnType<typeof LanguageProfileService.getInstance>;
	let settingsService: ReturnType<typeof LanguageSettingsService.getInstance>;
	beforeEach(() => {
		profileService = LanguageProfileService.getInstance();
		settingsService = LanguageSettingsService.getInstance();
		for (const table of TABLES_TO_CLEAR) {
			testDb.sqlite.prepare(`DELETE FROM ${table}`).run();
		}
	});

	describe('Singleton pattern', () => {
		it('should return the same instance', () => {
			const instance1 = LanguageProfileService.getInstance();
			const instance2 = LanguageProfileService.getInstance();

			expect(instance1).toBe(instance2);
		});

		it('should return same instance via helper function', () => {
			const instance1 = getLanguageProfileService();
			const instance2 = getLanguageProfileService();

			expect(instance1).toBe(instance2);
		});
	});

	describe('Profile validation (create/update)', () => {
		it('should reject a profile without subtitle requirements', async () => {
			await expect(profileService.createProfile(makeCreateBody({ subtitles: [] }))).rejects.toThrow(
				'At least one subtitle language is required'
			);
		});

		it('should reject a cutoff rank that does not reference a requirement', async () => {
			await expect(profileService.createProfile(makeCreateBody({ cutoffRank: 3 }))).rejects.toThrow(
				'Cutoff rank must reference a subtitle requirement'
			);
		});

		it('should reject an update whose cutoff rank exceeds the requirement list', async () => {
			const created = await profileService.createProfile(makeCreateBody());

			await expect(profileService.updateProfile(created.id, { cutoffRank: 3 })).rejects.toThrow(
				'Cutoff rank must reference a subtitle requirement'
			);
		});
	});

	describe('Defensive JSON parsing', () => {
		it('should fall back to audio defaults on malformed JSON', () => {
			const audio = parseAudioPreference('{not json', 'profile-1');

			expect(audio).toEqual({ preferOriginal: true, languages: [], mode: 'prefer' });
		});

		it('should fall back to audio defaults on shape-mismatched data', () => {
			expect(parseAudioPreference('null', 'profile-1')).toEqual({
				preferOriginal: true,
				languages: [],
				mode: 'prefer'
			});
			expect(parseAudioPreference({ preferOriginal: 'yes' }, 'profile-1')).toEqual({
				preferOriginal: true,
				languages: [],
				mode: 'prefer'
			});
			const partial = parseAudioPreference(
				{ preferOriginal: false, languages: ['en', '', 42] },
				'p'
			);
			expect(partial.preferOriginal).toBe(false);
			expect(partial.languages).toEqual(['en']);
		});

		it('should fall back to an empty requirement list on malformed subtitles JSON', () => {
			expect(parseSubtitleRequirements('[]}{', 'profile-1')).toEqual([]);
			expect(parseSubtitleRequirements({ tag: 'en' }, 'profile-1')).toEqual([]);
		});

		it('should coerce invalid requirement fields and drop entries without tags', () => {
			const requirements = parseSubtitleRequirements(
				[
					{ tag: 'en', variant: 'both', accessibility: 'require-hi' },
					{ tag: 'es', variant: 'bogus', accessibility: 'bogus' },
					{ variant: 'regular', accessibility: 'any' },
					{ tag: '   ', variant: 'regular', accessibility: 'any' },
					'garbage'
				],
				'profile-1'
			);

			expect(requirements).toEqual([
				{ tag: 'en', variant: 'both', accessibility: 'require-hi' },
				{ tag: 'es', variant: 'regular', accessibility: 'any' }
			]);
		});
	});

	describe('Profile CRUD and default authority', () => {
		it('should create and read a profile with canonical tags and defaults applied', async () => {
			const created = await profileService.createProfile(
				makeCreateBody({ minimumScore: 80, upgradesAllowed: false })
			);

			expect(created.id).toBeTruthy();
			expect(created.name).toBe('Created Profile');
			expect(created.audio).toEqual({ preferOriginal: true, languages: ['ja'], mode: 'prefer' });
			expect(created.subtitles).toEqual([{ tag: 'en', variant: 'regular', accessibility: 'any' }]);
			expect(created.cutoffRank).toBeNull();
			expect(created.minimumScore).toBe(80);
			expect(created.upgradesAllowed).toBe(false);

			const fetched = await profileService.getProfile(created.id);
			expect(fetched?.id).toBe(created.id);
			expect((await profileService.getProfiles()).map((p) => p.id)).toContain(created.id);
		});

		it('should canonicalize tags and apply schema defaults on create', async () => {
			const created = await profileService.createProfile(
				makeCreateBody({
					subtitles: [{ tag: 'ENG', variant: 'regular', accessibility: 'any' }]
				})
			);

			expect(created.subtitles[0].tag).toBe('en');
		});

		it('should update only the provided fields', async () => {
			const created = await profileService.createProfile(makeCreateBody());

			const updated = await profileService.updateProfile(created.id, {
				name: 'Renamed',
				cutoffRank: 0
			});

			expect(updated.name).toBe('Renamed');
			expect(updated.cutoffRank).toBe(0);
			expect(updated.minimumScore).toBe(70);
			expect(updated.upgradesAllowed).toBe(true);
			expect(updated.subtitles).toHaveLength(1);
		});

		it('preserves non-default fields on a rename-only update', async () => {
			const created = await profileService.createProfile(
				makeCreateBody({
					audio: { preferOriginal: false, languages: ['de'], mode: 'require' },
					minimumScore: 25,
					upgradesAllowed: false,
					cutoffRank: 0
				})
			);

			const updated = await profileService.updateProfile(created.id, { name: 'Renamed Only' });

			expect(updated.name).toBe('Renamed Only');
			expect(updated.audio).toEqual({ preferOriginal: false, languages: ['de'], mode: 'require' });
			expect(updated.minimumScore).toBe(25);
			expect(updated.upgradesAllowed).toBe(false);
			expect(updated.cutoffRank).toBe(0);
		});

		it('rejects duplicate requirement tuples on update', async () => {
			const created = await profileService.createProfile(makeCreateBody());

			await expect(
				profileService.updateProfile(created.id, {
					subtitles: [
						{ tag: 'en', variant: 'regular', accessibility: 'any' },
						{ tag: 'eng', variant: 'regular', accessibility: 'any' }
					]
				})
			).rejects.toThrow(/duplicate/i);
		});

		it('should delete a profile and null every reference', async () => {
			const created = await profileService.createProfile(makeCreateBody());
			await testDb.db.insert(movies).values({
				id: 'movie-1',
				tmdbId: 101,
				title: 'M1',
				path: '/m1',
				languageProfileId: created.id
			});
			await testDb.db.insert(libraries).values({
				id: 'lib-1',
				name: 'L',
				slug: 'lib-1',
				mediaType: 'movie',
				languageProfileId: created.id
			});
			await settingsService.update({ defaultProfileId: created.id });

			await profileService.deleteProfile(created.id);

			expect(await profileService.getProfile(created.id)).toBeUndefined();

			const movie = (await testDb.db.select().from(movies).where(eq(movies.id, 'movie-1')))[0];
			expect(movie.languageProfileId).toBeNull();
			const library = (
				await testDb.db.select().from(libraries).where(eq(libraries.id, 'lib-1'))
			)[0];
			expect(library.languageProfileId).toBeNull();
			expect(await settingsService.getDefaultProfileId()).toBeNull();
		});

		it('should resolve the default profile through language settings', async () => {
			expect(await profileService.getDefaultProfile()).toBeUndefined();

			const created = await profileService.createProfile(makeCreateBody());
			await settingsService.update({ defaultProfileId: created.id });

			const defaultProfile = await profileService.getDefaultProfile();
			expect(defaultProfile?.id).toBe(created.id);
		});

		it('reports override-only episodes as missing when no series profile chain resolves', async () => {
			const seriesId = await seedSeries('series-ovr');
			await seedEpisode('ep-ovr', seriesId, 1);
			await testDb.db
				.update(episodes)
				.set({
					subtitleRequirementsOverride: [{ tag: 'fr', variant: 'regular', accessibility: 'any' }]
				})
				.where(eq(episodes.id, 'ep-ovr'))
				.run();

			expect(await profileService.getSeriesEpisodesMissingSubtitles(seriesId)).toEqual(['ep-ovr']);

			// Clearing the override removes the episode from the missing list
			// (there is no series profile chain to inherit).
			await testDb.db
				.update(episodes)
				.set({ subtitleRequirementsOverride: null })
				.where(eq(episodes.id, 'ep-ovr'))
				.run();
			expect(await profileService.getSeriesEpisodesMissingSubtitles(seriesId)).toEqual([]);
		});

		it('excludes file-less episodes from the missing-subtitles list (arr parity)', async () => {
			const seriesId = await seedSeries('series-nofile');
			await seedEpisode('ep-with-file', seriesId, 1);
			await seedEpisode('ep-no-file', seriesId, 2);
			await testDb.db
				.update(episodes)
				.set({ hasFile: false })
				.where(eq(episodes.id, 'ep-no-file'))
				.run();
			await testDb.db
				.update(episodes)
				.set({
					subtitleRequirementsOverride: [{ tag: 'fr', variant: 'regular', accessibility: 'any' }]
				})
				.where(eq(episodes.id, 'ep-no-file'))
				.run();

			// ep-no-file carries an unsatisfied override but has no media
			// file: it is missing CONTENT, not subtitles. ep-with-file has a
			// file but no requirements (no series profile, no override), so
			// the missing list is empty either way.
			expect(await profileService.getSeriesEpisodesMissingSubtitles(seriesId)).toEqual([]);
		});

		it('should fall back to the default profile for movies without an assignment', async () => {
			const created = await profileService.createProfile(makeCreateBody());
			await settingsService.update({ defaultProfileId: created.id });
			await testDb.db
				.insert(movies)
				.values({ id: 'movie-2', tmdbId: 102, title: 'M2', path: '/m2' });

			const profile = await profileService.getProfileForMovie('movie-2');
			expect(profile?.id).toBe(created.id);

			await profileService.assignToMovie('movie-2', null);
			expect((await profileService.getProfileForMovie('movie-2'))?.id).toBe(created.id);
		});

		it('should assign and clear a library profile', async () => {
			const created = await profileService.createProfile(makeCreateBody());
			await testDb.db
				.insert(libraries)
				.values({ id: 'lib-2', name: 'L2', slug: 'lib-2', mediaType: 'movie' });

			await profileService.assignToLibrary('lib-2', created.id);
			let library = (await testDb.db.select().from(libraries).where(eq(libraries.id, 'lib-2')))[0];
			expect(library.languageProfileId).toBe(created.id);

			await profileService.assignToLibrary('lib-2', null);
			library = (await testDb.db.select().from(libraries).where(eq(libraries.id, 'lib-2')))[0];
			expect(library.languageProfileId).toBeNull();
		});
	});

	describe('Effective profile resolution with source', () => {
		it('returns null for a nonexistent movie', async () => {
			expect(await profileService.getEffectiveProfileForMovie('no-such-movie')).toBeNull();
		});

		it('returns null for an existing movie when nothing is configured at any level', async () => {
			await testDb.db
				.insert(movies)
				.values({ id: 'movie-eff-1', tmdbId: 201, title: 'M', path: '/m' })
				.run();

			const effective = await profileService.getEffectiveProfileForMovie('movie-eff-1');
			expect(effective).toBeNull();
			// Legacy accessor keeps returning undefined in the same situation.
			expect(await profileService.getProfileForMovie('movie-eff-1')).toBeUndefined();
		});

		it('prefers the movie override over library and instance defaults', async () => {
			await seedProfile(PROFILE_OVERRIDE, 'Override');
			await seedProfile(PROFILE_LIBRARY, 'Library');
			await seedProfile(PROFILE_DEFAULT, 'Default');
			await seedLibrary('lib-eff', PROFILE_LIBRARY);
			await testDb.db
				.insert(movies)
				.values({
					id: 'movie-eff-2',
					tmdbId: 202,
					title: 'M',
					path: '/m',
					libraryId: 'lib-eff',
					languageProfileId: PROFILE_OVERRIDE
				})
				.run();
			await settingsService.update({ defaultProfileId: PROFILE_DEFAULT });

			const effective = await profileService.getEffectiveProfileForMovie('movie-eff-2');

			expect(effective?.source).toBe('movie');
			expect(effective?.profile.id).toBe(PROFILE_OVERRIDE);
			expect((await profileService.getProfileForMovie('movie-eff-2'))?.id).toBe(PROFILE_OVERRIDE);
		});

		it('falls back to the owning library default when there is no item override', async () => {
			await seedProfile(PROFILE_LIBRARY, 'Library');
			await seedProfile(PROFILE_DEFAULT, 'Default');
			await seedLibrary('lib-eff-2', PROFILE_LIBRARY);
			await testDb.db
				.insert(movies)
				.values({ id: 'movie-eff-3', tmdbId: 203, title: 'M', path: '/m', libraryId: 'lib-eff-2' })
				.run();
			await settingsService.update({ defaultProfileId: PROFILE_DEFAULT });

			const effective = await profileService.getEffectiveProfileForMovie('movie-eff-3');

			expect(effective?.source).toBe('library');
			expect(effective?.profile.id).toBe(PROFILE_LIBRARY);
		});

		it('falls back to the instance default for an item with no library', async () => {
			await seedProfile(PROFILE_DEFAULT, 'Default');
			await testDb.db
				.insert(movies)
				.values({ id: 'movie-eff-4', tmdbId: 204, title: 'M', path: '/m', libraryId: null })
				.run();
			await settingsService.update({ defaultProfileId: PROFILE_DEFAULT });

			const effective = await profileService.getEffectiveProfileForMovie('movie-eff-4');

			expect(effective?.source).toBe('default');
			expect(effective?.profile.id).toBe(PROFILE_DEFAULT);
		});

		it('falls back to the instance default when the library has no assignment', async () => {
			await seedProfile(PROFILE_DEFAULT, 'Default');
			await seedLibrary('lib-eff-3', null);
			await testDb.db
				.insert(movies)
				.values({ id: 'movie-eff-5', tmdbId: 205, title: 'M', path: '/m', libraryId: 'lib-eff-3' })
				.run();
			await settingsService.update({ defaultProfileId: PROFILE_DEFAULT });

			const effective = await profileService.getEffectiveProfileForMovie('movie-eff-5');

			expect(effective?.source).toBe('default');
		});

		it('falls through a dangling item override to the library default', async () => {
			await seedProfile(PROFILE_LIBRARY, 'Library');
			await seedLibrary('lib-eff-4', PROFILE_LIBRARY);
			await testDb.db
				.insert(movies)
				.values({ id: 'movie-eff-6', tmdbId: 206, title: 'M', path: '/m', libraryId: 'lib-eff-4' })
				.run();

			// Simulate an out-of-band profile deletion that left a dangling
			// reference (real deletes null references; FKs would also block this).
			testDb.sqlite.pragma('foreign_keys = OFF');
			testDb.sqlite
				.prepare(`UPDATE movies SET language_profile_id = 'deleted-profile' WHERE id = ?`)
				.run('movie-eff-6');
			testDb.sqlite.pragma('foreign_keys = ON');

			const effective = await profileService.getEffectiveProfileForMovie('movie-eff-6');

			expect(effective?.source).toBe('library');
			expect(effective?.profile.id).toBe(PROFILE_LIBRARY);
		});

		it('resolves series with the same order (override > library > default)', async () => {
			await seedProfile(PROFILE_SERIES, 'SeriesOverride');
			await seedProfile(PROFILE_LIBRARY, 'Library');
			await seedProfile(PROFILE_DEFAULT, 'Default');
			await seedSeries('series-eff-1', null, PROFILE_SERIES);
			await settingsService.update({ defaultProfileId: PROFILE_DEFAULT });

			let effective = await profileService.getEffectiveProfileForSeries('series-eff-1');
			expect(effective?.source).toBe('series');
			expect(effective?.profile.id).toBe(PROFILE_SERIES);

			await profileService.assignToSeries('series-eff-1', null);
			effective = await profileService.getEffectiveProfileForSeries('series-eff-1');
			expect(effective?.source).toBe('default');
			expect(effective?.profile.id).toBe(PROFILE_DEFAULT);

			// Library level kicks in when the series has no override of its own.
			await seedLibrary('lib-series', PROFILE_LIBRARY);
			await testDb.db
				.insert(series)
				.values({
					id: 'series-eff-2',
					tmdbId: 5001,
					title: 'S2',
					path: 'S2',
					libraryId: 'lib-series'
				})
				.run();
			effective = await profileService.getEffectiveProfileForSeries('series-eff-2');
			expect(effective?.source).toBe('library');
			expect(effective?.profile.id).toBe(PROFILE_LIBRARY);

			expect(await profileService.getEffectiveProfileForSeries('no-such-series')).toBeNull();
		});
	});

	describe('getSeriesEpisodeSubtitleCounts (batch, cutoff-aware)', () => {
		async function seedSeriesWithTwoEpisodes(): Promise<string> {
			await seedSeries('series-counts');
			await seedEpisode('ep-counts-1', 'series-counts', 1);
			await seedEpisode('ep-counts-2', 'series-counts', 2);
			await seedEpisode('ep-counts-3', 'series-counts', 3);
			return 'series-counts';
		}

		async function seedEpisodeSubtitle(
			id: string,
			episodeId: string,
			language: string,
			overrides: Record<string, unknown> = {}
		): Promise<void> {
			await testDb.db.insert(subtitles).values({
				id,
				episodeId,
				language,
				relativePath: `${id}.srt`,
				format: 'srt',
				isForced: false,
				isHearingImpaired: false,
				...overrides
			});
		}

		function groupRowsByEpisode(
			rows: Array<typeof subtitles.$inferSelect>
		): Map<string, Array<typeof subtitles.$inferSelect>> {
			const map = new Map<string, Array<typeof subtitles.$inferSelect>>();
			for (const row of rows) {
				if (row.episodeId) {
					const list = map.get(row.episodeId) ?? [];
					list.push(row);
					map.set(row.episodeId, list);
				}
			}
			return map;
		}

		it('returns an empty map when the series has no effective profile', async () => {
			await seedSeriesWithTwoEpisodes();
			const rows = await testDb.db.select().from(subtitles);

			const counts = await profileService.getSeriesEpisodeSubtitleCounts(
				'series-counts',
				groupRowsByEpisode(rows)
			);

			expect(counts.size).toBe(0);
		});

		it('counts satisfied requirements per episode and skips rows whose file is gone', async () => {
			const seriesId = await seedSeriesWithTwoEpisodes();
			await seedProfile(PROFILE_COUNTS, 'Counts');
			await settingsService.update({ defaultProfileId: PROFILE_COUNTS });
			await profileService.updateProfile(PROFILE_COUNTS, {
				subtitles: [
					{ tag: 'en', variant: 'regular', accessibility: 'any' },
					{ tag: 'es', variant: 'regular', accessibility: 'any' }
				]
			});

			await seedEpisodeSubtitle('sub-counts-en', 'ep-counts-1', 'en');
			await seedEpisodeSubtitle('sub-counts-gone', 'ep-counts-1', 'es', {
				relativePath: 'gone.es.srt'
			});
			await seedEpisodeSubtitle('sub-counts-es', 'ep-counts-2', 'es');

			const rows = await testDb.db.select().from(subtitles);
			const grouped = groupRowsByEpisode(rows);
			// Seed every episode (even without rows) so each gets an entry.
			for (const epId of ['ep-counts-1', 'ep-counts-2', 'ep-counts-3']) {
				if (!grouped.has(epId)) grouped.set(epId, []);
			}

			const counts = await profileService.getSeriesEpisodeSubtitleCounts(
				seriesId,
				grouped,
				(path) => !path.includes('gone')
			);

			expect(counts.get('ep-counts-1')).toEqual({
				satisfiedCount: 1,
				totalRequirements: 2,
				satisfiedViaCutoff: false
			});
			expect(counts.get('ep-counts-2')).toEqual({
				satisfiedCount: 1,
				totalRequirements: 2,
				satisfiedViaCutoff: false
			});
			expect(counts.get('ep-counts-3')).toEqual({
				satisfiedCount: 0,
				totalRequirements: 2,
				satisfiedViaCutoff: false
			});
		});

		it('uses cutoffRank + 1 as the denominator and ignores requirements beyond the cutoff', async () => {
			const seriesId = await seedSeriesWithTwoEpisodes();
			await seedProfile(PROFILE_CUTOFF, 'Cutoff');
			await settingsService.update({ defaultProfileId: PROFILE_CUTOFF });
			await profileService.updateProfile(PROFILE_CUTOFF, {
				subtitles: [
					{ tag: 'en', variant: 'regular', accessibility: 'any' },
					{ tag: 'es', variant: 'regular', accessibility: 'any' },
					{ tag: 'fr', variant: 'regular', accessibility: 'any' }
				],
				cutoffRank: 1
			});

			// Episode 1 has the cutoff requirement (es) satisfied; fr beyond cutoff
			// is present too but must not inflate the count.
			await seedEpisodeSubtitle('sub-cutoff-en', 'ep-counts-1', 'en');
			await seedEpisodeSubtitle('sub-cutoff-es', 'ep-counts-1', 'es');
			await seedEpisodeSubtitle('sub-cutoff-fr', 'ep-counts-1', 'fr');
			// Episode 2 only satisfies the first requirement.
			await seedEpisodeSubtitle('sub-cutoff-en-2', 'ep-counts-2', 'en');

			const rows = await testDb.db.select().from(subtitles);
			const grouped = groupRowsByEpisode(rows);
			for (const epId of ['ep-counts-1', 'ep-counts-2', 'ep-counts-3']) {
				if (!grouped.has(epId)) grouped.set(epId, []);
			}

			const counts = await profileService.getSeriesEpisodeSubtitleCounts(
				seriesId,
				grouped,
				() => true
			);

			expect(counts.get('ep-counts-1')).toEqual({
				satisfiedCount: 2,
				totalRequirements: 2,
				satisfiedViaCutoff: true
			});
			expect(counts.get('ep-counts-2')).toEqual({
				satisfiedCount: 1,
				totalRequirements: 2,
				satisfiedViaCutoff: false
			});
			expect(counts.get('ep-counts-3')).toEqual({
				satisfiedCount: 0,
				totalRequirements: 2,
				satisfiedViaCutoff: false
			});
		});

		it('does not count embedded subtitle rows', async () => {
			const seriesId = await seedSeriesWithTwoEpisodes();
			await seedProfile(PROFILE_EMBEDDED, 'Embedded');
			await settingsService.update({ defaultProfileId: PROFILE_EMBEDDED });

			await seedEpisodeSubtitle('sub-embedded', 'ep-counts-1', 'en', {
				relativePath: 'embedded:en',
				format: 'embedded'
			});

			const rows = await testDb.db.select().from(subtitles);
			const grouped = groupRowsByEpisode(rows);
			for (const epId of ['ep-counts-1', 'ep-counts-2', 'ep-counts-3']) {
				if (!grouped.has(epId)) grouped.set(epId, []);
			}

			const counts = await profileService.getSeriesEpisodeSubtitleCounts(
				seriesId,
				grouped,
				() => true
			);

			expect(counts.get('ep-counts-1')).toEqual({
				satisfiedCount: 0,
				totalRequirements: 1,
				satisfiedViaCutoff: false
			});
		});
	});

	describe('calculateStatus (via subtitle status methods)', () => {
		it('should mark satisfied when no profile is assigned', async () => {
			const status = await profileService.getMovieSubtitleStatus('non-existent-movie-id');
			expect(status.satisfied).toBe(true);
			expect(status.missing).toHaveLength(0);
		});
	});

	describe('Status calculation logic', () => {
		it('should identify missing requirements based on the profile', async () => {
			const profile = makeProfile({
				subtitles: [
					{ tag: 'en', variant: 'regular', accessibility: 'any' },
					{ tag: 'es', variant: 'regular', accessibility: 'any' }
				]
			});

			const status = await calculate(profileService, profile, [], () => true);

			expect(status.satisfied).toBe(false);
			expect(status.missing.map((m) => m.tag)).toEqual(['en', 'es']);
			expect(status.missing[0]).toEqual({ tag: 'en', variant: 'regular', accessibility: 'any' });
		});

		it('should enforce require-hi (a non-HI subtitle does not satisfy it)', async () => {
			seedMovieFixture();
			const profile = makeProfile({
				subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'require-hi' }]
			});

			const nonHi = await calculate(
				profileService,
				profile,
				[subtitleRecord({ id: 'non-hi', isHearingImpaired: false })],
				() => true
			);
			expect(nonHi.satisfied).toBe(false);
			expect(nonHi.missing[0].accessibility).toBe('require-hi');

			const hi = await calculate(
				profileService,
				profile,
				[subtitleRecord({ id: 'hi', isHearingImpaired: true })],
				() => true
			);
			expect(hi.satisfied).toBe(true);
		});

		it('should not count a stored row whose file does not exist on disk', async () => {
			seedMovieFixture();
			const profile = makeProfile();

			const gone = await calculate(
				profileService,
				profile,
				[subtitleRecord({ id: 'gone' })],
				() => false
			);
			expect(gone.satisfied).toBe(false);
			expect(gone.missing).toHaveLength(1);

			const present = await calculate(
				profileService,
				profile,
				[subtitleRecord({ id: 'present' })],
				() => true
			);
			expect(present.satisfied).toBe(true);
		});

		it('should stat each distinct resolved path at most once per call', async () => {
			seedMovieFixture();
			const profile = makeProfile();
			const exists = vi.fn().mockReturnValue(true);

			await calculate(
				profileService,
				profile,
				[subtitleRecord({ id: 'row-a' }), subtitleRecord({ id: 'row-b' })],
				exists
			);

			// Both rows share the same relative path -> one stat.
			expect(exists).toHaveBeenCalledTimes(1);
		});

		it('should respect forced variant matching', async () => {
			seedMovieFixture();
			const profile = makeProfile({
				subtitles: [{ tag: 'en', variant: 'forced', accessibility: 'any' }]
			});

			const regular = await calculate(
				profileService,
				profile,
				[subtitleRecord({ id: 'sub-regular', isForced: false })],
				() => true
			);
			expect(regular.satisfied).toBe(false);
			expect(regular.missing[0].variant).toBe('forced');

			const forced = await calculate(
				profileService,
				profile,
				[subtitleRecord({ id: 'sub-forced', isForced: true })],
				() => true
			);
			expect(forced.satisfied).toBe(true);
		});

		it('should respect exclude-hi when checking existing subtitles', async () => {
			seedMovieFixture();
			const profile = makeProfile({
				subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'exclude-hi' }]
			});

			const status = await calculate(
				profileService,
				profile,
				[subtitleRecord({ isHearingImpaired: true })],
				() => true
			);

			expect(status.satisfied).toBe(false);
			expect(status.missing[0].accessibility).toBe('exclude-hi');
		});

		it('should emit exactly ONE missing entry for a both requirement', async () => {
			const profile = makeProfile({
				subtitles: [{ tag: 'en', variant: 'both', accessibility: 'any' }],
				cutoffRank: 0
			});

			const status = await calculate(profileService, profile, [], () => true);

			expect(status.missing).toEqual([{ tag: 'en', variant: 'both', accessibility: 'any' }]);
		});

		it('should let either variant satisfy a both requirement', async () => {
			seedMovieFixture();
			const profile = makeProfile({
				subtitles: [{ tag: 'en', variant: 'both', accessibility: 'any' }]
			});

			const status = await calculate(
				profileService,
				profile,
				[subtitleRecord({ id: 'regular', isForced: false })],
				() => true
			);

			expect(status.satisfied).toBe(true);
		});

		it('should use cutoffRank to determine satisfied', async () => {
			seedMovieFixture();
			const profile = makeProfile({
				subtitles: [
					{ tag: 'en', variant: 'regular', accessibility: 'any' },
					{ tag: 'es', variant: 'regular', accessibility: 'any' },
					{ tag: 'fr', variant: 'regular', accessibility: 'any' }
				],
				cutoffRank: 0
			});

			const status = await calculate(
				profileService,
				profile,
				[subtitleRecord({ language: 'en' })],
				() => true
			);

			expect(status.satisfied).toBe(true);
			expect(status.missing).toHaveLength(0);
		});

		it('should truncate missing after the cutoff rank', async () => {
			seedMovieFixture();
			const profile = makeProfile({
				subtitles: [
					{ tag: 'en', variant: 'regular', accessibility: 'any' },
					{ tag: 'es', variant: 'regular', accessibility: 'any' },
					{ tag: 'fr', variant: 'regular', accessibility: 'any' }
				],
				cutoffRank: 1
			});

			// en present, es missing. fr is beyond the cutoff and must not be reported.
			const status = await calculate(
				profileService,
				profile,
				[subtitleRecord({ language: 'en' })],
				() => true
			);

			expect(status.satisfied).toBe(false);
			expect(status.missing.map((m) => m.tag)).toEqual(['es']);
		});

		it('should keep searching when cutoffRank is null even if a language is satisfied', async () => {
			seedMovieFixture();
			const profile = makeProfile({
				subtitles: [
					{ tag: 'en', variant: 'regular', accessibility: 'any' },
					{ tag: 'es', variant: 'regular', accessibility: 'any' }
				],
				cutoffRank: null
			});

			const status = await calculate(
				profileService,
				profile,
				[subtitleRecord({ language: 'en' })],
				() => true
			);

			expect(status.satisfied).toBe(false);
			expect(status.missing.map((m) => m.tag)).toEqual(['es']);
		});

		it('should not treat embedded subtitles as satisfying profile requirements', async () => {
			const profile = makeProfile();

			const status = await calculate(
				profileService,
				profile,
				[
					subtitleRecord({
						id: 'embedded-en',
						relativePath: 'embedded:en',
						format: 'embedded'
					})
				],
				() => true
			);

			expect(status.satisfied).toBe(false);
			expect(status.missing).toHaveLength(1);
			expect(status.missing[0].tag).toBe('en');
		});

		it('should treat existing external files as satisfying and tag existing rows with requirementKey', async () => {
			seedMovieFixture();
			const profile = makeProfile();

			const status = await calculate(
				profileService,
				profile,
				[subtitleRecord({ id: 'external-en' })],
				() => true
			);

			expect(status.satisfied).toBe(true);
			expect(status.missing).toHaveLength(0);
			expect(status.existing).toHaveLength(1);
			expect(status.existing[0].subtitleId).toBe('external-en');
			expect(status.existing[0].requirementKey).toBe('en|regular|any');
		});
	});

	describe('SubtitleStatus interface validation', () => {
		it('should have correct structure for satisfied status', () => {
			const status: SubtitleStatus = {
				satisfied: true,
				missing: [],
				existing: []
			};

			expect(status.satisfied).toBe(true);
			expect(status.missing).toEqual([]);
			expect(status.existing).toEqual([]);
		});

		it('should have correct structure for unsatisfied status', () => {
			const status: SubtitleStatus = {
				satisfied: false,
				missing: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
				existing: []
			};

			expect(status.satisfied).toBe(false);
			expect(status.missing).toHaveLength(1);
			expect(status.missing[0].tag).toBe('en');
		});

		it('should track existing subtitles with all metadata', () => {
			const status: SubtitleStatus = {
				satisfied: true,
				missing: [],
				existing: [
					{
						language: 'en',
						subtitleId: 'sub-123',
						isForced: false,
						isHearingImpaired: true,
						matchScore: 95,
						requirementKey: 'en|regular|any'
					}
				]
			};

			expect(status.existing[0].language).toBe('en');
			expect(status.existing[0].subtitleId).toBe('sub-123');
			expect(status.existing[0].isHearingImpaired).toBe(true);
			expect(status.existing[0].matchScore).toBe(95);
			expect(status.existing[0].requirementKey).toBe('en|regular|any');
		});
	});

	describe('Profile structure validation', () => {
		it('should have correct v2 default values', () => {
			const profile = makeProfile();

			expect(profile.cutoffRank).toBeNull();
			expect(profile.upgradesAllowed).toBe(true);
			expect(profile.minimumScore).toBe(70);
			expect(profile.audio).toEqual({ preferOriginal: true, languages: [], mode: 'prefer' });
			expect(profile.subtitles[0]).toEqual({ tag: 'en', variant: 'regular', accessibility: 'any' });
		});

		it('should support multiple requirements with different variants', () => {
			const profile = makeProfile({
				subtitles: [
					{ tag: 'en', variant: 'regular', accessibility: 'any' },
					{ tag: 'en', variant: 'forced', accessibility: 'any' },
					{ tag: 'es', variant: 'regular', accessibility: 'require-hi' },
					{ tag: 'fr', variant: 'both', accessibility: 'exclude-hi' }
				],
				cutoffRank: 0,
				audio: { preferOriginal: false, languages: ['ja', 'en'], mode: 'prefer' }
			});

			expect(profile.subtitles[0].variant).toBe('regular');
			expect(profile.subtitles[1].variant).toBe('forced');
			expect(profile.subtitles[2].accessibility).toBe('require-hi');
			expect(profile.subtitles[3].variant).toBe('both');
			expect(profile.subtitles[3].accessibility).toBe('exclude-hi');
			expect(profile.cutoffRank).toBe(0);
			expect(profile.audio.preferOriginal).toBe(false);
			expect(profile.audio.languages).toEqual(['ja', 'en']);
		});
	});
});

describe('getEffectiveSubtitleRequirements (per-item overrides)', () => {
	let profileService: ReturnType<typeof LanguageProfileService.getInstance>;
	let settingsService: ReturnType<typeof LanguageSettingsService.getInstance>;

	beforeEach(async () => {
		for (const table of TABLES_TO_CLEAR) {
			testDb.sqlite.prepare(`DELETE FROM ${table}`).run();
		}
		profileService = LanguageProfileService.getInstance();
		settingsService = LanguageSettingsService.getInstance();
		await seedProfile(PROFILE_OVERRIDE, 'Override');
		await seedProfile(PROFILE_DEFAULT, 'Default');
		await settingsService.update({ defaultProfileId: PROFILE_DEFAULT });
	});

	async function setMovieOverride(movieId: string, override: unknown): Promise<void> {
		await testDb.db
			.update(movies)
			.set({ subtitleRequirementsOverride: override as never })
			.where(eq(movies.id, movieId));
	}

	it('movie override replaces the requirement list and disables the cutoff', async () => {
		seedMovieFixture('movie-ovr');
		await testDb.db
			.update(movies)
			.set({
				languageProfileId: PROFILE_OVERRIDE,
				subtitleRequirementsOverride: [
					{ tag: 'fr', variant: 'regular', accessibility: 'any' },
					{ tag: 'de', variant: 'forced', accessibility: 'any' }
				] as never
			})
			.where(eq(movies.id, 'movie-ovr'));

		const effective = await profileService.getEffectiveSubtitleRequirements({
			movieId: 'movie-ovr'
		});

		expect(effective).not.toBeNull();
		expect(effective!.source).toBe('movie');
		expect(effective!.cutoffApplies).toBe(false);
		expect(effective!.requirements.map((r) => r.tag)).toEqual(['fr', 'de']);
		// Policy still comes from the profile chain.
		expect(effective!.profile?.id).toBe(PROFILE_OVERRIDE);
	});

	it('override requirements are acquired in full even when the profile sets a cutoff', async () => {
		seedMovieFixture('movie-ovr-cutoff');
		// Profile with cutoffRank 0 (only the first requirement counts).
		await testDb.db
			.update(languageProfiles)
			.set({ cutoffRank: 0 })
			.where(eq(languageProfiles.id, PROFILE_DEFAULT));
		await setMovieOverride('movie-ovr-cutoff', [
			{ tag: 'fr', variant: 'regular', accessibility: 'any' },
			{ tag: 'de', variant: 'regular', accessibility: 'any' }
		]);

		const status = await profileService.getMovieSubtitleStatus('movie-ovr-cutoff');
		// No truncation: both override requirements are missing.
		expect(status.missing.map((m) => m.tag)).toEqual(['fr', 'de']);
	});

	it('without an override the profile chain applies with cutoff semantics', async () => {
		seedMovieFixture('movie-inherit');
		await testDb.db
			.update(languageProfiles)
			.set({
				cutoffRank: 0,
				subtitles: [
					{ tag: 'en', variant: 'regular', accessibility: 'any' },
					{ tag: 'fr', variant: 'regular', accessibility: 'any' }
				]
			})
			.where(eq(languageProfiles.id, PROFILE_DEFAULT));

		const status = await profileService.getMovieSubtitleStatus('movie-inherit');
		// Cutoff truncation: only rank 0 counts while nothing is downloaded.
		expect(status.missing.map((m) => m.tag)).toEqual(['en']);
	});

	it('episode override wins over the series resolution', async () => {
		const seriesId = await seedSeries('series-ovr');
		await testDb.db
			.update(series)
			.set({ languageProfileId: PROFILE_DEFAULT })
			.where(eq(series.id, seriesId));
		seedEpisode('ep-ovr', seriesId, 1);
		await testDb.db
			.update(episodes)
			.set({
				subtitleRequirementsOverride: [
					{ tag: 'ja', variant: 'both', accessibility: 'prefer-hi' }
				] as never
			})
			.where(eq(episodes.id, 'ep-ovr'));

		const effective = await profileService.getEffectiveSubtitleRequirements({
			episodeId: 'ep-ovr'
		});

		expect(effective).not.toBeNull();
		expect(effective!.source).toBe('episode');
		expect(effective!.cutoffApplies).toBe(false);
		expect(effective!.requirements.map((r) => r.tag)).toEqual(['ja']);
	});

	it('episode without an override inherits the series profile', async () => {
		const seriesId = await seedSeries('series-inh');
		await testDb.db
			.update(series)
			.set({ languageProfileId: PROFILE_OVERRIDE })
			.where(eq(series.id, seriesId));
		seedEpisode('ep-inh', seriesId, 1);

		const effective = await profileService.getEffectiveSubtitleRequirements({
			episodeId: 'ep-inh'
		});

		expect(effective).not.toBeNull();
		expect(effective!.source).toBe('series');
		expect(effective!.cutoffApplies).toBe(true);
		expect(effective!.requirements.map((r) => r.tag)).toEqual(['en']);
	});
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('countProfileUsage (delete impact preview)', () => {
	let profileService: ReturnType<typeof LanguageProfileService.getInstance>;

	beforeEach(async () => {
		for (const table of TABLES_TO_CLEAR) {
			testDb.sqlite.prepare(`DELETE FROM ${table}`).run();
		}
		profileService = LanguageProfileService.getInstance();
		await seedProfile(PROFILE_OVERRIDE, 'Used');
		await seedProfile(PROFILE_DEFAULT, 'Default');
	});

	it('counts direct, via-library, smart-list, and instance-default usage', async () => {
		const {
			movies: moviesTable,
			series: seriesTable,
			libraries: librariesTable,
			smartLists: smartListsTable
		} = await import('#lib/server/db/schema.js');

		await testDb.db.insert(librariesTable).values({
			id: 'lib-usage',
			name: 'L',
			slug: 'lib-usage',
			mediaType: 'movie',
			languageProfileId: PROFILE_OVERRIDE
		});
		await testDb.db.insert(moviesTable).values([
			{
				id: 'movie-usage-1',
				tmdbId: 1,
				title: 'Direct',
				path: 'direct',
				libraryId: 'lib-usage',
				languageProfileId: PROFILE_OVERRIDE
			},
			{
				id: 'movie-usage-2',
				tmdbId: 2,
				title: 'Via library',
				path: 'via',
				libraryId: 'lib-usage',
				languageProfileId: null
			}
		]);
		await testDb.db.insert(seriesTable).values({
			id: 'series-usage',
			tmdbId: 3,
			title: 'Direct series',
			path: 'direct-series',
			libraryId: 'lib-usage',
			languageProfileId: PROFILE_OVERRIDE
		});
		await testDb.db.insert(smartListsTable).values({
			id: 'sl-usage',
			name: 'List',
			mediaType: 'movie',
			filters: {},
			languageProfileId: PROFILE_OVERRIDE
		});
		await testDb.db
			.update(languageProfiles)
			.set({ id: PROFILE_OVERRIDE })
			.where(eq(languageProfiles.id, PROFILE_OVERRIDE));

		const usage = await profileService.countProfileUsage(PROFILE_OVERRIDE);

		expect(usage).toEqual({
			directMovies: 1,
			directSeries: 1,
			viaLibraries: 1,
			smartLists: 1,
			isInstanceDefault: false
		});
	});

	it('flags the instance default', async () => {
		const { LanguageSettingsService } = await import('./LanguageSettingsService.js');
		await LanguageSettingsService.getInstance().update({ defaultProfileId: PROFILE_DEFAULT });

		const usage = await profileService.countProfileUsage(PROFILE_DEFAULT);
		expect(usage.isInstanceDefault).toBe(true);
	});
});

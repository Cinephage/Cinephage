import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb } from '../../../test/db-helper.js';
import { eq } from 'drizzle-orm';
import { episodes, seasons, series } from '#lib/server/db/schema.js';
import type { EpisodeGroup, EpisodeGroupSummary } from '#lib/types/tmdb.js';

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

const tmdbMock = vi.hoisted(() => ({
	getEpisodeGroups: vi.fn(),
	getEpisodeGroup: vi.fn(),
	getSeason: vi.fn()
}));
vi.mock('#lib/server/tmdb.js', () => ({ tmdb: tmdbMock }));

const { buildDefaultOrderingPlan, persistEpisodePlan, resolveEpisodeGroupPlan } =
	await import('./series-episode-plan.js');

function makeSummary(overrides: Partial<EpisodeGroupSummary> = {}): EpisodeGroupSummary {
	return {
		id: 'abc123',
		name: 'Test Group',
		type: 1,
		description: 'A test episode group',
		episode_count: 12,
		group_count: 2,
		network: null,
		...overrides
	};
}

function makeGroupEpisode(
	overrides: Partial<{
		air_date: string;
		episode_number: number;
		id: number;
		name: string;
		order: number;
		season_number: number;
		show_id: number;
	}> = {}
) {
	return {
		air_date: '2020-01-01',
		episode_number: 1,
		id: 1001,
		name: 'Episode 1',
		order: 1,
		season_number: 1,
		show_id: 123,
		...overrides
	};
}

function makeGroup(overrides: Partial<EpisodeGroup> = {}): EpisodeGroup {
	return {
		id: 'abc123',
		name: 'Test Group',
		type: 1,
		description: 'A test episode group',
		episode_count: 12,
		group_count: 2,
		network: null,
		groups: [
			{
				name: 'Group A',
				locked: true,
				episodes: [
					makeGroupEpisode({ id: 1001, episode_number: 1, name: 'Ep 1' }),
					makeGroupEpisode({ id: 1002, episode_number: 2, name: 'Ep 2' })
				]
			},
			{
				name: 'Group B',
				locked: false,
				episodes: [
					makeGroupEpisode({ id: 2001, episode_number: 1, name: 'Ep 1B' }),
					makeGroupEpisode({ id: 2002, episode_number: 2, name: 'Ep 2B' })
				]
			}
		],
		...overrides
	};
}

async function seedSeries(id: string, tmdbId: number): Promise<void> {
	testDb.db
		.insert(series)
		.values({ id, tmdbId, title: 'Show', path: `Show ${id}` })
		.onConflictDoNothing()
		.run();
}

afterAll(() => {
	destroyTestDb(testDb);
});

describe('resolveEpisodeGroupPlan', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('keeps the current rows when the stored group cannot be fetched (stored-only)', async () => {
		tmdbMock.getEpisodeGroup.mockRejectedValue(new Error('TMDB 404'));

		const result = await resolveEpisodeGroupPlan({
			seriesId: 's1',
			tmdbId: 1,
			storedEpisodeGroupId: 'g1',
			selection: 'stored-only'
		});

		expect(result).toEqual({ kind: 'group-unavailable' });
		// No silent re-selection: the listing endpoint must never be consulted.
		expect(tmdbMock.getEpisodeGroups).not.toHaveBeenCalled();
	});

	it('falls back to default ordering when the stored group is empty (stored-only)', async () => {
		tmdbMock.getEpisodeGroup.mockResolvedValue(
			makeGroup({ groups: [{ name: 'Empty shell', locked: true, episodes: [] }] })
		);

		const result = await resolveEpisodeGroupPlan({
			seriesId: 's1',
			tmdbId: 1,
			storedEpisodeGroupId: 'g1',
			selection: 'stored-only'
		});

		expect(result).toEqual({ kind: 'default-ordering', fallbackReason: 'group-empty' });
	});

	it('stays on default ordering for a default-ordering series (stored-only)', async () => {
		const result = await resolveEpisodeGroupPlan({
			seriesId: 's1',
			tmdbId: 1,
			storedEpisodeGroupId: null,
			selection: 'stored-only'
		});

		expect(result).toEqual({ kind: 'default-ordering' });
		expect(tmdbMock.getEpisodeGroups).not.toHaveBeenCalled();
	});

	it('returns the stored plan when the group resolves with usable data', async () => {
		tmdbMock.getEpisodeGroup.mockResolvedValue(makeGroup());

		const result = await resolveEpisodeGroupPlan({
			seriesId: 's1',
			tmdbId: 1,
			storedEpisodeGroupId: 'g1',
			selection: 'stored-only'
		});

		expect(result).toEqual({
			kind: 'episode-group',
			groupId: 'g1',
			plan: expect.objectContaining({
				seasons: expect.any(Array),
				episodes: expect.any(Array)
			})
		});
	});

	it('auto-selects a populated group over an empty higher-priority one (add)', async () => {
		tmdbMock.getEpisodeGroups.mockResolvedValue({
			results: [
				makeSummary({ id: 'empty-t1', type: 1, episode_count: 0 }),
				makeSummary({ id: 'full-t4', type: 4, episode_count: 500 })
			]
		});
		tmdbMock.getEpisodeGroup.mockResolvedValue(makeGroup({ id: 'full-t4' }));

		const result = await resolveEpisodeGroupPlan({
			seriesId: 's1',
			tmdbId: 1,
			storedEpisodeGroupId: null,
			selection: 'auto'
		});

		expect(result).toMatchObject({ kind: 'episode-group', groupId: 'full-t4' });
	});

	it('falls back to default ordering when nothing suitable exists (add)', async () => {
		tmdbMock.getEpisodeGroups.mockResolvedValue({ results: [] });

		const result = await resolveEpisodeGroupPlan({
			seriesId: 's1',
			tmdbId: 1,
			storedEpisodeGroupId: null,
			selection: 'auto'
		});

		expect(result).toEqual({ kind: 'default-ordering', fallbackReason: 'no-suitable-group' });
	});

	it('re-selects when the stored group vanished mid-add (auto)', async () => {
		tmdbMock.getEpisodeGroup.mockRejectedValue(new Error('TMDB 404'));
		tmdbMock.getEpisodeGroups.mockResolvedValue({ results: [] });

		const result = await resolveEpisodeGroupPlan({
			seriesId: 's1',
			tmdbId: 1,
			storedEpisodeGroupId: 'dead-group',
			selection: 'auto'
		});

		expect(result).toEqual({ kind: 'default-ordering', fallbackReason: 'no-suitable-group' });
	});
});

describe('buildDefaultOrderingPlan', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('creates failed seasons as rows and reports them instead of failing silently', async () => {
		tmdbMock.getSeason.mockImplementation((_tvId: number, seasonNumber: number) =>
			seasonNumber === 1
				? Promise.resolve({
						episodes: [
							{
								id: 10,
								season_number: 1,
								episode_number: 1,
								name: 'Pilot',
								overview: '',
								air_date: '2020-01-01',
								runtime: 42
							}
						]
					})
				: Promise.reject(new Error('TMDB down'))
		);

		const { plan, failedSeasonNumbers } = await buildDefaultOrderingPlan({
			seriesId: 's1',
			seasonsSummary: [
				{ season_number: 1, name: 'Season 1', episode_count: 1 },
				{ season_number: 2, name: 'Season 2', episode_count: 5 }
			],
			fetchSeason: (seasonNumber) => tmdbMock.getSeason(1, seasonNumber),
			assignSeasonMonitored: (_seasonNumber, isSpecials) => !isSpecials,
			assignEpisodeMonitored: ({ seasonMonitored }) => seasonMonitored
		});

		expect(failedSeasonNumbers).toEqual([2]);
		expect(plan.seasons.map((s) => s.seasonNumber)).toEqual([1, 2]);
		expect(plan.episodes).toHaveLength(1);
		expect(plan.episodes[0]).toMatchObject({ seasonNumber: 1, episodeNumber: 1, title: 'Pilot' });
	});
});

describe('persistEpisodePlan', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		await seedSeries('s1', 101);
	});

	it('wipes and rebuilds atomically, linking episodes to seasons', async () => {
		// Pre-existing rows that must disappear with the wipe.
		testDb.db
			.insert(seasons)
			.values({ seriesId: 's1', seasonNumber: 9, name: 'Old', monitored: false, episodeCount: 0 })
			.run();

		persistEpisodePlan(
			's1',
			{
				seasons: [
					{
						seriesId: 's1',
						seasonNumber: 1,
						name: 'Season 1',
						monitored: true,
						episodeCount: 1,
						episodeFileCount: 0
					}
				],
				episodes: [
					{
						seriesId: 's1',
						seasonNumber: 1,
						episodeNumber: 1,
						title: 'Pilot',
						monitored: true,
						hasFile: false
					}
				]
			},
			{ wipe: true }
		);

		const seasonRows = testDb.db.select().from(seasons).where(eq(seasons.seriesId, 's1')).all();
		expect(seasonRows.map((s) => s.seasonNumber)).toEqual([1]);

		const episodeRows = testDb.db.select().from(episodes).where(eq(episodes.seriesId, 's1')).all();
		expect(episodeRows).toHaveLength(1);
		expect(episodeRows[0]).toMatchObject({ seasonNumber: 1, episodeNumber: 1, title: 'Pilot' });
		expect(episodeRows[0].seasonId).toBe(seasonRows[0].id);
	});

	it('survives duplicate keys inside one plan via onConflictDoNothing', async () => {
		await seedSeries('s2', 102);
		persistEpisodePlan(
			's2',
			{
				seasons: [
					{
						seriesId: 's2',
						seasonNumber: 0,
						name: 'Specials',
						monitored: false,
						episodeCount: 2,
						episodeFileCount: 0
					}
				],
				episodes: [
					{
						seriesId: 's2',
						seasonNumber: 0,
						episodeNumber: 1,
						title: 'First',
						monitored: false,
						hasFile: false
					},
					{
						seriesId: 's2',
						seasonNumber: 0,
						episodeNumber: 1,
						title: 'Duplicate key',
						monitored: false,
						hasFile: false
					}
				]
			},
			{ wipe: true }
		);

		const episodeRows = testDb.db.select().from(episodes).where(eq(episodes.seriesId, 's2')).all();
		expect(episodeRows).toHaveLength(1);
		expect(episodeRows[0].title).toBe('First');
	});
});

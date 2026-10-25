import { describe, it, expect } from 'vitest';
import {
	autoSelectEpisodeGroup,
	buildSeasonsAndEpisodesFromGroup,
	buildEpisodeGroupInfoList
} from './EpisodeGroupService';
import type { EpisodeGroup, EpisodeGroupSummary, EpisodeGroupsResponse } from '#lib/types/tmdb.js';

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

function makeEpisode(
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

function makeEpisodeGroup(overrides: Partial<EpisodeGroup> = {}): EpisodeGroup {
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
					makeEpisode({ id: 1001, episode_number: 1, name: 'Ep 1' }),
					makeEpisode({ id: 1002, episode_number: 2, name: 'Ep 2' })
				]
			},
			{
				name: 'Group B',
				locked: false,
				episodes: [
					makeEpisode({ id: 2001, episode_number: 1, name: 'Ep 1B' }),
					makeEpisode({ id: 2002, episode_number: 2, name: 'Ep 2B' })
				]
			}
		],
		...overrides
	};
}

describe('autoSelectEpisodeGroup', () => {
	it('should return null for empty groups', () => {
		expect(autoSelectEpisodeGroup([])).toBeNull();
	});

	it('should select type 1 (TVDB Order) over type 2 and 4', () => {
		const groups = [
			makeSummary({ id: 'g1', type: 4, episode_count: 50 }),
			makeSummary({ id: 'g2', type: 1, episode_count: 20 }),
			makeSummary({ id: 'g3', type: 2, episode_count: 30 })
		];

		const result = autoSelectEpisodeGroup(groups);
		expect(result).not.toBeNull();
		expect(result!.id).toBe('g2');
		expect(result!.type).toBe(1);
	});

	it('should select type 2 (Seasons) when no type 1 exists', () => {
		const groups = [
			makeSummary({ id: 'g1', type: 4, episode_count: 50 }),
			makeSummary({ id: 'g2', type: 2, episode_count: 30 })
		];

		const result = autoSelectEpisodeGroup(groups);
		expect(result).not.toBeNull();
		expect(result!.type).toBe(2);
	});

	it('should select type 4 (Streaming) when no type 1 or 2 exists', () => {
		const groups = [makeSummary({ id: 'g1', type: 4, episode_count: 50 })];

		const result = autoSelectEpisodeGroup(groups);
		expect(result).not.toBeNull();
		expect(result!.type).toBe(4);
	});

	it('should return null when no priority types available', () => {
		const groups = [makeSummary({ id: 'g1', type: 3 }), makeSummary({ id: 'g2', type: 5 })];

		expect(autoSelectEpisodeGroup(groups)).toBeNull();
	});

	it('should select group with highest episode_count among same-type candidates', () => {
		const groups = [
			makeSummary({ id: 'small', type: 1, episode_count: 10 }),
			makeSummary({ id: 'large', type: 1, episode_count: 100 }),
			makeSummary({ id: 'medium', type: 1, episode_count: 50 })
		];

		const result = autoSelectEpisodeGroup(groups);
		expect(result).not.toBeNull();
		expect(result!.id).toBe('large');
	});
});

describe('buildSeasonsAndEpisodesFromGroup', () => {
	it('should assign sequential season numbers to main groups', () => {
		const group = makeEpisodeGroup({
			groups: [
				{
					name: 'Arc 1',
					locked: true,
					episodes: [makeEpisode({ id: 1, season_number: 1 })]
				},
				{
					name: 'Arc 2',
					locked: false,
					episodes: [makeEpisode({ id: 2, season_number: 1 })]
				}
			]
		});

		const result = buildSeasonsAndEpisodesFromGroup('series-1', group);

		expect(result.seasonValues).toHaveLength(2);
		expect(result.seasonValues[0].seasonNumber).toBe(1);
		expect(result.seasonValues[0].name).toBe('Arc 1');
		expect(result.seasonValues[1].seasonNumber).toBe(2);
		expect(result.seasonValues[1].name).toBe('Arc 2');
	});

	it('should assign sequential episode numbers within each season', () => {
		const group = makeEpisodeGroup({
			groups: [
				{
					name: 'Season',
					locked: true,
					episodes: [
						makeEpisode({ id: 1, episode_number: 5, name: 'Fifth' }),
						makeEpisode({ id: 2, episode_number: 10, name: 'Tenth' })
					]
				}
			]
		});

		const result = buildSeasonsAndEpisodesFromGroup('series-1', group);

		expect(result.episodeValues).toHaveLength(2);
		expect(result.episodeValues[0].episodeNumber).toBe(1);
		expect(result.episodeValues[0].title).toBe('Fifth');
		expect(result.episodeValues[1].episodeNumber).toBe(2);
		expect(result.episodeValues[1].title).toBe('Tenth');
	});

	it('should treat groups with season_number 0 as specials', () => {
		const group = makeEpisodeGroup({
			groups: [
				{
					name: 'Main Season',
					locked: true,
					episodes: [makeEpisode({ id: 1, season_number: 1, name: 'Main Ep' })]
				},
				{
					name: 'OVAs',
					locked: false,
					episodes: [makeEpisode({ id: 2, season_number: 0, name: 'OVA Ep' })]
				}
			]
		});

		const result = buildSeasonsAndEpisodesFromGroup('series-1', group);

		expect(result.seasonValues).toHaveLength(2);
		expect(result.seasonValues[0].seasonNumber).toBe(1);
		expect(result.seasonValues[1].seasonNumber).toBe(0);

		expect(result.episodeValues[0].seasonNumber).toBe(1);
		expect(result.episodeValues[0].monitored).toBe(true);
		expect(result.episodeValues[1].seasonNumber).toBe(0);
		expect(result.episodeValues[1].monitored).toBe(false);
	});

	it('should use group name as season name, fallback to Season N', () => {
		const group = makeEpisodeGroup({
			groups: [
				{
					name: 'Named Arc',
					locked: true,
					episodes: [makeEpisode({ id: 1 })]
				},
				{
					name: '',
					locked: false,
					episodes: [makeEpisode({ id: 2 })]
				}
			]
		});

		const result = buildSeasonsAndEpisodesFromGroup('series-1', group);

		expect(result.seasonValues[0].name).toBe('Named Arc');
		expect(result.seasonValues[1].name).toBe('Season 2');
	});

	it('should set seriesId on all seasons and episodes', () => {
		const group = makeEpisodeGroup();
		const result = buildSeasonsAndEpisodesFromGroup('my-series', group);

		expect(result.seasonValues[0].seriesId).toBe('my-series');
		expect(result.episodeValues[0].seriesId).toBe('my-series');
	});

	it('should preserve tmdbId on episodes', () => {
		const group = makeEpisodeGroup({
			groups: [
				{
					name: 'Season',
					locked: true,
					episodes: [makeEpisode({ id: 9999 })]
				}
			]
		});

		const result = buildSeasonsAndEpisodesFromGroup('series-1', group);

		expect(result.episodeValues[0].tmdbId).toBe(9999);
	});

	it('should handle empty episode names', () => {
		const group = makeEpisodeGroup({
			groups: [
				{
					name: 'Season',
					locked: true,
					episodes: [makeEpisode({ id: 1, name: '' })]
				}
			]
		});

		const result = buildSeasonsAndEpisodesFromGroup('series-1', group);

		expect(result.episodeValues[0].title).toBe('');
	});

	it('should skip groups with zero episodes', () => {
		const group = makeEpisodeGroup({
			groups: [
				{
					name: 'Empty Group',
					locked: true,
					episodes: []
				},
				{
					name: 'Real Group',
					locked: true,
					episodes: [makeEpisode({ id: 1 })]
				}
			]
		});

		const result = buildSeasonsAndEpisodesFromGroup('series-1', group);

		expect(result.seasonValues).toHaveLength(1);
		expect(result.seasonValues[0].name).toBe('Real Group');
	});

	it('should treat multiple specials groups as one Season 0', () => {
		const group = makeEpisodeGroup({
			groups: [
				{
					name: 'OVAs',
					locked: false,
					episodes: [makeEpisode({ id: 1, season_number: 0, episode_number: 1 })]
				},
				{
					name: 'Specials',
					locked: false,
					episodes: [makeEpisode({ id: 2, season_number: 0, episode_number: 3 })]
				}
			]
		});

		const result = buildSeasonsAndEpisodesFromGroup('series-1', group);

		expect(result.seasonValues).toHaveLength(1);
		expect(result.seasonValues[0].seasonNumber).toBe(0);
		expect(result.seasonValues[0].name).toBe('Specials');
		expect(result.episodeValues).toHaveLength(2);
		expect(result.episodeValues[0].episodeNumber).toBe(1);
		expect(result.episodeValues[1].episodeNumber).toBe(3);
	});
});

describe('buildEpisodeGroupInfoList', () => {
	function makeResponse(id: number, summaries: EpisodeGroupSummary[]): EpisodeGroupsResponse {
		return { id, results: summaries };
	}

	it('should map groups to EpisodeGroupInfo', () => {
		const groups = [
			makeSummary({
				id: 'g1',
				name: 'TVDB Order',
				type: 1,
				group_count: 4,
				episode_count: 100,
				description: 'Official'
			}),
			makeSummary({
				id: 'g2',
				name: 'Seasons',
				type: 2,
				group_count: 2,
				episode_count: 50,
				description: 'Default'
			})
		];
		const response = makeResponse(12345, groups);

		const result = buildEpisodeGroupInfoList(response, 'g1');

		expect(result).toHaveLength(2);
		expect(result[0].selected).toBe(true);
		expect(result[0].name).toBe('TVDB Order');
		expect(result[0].type).toBe(1);
		expect(result[0].groupCount).toBe(4);
		expect(result[0].episodeCount).toBe(100);
		expect(result[1].selected).toBe(false);
	});

	it('should mark no groups as selected when selectedGroupId is null', () => {
		const groups = [makeSummary({ id: 'g1', name: 'TVDB Order', type: 1 })];
		const response = makeResponse(12345, groups);

		const result = buildEpisodeGroupInfoList(response, null);

		expect(result).toHaveLength(1);
		expect(result[0].selected).toBe(false);
	});

	it('should return empty array when no groups exist', () => {
		const response = makeResponse(12345, []);

		expect(buildEpisodeGroupInfoList(response, null)).toEqual([]);
	});
});

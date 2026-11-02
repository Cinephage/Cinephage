import { describe, expect, it } from 'vitest';
import { getMediaParseStem } from './media-utils';
import {
	extractSeasonFromPath,
	matchEpisodesByIdentifier,
	resolveTvEpisodeIdentifier
} from './tv-episode-resolver';

describe('tv-episode-resolver', () => {
	it('extracts season numbers from season folder paths', () => {
		expect(extractSeasonFromPath('/media/Series/Show/Season 01/Show - 018.mkv')).toBe(1);
		expect(extractSeasonFromPath('/media/Series/Show/S2/Show - 018.mkv')).toBe(2);
	});

	it('normalizes compound streaming file extensions before parsing', () => {
		expect(getMediaParseStem('/media/Series/Show/Season 01/Show - 003.mkv.strm')).toBe(
			'Show - 003'
		);
	});

	it('maps trailing episode numbers within a season folder to standard numbering', () => {
		const result = resolveTvEpisodeIdentifier({
			filePath: '/media/Series/Aggressive Retsuko/Season 01/[Horse] Aggressive Retsuko - 018.mkv',
			seriesType: 'standard'
		});

		expect(result).toEqual({
			numbering: 'standard',
			seasonNumber: 1,
			episodeNumbers: [18]
		});
	});

	it('keeps trailing episode numbers as absolute numbering for anime series', () => {
		const result = resolveTvEpisodeIdentifier({
			filePath: '/media/Anime/Show/Season 01/[SubsPlease] Example Show - 018.mkv',
			seriesType: 'anime'
		});

		expect(result).toEqual({
			numbering: 'absolute',
			absoluteEpisode: 18
		});
	});

	it('matches episodes by standard, daily, and absolute identifiers', () => {
		const episodes = [
			{
				seasonNumber: 1,
				episodeNumber: 18,
				absoluteEpisodeNumber: 18,
				airDate: '2016-04-02'
			},
			{
				seasonNumber: 1,
				episodeNumber: 19,
				absoluteEpisodeNumber: 19,
				airDate: '2016-04-09'
			}
		];

		expect(
			matchEpisodesByIdentifier(episodes, {
				numbering: 'standard',
				seasonNumber: 1,
				episodeNumbers: [18]
			})
		).toHaveLength(1);
		expect(
			matchEpisodesByIdentifier(episodes, {
				numbering: 'daily',
				airDate: '2016-04-09'
			})[0].episodeNumber
		).toBe(19);
		expect(
			matchEpisodesByIdentifier(episodes, {
				numbering: 'absolute',
				absoluteEpisode: 18
			})[0].episodeNumber
		).toBe(18);
	});

	it('maps absolute numbers onto the single regular season when absolute metadata is absent (Cosmos shape)', () => {
		// Live TMDB 1430: season 0 has 14 specials (incl. E99), season 1 has
		// E01-E13. "Episode 13 - <title>" parses as absolute 13.
		const episodes = [
			{ seasonNumber: 0, episodeNumber: 1, absoluteEpisodeNumber: null, airDate: '1989-04-18' },
			{ seasonNumber: 0, episodeNumber: 99, absoluteEpisodeNumber: null, airDate: null },
			...Array.from({ length: 13 }, (_, i) => ({
				seasonNumber: 1,
				episodeNumber: i + 1,
				absoluteEpisodeNumber: null,
				airDate: `1980-${String((i % 12) + 1).padStart(2, '0')}-01`
			}))
		];

		const matches = matchEpisodesByIdentifier(episodes, {
			numbering: 'absolute',
			absoluteEpisode: 13
		});

		expect(matches).toHaveLength(1);
		expect(matches[0].seasonNumber).toBe(1);
		expect(matches[0].episodeNumber).toBe(13);
	});

	it('does not map absolute numbers for series with multiple regular seasons', () => {
		const episodes = [
			{ seasonNumber: 0, episodeNumber: 1, absoluteEpisodeNumber: null, airDate: null },
			{ seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, airDate: '1997-04-01' },
			{ seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: null, airDate: '1998-04-01' }
		];

		expect(
			matchEpisodesByIdentifier(episodes, { numbering: 'absolute', absoluteEpisode: 30 })
		).toHaveLength(0);
	});
});

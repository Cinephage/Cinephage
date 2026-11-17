import { describe, expect, it } from 'vitest';
import { parseEpisodeMarker } from './episode-marker';

describe('parseEpisodeMarker', () => {
	it('reads standard, multi-episode and range markers', () => {
		expect(parseEpisodeMarker('Show.S01E07.480p.x265')).toEqual({
			numbering: 'standard',
			seasonNumber: 1,
			episodeNumbers: [7]
		});
		expect(parseEpisodeMarker('Show - 1x07 - Recap')).toEqual({
			numbering: 'standard',
			seasonNumber: 1,
			episodeNumbers: [7]
		});
		expect(parseEpisodeMarker('Show S02E07E08 1080p')).toEqual({
			numbering: 'standard',
			seasonNumber: 2,
			episodeNumbers: [7, 8]
		});
		expect(parseEpisodeMarker('Show.S01E03-E05.1080p')).toEqual({
			numbering: 'standard',
			seasonNumber: 1,
			episodeNumbers: [3, 4, 5]
		});
	});

	it('reads daily dates, separated and compact', () => {
		for (const name of ['Show.2026.11.17.720p', 'Show 2026-11-17 720p', 'Show.20261117.720p']) {
			expect(parseEpisodeMarker(name), name).toEqual({
				numbering: 'daily',
				airDate: '2026-11-17'
			});
		}
	});

	it('reads absolute numbers, which carry no season', () => {
		expect(parseEpisodeMarker('[SubsPlease] Show - 05 [1080p]')).toEqual({
			numbering: 'absolute',
			absoluteEpisode: 5
		});
		expect(parseEpisodeMarker('Show - 105 (1080p) [ABCD1234]')).toEqual({
			numbering: 'absolute',
			absoluteEpisode: 105
		});
	});

	it('reads the episode of a file whose name also carries pack wording', () => {
		expect(parseEpisodeMarker('Show.Complete.Series.S03E04.1080p')).toEqual({
			numbering: 'standard',
			seasonNumber: 3,
			episodeNumbers: [4]
		});
	});

	it('reports no episode for a name that has none', () => {
		for (const name of [
			'Some.Movie.2020.1080p',
			'Concert.2020.1080p',
			'Show.S01.1080p',
			'Show.S01E01-S08E99'
		]) {
			expect(parseEpisodeMarker(name), name).toBeNull();
		}
	});
});

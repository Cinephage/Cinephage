import { describe, expect, it } from 'vitest';
import { NamingService } from '#lib/server/library/naming/NamingService.js';
import { LibraryDestinationPlanner } from './LibraryDestinationPlanner';

describe('LibraryDestinationPlanner', () => {
	it('applies anime numbering', async () => {
		const plan = await new LibraryDestinationPlanner(new NamingService()).planEpisode({
			rootPath: '/library',
			mediaPath: 'One Piece',
			media: {
				title: 'One Piece',
				year: 1999,
				tvdbId: 81797,
				seriesType: 'anime'
			},
			seasonNumber: 2,
			episodeNumbers: [62],
			episodeTitle: 'The Strongest of Luffy`s Rivals?',
			absoluteNumber: 62,
			useSeasonFolders: false,
			sourcePath: '/tmp/[SubsPlease] One Piece - 062.mkv',
			releaseTitle: '[SubsPlease] One Piece - 062 [1080p]'
		});

		expect(plan.fileName).toContain('S02E62');
		expect(plan.fileName).toContain('062');
	});

	it('applies daily numbering', async () => {
		const plan = await new LibraryDestinationPlanner(new NamingService()).planEpisode({
			rootPath: '/library',
			mediaPath: 'The Daily Show',
			media: {
				title: 'The Daily Show',
				year: 1996,
				tvdbId: 71256,
				seriesType: 'daily'
			},
			seasonNumber: 29,
			episodeNumbers: [15],
			episodeTitle: 'January 15, 2024',
			airDate: '2024-01-15',
			useSeasonFolders: false,
			sourcePath: '/tmp/the.daily.show.2024.01.15.mkv',
			releaseTitle: 'The.Daily.Show.2024.01.15.1080p.WEB.h264'
		});

		expect(plan.fileName).toContain('2024-01-15');
		expect(plan.fileName).not.toContain('S29E15');
	});

	it('uses configured season folders only when enabled', async () => {
		const planner = new LibraryDestinationPlanner(
			new NamingService({ seasonFolderFormat: 'Series {Season}' })
		);
		const input = {
			rootPath: '/library',
			mediaPath: 'Show',
			media: { title: 'Show', seriesType: 'standard' },
			seasonNumber: 3,
			episodeNumbers: [3],
			sourcePath: '/tmp/Show.S03E03.mkv',
			releaseTitle: 'Show.S03E03.1080p.WEB.h264'
		};

		expect((await planner.planEpisode({ ...input, useSeasonFolders: true })).relativePath).toMatch(
			/^Series 3\//
		);
		expect(
			(await planner.planEpisode({ ...input, useSeasonFolders: false })).relativePath
		).not.toContain('/');
	});
});

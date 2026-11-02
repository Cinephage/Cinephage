import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { parseRelease } from '#lib/server/indexers/parser/ReleaseParser.js';
import {
	manualImportService,
	type ManualImportDetectionGroup,
	type ManualImportMatch
} from './manual-import-service.js';
import { NamingService, type MediaNamingInfo } from './naming/NamingService.js';

describe('ManualImportService naming', () => {
	it('preserves explicit season and episode overrides when parsed release lacks S/E markers', () => {
		const parsed = parseRelease('[Horse] Aggressive Retsuko - 003');
		const namingInfoBase: MediaNamingInfo = {
			title: 'Aggressive Retsuko',
			year: 2016,
			tmdbId: 70956,
			seasonNumber: 1,
			episodeNumbers: [3],
			episodeTitle: 'Shachiku no Uta'
		};

		// @ts-expect-error accessing private method for testing
		const namingInfo = manualImportService.enrichNamingInfo(
			namingInfoBase,
			parsed,
			'/tmp/[Horse] Aggressive Retsuko - 003.mkv.strm',
			null
		) as MediaNamingInfo;

		expect(namingInfo.seasonNumber).toBe(1);
		expect(namingInfo.episodeNumbers).toEqual([3]);
		expect(namingInfo.episodeTitle).toBe('Shachiku no Uta');

		const fileName = new NamingService().generateEpisodeFileName(namingInfo);
		expect(fileName).toContain('S01E03');
	});

	it('builds episode destination paths from the active naming service', () => {
		const service = manualImportService as unknown as {
			buildEpisodeDestinationPath: (
				rootFolderPath: string,
				seriesFolderName: string,
				useSeasonFolders: boolean,
				seasonNumber: number,
				namingInfo: MediaNamingInfo,
				sourceExtension: string
			) => string;
			namingService: Pick<NamingService, 'generateEpisodeFileName' | 'generateSeasonFolderName'>;
		};

		service.namingService = {
			generateEpisodeFileName: () => 'Episode 05.custom.mkv',
			generateSeasonFolderName: () => 'Collection 02'
		} as Pick<NamingService, 'generateEpisodeFileName' | 'generateSeasonFolderName'>;

		expect(
			service.buildEpisodeDestinationPath(
				'/library/tv',
				'Show Name',
				true,
				2,
				{ title: 'Show Name', seasonNumber: 2, episodeNumbers: [5] },
				'.mkv'
			)
		).toBe(join('/library/tv', 'Show Name', 'Collection 02', 'Episode 05.custom.mkv'));

		expect(
			service.buildEpisodeDestinationPath(
				'/library/tv',
				'Show Name',
				false,
				2,
				{ title: 'Show Name', seasonNumber: 2, episodeNumbers: [5] },
				'.mkv'
			)
		).toBe(join('/library/tv', 'Show Name', 'Episode 05.custom.mkv'));
	});

	it('derives match title candidates from folder structure for obfuscated file names', () => {
		const service = manualImportService as unknown as {
			buildTitleCandidatesForMatching: (input: {
				parsedTitle: string;
				groupPath: string;
				selectedFilePath: string;
				sourceRootPath: string;
			}) => string[];
		};

		const sourceRootPath = '/mnt/nzbdav/completed-downloads/tv';
		const selectedFilePath =
			'/mnt/nzbdav/completed-downloads/tv/The.Night.Agent.S03.HDR.2160p.WEB.h265-ETHEL/vCBKbT9IZNFBA52z2Zhw9ZntP9LsDxHY.mkv.strm';

		const candidates = service.buildTitleCandidatesForMatching({
			parsedTitle: 'vCBKbT9IZNFBA52z2Zhw9ZntP9LsDxHY',
			groupPath: selectedFilePath,
			selectedFilePath,
			sourceRootPath
		});

		expect(candidates.length).toBeGreaterThan(0);
		expect(candidates.some((candidate) => /night\s+agent/i.test(candidate))).toBe(true);
	});

	it('applies consensus match across grouped TV items', () => {
		const service = manualImportService as unknown as {
			applySeriesConsensusMatches: (groups: ManualImportDetectionGroup[]) => void;
		};

		const matchA: ManualImportMatch = {
			tmdbId: 100,
			title: 'Wrong Show',
			year: 2023,
			confidence: 0.88,
			mediaType: 'tv',
			inLibrary: false
		};
		const matchB: ManualImportMatch = {
			tmdbId: 200,
			title: 'Correct Show',
			year: 2023,
			confidence: 0.91,
			mediaType: 'tv',
			inLibrary: false
		};

		const buildGroup = (
			id: string,
			sourcePath: string,
			matches: ManualImportMatch[]
		): ManualImportDetectionGroup =>
			({
				id,
				displayName: id,
				sourceType: 'file',
				sourcePath,
				selectedFilePath: sourcePath,
				fileName: sourcePath.split('/').pop(),
				detectedFileCount: 1,
				parsedTitle: 'Correct Show',
				inferredMediaType: 'tv',
				matches
			}) as ManualImportDetectionGroup;

		const groups: ManualImportDetectionGroup[] = [
			buildGroup(
				'/imports/Correct.Show/Season 03/ep1.mkv',
				'/imports/Correct.Show/Season 03/ep1.mkv',
				[matchA, matchB]
			),
			buildGroup(
				'/imports/Correct.Show/Season 03/ep2.mkv',
				'/imports/Correct.Show/Season 03/ep2.mkv',
				[matchB, matchA]
			),
			buildGroup(
				'/imports/Correct.Show/Season 03/ep3.mkv',
				'/imports/Correct.Show/Season 03/ep3.mkv',
				[matchB]
			)
		];

		service.applySeriesConsensusMatches(groups);

		expect(groups[0].matches[0]?.tmdbId).toBe(200);
		expect(groups[1].matches[0]?.tmdbId).toBe(200);
		expect(groups[2].matches[0]?.tmdbId).toBe(200);
	});
});

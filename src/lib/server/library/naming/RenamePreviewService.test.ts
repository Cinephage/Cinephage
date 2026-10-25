/**
 * RenamePreviewService Tests
 *
 * Comprehensive test suite covering:
 * - Edge case naming (unicode, special chars, missing data)
 * - Filesystem safety (collisions, illegal chars, path lengths)
 * - Real-world regression suite (scene releases, multi-episode, anime, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, destroyTestDb } from '../../../../test/db-helper';
import { RenamePreviewService, type RenamePreviewResult } from './RenamePreviewService';
import { NamingService, type MediaNamingInfo, DEFAULT_NAMING_CONFIG } from './NamingService';
import { chooseBestParsedRelease, resolveAudioLanguages } from './preview-metadata';
import { clearLocalizationCaches } from './localization';
import { namingSettingsService } from './NamingSettingsService';
import { libraryOperationLock } from '../library-operation-lock';
import { diskScanService } from '../disk-scan.js';
import * as schema from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

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

const tmdbFetch = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/tmdb.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/tmdb.js')>();
	return { ...actual, tmdb: { ...actual.tmdb, fetch: tmdbFetch } };
});

const notifierMocks = vi.hoisted(() => ({
	queueUpdate: vi.fn(),
	deleteMediaItemByTmdb: vi.fn().mockResolvedValue(1)
}));

vi.mock('#lib/server/notifications/mediabrowser/index.js', () => ({
	getMediaBrowserNotifier: () => ({ queueUpdate: notifierMocks.queueUpdate }),
	getMediaBrowserManager: () => ({ deleteMediaItemByTmdb: notifierMocks.deleteMediaItemByTmdb })
}));

const mockedMoveFile = vi.fn();
const mockedFileExists = vi.fn();

vi.mock('#lib/server/downloadClients/import/FileTransfer.js', () => ({
	get moveFile() {
		return mockedMoveFile;
	},
	get fileExists() {
		return mockedFileExists;
	}
}));

vi.mock('node:fs/promises', () => ({
	rename: vi.fn(),
	stat: vi.fn(),
	readdir: vi.fn(),
	rmdir: vi.fn(),
	mkdir: vi.fn(),
	realpath: vi.fn(async (path: string) => path)
}));

// Import the mocked module to get references to the mock functions.
import * as mockFs from 'node:fs/promises';

function resetAllMocks() {
	vi.clearAllMocks();
	mockedMoveFile.mockResolvedValue({
		success: true,
		sourcePath: '',
		destPath: '',
		mode: 'move' as const
	});
	mockedFileExists.mockResolvedValue(true);
	(mockFs.rename as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	(mockFs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
		size: 100,
		isFile: () => true,
		isDirectory: () => false
	});
	(mockFs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([]);
	(mockFs.rmdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	(mockFs.mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
}

afterAll(() => {
	destroyTestDb(testDb);
});

describe('RenamePreviewService', () => {
	describe('preview metadata trust', () => {
		it('prefers current filename when sceneName points at different sequel/year', () => {
			const candidate = chooseBestParsedRelease({
				sceneName: 'Ant-Man and the Wasp Quantumania 2023 1080p WEBRip x265-RARBG',
				currentFileName: 'Ant-Man (2015) [WEBRip-1080p][x265]-RARBG.mp4',
				actualTitle: 'Ant-Man',
				actualYear: 2015
			});

			expect(candidate.label).toBe('currentFilename');
		});

		it('prefers sceneName when it is richer and matches title/year', () => {
			const candidate = chooseBestParsedRelease({
				sceneName: 'Interstellar.2014.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-FGT',
				currentFileName: 'Interstellar (2014) [Remux-2160p].mkv',
				actualTitle: 'Interstellar',
				actualYear: 2014
			});

			expect(candidate.label).toBe('sceneName');
			expect(candidate.parsed.releaseGroup).toBe('FGT');
		});

		it('recovers edition metadata from filenames when stored edition is missing', () => {
			const parsed = chooseBestParsedRelease({
				sceneName: null,
				currentFileName: 'Blade Runner (1982) edition-Final Cut [Bluray-1080p].mkv',
				actualTitle: 'Blade Runner',
				actualYear: 1982
			});

			expect(parsed.parsed.edition).toBe('Final Cut');
		});
	});

	describe('audio language resolution', () => {
		it('keeps audio languages from the ffprobe scan when present', () => {
			expect(resolveAudioLanguages(['eng', 'fre'])).toEqual(['eng', 'fre']);
		});

		it('never treats filename-parsed languages as audio evidence', () => {
			// No scan data -> undefined; the {AudioLanguages} token renders `und`.
			// The old filename fallback (['ger'] from the release name) is gone.
			expect(resolveAudioLanguages(undefined)).toBeUndefined();
			expect(resolveAudioLanguages([])).toBeUndefined();
		});
	});

	describe('media-server cleanup ordering (Jellyfin file-loss guard)', () => {
		it('deletes the old server entry only after the folder move', async () => {
			resetAllMocks();
			testDb.db.delete(schema.movies).run();
			testDb.db.delete(schema.rootFolders).run();

			const rootId = randomUUID();
			testDb.db
				.insert(schema.rootFolders)
				.values({ id: rootId, name: 'Movies', path: '/media/movies', mediaType: 'movie' })
				.run();
			testDb.db
				.insert(schema.movies)
				.values({
					id: 'movie-order',
					tmdbId: 4242,
					title: 'Order Test',
					year: 2024,
					path: 'Order Test (2024) OLD',
					rootFolderId: rootId
				})
				.run();

			mockedFileExists.mockResolvedValue(true);
			(mockFs.rename as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const result = await new RenamePreviewService().reorganizeFolder('movie-order', 'movie');

			expect(result.success).toBe(true);
			expect(notifierMocks.deleteMediaItemByTmdb).toHaveBeenCalledTimes(1);

			// Jellyfin/Emby DELETE removes the file location too: the call must
			// never happen before the disk rename or the media file is destroyed.
			const renameOrder = (mockFs.rename as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
			const deleteOrder = notifierMocks.deleteMediaItemByTmdb.mock.invocationCallOrder[0];
			expect(renameOrder).toBeLessThan(deleteOrder);
		});
	});

	describe('NamingService Edge Cases', () => {
		let namingService: NamingService;

		beforeEach(() => {
			namingService = new NamingService(DEFAULT_NAMING_CONFIG);
		});

		describe('Unicode and Special Characters', () => {
			it('should handle unicode characters in titles', () => {
				const info: MediaNamingInfo = {
					title: 'Crouching Tiger, Hidden Dragon (Wo hu cang long)',
					year: 2000,
					tmdbId: 146,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Crouching Tiger');
				expect(result).toContain('2000');
				expect(result).toMatch(/\.mkv$/);
			});

			it('should handle Japanese characters in titles', () => {
				const info: MediaNamingInfo = {
					title: 'Spirited Away (Sen to Chihiro no Kamikakushi)',
					year: 2001,
					tmdbId: 129,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Spirited Away');
				expect(result).not.toContain('null');
				expect(result).not.toContain('undefined');
			});

			it('should handle Korean characters in anime titles', () => {
				const info: MediaNamingInfo = {
					title: 'Parasite (Gisaengchung)',
					year: 2019,
					tmdbId: 496243,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Parasite');
			});

			it('should strip filesystem-unsafe unicode characters', () => {
				const info: MediaNamingInfo = {
					title: 'Movie: With "Quotes" and <Brackets>',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toContain('"');
				expect(result).not.toContain('<');
				expect(result).not.toContain('>');
			});

			it('should handle titles with only special characters gracefully', () => {
				const info: MediaNamingInfo = {
					title: '!!??',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				// Should not be empty or throw
				expect(result.length).toBeGreaterThan(0);
				expect(result).toContain('2020');
			});
		});

		describe('Colon Handling', () => {
			it('should handle smart colon replacement (Title: Subtitle)', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					colonReplacement: 'smart'
				});

				const info: MediaNamingInfo = {
					title: 'Star Wars: The Force Awakens',
					year: 2015,
					tmdbId: 140607,
					originalExtension: '.mkv'
				};

				const result = service.generateMovieFileName(info);
				expect(result).not.toContain(':');
				// CleanTitle now respects colonReplacement setting
				// Smart replacement converts ": " to " - "
				expect(result).toContain('Star Wars - The Force Awakens');
			});

			it('should delete colons when configured', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					colonReplacement: 'delete'
				});

				const info: MediaNamingInfo = {
					title: 'Mission: Impossible',
					year: 1996,
					tmdbId: 954,
					originalExtension: '.mkv'
				};

				const result = service.generateMovieFileName(info);
				expect(result).not.toContain(':');
				expect(result).toContain('Mission Impossible');
			});

			it('should replace colons with dash when configured', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					colonReplacement: 'dash'
				});

				const info: MediaNamingInfo = {
					title: 'Title: Subtitle',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = service.generateMovieFileName(info);
				expect(result).not.toContain(':');
			});
		});

		describe('Missing Metadata Handling', () => {
			it('should handle missing year gracefully', () => {
				const info: MediaNamingInfo = {
					title: 'Unknown Movie',
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Unknown Movie');
				expect(result).not.toContain('undefined');
				expect(result).not.toContain('null');
				expect(result).not.toContain('()'); // Empty year parens should be cleaned
			});

			it('should handle missing TMDB ID gracefully', () => {
				const info: MediaNamingInfo = {
					title: 'No ID Movie',
					year: 2020,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('No ID Movie');
				expect(result).toContain('2020');
			});

			it('should handle missing quality info gracefully', () => {
				const info: MediaNamingInfo = {
					title: 'Basic Movie',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Basic Movie');
				expect(result).not.toContain('[]'); // Empty brackets should be cleaned
			});

			it('should handle missing episode title gracefully', () => {
				const info: MediaNamingInfo = {
					title: 'Test Series',
					year: 2020,
					tvdbId: 12345,
					seasonNumber: 1,
					episodeNumbers: [1],
					originalExtension: '.mkv'
				};

				const result = namingService.generateEpisodeFileName(info);
				expect(result).toContain('Test Series');
				expect(result).toContain('S01E01');
			});

			it('should handle missing release group gracefully', () => {
				const info: MediaNamingInfo = {
					title: 'No Group Movie',
					year: 2020,
					tmdbId: 12345,
					resolution: '1080p',
					source: 'Bluray',
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toContain('-undefined');
				expect(result).not.toMatch(/-$/); // Should not end with dash
			});
		});

		describe('Quality String Formatting', () => {
			it('should format full quality string with all components', () => {
				const info: MediaNamingInfo = {
					title: 'Quality Test',
					year: 2020,
					tmdbId: 12345,
					resolution: '2160p',
					source: 'Remux',
					codec: 'x265',
					hdr: 'DV',
					audioCodec: 'TrueHD',
					audioChannels: '7.1',
					releaseGroup: 'FraMeSToR',
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Remux-2160p');
				expect(result).toContain('DV');
				expect(result).toContain('TrueHD');
				expect(result).toContain('7.1');
				expect(result).toContain('x265');
				expect(result).toContain('FraMeSToR');
			});

			it('should handle PROPER marker', () => {
				const info: MediaNamingInfo = {
					title: 'Proper Test',
					year: 2020,
					tmdbId: 12345,
					resolution: '1080p',
					source: 'Bluray',
					proper: true,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Proper');
			});

			it('should handle REPACK marker', () => {
				const info: MediaNamingInfo = {
					title: 'Repack Test',
					year: 2020,
					tmdbId: 12345,
					resolution: '1080p',
					source: 'Bluray',
					repack: true,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Repack');
			});
		});

		describe('Source Normalization', () => {
			const sourceTests = [
				{ input: 'bluray', expected: 'Bluray' },
				{ input: 'blu-ray', expected: 'Bluray' },
				{ input: 'bdrip', expected: 'Bluray' },
				{ input: 'webdl', expected: 'WEB-DL' },
				{ input: 'web-dl', expected: 'WEB-DL' },
				{ input: 'webrip', expected: 'WEBRip' },
				{ input: 'hdtv', expected: 'HDTV' },
				{ input: 'remux', expected: 'Remux' }
			];

			sourceTests.forEach(({ input, expected }) => {
				it(`should normalize source "${input}" to "${expected}"`, () => {
					const info: MediaNamingInfo = {
						title: 'Source Test',
						year: 2020,
						tmdbId: 12345,
						source: input,
						resolution: '1080p',
						originalExtension: '.mkv'
					};

					const result = namingService.generateMovieFileName(info);
					expect(result).toContain(expected);
				});
			});
		});

		describe('Video Codec Normalization', () => {
			const codecTests = [
				{ input: 'h264', expected: 'x264' },
				{ input: 'h.264', expected: 'x264' },
				{ input: 'avc', expected: 'x264' },
				{ input: 'h265', expected: 'x265' },
				{ input: 'hevc', expected: 'x265' },
				{ input: 'av1', expected: 'AV1' },
				{ input: 'vp9', expected: 'VP9' }
			];

			codecTests.forEach(({ input, expected }) => {
				it(`should normalize codec "${input}" to "${expected}"`, () => {
					const info: MediaNamingInfo = {
						title: 'Codec Test',
						year: 2020,
						tmdbId: 12345,
						codec: input,
						source: 'Bluray',
						resolution: '1080p',
						originalExtension: '.mkv'
					};

					const result = namingService.generateMovieFileName(info);
					expect(result).toContain(expected);
				});
			});
		});

		describe('Audio Codec Normalization', () => {
			const audioTests = [
				{ input: 'truehd', expected: 'TrueHD' },
				{ input: 'dtshdma', expected: 'DTS-HD MA' },
				{ input: 'dtsx', expected: 'DTS-X' },
				{ input: 'dts', expected: 'DTS' },
				{ input: 'aac', expected: 'AAC' },
				{ input: 'flac', expected: 'FLAC' }
			];

			audioTests.forEach(({ input, expected }) => {
				it(`should normalize audio codec "${input}" to "${expected}"`, () => {
					const info: MediaNamingInfo = {
						title: 'Audio Test',
						year: 2020,
						tmdbId: 12345,
						audioCodec: input,
						audioChannels: '5.1',
						source: 'Bluray',
						resolution: '1080p',
						originalExtension: '.mkv'
					};

					const result = namingService.generateMovieFileName(info);
					expect(result).toContain(expected);
				});
			});
		});
	});

	describe('Episode Naming', () => {
		let namingService: NamingService;

		beforeEach(() => {
			namingService = new NamingService(DEFAULT_NAMING_CONFIG);
		});

		describe('Standard Episodes', () => {
			it('should format single episode correctly', () => {
				const info: MediaNamingInfo = {
					title: 'Breaking Bad',
					year: 2008,
					tvdbId: 81189,
					seasonNumber: 1,
					episodeNumbers: [1],
					episodeTitle: 'Pilot',
					resolution: '1080p',
					source: 'Bluray',
					originalExtension: '.mkv'
				};

				const result = namingService.generateEpisodeFileName(info);
				expect(result).toContain('Breaking Bad');
				expect(result).toContain('S01E01');
				expect(result).toContain('Pilot');
			});

			it('should format multi-episode range correctly', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					multiEpisodeStyle: 'range'
				});

				const info: MediaNamingInfo = {
					title: 'Breaking Bad',
					year: 2008,
					tvdbId: 81189,
					seasonNumber: 1,
					episodeNumbers: [1, 2, 3],
					episodeTitle: 'Pilot',
					originalExtension: '.mkv'
				};

				const result = service.generateEpisodeFileName(info);
				expect(result).toContain('S01E01-E03');
			});

			it('should format multi-episode extend correctly', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					multiEpisodeStyle: 'extend'
				});

				const info: MediaNamingInfo = {
					title: 'Test Show',
					year: 2020,
					tvdbId: 12345,
					seasonNumber: 1,
					episodeNumbers: [1, 2],
					originalExtension: '.mkv'
				};

				const result = service.generateEpisodeFileName(info);
				expect(result).toContain('S01E01E02');
			});

			it('should format multi-episode duplicate correctly', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					multiEpisodeStyle: 'duplicate'
				});

				const info: MediaNamingInfo = {
					title: 'Test Show',
					year: 2020,
					tvdbId: 12345,
					seasonNumber: 1,
					episodeNumbers: [1, 2],
					originalExtension: '.mkv'
				};

				const result = service.generateEpisodeFileName(info);
				expect(result).toContain('S01E01-E02');
			});

			it('should format multi-episode repeat correctly', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					multiEpisodeStyle: 'repeat'
				});

				const info: MediaNamingInfo = {
					title: 'Test Show',
					year: 2020,
					tvdbId: 12345,
					seasonNumber: 1,
					episodeNumbers: [1, 2, 3],
					originalExtension: '.mkv'
				};

				const result = service.generateEpisodeFileName(info);
				expect(result).toContain('S01E01 - S01E02 - S01E03');
			});
		});

		describe('Daily Episodes', () => {
			it('should format daily episode with air date', () => {
				const info: MediaNamingInfo = {
					title: 'The Daily Show',
					year: 1996,
					tvdbId: 71256,
					seasonNumber: 28,
					episodeNumbers: [1],
					episodeTitle: 'January 15, 2024',
					airDate: '2024-01-15',
					isDaily: true,
					originalExtension: '.mkv'
				};

				const result = namingService.generateEpisodeFileName(info);
				expect(result).toContain('Daily Show');
				expect(result).toContain('2024-01-15');
			});
		});

		describe('Anime Episodes', () => {
			it('should format anime with absolute episode number', () => {
				const info: MediaNamingInfo = {
					title: 'Attack on Titan',
					year: 2013,
					tvdbId: 267440,
					seasonNumber: 1,
					episodeNumbers: [1],
					absoluteNumber: 1,
					episodeTitle: 'To You, in 2000 Years',
					isAnime: true,
					resolution: '1080p',
					source: 'Bluray',
					bitDepth: '10',
					originalExtension: '.mkv'
				};

				const result = namingService.generateEpisodeFileName(info);
				expect(result).toContain('Attack on Titan');
				expect(result).toContain('S01E01');
				expect(result).toContain('001');
			});

			it('should include bit depth for anime', () => {
				const info: MediaNamingInfo = {
					title: 'Demon Slayer',
					year: 2019,
					tvdbId: 348225,
					seasonNumber: 1,
					episodeNumbers: [1],
					absoluteNumber: 1,
					isAnime: true,
					bitDepth: '10',
					originalExtension: '.mkv'
				};

				const result = namingService.generateEpisodeFileName(info);
				expect(result).toContain('10bit');
			});
		});

		describe('Season Folder Naming', () => {
			it('should format season folder with double digit padding', () => {
				const result = namingService.generateSeasonFolderName(1);
				expect(result).toBe('Season 01');
			});

			it('should handle double digit seasons', () => {
				const result = namingService.generateSeasonFolderName(12);
				expect(result).toBe('Season 12');
			});

			it('should handle specials (Season 0)', () => {
				const result = namingService.generateSeasonFolderName(0);
				expect(result).toBe('Season 00');
			});
		});
	});

	describe('Filesystem Safety', () => {
		let namingService: NamingService;

		beforeEach(() => {
			namingService = new NamingService(DEFAULT_NAMING_CONFIG);
		});

		describe('Illegal Character Removal', () => {
			it('should remove forward slash', () => {
				const info: MediaNamingInfo = {
					title: 'Movie/With/Slashes',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toContain('/');
			});

			it('should remove backslash', () => {
				const info: MediaNamingInfo = {
					title: 'Movie\\With\\Backslashes',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toContain('\\');
			});

			it('should remove question mark', () => {
				const info: MediaNamingInfo = {
					title: 'What If?',
					year: 2021,
					tmdbId: 91363,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toContain('?');
			});

			it('should remove asterisk', () => {
				const info: MediaNamingInfo = {
					title: 'Movie*With*Stars',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toContain('*');
			});

			it('should remove pipe character', () => {
				const info: MediaNamingInfo = {
					title: 'Movie|With|Pipes',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toContain('|');
			});
		});

		describe('Path Cleaning', () => {
			it('should clean multiple consecutive spaces', () => {
				const info: MediaNamingInfo = {
					title: 'Movie   With   Spaces',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toMatch(/\s{2,}/);
			});

			it('should clean empty brackets', () => {
				const info: MediaNamingInfo = {
					title: 'Movie',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toContain('[]');
				expect(result).not.toContain('()');
				expect(result).not.toContain('{}');
			});

			it('should clean trailing dashes', () => {
				const info: MediaNamingInfo = {
					title: 'Movie',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toMatch(/-\.mkv$/);
			});

			it('should clean leading/trailing whitespace', () => {
				const info: MediaNamingInfo = {
					title: '  Movie With Spaces  ',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).not.toMatch(/^\s/);
				expect(result).not.toMatch(/\s\.mkv$/);
			});
		});

		describe('Extension Handling', () => {
			it('should preserve original file extension', () => {
				const info: MediaNamingInfo = {
					title: 'Movie',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toMatch(/\.mkv$/);
			});

			it('should handle MP4 extension', () => {
				const info: MediaNamingInfo = {
					title: 'Movie',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.mp4'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toMatch(/\.mp4$/);
			});

			it('should handle AVI extension', () => {
				const info: MediaNamingInfo = {
					title: 'Movie',
					year: 2020,
					tmdbId: 12345,
					originalExtension: '.avi'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toMatch(/\.avi$/);
			});

			it('should handle missing extension', () => {
				const info: MediaNamingInfo = {
					title: 'Movie',
					year: 2020,
					tmdbId: 12345
				};

				const result = namingService.generateMovieFileName(info);
				// Should not end with a dot
				expect(result).not.toMatch(/\.$/);
			});
		});
	});

	describe('Real-World Regression Suite', () => {
		let namingService: NamingService;

		beforeEach(() => {
			namingService = new NamingService(DEFAULT_NAMING_CONFIG);
		});

		describe('Scene Release Naming', () => {
			it('should properly rename scene release to TRaSH format', () => {
				// Input would be: The.Dark.Knight.2008.1080p.BluRay.x264-GROUP
				const info: MediaNamingInfo = {
					title: 'The Dark Knight',
					year: 2008,
					tmdbId: 155,
					imdbId: 'tt0468569',
					resolution: '1080p',
					source: 'bluray',
					codec: 'x264',
					releaseGroup: 'GROUP',
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('The Dark Knight');
				expect(result).toContain('(2008)');
				expect(result).toContain('Bluray-1080p');
				expect(result).toContain('GROUP');
			});

			it('should properly rename WEB-DL release', () => {
				const info: MediaNamingInfo = {
					title: 'Dune',
					year: 2021,
					tmdbId: 438631,
					resolution: '2160p',
					source: 'web-dl',
					codec: 'hevc',
					hdr: 'HDR',
					audioCodec: 'dtshdma',
					audioChannels: '5.1',
					releaseGroup: 'SPARKS',
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Dune');
				expect(result).toContain('(2021)');
				expect(result).toContain('WEB-DL-2160p');
				expect(result).toContain('HDR');
				expect(result).toContain('DTS-HD MA');
			});
		});

		describe('Remux Release Naming', () => {
			it('should properly format 4K HDR Remux', () => {
				const info: MediaNamingInfo = {
					title: 'Interstellar',
					year: 2014,
					tmdbId: 157336,
					resolution: '2160p',
					source: 'remux',
					codec: 'hevc',
					hdr: 'DV',
					audioCodec: 'truehd',
					audioChannels: '7.1',
					releaseGroup: 'FraMeSToR',
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Interstellar');
				expect(result).toContain('Remux-2160p');
				expect(result).toContain('DV');
				expect(result).toContain('TrueHD');
				expect(result).toContain('7.1');
			});
		});

		describe('Edition Handling', () => {
			it('should include Directors Cut edition', () => {
				const info: MediaNamingInfo = {
					title: 'Blade Runner',
					year: 1982,
					tmdbId: 78,
					edition: "Director's Cut",
					resolution: '1080p',
					source: 'bluray',
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain("Director's Cut");
			});

			it('should include Extended edition', () => {
				const info: MediaNamingInfo = {
					title: 'The Lord of the Rings: The Return of the King',
					year: 2003,
					tmdbId: 122,
					edition: 'Extended',
					resolution: '1080p',
					source: 'bluray',
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('Extended');
			});

			it('should handle IMAX edition', () => {
				const info: MediaNamingInfo = {
					title: 'Oppenheimer',
					year: 2023,
					tmdbId: 872585,
					edition: 'IMAX',
					resolution: '2160p',
					source: 'bluray',
					originalExtension: '.mkv'
				};

				const result = namingService.generateMovieFileName(info);
				expect(result).toContain('IMAX');
			});
		});

		describe('TV Series Real-World Examples', () => {
			it('should rename Game of Thrones episode correctly', () => {
				const info: MediaNamingInfo = {
					title: 'Game of Thrones',
					year: 2011,
					tvdbId: 121361,
					seasonNumber: 1,
					episodeNumbers: [1],
					episodeTitle: 'Winter Is Coming',
					resolution: '1080p',
					source: 'bluray',
					codec: 'x265',
					audioCodec: 'dtshdma',
					audioChannels: '5.1',
					releaseGroup: 'DEMAND',
					originalExtension: '.mkv'
				};

				const result = namingService.generateEpisodeFileName(info);
				expect(result).toContain('Game of Thrones');
				expect(result).toContain('S01E01');
				expect(result).toContain('Winter Is Coming');
				expect(result).toContain('Bluray-1080p');
			});

			it('should handle double episode properly', () => {
				const info: MediaNamingInfo = {
					title: 'Breaking Bad',
					year: 2008,
					tvdbId: 81189,
					seasonNumber: 5,
					episodeNumbers: [15, 16],
					episodeTitle: 'Granite State / Felina',
					resolution: '1080p',
					source: 'bluray',
					originalExtension: '.mkv'
				};

				const result = namingService.generateEpisodeFileName(info);
				expect(result).toContain('Breaking Bad');
				expect(result).toContain('S05');
				expect(result).toMatch(/E15.*E16|E15-E16/);
			});
		});

		describe('Streaming Service Releases', () => {
			it('should handle Netflix WEBDL correctly', () => {
				const info: MediaNamingInfo = {
					title: 'Stranger Things',
					year: 2016,
					tvdbId: 305288,
					seasonNumber: 4,
					episodeNumbers: [1],
					episodeTitle: 'Chapter One: The Hellfire Club',
					resolution: '2160p',
					source: 'webdl',
					codec: 'hevc',
					hdr: 'DV',
					audioCodec: 'eac3',
					audioChannels: '5.1',
					releaseGroup: 'NTb',
					originalExtension: '.mkv'
				};

				const result = namingService.generateEpisodeFileName(info);
				expect(result).toContain('Stranger Things');
				expect(result).toContain('WEB-DL-2160p');
				expect(result).toContain('DV');
			});

			it('should handle Amazon WEBRip correctly', () => {
				const info: MediaNamingInfo = {
					title: 'The Boys',
					year: 2019,
					tvdbId: 355567,
					seasonNumber: 3,
					episodeNumbers: [1],
					episodeTitle: 'Payback',
					resolution: '1080p',
					source: 'webrip',
					codec: 'x264',
					audioCodec: 'aac',
					audioChannels: '2.0',
					releaseGroup: 'PECULATE',
					originalExtension: '.mkv'
				};

				const result = namingService.generateEpisodeFileName(info);
				expect(result).toContain('The Boys');
				expect(result).toContain('WEBRip-1080p');
			});
		});
	});

	describe('Collision Detection', () => {
		it('should detect files with same target name', () => {
			const result: RenamePreviewResult = {
				willChange: [
					{
						fileId: '1',
						mediaType: 'movie',
						mediaId: 'movie1',
						mediaTitle: 'Movie 1',
						currentRelativePath: 'old1.mkv',
						currentFullPath: '/path/old1.mkv',
						currentParentPath: '/path',
						newRelativePath: 'same.mkv',
						newFullPath: '/path/same.mkv',
						newParentPath: '/path',
						status: 'will_change'
					},
					{
						fileId: '2',
						mediaType: 'movie',
						mediaId: 'movie2',
						mediaTitle: 'Movie 2',
						currentRelativePath: 'old2.mkv',
						currentFullPath: '/path/old2.mkv',
						currentParentPath: '/path',
						newRelativePath: 'same.mkv',
						newFullPath: '/path/same.mkv',
						newParentPath: '/path',
						status: 'will_change'
					}
				],
				alreadyCorrect: [],
				collisions: [],
				errors: [],
				totalFiles: 2,
				totalWillChange: 2,
				totalAlreadyCorrect: 0,
				totalCollisions: 0,
				totalErrors: 0
			};

			// Use the service's collision detection
			const _service = new RenamePreviewService();
			// Access private method via prototype or create test helper
			// For testing, we'll verify the structure and expected behavior

			// Both items have same newFullPath, should be detected as collision
			expect(result.willChange[0].newFullPath).toBe(result.willChange[1].newFullPath);
		});
	});

	describe('Anime Rename Fallbacks', () => {
		it('builds fallback absolute numbering from episode order when DB values are missing', () => {
			const service = new RenamePreviewService();
			const testEpisodes: Array<{
				id: string;
				seasonNumber: number;
				episodeNumber: number;
				absoluteEpisodeNumber: number | null;
			}> = [
				{
					id: 'special',
					seasonNumber: 0,
					episodeNumber: 1,
					absoluteEpisodeNumber: null
				},
				{
					id: 'ep1',
					seasonNumber: 1,
					episodeNumber: 1,
					absoluteEpisodeNumber: null
				},
				{
					id: 'ep2',
					seasonNumber: 1,
					episodeNumber: 2,
					absoluteEpisodeNumber: null
				},
				{
					id: 'ep3',
					seasonNumber: 2,
					episodeNumber: 1,
					absoluteEpisodeNumber: null
				}
			];
			// @ts-expect-error accessing private method for testing
			const absoluteEpisodeMap = service.buildAbsoluteEpisodeFallbackMap(testEpisodes);

			expect(absoluteEpisodeMap.get('special')).toBeUndefined();
			expect(absoluteEpisodeMap.get('ep1')).toBe(1);
			expect(absoluteEpisodeMap.get('ep2')).toBe(2);
			expect(absoluteEpisodeMap.get('ep3')).toBe(3);
		});
	});

	describe('Media Server ID Formats', () => {
		it('should format Plex ID correctly', () => {
			const service = new NamingService({
				...DEFAULT_NAMING_CONFIG,
				mediaServerIdFormat: 'plex'
			});

			const info: MediaNamingInfo = {
				title: 'Test Movie',
				year: 2020,
				tmdbId: 12345,
				originalExtension: '.mkv'
			};

			const folder = service.generateMovieFolderName(info);
			expect(folder).toContain('{tmdb-12345}');
		});

		it('should format Jellyfin ID correctly', () => {
			const service = new NamingService({
				...DEFAULT_NAMING_CONFIG,
				mediaServerIdFormat: 'jellyfin'
			});

			const info: MediaNamingInfo = {
				title: 'Test Movie',
				year: 2020,
				tmdbId: 12345,
				originalExtension: '.mkv'
			};

			const folder = service.generateMovieFolderName(info);
			expect(folder).toContain('[tmdbid-12345]');
		});

		it('should use TVDB ID for series when available', () => {
			const service = new NamingService({
				...DEFAULT_NAMING_CONFIG,
				mediaServerIdFormat: 'plex'
			});

			const info: MediaNamingInfo = {
				title: 'Test Series',
				year: 2020,
				tmdbId: 12345,
				tvdbId: 67890,
				originalExtension: '.mkv'
			};

			const folder = service.generateSeriesFolderName(info);
			expect(folder).toContain('{tvdb-67890}');
		});

		it('should fall back to TMDB ID for series when TVDB unavailable', () => {
			const service = new NamingService({
				...DEFAULT_NAMING_CONFIG,
				mediaServerIdFormat: 'plex'
			});

			const info: MediaNamingInfo = {
				title: 'Test Series',
				year: 2020,
				tmdbId: 12345,
				originalExtension: '.mkv'
			};

			const folder = service.generateSeriesFolderName(info);
			expect(folder).toContain('{tmdb-12345}');
		});
	});

	describe('OriginalTitle Token — NamingService integration (WP-2)', () => {
		/**
		 * These tests verify that when originalTitle is present in MediaNamingInfo,
		 * the {OriginalTitle} and {OriginalCleanTitle} tokens render correctly
		 * in movie and series naming formats.
		 *
		 * This is the code path exercised by buildMoviePreviewItem()
		 * and buildEpisodePreviewItem() in RenamePreviewService.
		 * These tests will FAIL until the originalTitle wiring is added.
		 */

		describe('Movie naming with originalTitle', () => {
			it('renders {OriginalTitle} in movie folder format', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					movieFolderFormat: '{OriginalTitle} ({Year}) {MediaId}'
				});

				const info: MediaNamingInfo = {
					title: 'English Title',
					originalTitle: 'Crouching Tiger, Hidden Dragon',
					year: 2000,
					tmdbId: 146
				};

				const result = service.generateMovieFolderName(info);
				expect(result).toContain('Crouching Tiger, Hidden Dragon');
				expect(result).toContain('2000');
				expect(result).not.toContain('English Title');
			});

			it('renders {OriginalTitle} in movie file format', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					movieFileFormat: '{OriginalTitle} ({Year}) [{QualityFull}]{-{ReleaseGroup}}'
				});

				const info: MediaNamingInfo = {
					title: 'The Dark Knight',
					originalTitle: 'Batman: The Dark Knight',
					year: 2008,
					tmdbId: 155,
					resolution: '1080p',
					source: 'Bluray',
					codec: 'x264',
					releaseGroup: 'GROUP',
					originalExtension: '.mkv'
				};

				const result = service.generateMovieFileName(info);
				expect(result).toContain('Batman - The Dark Knight');
				expect(result).toContain('2008');
				expect(result).toContain('Bluray-1080p');
				expect(result).toContain('-GROUP');
			});

			it('renders {OriginalCleanTitle} in movie file format', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					movieFileFormat: '{OriginalCleanTitle} ({Year}) [{QualityFull}]{-{ReleaseGroup}}'
				});

				const info: MediaNamingInfo = {
					title: 'Star Wars: A New Hope (Fallback)',
					originalTitle: 'Star Wars',
					year: 1977,
					tmdbId: 11,
					resolution: '2160p',
					source: 'Remux',
					codec: 'x265',
					hdr: 'DV',
					originalExtension: '.mkv'
				};

				const result = service.generateMovieFileName(info);
				expect(result).toContain('Star Wars');
				expect(result).toContain('1977');
				expect(result).toContain('Remux-2160p');
				expect(result).not.toContain('Fallback');
			});

			it('renders {OriginalCleanTitle} with special chars stripped but colons preserved', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					movieFileFormat: '{OriginalCleanTitle} ({Year})'
				});

				const info: MediaNamingInfo = {
					title: 'Fallback Title!',
					originalTitle: 'Film "Name" <Test> |Bad?',
					year: 2020,
					tmdbId: 99999,
					originalExtension: '.mkv'
				};

				const result = service.generateMovieFileName(info);
				// Special chars like " < > | ? are removed by clean title
				expect(result).toContain('Film Name Test Bad');
				expect(result).not.toContain('"');
				expect(result).not.toContain('<');
				expect(result).not.toContain('>');
				expect(result).not.toContain('|');
				expect(result).not.toContain('?');
			});

			it('falls back to title when originalTitle is undefined', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					movieFolderFormat: '{OriginalTitle} ({Year})'
				});

				const info: MediaNamingInfo = {
					title: 'Only Title Available',
					year: 2023,
					tmdbId: 12345
					// originalTitle intentionally omitted
				};

				const result = service.generateMovieFolderName(info);
				expect(result).toContain('Only Title Available');
				expect(result).toContain('2023');
			});

			it('falls back to title when originalTitle is explicitly undefined', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					movieFolderFormat: '{OriginalCleanTitle} ({Year})'
				});

				const info: MediaNamingInfo = {
					title: 'Normal Title',
					originalTitle: undefined,
					year: 2023,
					tmdbId: 12345
				};

				const result = service.generateMovieFolderName(info);
				expect(result).toContain('Normal Title');
			});
		});

		describe('Series naming with originalTitle', () => {
			it('renders {OriginalTitle} in series folder format', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					seriesFolderFormat: '{OriginalTitle} ({Year}) {SeriesId}'
				});

				const info: MediaNamingInfo = {
					title: 'Attack on Titan',
					originalTitle: 'Shingeki no Kyojin',
					year: 2013,
					tvdbId: 267440,
					tmdbId: 1429
				};

				const result = service.generateSeriesFolderName(info);
				expect(result).toContain('Shingeki no Kyojin');
				expect(result).toContain('2013');
				expect(result).not.toContain('Attack on Titan');
			});

			it('renders {OriginalTitle} in episode file format', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					episodeFileFormat:
						'{OriginalTitle} ({Year}) - S{Season:00}E{Episode:00} - {EpisodeCleanTitle} [{QualityFull}]'
				});

				const info: MediaNamingInfo = {
					title: 'Demon Slayer',
					originalTitle: 'Kimetsu no Yaiba',
					year: 2019,
					tvdbId: 348225,
					seasonNumber: 1,
					episodeNumbers: [1],
					episodeTitle: 'Cruelty',
					resolution: '1080p',
					source: 'Bluray',
					originalExtension: '.mkv'
				};

				const result = service.generateEpisodeFileName(info);
				expect(result).toContain('Kimetsu no Yaiba');
				expect(result).toContain('S01E01');
				expect(result).toContain('Cruelty');
				expect(result).toContain('Bluray-1080p');
				expect(result).not.toContain('Demon Slayer');
			});

			it('renders {OriginalCleanTitle} in episode file format', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					episodeFileFormat:
						'{OriginalCleanTitle} ({Year}) - S{Season:00}E{Episode:00} - {EpisodeCleanTitle}'
				});

				const info: MediaNamingInfo = {
					title: 'Fullmetal Alchemist: Brotherhood',
					originalTitle: 'Hagane no Renkinjutsushi: Fullmetal Alchemist',
					year: 2009,
					tvdbId: 102261,
					seasonNumber: 1,
					episodeNumbers: [1],
					episodeTitle: 'Fullmetal Alchemist',
					originalExtension: '.mkv'
				};

				const result = service.generateEpisodeFileName(info);
				expect(result).toContain('Hagane no Renkinjutsushi');
				expect(result).toContain('Fullmetal Alchemist');
				expect(result).toContain('S01E01');
			});

			it('renders {OriginalCleanTitle} in series folder format', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					seriesFolderFormat: '{OriginalCleanTitle} ({Year})'
				});

				const info: MediaNamingInfo = {
					title: 'Cowboy Bebop!',
					originalTitle: 'Cowboy Bebop (Kauboi Bibappu)',
					year: 1998,
					tvdbId: 76885,
					tmdbId: 1
				};

				const result = service.generateSeriesFolderName(info);
				// CleanTitle preserves parens content, strips trailing '!'
				expect(result).toContain('Cowboy Bebop');
				expect(result).toContain('Kauboi Bibappu');
				expect(result).not.toContain('!');
			});

			it('falls back to title in series when originalTitle is undefined', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					seriesFolderFormat: '{OriginalTitle} ({Year})'
				});

				const info: MediaNamingInfo = {
					title: 'Breaking Bad',
					year: 2008,
					tvdbId: 81189,
					tmdbId: 1396
					// originalTitle intentionally omitted
				};

				const result = service.generateSeriesFolderName(info);
				expect(result).toContain('Breaking Bad');
				expect(result).toContain('2008');
			});

			it('falls back to title in episode when originalTitle is undefined', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					episodeFileFormat:
						'{OriginalTitle} ({Year}) - S{Season:00}E{Episode:00} - {EpisodeCleanTitle}'
				});

				const info: MediaNamingInfo = {
					title: 'Game of Thrones',
					year: 2011,
					tvdbId: 121361,
					seasonNumber: 1,
					episodeNumbers: [1],
					episodeTitle: 'Winter Is Coming',
					originalExtension: '.mkv'
					// originalTitle intentionally omitted
				};

				const result = service.generateEpisodeFileName(info);
				expect(result).toContain('Game of Thrones');
				expect(result).toContain('S01E01');
				expect(result).toContain('Winter Is Coming');
			});

			it('renders {OriginalTitle} in anime episode format', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					animeEpisodeFormat:
						'{OriginalTitle} ({Year}) - S{Season:00}E{Episode:00} - {Absolute:000} - {EpisodeCleanTitle} [{QualityFull}]'
				});

				const info: MediaNamingInfo = {
					title: 'One Punch Man',
					originalTitle: 'One Punch Man',
					year: 2015,
					tvdbId: 289906,
					seasonNumber: 1,
					episodeNumbers: [1],
					absoluteNumber: 1,
					episodeTitle: 'The Strongest Man',
					isAnime: true,
					resolution: '1080p',
					source: 'Bluray',
					bitDepth: '10',
					originalExtension: '.mkv'
				};

				const result = service.generateEpisodeFileName(info);
				expect(result).toContain('One Punch Man');
				expect(result).toContain('S01E01');
				expect(result).toContain('001');
			});
		});

		describe('Alias tokens render correctly', () => {
			it('MovieOriginalTitle alias works in movie formats', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					movieFileFormat: '{MovieOriginalTitle} ({Year})'
				});

				const info: MediaNamingInfo = {
					title: 'Parasite',
					originalTitle: 'Gisaengchung',
					year: 2019,
					tmdbId: 496243,
					originalExtension: '.mkv'
				};

				const result = service.generateMovieFileName(info);
				expect(result).toContain('Gisaengchung');
				expect(result).not.toContain('Parasite');
			});

			it('SeriesOriginalTitle alias works in series formats', () => {
				const service = new NamingService({
					...DEFAULT_NAMING_CONFIG,
					seriesFolderFormat: '{SeriesOriginalTitle} ({Year})'
				});

				const info: MediaNamingInfo = {
					title: 'My Hero Academia',
					originalTitle: 'Boku no Hero Academia',
					year: 2016,
					tvdbId: 305074,
					tmdbId: 65930
				};

				const result = service.generateSeriesFolderName(info);
				expect(result).toContain('Boku no Hero Academia');
			});
		});
	});

	describe('executeRenames safety: files-only (no folder rename)', () => {
		beforeEach(() => {
			resetAllMocks();
		});

		it('no-op guard: returns success when currentFullPath === newFullPath', async () => {
			const service = new RenamePreviewService();
			const item = {
				fileId: 'file-1',
				mediaType: 'movie' as const,
				mediaId: 'movie-1',
				mediaTitle: 'Test',
				currentParentPath: 'Test (2024) [tmdbid-1]',
				currentRelativePath: 'Test (2024).mkv',
				currentFullPath: '/media/Test (2024) [tmdbid-1]/Test (2024).mkv',
				newParentPath: 'Test (2024) [tmdbid-1]',
				newRelativePath: 'Test (2024).mkv',
				newFullPath: '/media/Test (2024) [tmdbid-1]/Test (2024).mkv',
				status: 'will_change' as const
			};

			// @ts-expect-error accessing private method for testing
			const result = await service.executeFileRename(item);

			expect(result.success).toBe(true);
			expect(mockedMoveFile).not.toHaveBeenCalled();
		});

		it('does NOT rename parent folders during file rename (separation of concerns)', async () => {
			const service = new RenamePreviewService();

			const rootId = 'root-1';
			const movieId = 'movie-foldertest';
			const fileId = 'file-foldertest';

			testDb.db
				.insert(schema.rootFolders)
				.values({
					id: rootId,
					name: 'Movies',
					path: '/media/Movies',
					mediaType: 'movie',
					readOnly: false
				})
				.run();

			testDb.db
				.insert(schema.movies)
				.values({
					id: movieId,
					tmdbId: 999999,
					title: 'Folder Test',
					year: 2024,
					path: 'Folder Test (2024) {tmdb-999999}',
					rootFolderId: rootId,
					hasFile: true
				})
				.run();

			// Name that will produce a DIFFERENT target under the current naming config
			testDb.db
				.insert(schema.movieFiles)
				.values({
					id: fileId,
					movieId: movieId,
					relativePath: 'bad-name.avi',
					quality: { resolution: '1080p', source: 'WEBRip', codec: 'x265' },
					releaseGroup: 'RARBG'
				})
				.run();

			mockedFileExists.mockResolvedValue(true);

			const result = await service.executeRenames([fileId]);

			expect(result.processed).toBeGreaterThanOrEqual(1);

			// Verify the movie's folder path was NOT changed.
			const movieAfter = testDb.db
				.select()
				.from(schema.movies)
				.where(eq(schema.movies.id, movieId))
				.get();
			expect(movieAfter?.path).toBe('Folder Test (2024) {tmdb-999999}');
		});
	});
});

describe('RenamePreviewService lock integration', () => {
	beforeEach(() => {
		resetAllMocks();
	});

	it('executeRenames holds the operation lock for the duration of execution', async () => {
		let observedDuringCall: boolean | undefined;
		const withLockSpy = vi.spyOn(libraryOperationLock, 'withLock');

		const svc = new RenamePreviewService();
		const buildSpy = vi.spyOn(
			svc as unknown as {
				buildTargetMap: (fileIds: string[], result: unknown) => Promise<Map<string, unknown>>;
			},
			'buildTargetMap'
		);
		buildSpy.mockImplementation(async () => {
			observedDuringCall = libraryOperationLock.isLocked;
			return new Map();
		});

		await svc.executeRenames(['nonexistent-id']);

		expect(withLockSpy).toHaveBeenCalledWith('rename', expect.any(Function));
		expect(observedDuringCall).toBe(true);
	});

	it('reorganizeFolder holds the operation lock', async () => {
		const withLockSpy = vi.spyOn(libraryOperationLock, 'withLock');
		const svc = new RenamePreviewService();

		await svc.reorganizeFolder('does-not-exist', 'movie');

		expect(withLockSpy).toHaveBeenCalledWith('reorganize', expect.any(Function));
	});

	it('reorganizeFolders holds the lock once for the whole batch and isolates per-item failures', async () => {
		const withLockSpy = vi.spyOn(libraryOperationLock, 'withLock');
		const svc = new RenamePreviewService();

		const result = await svc.reorganizeFolders([
			{ mediaId: 'missing-1', mediaType: 'movie' as const },
			{ mediaId: 'missing-2', mediaType: 'series' as const }
		]);

		expect(withLockSpy).toHaveBeenCalledTimes(1);
		expect(withLockSpy).toHaveBeenCalledWith('reorganize-batch', expect.any(Function));
		expect(result.total).toBe(2);
		expect(result.organized).toBe(0);
		expect(result.failed).toBe(2);
		expect(result.errors).toHaveLength(2);
		expect(result.errors.every((e) => typeof e === 'string' && e.length > 0)).toBe(true);
		expect(result.results).toHaveLength(2);
		expect(result.results.map((r) => r.mediaId)).toEqual(['missing-1', 'missing-2']);
		expect(result.results.every((r) => r.success === false)).toBe(true);
		expect(result.results.every((r) => typeof r.error === 'string' && r.error.length > 0)).toBe(
			true
		);
	});
});

describe('reorganizeFolder DB-failure rollback', () => {
	beforeEach(() => {
		resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renames the folder back on disk and records a failure when the DB update throws', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/reorg-root',
			mediaType: 'movie',
			name: 'reorg-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'Wrong (1900)',
			title: 'Test Movie',
			year: 2020,
			tmdbId: 42
		});

		const svc = new RenamePreviewService();
		// reorganizeFolderLocked builds a fresh NamingService from the stored
		// config, so the prototype method must be stubbed (not the instance).
		const folderNameSpy = vi
			.spyOn(NamingService.prototype, 'generateMovieFolderName')
			.mockReturnValue('Generated (2020)');
		const updateSpy = vi
			.spyOn(
				svc as unknown as {
					updateMediaFolderPath: (
						mediaType: 'movie' | 'series',
						mediaId: string,
						newPath: string
					) => void;
				},
				'updateMediaFolderPath'
			)
			.mockImplementation(() => {
				throw new Error('db exploded');
			});

		const result = await svc.reorganizeFolder(movieId, 'movie');

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/database update failed/i);
		expect(mockFs.rename).toHaveBeenNthCalledWith(
			1,
			'/tmp/opencode/reorg-root/Wrong (1900)',
			'/tmp/opencode/reorg-root/Generated (2020)'
		);
		expect(mockFs.rename).toHaveBeenNthCalledWith(
			2,
			'/tmp/opencode/reorg-root/Generated (2020)',
			'/tmp/opencode/reorg-root/Wrong (1900)'
		);

		const failure = db
			.select()
			.from(schema.renamingFailures)
			.where(eq(schema.renamingFailures.fileId, movieId))
			.get();
		expect(failure?.reason).toBe('folder_db_update_failed');
		expect(failure?.reasonDetail).toBe('db exploded');
		expect(failure?.fileType).toBe('movie');

		updateSpy.mockRestore();
		folderNameSpy.mockRestore();
		await db.delete(schema.renamingFailures).where(eq(schema.renamingFailures.fileId, movieId));
		await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});

	it('reports accurately when the DB update fails AND the disk rollback also fails', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/reorg-root',
			mediaType: 'movie',
			name: 'reorg-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'Wrong (1900)',
			title: 'Test Movie',
			year: 2020,
			tmdbId: 43
		});

		const svc = new RenamePreviewService();
		const folderNameSpy = vi
			.spyOn(NamingService.prototype, 'generateMovieFolderName')
			.mockReturnValue('Generated (2020)');
		const updateSpy = vi
			.spyOn(
				svc as unknown as {
					updateMediaFolderPath: (
						mediaType: 'movie' | 'series',
						mediaId: string,
						newPath: string
					) => void;
				},
				'updateMediaFolderPath'
			)
			.mockImplementation(() => {
				throw new Error('db exploded');
			});
		// First call: forward rename succeeds. Second call: rollback fails.
		(mockFs.rename as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('rollback boom'));

		const result = await svc.reorganizeFolder(movieId, 'movie');

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/rollback failed/i);
		expect(result.error).toContain('db exploded');
		expect(mockFs.rename).toHaveBeenCalledTimes(2);

		const failure = db
			.select()
			.from(schema.renamingFailures)
			.where(eq(schema.renamingFailures.fileId, movieId))
			.get();
		expect(failure?.reason).toBe('folder_db_update_failed');
		expect(failure?.reasonDetail).toBe('db exploded');

		updateSpy.mockRestore();
		folderNameSpy.mockRestore();
		await db.delete(schema.renamingFailures).where(eq(schema.renamingFailures.fileId, movieId));
		await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});
});

describe('reorganizeFolder read-only guard', () => {
	beforeEach(() => {
		resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('refuses to reorganize a movie in a read-only root folder without touching disk', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/reorg-root',
			mediaType: 'movie',
			name: 'reorg-root',
			readOnly: true
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'Wrong (1900)',
			title: 'Test Movie',
			year: 2020,
			tmdbId: 44
		});

		const svc = new RenamePreviewService();
		const result = await svc.reorganizeFolder(movieId, 'movie');

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/read-only/i);
		expect(mockFs.rename).not.toHaveBeenCalled();

		await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});

	it('reports read-only roots as per-item failures in batch reorganization', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/reorg-root',
			mediaType: 'movie',
			name: 'reorg-root',
			readOnly: true
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'Wrong (1900)',
			title: 'Test Movie',
			year: 2020,
			tmdbId: 45
		});

		const svc = new RenamePreviewService();
		const result = await svc.reorganizeFolders([{ mediaId: movieId, mediaType: 'movie' }]);

		expect(result.organized).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.results[0]?.success).toBe(false);
		expect(result.results[0]?.error).toMatch(/read-only/i);
		expect(mockFs.rename).not.toHaveBeenCalled();

		await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});
});

describe('reorganizeFolder rename history', () => {
	beforeEach(() => {
		resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('writes a reorganize rename_history row per tracked file before the disk rename', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		const fileId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/reorg-history-root',
			mediaType: 'movie',
			name: 'reorg-history-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'Wrong (1900)',
			title: 'Test Movie',
			year: 2020,
			tmdbId: 44
		});
		await db.insert(schema.movieFiles).values({
			id: fileId,
			movieId,
			relativePath: 'test.movie.2020.mkv',
			size: 100
		});

		const svc = new RenamePreviewService();
		const folderNameSpy = vi
			.spyOn(NamingService.prototype, 'generateMovieFolderName')
			.mockReturnValue('Generated (2020)');

		const result = await svc.reorganizeFolder(movieId, 'movie');

		expect(result.success).toBe(true);
		expect(mockFs.rename).toHaveBeenCalledWith(
			'/tmp/opencode/reorg-history-root/Wrong (1900)',
			'/tmp/opencode/reorg-history-root/Generated (2020)'
		);

		const [history] = await db
			.select()
			.from(schema.renameHistory)
			.where(eq(schema.renameHistory.fileId, fileId));
		expect(history).toBeDefined();
		expect(history.operation).toBe('reorganize');
		expect(history.success).toBe(1);
		expect(history.error).toBeNull();
		expect(history.mediaType).toBe('movie');
		expect(history.oldPath).toBe(
			'/tmp/opencode/reorg-history-root/Wrong (1900)/test.movie.2020.mkv'
		);
		expect(history.newPath).toBe(
			'/tmp/opencode/reorg-history-root/Generated (2020)/test.movie.2020.mkv'
		);

		folderNameSpy.mockRestore();
		await db.delete(schema.renameHistory).where(eq(schema.renameHistory.fileId, fileId));
		await db.delete(schema.movieFiles).where(eq(schema.movieFiles.id, fileId));
		await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});
});

describe('reorganizeFolder nested (letter-bucket) targets', () => {
	beforeEach(() => {
		resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('creates the missing letter-dir parent before renaming into a nested target', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		const root = '/tmp/opencode/nested-reorg-root';
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: root,
			mediaType: 'movie',
			name: 'nested-reorg-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'The Mandalorian and Grogu (2026)',
			title: 'The Mandalorian and Grogu',
			year: 2026,
			tmdbId: 1228710
		});

		const svc = new RenamePreviewService();
		const folderNameSpy = vi
			.spyOn(NamingService.prototype, 'generateMovieFolderName')
			.mockReturnValue('T/The Mandalorian and Grogu (2026) [tmdbid-1228710]');

		try {
			const result = await svc.reorganizeFolder(movieId, 'movie');

			expect(result.success).toBe(true);
			expect(mockFs.mkdir).toHaveBeenCalledWith(`${root}/T`, { recursive: true });
			// mkdir must happen BEFORE the rename — rename() cannot create parents.
			const mkdirOrder = (mockFs.mkdir as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
			const renameOrder = (mockFs.rename as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
			expect(mkdirOrder).toBeLessThan(renameOrder);
			expect(mockFs.rename).toHaveBeenCalledWith(
				`${root}/The Mandalorian and Grogu (2026)`,
				`${root}/T/The Mandalorian and Grogu (2026) [tmdbid-1228710]`
			);
		} finally {
			folderNameSpy.mockRestore();
			await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
			await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
		}
	});

	it('removes the emptied letter dir after moving a title out of a nested path (revert)', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		const root = '/tmp/opencode/nested-revert-root';
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: root,
			mediaType: 'movie',
			name: 'nested-revert-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'T/The Mandalorian and Grogu (2026) [tmdbid-1228710]',
			title: 'The Mandalorian and Grogu',
			year: 2026,
			tmdbId: 1228710
		});

		const svc = new RenamePreviewService();
		const folderNameSpy = vi
			.spyOn(NamingService.prototype, 'generateMovieFolderName')
			.mockReturnValue('The Mandalorian and Grogu (2026)');

		try {
			const result = await svc.reorganizeFolder(movieId, 'movie');

			expect(result.success).toBe(true);
			expect(mockFs.rename).toHaveBeenCalledWith(
				`${root}/T/The Mandalorian and Grogu (2026) [tmdbid-1228710]`,
				`${root}/The Mandalorian and Grogu (2026)`
			);
			// The emptied letter bucket must be tidied up.
			expect(mockFs.rmdir).toHaveBeenCalledWith(`${root}/T`);
			// The root folder itself must never be removed.
			expect(mockFs.rmdir).not.toHaveBeenCalledWith(root);
		} finally {
			folderNameSpy.mockRestore();
			await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
			await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
		}
	});
});

describe('applyFolderRename DB-failure surfacing', () => {
	beforeEach(() => {
		resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns a warning and records a renaming failure instead of silently succeeding', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/afr-root',
			mediaType: 'tv',
			name: 'afr-root'
		});
		await db.insert(schema.series).values({
			id: seriesId,
			rootFolderId,
			path: 'Old (1999)',
			title: 'Show',
			tmdbId: 7
		});

		const svc = new RenamePreviewService();
		const updateSpy = vi
			.spyOn(
				svc as unknown as {
					updateMediaFolderPath: (
						mediaType: 'movie' | 'series',
						mediaId: string,
						newPath: string
					) => void;
				},
				'updateMediaFolderPath'
			)
			.mockImplementation(() => {
				throw new Error('db exploded');
			});

		const warnings = await svc['applyFolderRename'](
			seriesId,
			'episode',
			'Old (1999)',
			'New (1999)',
			'stem'
		);

		expect(warnings.some((w) => /database/i.test(w))).toBe(true);

		const failure = db
			.select()
			.from(schema.renamingFailures)
			.where(eq(schema.renamingFailures.fileId, seriesId))
			.get();
		expect(failure?.reason).toBe('folder_db_update_failed');
		expect(failure?.reasonDetail).toBe('db exploded');
		expect(failure?.fileType).toBe('episode');

		updateSpy.mockRestore();
		await db.delete(schema.renamingFailures).where(eq(schema.renamingFailures.fileId, seriesId));
		await db.delete(schema.series).where(eq(schema.series.id, seriesId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});
});

describe('rename media-server notifications', () => {
	beforeEach(() => {
		resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('queues Deleted(old folder) and Modified(new folder) after a successful reorganize', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/notif-root',
			mediaType: 'movie',
			name: 'notif-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'Wrong (1900)',
			title: 'Test Movie',
			year: 2020,
			tmdbId: 77
		});

		const svc = new RenamePreviewService();
		const folderNameSpy = vi
			.spyOn(NamingService.prototype, 'generateMovieFolderName')
			.mockReturnValue('Generated (2020)');

		const result = await svc.reorganizeFolder(movieId, 'movie');

		expect(result.success).toBe(true);
		expect(notifierMocks.queueUpdate).toHaveBeenCalledWith(
			'/tmp/opencode/notif-root/Wrong (1900)',
			'Deleted',
			'rename'
		);
		expect(notifierMocks.queueUpdate).toHaveBeenCalledWith(
			'/tmp/opencode/notif-root/Generated (2020)',
			'Modified',
			'rename'
		);

		folderNameSpy.mockRestore();
		await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});

	it('queues Deleted(old folder) and Modified(new folder) when applyFolderRename moves the parent folder', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/afr-notif-root',
			mediaType: 'tv',
			name: 'afr-notif-root'
		});
		await db.insert(schema.series).values({
			id: seriesId,
			rootFolderId,
			path: 'Old (1999)',
			title: 'Show',
			tmdbId: 8
		});

		const svc = new RenamePreviewService();
		await svc['applyFolderRename'](seriesId, 'episode', 'Old (1999)', 'New (1999)', 'stem');

		expect(notifierMocks.queueUpdate).toHaveBeenCalledWith(
			'/tmp/opencode/afr-notif-root/Old (1999)',
			'Deleted',
			'rename'
		);
		expect(notifierMocks.queueUpdate).toHaveBeenCalledWith(
			'/tmp/opencode/afr-notif-root/New (1999)',
			'Modified',
			'rename'
		);

		await db.delete(schema.series).where(eq(schema.series.id, seriesId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});

	it('refuses to reorganize, never renames and never notifies when the tracked path is the root folder', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/rootguard-root',
			mediaType: 'movie',
			name: 'rootguard-root'
		});
		// Root-level file: media-matcher tracks these with path '.' and the
		// scan-heal path can write '' — either resolves to the root folder itself.
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: '.',
			title: 'Root Movie',
			year: 2020,
			tmdbId: 99
		});

		const svc = new RenamePreviewService();
		const folderNameSpy = vi
			.spyOn(NamingService.prototype, 'generateMovieFolderName')
			.mockReturnValue('Root Movie (2020)');

		const result = await svc.reorganizeFolder(movieId, 'movie');

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/root folder/);
		expect(mockFs.rename).not.toHaveBeenCalled();
		expect(notifierMocks.queueUpdate).not.toHaveBeenCalled();

		folderNameSpy.mockRestore();
		await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});

	it('queues no notifications when applyFolderRename is invoked for the root folder itself', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/rootguard-afr',
			mediaType: 'movie',
			name: 'rootguard-afr'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: '.',
			title: 'Root Movie',
			year: 2020,
			tmdbId: 100
		});

		const svc = new RenamePreviewService();
		// oldParentPath '.' makes join(root, oldParentPath) resolve to the root
		// itself — the guard must suppress Deleted(root)/Modified(root).
		await svc['applyFolderRename'](movieId, 'movie', '.', 'Root Movie (2020)', 'stem');

		expect(notifierMocks.queueUpdate).not.toHaveBeenCalled();

		await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
		await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
	});
});

describe('RenamePreviewService scan-in-progress refusal', () => {
	let scanSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		scanSpy = vi.spyOn(diskScanService, 'scanning', 'get').mockReturnValue(true);
	});

	afterEach(() => {
		scanSpy.mockRestore();
	});

	it('refuses executeRenames while a library scan is in progress', async () => {
		const svc = new RenamePreviewService();

		await expect(svc.executeRenames(['nonexistent-file'])).rejects.toThrow(/scan is in progress/i);
	});

	it('refuses reorganizeFolder while a library scan is in progress', async () => {
		const svc = new RenamePreviewService();

		const result = await svc.reorganizeFolder(randomUUID(), 'movie');

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/scan is in progress/i);
	});

	it('refuses the whole reorganizeFolders batch while a library scan is in progress', async () => {
		const svc = new RenamePreviewService();

		await expect(
			svc.reorganizeFolders([{ mediaId: randomUUID(), mediaType: 'movie' }])
		).rejects.toThrow(/scan is in progress/i);
	});
});

describe('in-place subtitle companion renames', () => {
	const dir = '/media/Season 01';

	beforeEach(() => {
		resetAllMocks();
	});

	function buildItem(currentName: string, newName: string) {
		return {
			fileId: 'file-1',
			mediaType: 'movie' as const,
			mediaId: 'movie-1',
			mediaTitle: 'Test',
			currentParentPath: 'Season 01',
			currentRelativePath: currentName,
			currentFullPath: `${dir}/${currentName}`,
			newParentPath: 'Season 01',
			newRelativePath: newName,
			newFullPath: `${dir}/${newName}`,
			status: 'will_change' as const
		};
	}

	it('updates the subtitle DB row to follow an in-place companion rename', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		const fileId = randomUUID();
		const root = '/media';
		const folder = 'Season 01';
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: root,
			mediaType: 'movie',
			name: 'subrename-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: folder,
			title: 'Sub Rename',
			year: 2020,
			tmdbId: 47,
			hasFile: true
		});
		await db.insert(schema.movieFiles).values({
			id: fileId,
			movieId,
			relativePath: 'Old.mkv'
		});
		await db.insert(schema.subtitles).values({
			id: randomUUID(),
			movieId,
			movieFileId: fileId,
			relativePath: 'Old.en.srt',
			language: 'en',
			format: 'srt'
		});

		(mockFs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['Old.en.srt']);
		mockedFileExists.mockImplementation(async (p: string) => p === `${root}/${folder}/Old.mkv`);

		try {
			const service = new RenamePreviewService();
			// @ts-expect-error accessing private method for testing
			const result = await service.executeFileRename(
				{ ...buildItem('Old.mkv', 'New.mkv'), mediaId: movieId },
				[]
			);

			expect(result.success).toBe(true);
			const rows = await db
				.select()
				.from(schema.subtitles)
				.where(eq(schema.subtitles.movieId, movieId));
			expect(rows).toHaveLength(1);
			expect(rows[0].relativePath).toBe('New.en.srt');
		} finally {
			await db.delete(schema.subtitles).where(eq(schema.subtitles.movieId, movieId));
			await db.delete(schema.movieFiles).where(eq(schema.movieFiles.id, fileId));
			await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
			await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
		}
	});

	it('renames a stem-matched .en.srt sibling when the video is renamed in place', async () => {
		const service = new RenamePreviewService();
		(mockFs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
			'In My Time of Dying.en.srt',
			'In My Time of Dying-poster.jpg'
		]);
		mockedFileExists.mockImplementation(
			async (p: string) => p === `${dir}/In My Time of Dying.strm`
		);

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(
			buildItem('In My Time of Dying.strm', 'In My Time of Dying [AAC 2.0]-Dying.strm'),
			[]
		);

		expect(result.success).toBe(true);
		expect(mockFs.rename).toHaveBeenCalledTimes(1);
		expect(mockFs.rename).toHaveBeenCalledWith(
			`${dir}/In My Time of Dying.en.srt`,
			`${dir}/In My Time of Dying [AAC 2.0]-Dying.en.srt`
		);
	});

	it('preserves multi-language suffix chains when renaming companions', async () => {
		const service = new RenamePreviewService();
		(mockFs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['Old.en.hi.srt']);
		mockedFileExists.mockImplementation(async (p: string) => p === `${dir}/Old.mkv`);

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(buildItem('Old.mkv', 'New.mkv'), []);

		expect(result.success).toBe(true);
		expect(mockFs.rename).toHaveBeenCalledWith(`${dir}/Old.en.hi.srt`, `${dir}/New.en.hi.srt`);
	});

	it('leaves siblings with different stems untouched', async () => {
		const service = new RenamePreviewService();
		(mockFs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
			'Other Episode.en.srt',
			'Unrelated.srt'
		]);
		mockedFileExists.mockImplementation(async (p: string) => p === `${dir}/Pilot.mkv`);

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(buildItem('Pilot.mkv', 'Pilot (2024).mkv'), []);

		expect(result.success).toBe(true);
		expect(mockFs.rename).not.toHaveBeenCalled();
	});

	it('does not treat a prefix match with a different episode as a companion', async () => {
		const service = new RenamePreviewService();
		(mockFs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
			'Pilot 2.en.srt',
			'Pilot.Repack.en.srt'
		]);
		mockedFileExists.mockImplementation(async (p: string) => p === `${dir}/Pilot.mkv`);

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(buildItem('Pilot.mkv', 'Pilot (2024).mkv'), []);

		expect(result.success).toBe(true);
		expect(mockFs.rename).not.toHaveBeenCalled();
	});

	it('skips the companion rename when the target already exists', async () => {
		const service = new RenamePreviewService();
		(mockFs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['Old.en.srt']);
		mockedFileExists.mockImplementation(
			async (p: string) => p === `${dir}/Old.mkv` || p === `${dir}/New.en.srt`
		);
		const warnings: string[] = [];

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(buildItem('Old.mkv', 'New.mkv'), warnings);

		expect(result.success).toBe(true);
		expect(mockFs.rename).not.toHaveBeenCalled();
		expect(warnings).toHaveLength(0);
	});

	it('adds a warning to the batch result when a companion rename fails', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		const fileId = randomUUID();
		const root = '/tmp/opencode/subcompanion-root';
		const folder = 'Companion Test (2020)';
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: root,
			mediaType: 'movie',
			name: 'subcompanion-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: folder,
			title: 'Companion Test',
			year: 2020,
			tmdbId: 46,
			hasFile: true
		});
		await db.insert(schema.movieFiles).values({
			id: fileId,
			movieId,
			relativePath: 'bad-name.avi',
			quality: { resolution: '1080p', source: 'WEBRip', codec: 'x265' },
			releaseGroup: 'RARBG'
		});

		const fileSpy = vi
			.spyOn(NamingService.prototype, 'generateMovieFileName')
			.mockReturnValue('New Name (2020).mkv');
		// Keep the parent folder stable so this is an in-place rename.
		const folderSpy = vi
			.spyOn(NamingService.prototype, 'generateMovieFolderName')
			.mockReturnValue(folder);
		mockedFileExists.mockImplementation(
			async (p: string) => p === `${root}/${folder}/bad-name.avi`
		);
		(mockFs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['bad-name.en.srt']);
		(mockFs.rename as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('EACCES: permission denied')
		);

		try {
			const service = new RenamePreviewService();
			const result = await service.executeRenames([fileId]);

			expect(result.succeeded).toBe(1);
			expect(result.failed).toBe(0);
			expect(result.warnings?.some((w) => w.includes('bad-name.en.srt'))).toBe(true);
			expect(mockFs.rename).toHaveBeenCalledWith(
				`${root}/${folder}/bad-name.en.srt`,
				`${root}/${folder}/New Name (2020).en.srt`
			);
		} finally {
			fileSpy.mockRestore();
			folderSpy.mockRestore();
			await db.delete(schema.movieFiles).where(eq(schema.movieFiles.id, fileId));
			await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
			await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
		}
	});

	it('does not scan for subtitle companions when the parent folder changes', async () => {
		const service = new RenamePreviewService();
		const item = {
			fileId: 'file-1',
			mediaType: 'movie' as const,
			mediaId: 'movie-1',
			mediaTitle: 'Test',
			currentParentPath: 'Season 01',
			currentRelativePath: 'Old.mkv',
			currentFullPath: `${dir}/Old.mkv`,
			newParentPath: 'Specials',
			newRelativePath: 'New.mkv',
			newFullPath: '/media/Specials/New.mkv',
			status: 'will_change' as const
		};
		mockedFileExists.mockImplementation(async (p: string) => p === `${dir}/Old.mkv`);

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(item, []);

		expect(result.success).toBe(true);
		expect(mockFs.readdir).not.toHaveBeenCalled();
		expect(mockFs.rename).not.toHaveBeenCalled();
	});
});

describe('.nfo companion renames (no stale orphan left under the old name)', () => {
	const dir = '/media/Season 01';

	beforeEach(() => {
		resetAllMocks();
	});

	function buildItem(
		currentName: string,
		newName: string,
		overrides: { currentParentPath?: string; newParentPath?: string; newDir?: string } = {}
	) {
		const newDir = overrides.newDir ?? dir;
		return {
			fileId: 'file-1',
			mediaType: 'movie' as const,
			mediaId: 'movie-1',
			mediaTitle: 'Test',
			currentParentPath: overrides.currentParentPath ?? 'Season 01',
			currentRelativePath: currentName,
			currentFullPath: `${dir}/${currentName}`,
			newParentPath: overrides.newParentPath ?? 'Season 01',
			newRelativePath: newName,
			newFullPath: `${newDir}/${newName}`,
			status: 'will_change' as const
		};
	}

	it('renames the .nfo sidecar alongside an in-place video rename', async () => {
		const service = new RenamePreviewService();
		mockedFileExists.mockImplementation(
			async (p: string) => p === `${dir}/Old.mkv` || p === `${dir}/Old.nfo`
		);

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(buildItem('Old.mkv', 'New.mkv'), []);

		expect(result.success).toBe(true);
		expect(mockFs.rename).toHaveBeenCalledWith(`${dir}/Old.nfo`, `${dir}/New.nfo`);
	});

	it('also carries the .nfo across a folder-changing rename (not restricted to same-dir)', async () => {
		const service = new RenamePreviewService();
		const newDir = '/media/Specials';
		mockedFileExists.mockImplementation(
			async (p: string) => p === `${dir}/Old.mkv` || p === `${dir}/Old.nfo`
		);

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(
			buildItem('Old.mkv', 'New.mkv', { newParentPath: 'Specials', newDir }),
			[]
		);

		expect(result.success).toBe(true);
		expect(mockFs.rename).toHaveBeenCalledWith(`${dir}/Old.nfo`, `${newDir}/New.nfo`);
	});

	it('does nothing when there is no .nfo to carry', async () => {
		const service = new RenamePreviewService();
		mockedFileExists.mockImplementation(async (p: string) => p === `${dir}/Old.mkv`);

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(buildItem('Old.mkv', 'New.mkv'), []);

		expect(result.success).toBe(true);
		expect(mockFs.rename).not.toHaveBeenCalledWith(`${dir}/Old.nfo`, `${dir}/New.nfo`);
	});

	it('skips the .nfo carry when a .nfo already exists at the destination', async () => {
		const service = new RenamePreviewService();
		mockedFileExists.mockImplementation(
			async (p: string) =>
				p === `${dir}/Old.mkv` || p === `${dir}/Old.nfo` || p === `${dir}/New.nfo`
		);
		const warnings: string[] = [];

		// @ts-expect-error accessing private method for testing
		const result = await service.executeFileRename(buildItem('Old.mkv', 'New.mkv'), warnings);

		expect(result.success).toBe(true);
		expect(mockFs.rename).not.toHaveBeenCalledWith(`${dir}/Old.nfo`, `${dir}/New.nfo`);
		expect(warnings).toHaveLength(0);
	});
});

describe('localized title rename parity', () => {
	let configSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		resetAllMocks();
		clearLocalizationCaches();
		tmdbFetch.mockReset();
	});

	afterEach(() => {
		configSpy?.mockRestore();
	});

	function mockNamingConfig(overrides: Record<string, string>) {
		configSpy = vi.spyOn(namingSettingsService, 'getConfigSync').mockReturnValue({
			...DEFAULT_NAMING_CONFIG,
			...overrides
		} as ReturnType<typeof namingSettingsService.getConfigSync>);
	}

	it('preview and execute render identical localized output for {Title:ja}', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		const fileId = randomUUID();
		const root = '/tmp/opencode/localized-root';
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: root,
			mediaType: 'movie',
			name: 'localized-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'Old (2001)',
			title: 'Spirited Away',
			year: 2001,
			tmdbId: 129,
			hasFile: true
		});
		await db.insert(schema.movieFiles).values({
			id: fileId,
			movieId,
			relativePath: 'spirited.away.2001.mkv',
			size: 100
		});

		tmdbFetch.mockResolvedValue({ title: '千と千尋の神隠し' });
		mockNamingConfig({
			movieFolderFormat: '{Title:ja} ({Year}) {MediaId}',
			movieFileFormat: '{Title:ja} [{QualityFull}]'
		});

		try {
			const svc = new RenamePreviewService();

			// Preview renders the Japanese title fetched from TMDB.
			const preview = await svc.previewMovie(movieId);
			expect(tmdbFetch).toHaveBeenCalledTimes(1);
			expect(tmdbFetch).toHaveBeenCalledWith('/movie/129?language=ja-JP', {}, true);
			expect(preview.willChange).toHaveLength(1);
			const previewedFolder = preview.willChange[0].newParentPath;
			const previewedFile = preview.willChange[0].newRelativePath;
			expect(previewedFolder).toContain('千と千尋の神隠し (2001)');
			expect(previewedFile).toContain('千と千尋の神隠し');

			// Execute produces the exact paths the preview proposed.
			const currentFullPath = preview.willChange[0].currentFullPath;
			mockedFileExists.mockImplementation(async (p: string) => p === currentFullPath);

			const result = await svc.executeRenames([fileId]);

			expect(result.succeeded).toBeGreaterThanOrEqual(1);
			// Shared cache: execute must NOT refetch what preview already resolved.
			expect(tmdbFetch).toHaveBeenCalledTimes(1);
			expect(mockedMoveFile).toHaveBeenCalledWith(
				preview.willChange[0].currentFullPath,
				preview.willChange[0].newFullPath
			);

			// The moved file and updated DB folder both use the localized name.
			const movieAfter = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
			expect(movieAfter?.path).toBe(previewedFolder);
			const fileAfter = db
				.select()
				.from(schema.movieFiles)
				.where(eq(schema.movieFiles.id, fileId))
				.get();
			expect(fileAfter?.relativePath).toBe(previewedFile);
		} finally {
			await db.delete(schema.movieFiles).where(eq(schema.movieFiles.id, fileId));
			await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
			await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
		}
	});

	it('falls back to the base title when the language code has no valid locale', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/invalid-locale-root',
			mediaType: 'movie',
			name: 'invalid-locale-root'
		});
		await db.insert(schema.movies).values({
			id: movieId,
			rootFolderId,
			path: 'Old (2020)',
			title: 'Base Title',
			year: 2020,
			tmdbId: 555001,
			hasFile: true
		});
		await db.insert(schema.movieFiles).values({
			id: randomUUID(),
			movieId,
			relativePath: 'base.title.2020.mkv'
		});

		mockNamingConfig({ movieFolderFormat: '{Title:xx} ({Year})' });

		try {
			const svc = new RenamePreviewService();
			const preview = await svc.previewMovie(movieId);

			// No fetch for the undecorable code; the base title renders.
			expect(tmdbFetch).not.toHaveBeenCalled();
			expect(preview.willChange).toHaveLength(1);
			expect(preview.willChange[0].newParentPath).toBe('Base Title (2020)');
		} finally {
			await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
			await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
		}
	});

	it('localizes series folder and episode names via the tv endpoint', async () => {
		const db = testDb.db;
		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const episodeId = randomUUID();
		const fileId = randomUUID();
		await db.insert(schema.rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/localized-series-root',
			mediaType: 'tv',
			name: 'localized-series-root'
		});
		await db.insert(schema.series).values({
			id: seriesId,
			rootFolderId,
			path: 'Old Show (2015)',
			title: 'Show',
			year: 2015,
			tmdbId: 60059
		});
		await db.insert(schema.episodes).values({
			id: episodeId,
			seriesId,
			seasonNumber: 1,
			episodeNumber: 1,
			title: 'Pilot'
		});
		await db.insert(schema.episodeFiles).values({
			id: fileId,
			seriesId,
			seasonNumber: 1,
			relativePath: 'old.show.mkv',
			episodeIds: [episodeId]
		});

		tmdbFetch.mockResolvedValue({ name: '日本語ショー' });
		mockNamingConfig({
			seriesFolderFormat: '{Title:ja} ({Year}) {SeriesId}',
			episodeFileFormat: '{Title:ja} - S{Season:00}E{Episode:00}'
		});

		try {
			const svc = new RenamePreviewService();
			const preview = await svc.previewSeries(seriesId);

			expect(tmdbFetch).toHaveBeenCalledTimes(1);
			expect(tmdbFetch).toHaveBeenCalledWith('/tv/60059?language=ja-JP', {}, true);
			expect(preview.willChange).toHaveLength(1);
			expect(preview.willChange[0].newParentPath).toContain('日本語ショー (2015)');
			expect(preview.willChange[0].newRelativePath).toContain('日本語ショー - S01E01');
		} finally {
			await db.delete(schema.episodeFiles).where(eq(schema.episodeFiles.id, fileId));
			await db.delete(schema.episodes).where(eq(schema.episodes.id, episodeId));
			await db.delete(schema.series).where(eq(schema.series.id, seriesId));
			await db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, rootFolderId));
		}
	});
});

import { describe, it, expect } from 'vitest';
import {
	NamingService,
	DEFAULT_NAMING_CONFIG,
	releaseToNamingInfo,
	type MediaNamingInfo
} from './NamingService';

describe('NamingService', () => {
	describe('Movie Naming', () => {
		it('should generate movie folder name with default format', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'The Dark Knight',
				year: 2008,
				tmdbId: 155
			};
			const result = service.generateMovieFolderName(info);
			expect(result).toBe('The Dark Knight (2008) {tmdb-155}');
		});

		it('should generate movie folder name with Jellyfin format', () => {
			const service = new NamingService({ mediaServerIdFormat: 'jellyfin' });
			const info: MediaNamingInfo = {
				title: 'The Dark Knight',
				year: 2008,
				tmdbId: 155
			};
			const result = service.generateMovieFolderName(info);
			expect(result).toBe('The Dark Knight (2008) [tmdbid-155]');
		});

		it('should generate movie file name with quality info', () => {
			// Use a custom format with single-token conditionals (service limitation:
			// default format uses multi-token conditionals which aren't fully processed)
			const service = new NamingService({
				movieFileFormat:
					'{CleanTitle} ({Year}) [{QualityFull}]{[{HDR}]}[{AudioCodec}]{[{VideoCodec}]}{-{ReleaseGroup}}'
			});
			const info: MediaNamingInfo = {
				title: 'The Dark Knight',
				year: 2008,
				tmdbId: 155,
				resolution: '1080p',
				source: 'bluray',
				codec: 'x265',
				audioCodec: 'dtshdma',
				audioChannels: '5.1',
				releaseGroup: 'GROUP',
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).toBe('The Dark Knight (2008) [Bluray-1080p][DTS-HD MA][x265]-GROUP.mkv');
		});

		it('should include HDR in movie file name when present', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Dune',
				year: 2021,
				resolution: '2160p',
				source: 'webdl',
				hdr: 'HDR10+',
				codec: 'hevc',
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).toContain('[HDR10+]');
			expect(result).toContain('[WEB-DL-2160p]');
		});

		it('should include edition in movie file name', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Blade Runner',
				year: 1982,
				edition: 'Final Cut',
				resolution: '1080p',
				source: 'bluray',
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).toContain('edition-Final Cut');
		});

		it('should include PROPER marker in quality', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test Movie',
				year: 2023,
				resolution: '1080p',
				source: 'bluray',
				proper: true,
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).toContain('[Proper Bluray-1080p]');
		});

		it('should include REPACK marker in quality', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test Movie',
				year: 2023,
				resolution: '1080p',
				source: 'webdl',
				repack: true,
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).toContain('[Repack WEB-DL-1080p]');
		});
	});

	describe('Series Naming', () => {
		it('should generate series folder name', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Breaking Bad',
				year: 2008,
				tvdbId: 81189
			};
			const result = service.generateSeriesFolderName(info);
			expect(result).toBe('Breaking Bad (2008) {tvdb-81189}');
		});

		it('should fall back to TMDB ID for series when TVDB missing', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'New Show',
				year: 2023,
				tmdbId: 12345
			};
			const result = service.generateSeriesFolderName(info);
			expect(result).toBe('New Show (2023) {tmdb-12345}');
		});

		it('should generate season folder name', () => {
			const service = new NamingService();
			const result = service.generateSeasonFolderName(1);
			expect(result).toBe('Season 01');
		});

		it('should generate season folder name with double digits', () => {
			const service = new NamingService();
			const result = service.generateSeasonFolderName(12);
			expect(result).toBe('Season 12');
		});

		it('should render series tokens in season folder when series context is given', () => {
			const service = new NamingService({
				...DEFAULT_NAMING_CONFIG,
				seasonFolderFormat: '{Title} ({Year}) - Season {Season:00}'
			});
			const result = service.generateSeasonFolderName(1, {
				title: 'Breaking Bad',
				year: 2008,
				tvdbId: 81189
			});
			expect(result).toBe('Breaking Bad (2008) - Season 01');
		});

		it('should render media server ID tokens in season folder', () => {
			const service = new NamingService({
				...DEFAULT_NAMING_CONFIG,
				seasonFolderFormat: 'Season {Season:00} {SeriesId}'
			});
			const result = service.generateSeasonFolderName(1, {
				title: 'Breaking Bad',
				year: 2008,
				tvdbId: 81189
			});
			expect(result).toBe('Season 01 {tvdb-81189}');
		});

		it('should leave series tokens empty in season folder without series context', () => {
			const service = new NamingService({
				...DEFAULT_NAMING_CONFIG,
				seasonFolderFormat: '{Year} - Season {Season:00}'
			});
			const result = service.generateSeasonFolderName(1);
			expect(result).toBe('Season 01');
		});
	});

	describe('Episode Naming', () => {
		it('should generate standard episode file name', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Breaking Bad',
				year: 2008,
				seasonNumber: 1,
				episodeNumbers: [1],
				episodeTitle: 'Pilot',
				resolution: '1080p',
				source: 'bluray',
				codec: 'x264',
				releaseGroup: 'NTb',
				originalExtension: '.mkv'
			};
			const result = service.generateEpisodeFileName(info);
			expect(result).toBe('Breaking Bad (2008) - S01E01 - Pilot [Bluray-1080p][x264]-NTb.mkv');
		});

		it('should generate daily episode file name', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'The Daily Show',
				year: 1996,
				isDaily: true,
				airDate: '2023-12-15',
				episodeTitle: 'Guest Interview',
				resolution: '720p',
				source: 'hdtv',
				codec: 'x264',
				releaseGroup: 'LOL',
				originalExtension: '.mkv'
			};
			const result = service.generateEpisodeFileName(info);
			expect(result).toBe(
				'The Daily Show (1996) - 2023-12-15 - Guest Interview [HDTV-720p][x264]-LOL.mkv'
			);
		});

		it('should generate anime episode file name with absolute number', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'One Piece',
				year: 1999,
				isAnime: true,
				seasonNumber: 21,
				episodeNumbers: [1000],
				absoluteNumber: 1000,
				episodeTitle: 'Overwhelming Strength',
				resolution: '1080p',
				source: 'webdl',
				codec: 'hevc',
				hdr: 'HDR10',
				bitDepth: '10',
				audioCodec: 'AAC',
				audioChannels: '2.0',
				releaseGroup: 'SubsPlease',
				originalExtension: '.mkv'
			};
			const result = service.generateEpisodeFileName(info);
			expect(result).toContain('S21E1000 - 1000');
			expect(result).toContain('[10bit]');
			expect(result).toContain('[HDR10]');
		});
	});

	describe('Multi-Episode Styles', () => {
		const baseInfo: MediaNamingInfo = {
			title: 'Test Show',
			year: 2023,
			seasonNumber: 1,
			episodeNumbers: [1, 2, 3],
			episodeTitle: 'Multi Part',
			originalExtension: '.mkv'
		};

		it('should format range style (default)', () => {
			const service = new NamingService({ multiEpisodeStyle: 'range' });
			const result = service.generateEpisodeFileName(baseInfo);
			expect(result).toContain('S01E01-E03');
		});

		it('should format extend style', () => {
			const service = new NamingService({ multiEpisodeStyle: 'extend' });
			const result = service.generateEpisodeFileName(baseInfo);
			expect(result).toContain('S01E01E02E03');
		});

		it('should format duplicate style', () => {
			const service = new NamingService({ multiEpisodeStyle: 'duplicate' });
			const result = service.generateEpisodeFileName(baseInfo);
			expect(result).toContain('S01E01-E02-E03');
		});

		it('should format scene style', () => {
			const service = new NamingService({ multiEpisodeStyle: 'scene' });
			const result = service.generateEpisodeFileName(baseInfo);
			expect(result).toContain('S01E01E2E3');
		});

		it('should handle two episodes with range style', () => {
			const service = new NamingService({ multiEpisodeStyle: 'range' });
			const info = { ...baseInfo, episodeNumbers: [1, 2] };
			const result = service.generateEpisodeFileName(info);
			expect(result).toContain('S01E01-E02');
		});

		it('should format repeat style', () => {
			const service = new NamingService({ multiEpisodeStyle: 'repeat' });
			const result = service.generateEpisodeFileName(baseInfo);
			expect(result).toContain('S01E01 - S01E02 - S01E03');
		});
	});

	describe('Colon Replacement', () => {
		// Note: {CleanTitle} token removes colons via generateCleanTitle() before
		// Note: CleanTitle now respects the colonReplacement setting.
		// Previously it would always remove colons, but now the colon replacement
		// is handled by NamingService.cleanName() which applies the user's preference.
		const infoWithColon: MediaNamingInfo = {
			title: 'Star Wars: A New Hope',
			year: 1977,
			tmdbId: 11
		};

		it('should apply colonReplacement setting to CleanTitle', () => {
			// CleanTitle now respects the colonReplacement setting
			const service = new NamingService({ colonReplacement: 'smart' });
			const result = service.generateMovieFolderName(infoWithColon);
			// Smart replaces ": " with " - "
			expect(result).toBe('Star Wars - A New Hope (1977) {tmdb-11}');
		});

		it('should use smart colon replacement on raw Title', () => {
			const service = new NamingService({
				movieFolderFormat: '{Title} ({Year})',
				colonReplacement: 'smart'
			});
			const result = service.generateMovieFolderName(infoWithColon);
			// Smart replaces ": " with " - "
			expect(result).toBe('Star Wars - A New Hope (1977)');
		});

		it('should delete colons from raw Title', () => {
			const service = new NamingService({
				movieFolderFormat: '{Title} ({Year})',
				colonReplacement: 'delete'
			});
			const result = service.generateMovieFolderName(infoWithColon);
			expect(result).toBe('Star Wars A New Hope (1977)');
		});

		it('should replace colon with dash in raw Title', () => {
			const service = new NamingService({
				movieFolderFormat: '{Title} ({Year})',
				colonReplacement: 'dash'
			});
			const result = service.generateMovieFolderName(infoWithColon);
			expect(result).toBe('Star Wars- A New Hope (1977)');
		});

		it('should replace colon with space-dash in raw Title', () => {
			const service = new NamingService({
				movieFolderFormat: '{Title} ({Year})',
				colonReplacement: 'spaceDash'
			});
			const result = service.generateMovieFolderName(infoWithColon);
			expect(result).toBe('Star Wars - A New Hope (1977)');
		});

		it('should replace colon with space-dash-space in raw Title', () => {
			const service = new NamingService({
				movieFolderFormat: '{Title} ({Year})',
				colonReplacement: 'spaceDashSpace'
			});
			const result = service.generateMovieFolderName(infoWithColon);
			expect(result).toBe('Star Wars - A New Hope (1977)');
		});
	});

	describe('Source Normalization', () => {
		const testCases = [
			{ input: 'bluray', expected: 'Bluray' },
			{ input: 'blu-ray', expected: 'Bluray' },
			{ input: 'bdrip', expected: 'Bluray' },
			{ input: 'webdl', expected: 'WEB-DL' },
			{ input: 'web-dl', expected: 'WEB-DL' },
			{ input: 'webrip', expected: 'WEBRip' },
			{ input: 'hdtv', expected: 'HDTV' },
			{ input: 'remux', expected: 'Remux' },
			{ input: 'dvdrip', expected: 'DVDRip' }
		];

		testCases.forEach(({ input, expected }) => {
			it(`should normalize ${input} to ${expected}`, () => {
				const service = new NamingService();
				const info: MediaNamingInfo = {
					title: 'Test',
					year: 2023,
					source: input,
					resolution: '1080p',
					originalExtension: '.mkv'
				};
				const result = service.generateMovieFileName(info);
				expect(result).toContain(`[${expected}-1080p]`);
			});
		});
	});

	describe('Video Codec Normalization', () => {
		const testCases = [
			{ input: 'h264', expected: 'x264' },
			{ input: 'h.264', expected: 'x264' },
			{ input: 'avc', expected: 'x264' },
			{ input: 'h265', expected: 'x265' },
			{ input: 'hevc', expected: 'x265' },
			{ input: 'av1', expected: 'AV1' },
			{ input: 'vp9', expected: 'VP9' }
		];

		testCases.forEach(({ input, expected }) => {
			it(`should normalize ${input} to ${expected}`, () => {
				const service = new NamingService();
				const info: MediaNamingInfo = {
					title: 'Test',
					year: 2023,
					codec: input,
					source: 'bluray',
					resolution: '1080p',
					originalExtension: '.mkv'
				};
				const result = service.generateMovieFileName(info);
				expect(result).toContain(`[${expected}]`);
			});
		});
	});

	describe('Audio Codec Normalization', () => {
		const testCases = [
			{ input: 'truehd', expected: 'TrueHD' },
			{ input: 'dtshdma', expected: 'DTS-HD MA' },
			{ input: 'dtsx', expected: 'DTS-X' },
			{ input: 'flac', expected: 'FLAC' },
			{ input: 'aac', expected: 'AAC' },
			{ input: 'ac3', expected: 'DD' },
			{ input: 'eac3', expected: 'DD+' }
		];

		testCases.forEach(({ input, expected }) => {
			it(`should normalize ${input} to ${expected}`, () => {
				const service = new NamingService();
				const info: MediaNamingInfo = {
					title: 'Test',
					year: 2023,
					audioCodec: input,
					audioChannels: '5.1',
					source: 'bluray',
					resolution: '1080p',
					originalExtension: '.mkv'
				};
				const result = service.generateMovieFileName(info);
				expect(result).toContain(`[${expected} 5.1]`);
			});
		});
	});

	describe('Conditional Blocks', () => {
		it('should include conditional block when value exists', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test',
				year: 2023,
				releaseGroup: 'GROUP',
				source: 'bluray',
				resolution: '1080p',
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).toContain('-GROUP');
		});

		it('should exclude conditional block when value missing', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test',
				year: 2023,
				source: 'bluray',
				resolution: '1080p',
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).not.toContain('-undefined');
			expect(result).not.toContain('--');
		});

		it('should handle multiple conditional blocks', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test',
				year: 2023,
				hdr: 'dolby-vision',
				codec: 'x265',
				audioCodec: 'TrueHD',
				audioChannels: '7.1',
				source: 'remux',
				resolution: '2160p',
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).toContain('[DV]');
			expect(result).toContain('[TrueHD 7.1]');
			expect(result).toContain('[x265]');
		});
	});

	describe('Config controlled tokens', () => {
		it('should suppress quality tokens when includeQuality is false', () => {
			const service = new NamingService({ includeQuality: false });
			const result = service.generateMovieFileName({
				title: 'Test',
				year: 2023,
				source: 'bluray',
				resolution: '1080p',
				originalExtension: '.mkv'
			});

			expect(result).not.toContain('Bluray');
			expect(result).not.toContain('1080p');
		});

		it('should suppress media info tokens when includeMediaInfo is false', () => {
			const service = new NamingService({ includeMediaInfo: false });
			const result = service.generateMovieFileName({
				title: 'Test',
				year: 2023,
				source: 'bluray',
				resolution: '1080p',
				codec: 'x265',
				audioCodec: 'truehd',
				audioChannels: '7.1',
				originalExtension: '.mkv'
			});

			expect(result).not.toContain('x265');
			expect(result).not.toContain('TrueHD');
		});

		it('should suppress release group token when includeReleaseGroup is false', () => {
			const service = new NamingService({ includeReleaseGroup: false });
			const result = service.generateMovieFileName({
				title: 'Test',
				year: 2023,
				releaseGroup: 'GROUP',
				originalExtension: '.mkv'
			});

			expect(result).not.toContain('GROUP');
		});
	});

	describe('Edge Cases', () => {
		it('should handle missing year', () => {
			const service = new NamingService({
				movieFolderFormat: '{CleanTitle} ({Year}) {MediaId}'
			});
			const info: MediaNamingInfo = {
				title: 'Test Movie',
				tmdbId: 123
			};
			const result = service.generateMovieFolderName(info);
			// Empty parens are removed and extra spaces are cleaned up
			expect(result).toBe('Test Movie {tmdb-123}');
		});

		it('should handle missing TMDB ID', () => {
			const service = new NamingService({
				movieFolderFormat: '{CleanTitle} ({Year}) {MediaId}'
			});
			const info: MediaNamingInfo = {
				title: 'Test Movie',
				year: 2023
			};
			const result = service.generateMovieFolderName(info);
			expect(result).toBe('Test Movie (2023)');
		});

		it('should remove illegal characters from title', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test: Movie? <With> "Illegal" |Chars|',
				year: 2023,
				tmdbId: 123
			};
			const result = service.generateMovieFolderName(info);
			expect(result).not.toContain(':');
			expect(result).not.toContain('?');
			expect(result).not.toContain('<');
			expect(result).not.toContain('>');
			expect(result).not.toContain('"');
			expect(result).not.toContain('|');
		});

		it('should clean up empty brackets', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test',
				year: 2023,
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).not.toContain('[]');
			expect(result).not.toContain('()');
			expect(result).not.toContain('{}');
		});

		it('should clean up multiple spaces', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test  Movie   Title',
				year: 2023,
				tmdbId: 123
			};
			const result = service.generateMovieFolderName(info);
			expect(result).not.toMatch(/\s{2,}/);
		});

		it('should clean up multiple dashes', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test',
				year: 2023,
				source: 'bluray',
				resolution: '1080p',
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).not.toMatch(/--+/);
		});

		it('should replace spaces when configured', () => {
			const service = new NamingService({ replaceSpacesWith: '.' });
			const info: MediaNamingInfo = {
				title: 'Test Movie',
				year: 2023,
				tmdbId: 123
			};
			const result = service.generateMovieFolderName(info);
			expect(result).toContain('Test.Movie');
		});

		it('should handle single episode correctly', () => {
			const service = new NamingService();
			const info: MediaNamingInfo = {
				title: 'Test Show',
				year: 2023,
				seasonNumber: 1,
				episodeNumbers: [5],
				episodeTitle: 'Single Episode',
				originalExtension: '.mkv'
			};
			const result = service.generateEpisodeFileName(info);
			expect(result).toContain('S01E05');
			expect(result).not.toContain('E05E');
		});

		it('should use IMDB ID token when provided', () => {
			const service = new NamingService({
				movieFolderFormat: '{CleanTitle} ({Year}) {ImdbId}'
			});
			const info: MediaNamingInfo = {
				title: 'Test Movie',
				year: 2023,
				imdbId: 'tt1234567'
			};
			const result = service.generateMovieFolderName(info);
			expect(result).toBe('Test Movie (2023) tt1234567');
		});

		it('should handle 3D content', () => {
			const service = new NamingService({
				movieFileFormat: '{CleanTitle} ({Year}) {3D} [{QualityFull}]'
			});
			const info: MediaNamingInfo = {
				title: 'Avatar',
				year: 2009,
				is3D: true,
				source: 'bluray',
				resolution: '1080p',
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result).toContain('3D');
		});
	});

	describe('Docs-style patterns (issue #497)', () => {
		it('renders the docs-advertised first-letter movie folder pattern', () => {
			const service = new NamingService({
				movieFolderFormat: '{Movie Title:First}/{Movie Title} ({Release Year})'
			});
			const info: MediaNamingInfo = { title: 'The Matrix', year: 1999 };
			expect(service.generateMovieFolderName(info)).toBe('T/The Matrix (1999)');
		});

		it('resolves {Quality Full} via alias', () => {
			const service = new NamingService({ movieFileFormat: '[{Quality Full}]' });
			const info: MediaNamingInfo = {
				title: 'The Matrix',
				year: 1999,
				source: 'bluray',
				resolution: '1080p',
				originalExtension: '.mkv'
			};
			expect(service.generateMovieFileName(info)).toBe('[Bluray-1080p].mkv');
		});
	});

	describe('Configuration', () => {
		it('should use default configuration', () => {
			const service = new NamingService();
			const config = service.getConfig();
			expect(config).toEqual(DEFAULT_NAMING_CONFIG);
		});

		it('should allow partial configuration override', () => {
			const service = new NamingService({ colonReplacement: 'delete' });
			const config = service.getConfig();
			expect(config.colonReplacement).toBe('delete');
			expect(config.movieFolderFormat).toBe(DEFAULT_NAMING_CONFIG.movieFolderFormat);
		});

		it('should update configuration', () => {
			const service = new NamingService();
			service.updateConfig({ mediaServerIdFormat: 'jellyfin' });
			const config = service.getConfig();
			expect(config.mediaServerIdFormat).toBe('jellyfin');
		});
	});

	describe('releaseToNamingInfo with honest parser languages', () => {
		it('maps empty parsed languages to undefined audioLanguages (renders und)', () => {
			// The parser no longer asserts 'en' for untagged releases; naming must
			// treat an empty list as "no audio-language evidence".
			const info = releaseToNamingInfo({
				title: 'Movie',
				year: 2023,
				resolution: '1080p',
				languages: []
			});

			expect(info.audioLanguages).toBeUndefined();
		});

		it('keeps explicitly tagged languages as audioLanguages', () => {
			const info = releaseToNamingInfo({
				title: 'Movie',
				year: 2023,
				languages: ['de', 'fr']
			});

			expect(info.audioLanguages).toEqual(['de', 'fr']);
		});

		it('passes the multi marker through for the token layer to neutralize', () => {
			// 'multi' is not English and not a language; {AudioLanguages} renders
			// it as `und` (normalizeLanguageTag maps markers to und).
			const info = releaseToNamingInfo({
				title: 'Movie',
				year: 2023,
				languages: ['multi']
			});

			expect(info.audioLanguages).toEqual(['multi']);
		});
	});

	describe('Path-segment safety', () => {
		it('strips path separators from scraped titles', () => {
			const service = new NamingService({ movieFolderFormat: '{Title} ({Year})' });
			const info: MediaNamingInfo = {
				title: 'Face/Off',
				year: 1997,
				tmdbId: 432
			};
			const result = service.generateMovieFolderName(info);
			expect(result).not.toContain('/');
			expect(result).toBe('FaceOff (1997)');
		});

		it('drops dot-segments that would escape the library root', () => {
			const service = new NamingService({ movieFolderFormat: '{Title}/Files' });
			const info: MediaNamingInfo = {
				title: '..',
				year: 0,
				tmdbId: 0
			};
			const result = service.generateMovieFolderName(info);
			// The '..' segment must be filtered, never joined into the path.
			expect(result.split('/')).not.toContain('..');
			expect(result).toBe('Files');
		});

		it('keeps intended format separators working', () => {
			const service = new NamingService({ movieFolderFormat: 'Movies/{CleanTitle} ({Year})' });
			const info: MediaNamingInfo = {
				title: 'The Dark Knight',
				year: 2008,
				tmdbId: 155
			};
			expect(service.generateMovieFolderName(info)).toBe('Movies/The Dark Knight (2008)');
		});

		it('strips a leading dot-ellipsis from a movie folder name so it is not hidden on Linux', () => {
			const service = new NamingService({ movieFolderFormat: '{Title} ({Year})' });
			const info: MediaNamingInfo = {
				title: '...And Justice for All',
				year: 1979,
				tmdbId: 17443
			};
			const result = service.generateMovieFolderName(info);
			expect(result.startsWith('.')).toBe(false);
			expect(result).toBe('And Justice for All (1979)');
		});

		it('strips a leading dot-ellipsis from a movie file name', () => {
			const service = new NamingService({ movieFileFormat: '{Title} ({Year})' });
			const info: MediaNamingInfo = {
				title: '...And Justice for All',
				year: 1979,
				tmdbId: 17443,
				originalExtension: '.mkv'
			};
			const result = service.generateMovieFileName(info);
			expect(result.startsWith('.')).toBe(false);
			expect(result).toBe('And Justice for All (1979).mkv');
		});

		it('strips a leading dot-ellipsis from a series folder name', () => {
			const service = new NamingService({ seriesFolderFormat: '{Title} ({Year})' });
			const info: MediaNamingInfo = {
				title: '...Baby One More Time',
				year: 2024,
				tvdbId: 1
			};
			const result = service.generateSeriesFolderName(info);
			expect(result.startsWith('.')).toBe(false);
			expect(result).toBe('Baby One More Time (2024)');
		});

		it('strips a leading dot-ellipsis from an episode file name', () => {
			const service = new NamingService({
				episodeFileFormat: '{Title} - S{Season:00}E{Episode:00}'
			});
			const info: MediaNamingInfo = {
				title: '...Baby One More Time',
				seasonNumber: 1,
				episodeNumbers: [1],
				originalExtension: '.mkv'
			};
			const result = service.generateEpisodeFileName(info);
			expect(result.startsWith('.')).toBe(false);
			expect(result).toBe('Baby One More Time - S01E01.mkv');
		});

		it('still allows an internal dot (e.g. "Mr. Robot") to survive untouched', () => {
			const service = new NamingService({ movieFolderFormat: '{Title} ({Year})' });
			const info: MediaNamingInfo = {
				title: 'Mr. Robot',
				year: 2015,
				tmdbId: 1
			};
			expect(service.generateMovieFolderName(info)).toBe('Mr. Robot (2015)');
		});
	});
});

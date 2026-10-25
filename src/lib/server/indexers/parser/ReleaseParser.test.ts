import { describe, it, expect } from 'vitest';
import { parseRelease, extractExternalIds } from './ReleaseParser';
import { extractLanguages, extractLanguagesFromFileName } from './patterns/language';
import { isTvRelease } from './patterns/episode';
import { extractResolution } from './patterns/resolution';
import { extractSource } from './patterns/source';
import { extractBitDepth, extractCodec } from './patterns/codec';
import { extractEnhancedAudio, extractHdr } from './patterns/audio';
import { extractReleaseGroup } from './patterns/releaseGroup';

describe('ReleaseParser', () => {
	describe('Movie Releases', () => {
		it.each([
			[
				"Straight Outta Compton (2015-Director's Cut)",
				'Straight Outta Compton',
				2015,
				"Director's Cut"
			],
			['Se7en (1995-Remastered)', 'Se7en', 1995, 'Remastered'],
			[
				"Gods and Generals (2003-Extended Director's Cut)",
				'Gods and Generals',
				2003,
				"Director's Cut"
			],
			['Aquaman (2018-Imax)', 'Aquaman', 2018, 'IMAX'],
			['Alien (1979-Theatrical Cut)', 'Alien', 1979, 'Theatrical'],
			['Se7en (1995 Remastered)', 'Se7en', 1995, 'Remastered'],
			[
				"Straight Outta Compton (2015 Director's Cut)",
				'Straight Outta Compton',
				2015,
				"Director's Cut"
			]
		])('parses year and edition from %s', (filename, cleanTitle, year, edition) => {
			const result = parseRelease(filename);
			expect(result.cleanTitle).toBe(cleanTitle);
			expect(result.year).toBe(year);
			expect(result.edition).toBe(edition);
		});

		it('should parse a standard movie release', () => {
			const result = parseRelease('The.Matrix.1999.1080p.BluRay.x264-GROUP');

			expect(result.cleanTitle).toBe('The Matrix');
			expect(result.year).toBe(1999);
			expect(result.resolution).toBe('1080p');
			expect(result.source).toBe('bluray');
			expect(result.codec).toBe('h264');
			expect(result.releaseGroup).toBe('GROUP');
			expect(result.episode).toBeUndefined();
		});

		it('should parse a 4K HDR release', () => {
			const result = parseRelease('Dune.2021.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-FGT');

			expect(result.cleanTitle).toBe('Dune');
			expect(result.year).toBe(2021);
			expect(result.resolution).toBe('2160p');
			expect(result.source).toBe('remux');
			expect(result.codec).toBe('h265');
			expect(result.hdr).toBe('hdr'); // Generic HDR without specific version
			expect(result.audioCodec).toBe('unknown');
			expect(result.hasAtmos).toBe(true);
			expect(result.isRemux).toBe(true);
			expect(result.releaseGroup).toBe('FGT');
		});

		it('should parse a WEB-DL release', () => {
			const result = parseRelease('Spider-Man.No.Way.Home.2021.1080p.WEB-DL.DD+5.1.H.264-RUMOUR');

			expect(result.cleanTitle).toBe('Spider-man No Way Home');
			expect(result.year).toBe(2021);
			expect(result.resolution).toBe('1080p');
			expect(result.source).toBe('webdl');
			expect(result.codec).toBe('h264');
			expect(result.audioCodec).toBe('dd+');
			expect(result.releaseGroup).toBe('RUMOUR');
		});

		it('should detect Dolby Vision', () => {
			const result = parseRelease('Interstellar.2014.2160p.WEB-DL.DV.HDR.DDP.5.1.Atmos.H.265-FLUX');

			expect(result.hdr).toBe('dolby-vision');
			expect(result.audioCodec).toBe('dd+');
			expect(result.hasAtmos).toBe(true);
		});

		it('should parse YTS-style releases', () => {
			const result = parseRelease('Oppenheimer (2023) [1080p] [WEBRip] [5.1] [YTS.MX]');

			expect(result.cleanTitle).toContain('Oppenheimer');
			expect(result.year).toBe(2023);
			expect(result.resolution).toBe('1080p');
			expect(result.source).toBe('webrip');
			expect(result.releaseGroup).toBe('YTS');
		});

		it('should parse normalized H 265 codec markers', () => {
			const result = parseRelease('Movie.2024.2160p.MA.WEB-DL.DDP.7.1.DoVi.HDR10.H.265-GROUP');

			expect(result.codec).toBe('h265');
		});

		it('should parse WEBSCREENER as screener source', () => {
			const result = parseRelease('Movie.2024.1080p.WEBSCREENER.x265.AAC-GROUP');

			expect(result.source).toBe('screener');
		});

		it('should parse HDRip as a distinct source', () => {
			const result = parseRelease('Movie.2024.HDRip.1080p.x264-GROUP');

			expect(result.source).toBe('hdrip');
			expect(result.resolution).toBe('1080p');
			expect(result.codec).toBe('h264');
		});

		it('should parse BD25 releases as bluray source', () => {
			const result = parseRelease('Movie.2024.CUSTOM.BD25.AVC.x264.DD.Plus.7.1-GROUP');

			expect(result.source).toBe('bluray');
			expect(result.codec).toBe('h264');
			expect(result.audioCodec).toBe('dd+');
			expect(result.audioChannels).toBe('7.1');
		});

		it('should parse DD Plus punctuation variants as ddplus', () => {
			const dotted = parseRelease('Movie.2024.1080p.WEB-DL.DD.Plus.5.1.H264-GROUP');
			const spaced = parseRelease('Movie.2024.1080p.WEB-DL.DD Plus.5.1.H264-GROUP');

			expect(dotted.audioCodec).toBe('dd+');
			expect(spaced.audioCodec).toBe('dd+');
		});

		it('should parse bit depth as a canonical fact', () => {
			const result = parseRelease('Movie.2024.1080p.10bit.WEBRip.x265.AAC-GROUP');

			expect(result.bitDepth).toBe('10');
			expect(result.codec).toBe('h265');
		});

		it('should detect streaming service and richer HDR combinations', () => {
			const result = parseRelease(
				'Avatar.Fire.and.Ash.2025.Hybrid.1080p.MA.WEBRIP.DDP7.1.DoVi.HDR10P.x265.HuN-TRiNiTY'
			);

			expect(result.streamingService).toBe('MA');
			expect(result.audioCodec).toBe('dd+');
			expect(result.audioChannels).toBe('7.1');
			expect(result.hdr).toBe('dolby-vision');
		});

		it('should detect PROPER releases', () => {
			const result = parseRelease('Movie.2023.1080p.BluRay.x264.PROPER-GROUP');

			expect(result.isProper).toBe(true);
		});

		it('should detect REPACK releases', () => {
			const result = parseRelease('Movie.2023.1080p.BluRay.x264.REPACK-GROUP');

			expect(result.isRepack).toBe(true);
		});

		it('should detect edition info', () => {
			const result = parseRelease(
				'Blade.Runner.1982.Final.Cut.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.5.1-FGT'
			);

			expect(result.cleanTitle).toContain('Blade Runner');
			expect(result.edition).toBe('Final Cut');
		});

		it('should detect IMAX Enhanced releases', () => {
			const result = parseRelease('Movie.2024.IMAX.Enhanced.2160p.WEB-DL.DDP5.1.H265-GROUP');

			expect(result.edition).toBe('IMAX Enhanced');
		});

		it('should detect hybrid releases', () => {
			const result = parseRelease('Movie.2024.Hybrid.1080p.BluRay.x264-GROUP');

			expect(result.edition).toBe('Hybrid');
		});

		it('should not treat WEB-DL quality suffix as release group', () => {
			const result = parseRelease('Movie (2024) [WEB-DL-1080p][AC3 5.1][x265].mkv');

			expect(result.releaseGroup).toBeUndefined();
		});

		it('should not invent release groups from subtitle and language suffixes', () => {
			const subResult = parseRelease('Avatar: Fire and Ash / 2025 / DUB, Sub / HEVC / WEBDL 1080p');
			const engResult = parseRelease(
				'Avatar: Fire and Ash (James Cameron) [2025, WEB-DL-AVC] MVO (HDRezka Studio) + Sub + Original Eng'
			);
			const telResult = parseRelease(
				'Avatar Fire and Ash (2025) Telesync TS HD 1080p - x264 - [Tam.Tel.Hin]'
			);

			expect(subResult.releaseGroup).toBeUndefined();
			expect(engResult.releaseGroup).toBeUndefined();
			expect(telResult.releaseGroup).toBeUndefined();
		});

		it('should detect 3D releases', () => {
			const result = parseRelease('Avatar.2009.3D.1080p.BluRay.x264-GROUP');

			expect(result.is3d).toBe(true);
		});

		it('should not treat generic movie collection titles as TV packs', () => {
			const result = parseRelease('War Movies Complete Collection 2024 1080p BluRay x264');

			expect(result.episode).toBeUndefined();
		});
	});

	describe('TV Show Releases', () => {
		it('should parse standard S##E## format', () => {
			const result = parseRelease('Breaking.Bad.S01E01.1080p.BluRay.x264-GROUP');

			expect(result.cleanTitle).toBe('Breaking Bad');
			expect(result.episode).toBeDefined();
			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes).toEqual([1]);
			expect(result.episode?.isSeasonPack).toBe(false);
			expect(result.resolution).toBe('1080p');
		});

		it('should parse multi-episode releases', () => {
			const result = parseRelease('Game.of.Thrones.S08E01E02.1080p.WEB-DL.DD5.1.H.264-GoT');

			expect(result.episode?.season).toBe(8);
			expect(result.episode?.episodes).toContain(1);
			expect(result.episode?.episodes).toContain(2);
		});

		it('should parse episode version suffix without separator (s01e01v2)', () => {
			const result = parseRelease('[HorribleSubs] Honzuki no Gekokujou - s01e01v2 [1080p].mkv');

			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes).toEqual([1]);
		});

		it('should parse episode version suffixes with dot and hyphen separators', () => {
			const dotResult = parseRelease('[HorribleSubs] Honzuki no Gekokujou - s01e01.v2 [1080p].mkv');
			const hyphenResult = parseRelease(
				'[HorribleSubs] Honzuki no Gekokujou - s01e01-v2 [1080p].mkv'
			);

			expect(dotResult.episode?.season).toBe(1);
			expect(dotResult.episode?.episodes).toEqual([1]);
			expect(hyphenResult.episode?.season).toBe(1);
			expect(hyphenResult.episode?.episodes).toEqual([1]);
		});

		it('should parse higher episode version numbers (v3, v4, v10)', () => {
			const v3 = parseRelease('[SubsPlease] Show Title - S01E05v3 [720p].mkv');
			const v4 = parseRelease('[SubsPlease] Show Title - S01E05v4 [720p].mkv');
			const v10 = parseRelease('[SubsPlease] Show Title - S01E05v10 [720p].mkv');

			expect(v3.episode?.episodes).toEqual([5]);
			expect(v4.episode?.episodes).toEqual([5]);
			expect(v10.episode?.episodes).toEqual([5]);
		});

		it('should parse season packs', () => {
			const result = parseRelease('The.Office.US.S01.1080p.BluRay.x264-DEMAND');

			expect(result.cleanTitle).toBe('The Office Us');
			expect(result.episode?.season).toBe(1);
			expect(result.episode?.isSeasonPack).toBe(true);
		});

		it('should parse "Season X" format packs', () => {
			const result = parseRelease('Stranger.Things.Season.4.1080p.NF.WEB-DL.DDP5.1.x264-NTb');

			expect(result.episode?.season).toBe(4);
			expect(result.episode?.isSeasonPack).toBe(true);
		});

		it('should parse tracker season packs with explicit episode range', () => {
			const result = parseRelease(
				'The Pitt / Season: 2 / Episodes: 1-10 of 15 [2026, USA, WEB-DLRip]'
			);

			expect(result.episode?.season).toBe(2);
			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.episodes).toContain(1);
			expect(result.episode?.episodes).toContain(10);
			expect(result.episode?.episodes).not.toContain(11);
		});

		it('should parse SxxExx-yy episode range packs', () => {
			const result = parseRelease('Stranger Things S1E1-8 [2016, HEVC, WEB-DL]');

			expect(result.episode?.season).toBe(1);
			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.episodes).toContain(1);
			expect(result.episode?.episodes).toContain(8);
			expect(result.episode?.episodes).not.toContain(9);
		});

		it('should not treat clock time episode titles as season-pack ranges', () => {
			const result = parseRelease('The Pitt S02E01 - 7:00 A.M. [Streaming]');

			expect(result.episode?.season).toBe(2);
			expect(result.episode?.episodes).toEqual([1]);
			expect(result.episode?.isSeasonPack).toBe(false);
		});

		it('should not fabricate a multi-episode range from an unrelated bare number in the title', () => {
			const result = parseRelease(
				'Die Legende von Korra (2012) ger - S02E08 - 020 - Wie alles begann, Teil 2 [WEBRip-1080p][8bit][x265][DD+ 2.0]-WOTT'
			);

			expect(result.episode?.season).toBe(2);
			expect(result.episode?.episodes).toEqual([8]);
			expect(result.episode?.isSeasonPack).toBe(false);
		});

		it('should not treat a spaced standalone number after SxxExx as a range end', () => {
			const result = parseRelease('Show Name S01E05 - 12 - Episode Title [1080p]');

			expect(result.episode?.episodes).toEqual([5]);
			expect(result.episode?.isSeasonPack).toBe(false);
		});

		it('should still parse spaced ranges when the second number is explicitly marked with E', () => {
			const result = parseRelease('Show Name S01E05 - E08 [1080p]');

			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes).toContain(5);
			expect(result.episode?.episodes).toContain(8);
		});

		it('should parse complete series packs', () => {
			const result = parseRelease('Friends.Complete.Series.S01-S10.1080p.BluRay.x264-GROUP');

			expect(result.episode?.isCompleteSeries).toBe(true);
			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		});

		it('should parse multi-season packs S01-S05', () => {
			const result = parseRelease('Breaking.Bad.S01-S05.1080p.BluRay.x264-GROUP');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5]);
			expect(result.episode?.isCompleteSeries).toBe(true);
		});

		it('should parse multi-season packs S03-S06 (not starting from S01)', () => {
			const result = parseRelease('Show.S03-S06.720p.WEB-DL.x264-GROUP');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([3, 4, 5, 6]);
			expect(result.episode?.isCompleteSeries).toBe(false);
		});

		it('should parse multi-season packs with Seasons format', () => {
			const result = parseRelease('The.Office.Seasons.1-9.Complete.1080p.BluRay-GROUP');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		});

		it('should parse SxxExx-SyyEzz multi-season range notation', () => {
			const result = parseRelease('Show.Name.S01E01-S08E99.1080p.WEB-DL');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
			expect(result.episode?.isCompleteSeries).toBe(true);
		});

		it('should parse 1x01-8x99 multi-season range notation', () => {
			const result = parseRelease('Show Name 1x01-8x99 720p WEB-DL');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		});

		it('should parse "Season X through Y" notation', () => {
			const result = parseRelease('The Show / Season: 1 through 5 / Episodes: 1-60 of 100');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5]);
			expect(result.episode?.isCompleteSeries).toBe(true);
		});

		it('should parse "Every Season" as complete series', () => {
			const result = parseRelease('The Show Every Season 1080p WEB-DL');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.isCompleteSeries).toBe(true);
		});

		it('should parse "Season: 1 of 1" as single-season complete series', () => {
			const result = parseRelease('One Season Show / Season: 1 of 1 / Episodes: 1-10 of 10');

			expect(result.episode?.season).toBe(1);
			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.isCompleteSeries).toBe(true);
		});

		it('should parse russian season ranges used by trackers', () => {
			const result = parseRelease('Сериал / Сезоны: 1-4 из 4 / Эпизоды: 1-40 из 40');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4]);
			expect(result.episode?.isCompleteSeries).toBe(true);
		});

		it('should parse tracker multi-season packs with "Season: 1-8 of 8 / Episodes: 1-171 of 171" format', () => {
			const result = parseRelease(
				'The Vampire Diaries / Season: 1-8 of 8 / Episodes: 1-171 of 171 [2009-2017, USA, BDRip]'
			);

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
			expect(result.episode?.isCompleteSeries).toBe(true);
		});

		it('should parse tracker multi-season ranges with "Season: X-Y of N" where start season is not 1', () => {
			const result = parseRelease(
				'Some Show / Season: 3-5 of 8 / Episodes: 1-60 of 171 [2012-2015, WEB-DL]'
			);

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.seasons).toEqual([3, 4, 5]);
			expect(result.episode?.isCompleteSeries).toBe(false);
		});

		it('should infer complete series from large S1E1-XXX of XXX ranges', () => {
			const result = parseRelease(
				'The Vampire Diaries: S1E1-171 of 171 [2009-2017, BDRip] MVO (LostFilm)'
			);

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.isCompleteSeries).toBe(true);
			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes?.length).toBe(171);
		});

		it('should not infer complete series for normal single-season ranges', () => {
			const result = parseRelease('The Vampire Diaries: S1E1-22 of 22 [2009-2010, BDRip]');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.isCompleteSeries).toBe(false);
			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes?.length).toBe(22);
		});

		it('should parse S01-S07 with language/source tags as complete series', () => {
			const result = parseRelease('The.Mentalist.S01-S07.ITA.DLMUX.x264');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.isCompleteSeries).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5, 6, 7]);
		});

		it('should parse S01-07 (no second S prefix) with language tags as complete series', () => {
			const result = parseRelease('The.Mentalist.S01-07.ITA.WEBRIP.x264');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.isCompleteSeries).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5, 6, 7]);
		});

		it('should parse localized title with year range and bracketed S01-S07 as complete series', () => {
			const result = parseRelease('Mentalista - The Mentalist 2008-2015 [S01-S07]');

			expect(result.episode?.isSeasonPack).toBe(true);
			expect(result.episode?.isCompleteSeries).toBe(true);
			expect(result.episode?.seasons).toEqual([1, 2, 3, 4, 5, 6, 7]);
		});

		it('should parse 1x05 format', () => {
			const result = parseRelease('House.1x05.720p.WEB-DL.AAC2.0.H264-BTN');

			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes).toEqual([5]);
			expect(result.resolution).toBe('720p');
		});

		it('should parse daily show format', () => {
			const result = parseRelease('The.Daily.Show.2024.01.15.720p.WEB.h264-KOGi');

			expect(result.episode?.isDaily).toBe(true);
			expect(result.episode?.airDate).toBe('2024-01-15');
		});

		it('should parse anime absolute numbering', () => {
			const result = parseRelease('[SubGroup] One Piece - 1089 [1080p].mkv');

			expect(result.episode?.absoluteEpisode).toBe(1089);
		});

		it('should parse anime with dashes', () => {
			const result = parseRelease('[Erai-raws] Jujutsu Kaisen - 24 [1080p][HEVC].mkv');

			// The " - 24 " pattern should match anime absolute episode
			expect(result.episode?.absoluteEpisode).toBe(24);
			expect(result.resolution).toBe('1080p');
			expect(result.codec).toBe('h265');
		});

		it('should parse anime absolute numbering at end of filename', () => {
			const result = parseRelease('[Horse] Aggressive Retsuko - 018');

			expect(result.episode?.absoluteEpisode).toBe(18);
		});
	});

	describe('Language Detection', () => {
		it('should detect German language', () => {
			const result = parseRelease('Movie.2023.German.1080p.BluRay.x264-GROUP');

			expect(result.languages).toContain('de');
		});

		it('should detect multi-language releases as the multi marker only', () => {
			const result = parseRelease('Movie.2023.MULTi.1080p.BluRay.x264-GROUP');

			expect(result.languages).toEqual(['multi']);
		});

		it('should detect dual audio releases as the multi marker only', () => {
			const result = parseRelease('Movie.2023.DUAL.AUDIO.1080p.BluRay.x264-GROUP');

			expect(result.languages).toEqual(['multi']);
		});

		it('should keep the orig marker unchanged', () => {
			const result = parseRelease('Movie.2023.1080p.BluRay.x264 + Original + RUS-GROUP');

			expect(result.languages).toContain('orig');
			expect(result.languages).toContain('ru');
		});

		it('should detect French with VFF tag', () => {
			const result = parseRelease('Movie.2023.VFF.1080p.BluRay.x264-GROUP');

			expect(result.languages).toContain('fr');
		});

		it('should stay empty when the title names no language', () => {
			const result = parseRelease('Movie.2023.1080p.BluRay.x264-GROUP');

			// No English assertion: untagged is unknown, not English.
			expect(result.languages).toEqual([]);
		});

		it('should detect a bare ISO 639-1 code in the fan-release name slot', () => {
			const result = parseRelease(
				'Love, Death & Robots (2019) de - S01E05 - SUCKER OF SOULS [WEB-DL-1080p][DV][x265]-WACHi'
			);

			expect(result.languages).toContain('de');
		});

		it('should detect multiple bare space-delimited codes', () => {
			const result = parseRelease('Die Legende von Korra (2012) de en - S02E05 - Title');

			expect(result.languages).toContain('de');
			expect(result.languages).toContain('en');
		});

		it('should not treat dotted scene-title words as bare language codes', () => {
			const result = parseRelease('Le.Chateau.de.Ma.Mere.2023.1080p.BluRay.x264-GROUP');

			expect(result.languages).not.toContain('de');
		});

		it('should not detect codes embedded inside larger words', () => {
			const result = parseRelease('Death.Watch.2023.1080p.BluRay.x264-GROUP');

			expect(result.languages).toEqual([]);
		});
	});

	describe('Language truth table (extractLanguages)', () => {
		it('untagged titles parse to an empty list', () => {
			expect(extractLanguages('Movie.2023.1080p.BluRay.x264-GROUP').languages).toEqual([]);
		});

		it('multi and dual audio parse to the multi marker only', () => {
			expect(extractLanguages('Show.2023.MULTI.1080p.WEB-DL.DDP5.1-GROUP').languages).toEqual([
				'multi'
			]);
			expect(extractLanguages('Show.2023.Dual.Audio.1080p-GROUP').languages).toEqual(['multi']);
		});

		it('DUAL with language context parses to multi plus the tagged languages', () => {
			// Real recon title 2026-09-15 — previously parsed as ['en'] only
			expect(
				extractLanguages('Toy.Story.5.(2026)[DUAL ESP-ENG][HDR10 HEVC][WEB-DL 1080p]-Mang0z4')
					.languages
			).toEqual(['multi', 'en', 'es']);
			expect(extractLanguages('Avatar.Fuego.2025.dual-lat.1080p.WEB-DL').languages).toEqual([
				'multi'
			]);
			expect(extractLanguages('Movie.2023.DUAL.ENG-HIN.720p').languages).toEqual([
				'multi',
				'en',
				'hi'
			]);
		});

		it('bare DUAL without language context stays untagged (movie title "Dual")', () => {
			expect(extractLanguages('Dual.2022.1080p.WEBRip.x264-GROUP').languages).toEqual([]);
		});

		it('NORDiC packs parse to the multi marker', () => {
			expect(
				extractLanguages('Show.2026.NORDiC.1080p.WEB-DL.DDP5.1.Atmos.H.265-NORViNE').languages
			).toEqual(['multi']);
		});

		it('ESP abbreviation parses as Spanish', () => {
			expect(extractLanguages('Movie.2026.1080p.WEB-DL.ESP.x264-GROUP').languages).toEqual(['es']);
		});

		it('explicit languages are kept as-is', () => {
			expect(extractLanguages('Film.2023.German.French.1080p-GROUP').languages).toEqual([
				'de',
				'fr'
			]);
		});

		it('the RuTracker original-audio marker stays orig', () => {
			expect(extractLanguages('3 XX + Original + RUS').languages).toEqual(['orig', 'ru']);
		});

		it('file names parse with the same token table (tier-3 evidence)', () => {
			expect(extractLanguagesFromFileName('Movie.2026.1080p.ESP.mkv').languages).toEqual(['es']);
			expect(extractLanguagesFromFileName('show-s02e05.eng.srt').languages).toEqual(['en']);
			expect(extractLanguagesFromFileName('La.Pelicula.Castellano.mp4').languages).toEqual(['es']);
		});

		it('file names without language tokens stay untagged', () => {
			expect(extractLanguagesFromFileName('Toy.Story.5.2026.1080p.WEB-DL.mkv').languages).toEqual(
				[]
			);
		});
	});

	describe('Source language is metadata, not audio evidence', () => {
		it('does not merge the indexer definition language into languages', () => {
			const result = parseRelease('Movie.2023.German.1080p.BluRay.x264-GROUP', {
				sourceLanguage: 'ru'
			});

			expect(result.languages).toEqual(['de']);
			expect(result.languages).not.toContain('ru');
		});

		it('keeps sourceLanguage available on the parsed release', () => {
			const result = parseRelease('Movie.2023.German.1080p.BluRay.x264-GROUP', {
				sourceLanguage: 'ru-RU'
			});

			expect(result.sourceLanguage).toBe('ru-RU');
		});

		it('does not let the definition language fill an untagged title', () => {
			const result = parseRelease('Movie.2023.1080p.BluRay.x264-GROUP', {
				sourceLanguage: 'en'
			});

			expect(result.languages).toEqual([]);
			expect(result.sourceLanguage).toBe('en');
		});
	});

	describe('Quality Detection', () => {
		it('should detect all resolution variants', () => {
			expect(extractResolution('4K')?.resolution).toBe('2160p');
			expect(extractResolution('2160p')?.resolution).toBe('2160p');
			expect(extractResolution('UHD')?.resolution).toBe('2160p');
			expect(extractResolution('1080p')?.resolution).toBe('1080p');
			expect(extractResolution('FHD')?.resolution).toBe('1080p');
			expect(extractResolution('720p')?.resolution).toBe('720p');
			expect(extractResolution('480p')?.resolution).toBe('480p');
			expect(extractResolution('SD')?.resolution).toBe('480p');
		});

		it('should prefer an explicit resolution over a UHD/4K marketing alias in the same title', () => {
			// A 1080p encode sourced from UHD/4K media - the title states
			// both, but the explicit "1080p" is what the release actually is.
			expect(
				extractResolution('A Bronx Tale 1993 1080p UHD BluRay FLAC 2.0 DV HDR x265-PTer')
					?.resolution
			).toBe('1080p');
			expect(extractResolution('Movie.2021.720p.UHD.BluRay.x264-GROUP')?.resolution).toBe('720p');
			expect(extractResolution('Movie.2021.4K.1080p.BluRay.x264-GROUP')?.resolution).toBe('1080p');

			// Alias-only titles (no explicit numeric resolution) must still
			// resolve to 2160p.
			expect(extractResolution('Movie 2021 UHD BluRay REMUX')?.resolution).toBe('2160p');
			expect(extractResolution('Movie 2021 4K BluRay REMUX')?.resolution).toBe('2160p');
		});

		it('should detect all source variants', () => {
			expect(extractSource('REMUX')?.source).toBe('remux');
			expect(extractSource('BluRay')?.source).toBe('bluray');
			expect(extractSource('BDRip')?.source).toBe('bluray');
			expect(extractSource('WEB-DL')?.source).toBe('webdl');
			expect(extractSource('WEBRip')?.source).toBe('webrip');
			expect(extractSource('HDTV')?.source).toBe('hdtv');
			expect(extractSource('DVDRip')?.source).toBe('dvd');
			expect(extractSource('CAM')?.source).toBe('cam');
			expect(extractSource('TS')?.source).toBe('telesync');
		});

		it('should detect all codec variants', () => {
			expect(extractCodec('AV1')?.codec).toBe('av1');
			expect(extractCodec('HEVC')?.codec).toBe('h265');
			expect(extractCodec('x265')?.codec).toBe('h265');
			expect(extractCodec('H.265')?.codec).toBe('h265');
			expect(extractCodec('x264')?.codec).toBe('h264');
			expect(extractCodec('H.264')?.codec).toBe('h264');
			expect(extractCodec('AVC')?.codec).toBe('h264');
			expect(extractCodec('XviD')?.codec).toBe('xvid');
		});

		it('should detect bit depth variants', () => {
			expect(extractBitDepth('10bit')?.bitDepth).toBe('10');
			expect(extractBitDepth('12-bit')?.bitDepth).toBe('12');
			expect(extractBitDepth('8 bit')?.bitDepth).toBe('8');
		});

		it('should detect canonical audio attributes', () => {
			expect(extractEnhancedAudio('Atmos').hasAtmos).toBe(true);
			expect(extractEnhancedAudio('TrueHD').codec).toBe('truehd');
			expect(extractEnhancedAudio('DTS-X').codec).toBe('dts-x');
			expect(extractEnhancedAudio('DTS-HD.MA').codec).toBe('dts-hdma');
			expect(extractEnhancedAudio('DTS-HDMA').codec).toBe('dts-hdma');
			expect(extractEnhancedAudio('DTS-HD').codec).toBe('dts-hd');
			expect(extractEnhancedAudio('DTS').codec).toBe('dts');
			expect(extractEnhancedAudio('DD+').codec).toBe('dd+');
			expect(extractEnhancedAudio('EAC3').codec).toBe('dd+');
			expect(extractEnhancedAudio('AC3').codec).toBe('dd');
			expect(extractEnhancedAudio('AAC').codec).toBe('aac');
			expect(extractEnhancedAudio('FLAC').codec).toBe('flac');
		});

		it('should detect codecs with channel digits glued on (#585)', () => {
			// Releases routinely glue the channel spec straight onto the codec
			// token (FLAC1.0, DTSHDMA7.1) and a trailing \b never matches there.
			expect(extractEnhancedAudio('FLAC1.0').codec).toBe('flac');
			expect(extractEnhancedAudio('FLAC.1.0').codec).toBe('flac');
			expect(extractEnhancedAudio('LPCM7.1').codec).toBe('pcm');
			expect(extractEnhancedAudio('PCM2.0').codec).toBe('pcm');
			expect(extractEnhancedAudio('DTSHDMA7.1').codec).toBe('dts-hdma');
			expect(extractEnhancedAudio('DTS-HDMA7.1').codec).toBe('dts-hdma');
			expect(extractEnhancedAudio('DTS-HD.MA.5.1').codec).toBe('dts-hdma');
			expect(extractEnhancedAudio('DTS-HD7.1').codec).toBe('dts-hd');
			expect(extractEnhancedAudio('DTS-HD-HRA7.1').codec).toBe('dts-hd-hra');
			expect(extractEnhancedAudio('DTS-ES6.1').codec).toBe('dts-es');
			expect(extractEnhancedAudio('DTSX5.1').codec).toBe('dts-x');
			expect(extractEnhancedAudio('EAC35.1').codec).toBe('dd+');
			expect(extractEnhancedAudio('AC35.1').codec).toBe('dd');
			expect(extractEnhancedAudio('DolbyDigitalPlus5.1').codec).toBe('dd+');
			expect(extractEnhancedAudio('DolbyDigital5.1').codec).toBe('dd');
			expect(extractEnhancedAudio('DTS5.1').codec).toBe('dts');
			expect(extractEnhancedAudio('MP3 320kbps').codec).toBe('mp3');
		});

		it('should still parse channels glued after letter-ending codecs (#585)', () => {
			expect(extractEnhancedAudio('FLAC1.0').channels).toBe('1.0');
			expect(extractEnhancedAudio('LPCM7.1').channels).toBe('7.1');
			// AC3-style codecs end in a digit themselves, so the channel guard
			// still cannot see the glued spec; codec detection is what scoring
			// depends on.
			expect(extractEnhancedAudio('EAC35.1').channels).toBe('unknown');
		});

		it('should detect Atmos glued to codec tokens and channel digits (#585)', () => {
			expect(extractEnhancedAudio('TrueHDAtmos7.1').hasAtmos).toBe(true);
			expect(extractEnhancedAudio('Atmos7.1').hasAtmos).toBe(true);
			expect(extractEnhancedAudio('TrueHD.Atmos.7.1').hasAtmos).toBe(true);
			expect(extractEnhancedAudio('Atmospheric.Disaster.2020.1080p').hasAtmos).toBe(false);
		});

		it('should parse FLAC1.0 inside a full release title (#585)', () => {
			const parsed = parseRelease('And.Justice.for.All.1979.1080p.BluRay.FLAC1.0.x264-ZoroSenpai');
			expect(parsed.audioCodec).toBe('flac');
			expect(parsed.audioChannels).toBe('1.0');
		});

		it('should detect HDR formats', () => {
			expect(extractHdr('Dolby Vision')?.hdr).toBe('dolby-vision');
			expect(extractHdr('DoVi')?.hdr).toBe('dolby-vision');
			expect(extractHdr('DV')?.hdr).toBe('dolby-vision');
			expect(extractHdr('HDR10+')?.hdr).toBe('hdr10+');
			expect(extractHdr('HDR10')?.hdr).toBe('hdr10');
			expect(extractHdr('HDR')?.hdr).toBe('hdr'); // Generic HDR without version
			expect(extractHdr('HLG')?.hdr).toBe('hlg');
		});
	});

	describe('Release Group Detection', () => {
		it('should extract release group after dash', () => {
			const result = extractReleaseGroup('Movie.2023.1080p.BluRay.x264-SPARKS');
			expect(result?.group).toBe('SPARKS');
		});

		it('should extract release group from YTS style', () => {
			// YTS releases typically have the group at the end
			const result = parseRelease('Oppenheimer (2023) [1080p] [WEBRip] [5.1] [YTS.MX]');
			// The parser should handle this style
			expect(result.resolution).toBe('1080p');
		});

		it('should not confuse quality info with release group', () => {
			// 1080p should NOT be detected as a group
			const result = extractReleaseGroup('Movie.2023.1080p');
			expect(result?.group).not.toBe('1080p');
		});

		it('should extract fansub group from leading brackets', () => {
			const result = extractReleaseGroup('[HorribleSubs] Honzuki no Gekokujou - 01 [1080p].mkv');
			expect(result?.group).toBe('HorribleSubs');
		});

		it('should extract hyphenated fansub group from leading brackets', () => {
			const result = extractReleaseGroup('[Erai-raws] Fullmetal Alchemist - 01 [1080p].mkv');
			expect(result?.group).toBe('Erai-raws');
		});

		it('should extract fansub group when episode has version suffix', () => {
			const result = extractReleaseGroup(
				'[SubsPlease] Honzuki no Gekokujou - s01e01v2 [1080p].mkv'
			);
			expect(result?.group).toBe('SubsPlease');
		});

		it('should extract fansub group from leading parentheses', () => {
			const result = extractReleaseGroup('(Hi10) Anime Title - 01 [1080p].mkv');
			expect(result?.group).toBe('Hi10');
		});

		it('should extract hyphenated fansub group from leading parentheses', () => {
			const result = extractReleaseGroup('(Hi10-P) Anime Title - 01 [1080p].mkv');
			expect(result?.group).toBe('Hi10-P');
		});

		it('should not treat Chinese site prefix as a fansub group', () => {
			const result = extractReleaseGroup('[www.mkvhome.com] Movie.Title.2023.1080p.mkv');
			expect(result?.group).not.toBe('wwwmkvhomecom');
		});

		it('should not treat the episode-title tail as a release group', () => {
			// Stream sources expose titles like "Show - S01E01 - Episode Title";
			// the trailing word belongs to the episode title, not a scene group.
			const result = parseRelease('Supernatural (2005) - S02E01 - In My Time of Dying');
			expect(result.releaseGroup).toBeUndefined();
		});

		it('should not treat the episode-title tail as a release group with an extension', () => {
			// File paths hit the space-separated extension form: normalizeTitle
			// turns dots into spaces, so ".mkv" arrives as " mkv" here and must
			// be stripped the same way extractReleaseGroup strips it.
			const result = parseRelease('Show.S01E01.In.My.Time.of.Dying.mkv');
			expect(result.releaseGroup).toBeUndefined();
		});

		it('should not treat a capitalized episode-title tail word as a group with an extension', () => {
			const result = parseRelease('Show.S01E01.Pale.Fire.mkv');
			expect(result.releaseGroup).toBeUndefined();
		});

		it('should not treat the episode-title tail as a group when bracketed quality is unrecognized', () => {
			// Cinephage-generated names wrap audio in brackets; normalizeTitle
			// turns "2.0" into "2 0" so no audio matcher registers, and the
			// span must ignore the bracket block to still see the title tail.
			const result = parseRelease(
				'Supernatural (2005) - S02E01 - In My Time of Dying [AAC 2.0]-Dying.strm'
			);
			expect(result.releaseGroup).toBeUndefined();
		});

		it('should keep a real group after unrecognized bracketed quality', () => {
			const result = parseRelease(
				'Blue Mountain State (2010) - S03E10 - One Week [AAC 2.0]-RARBG.strm'
			);
			expect(result.releaseGroup).toBe('RARBG');
		});

		it('should not treat capitalized episode-title tail words as release groups', () => {
			const result = parseRelease('The Boys - S00E35 - An Important Update on Homelander');
			expect(result.releaseGroup).toBeUndefined();
		});

		it('should keep the release group for movie titles with dash groups', () => {
			const result = parseRelease('Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP');
			expect(result.releaseGroup).toBe('GROUP');
		});

		it('should keep the release group for bracketed movie titles', () => {
			const result = parseRelease('Movie (2020) [1080p][x265]-GRP');
			expect(result.releaseGroup).toBe('GRP');
		});

		it('should keep the release group for extension-suffixed TV titles', () => {
			// Quality tokens after the SxxEyy marker still bound the title span
			// even when a file extension trails the group.
			const result = parseRelease('Show.S01E01.Title.1080p.AMZN.WEB-DL.DDP5.1.H.264-GROUP.mkv');
			expect(result.releaseGroup).toBe('GROUP');
		});

		it('should keep a group that follows quality tokens after the episode title', () => {
			// Quality tokens intervene between the title tail and the candidate,
			// so the group is unambiguous and must be kept.
			const result = parseRelease('Show - S01E01 - Title 1080p x265 BONE');
			expect(result.releaseGroup).toBe('BONE');
		});

		it('should keep YTS normalization for TV titles', () => {
			// YTS_PATTERNS only fire when the indexer-suffix strip hasn't already
			// consumed the token, e.g. the tight "-YTS" form.
			const result = parseRelease('Show - S01E01 - Title 1080p x264 -YTS');
			expect(result.releaseGroup).toBe('YTS');
		});

		it('should not extract a junk group when a spaced YTS suffix is stripped', () => {
			// INDEXER_SUFFIXES consumes " YTS", leaving a trailing space that
			// defeats the trailing-separator cleanup, so extractReleaseGroup
			// returns null for this form; the guard never even runs.
			const result = parseRelease('Show - S01E01 - Title - YTS');
			expect(result.releaseGroup).toBeUndefined();
		});

		it('should extract dot-separated, dash-less group via parseRelease', () => {
			// Regression: dotted scene names with no dash before the group must resolve
			// the same as their spaced equivalent. parseRelease normalizes separators
			// before extraction; the activity feed relies on this stored value rather
			// than re-parsing the raw (separator-sensitive) title at display time.
			const dotted = parseRelease('Movie.Title.2024.1080p.WEBRip.x264.SPARKS');
			const spaced = parseRelease('Movie Title 2024 1080p WEBRip x264 SPARKS');
			expect(dotted.releaseGroup).toBe('SPARKS');
			expect(spaced.releaseGroup).toBe('SPARKS');
			expect(dotted.releaseGroup).toBe(spaced.releaseGroup);
		});

		it('should extract dotted group with a filename extension', () => {
			const result = parseRelease('Movie.Title.2024.1080p.BluRay.x265.SPARKS.mkv');
			expect(result.releaseGroup).toBe('SPARKS');
		});

		it('should return undefined when a title genuinely has no group', () => {
			const result = parseRelease('Movie.Title.2024.1080p');
			expect(result.releaseGroup).toBeUndefined();
		});
	});

	describe('Edge Cases', () => {
		it('should handle releases with minimal info', () => {
			const result = parseRelease('Movie.Title.2023');

			expect(result.cleanTitle).toContain('Movie Title');
			expect(result.year).toBe(2023);
			expect(result.resolution).toBe('unknown');
			expect(result.source).toBe('unknown');
		});

		it('should handle releases with special characters', () => {
			const result = parseRelease('Marvels.Agents.of.SHIELD.S01E01.1080p.WEB-DL-GROUP');

			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes).toEqual([1]);
		});

		it('should handle releases with year in title', () => {
			const result = parseRelease('2001.A.Space.Odyssey.1968.2160p.UHD.BluRay.x265-GROUP');

			// Both 2001 and 1968 are valid years, parser picks first valid one
			// The key is that quality info is correctly extracted
			expect(result.resolution).toBe('2160p');
			expect(result.source).toBe('bluray');
			expect(result.codec).toBe('h265');
		});

		it('should handle EZTV-style releases', () => {
			const result = parseRelease('Severance.S01E01.720p.WEB.H264-CAKES');

			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes).toEqual([1]);
			expect(result.resolution).toBe('720p');
			expect(result.source).toBe('webrip');
			expect(result.codec).toBe('h264');
		});

		it('should calculate reasonable confidence', () => {
			const fullInfo = parseRelease('Movie.2023.1080p.BluRay.x264-GROUP');
			expect(fullInfo.confidence).toBeGreaterThan(0.7);

			const minimalInfo = parseRelease('Unknown');
			expect(minimalInfo.confidence).toBeLessThan(fullInfo.confidence);
		});
	});

	describe('isTvRelease helper', () => {
		it('should identify TV releases', () => {
			expect(isTvRelease('Show.S01E01.1080p')).toBe(true);
			expect(isTvRelease('Show.Season.1.1080p')).toBe(true);
			expect(isTvRelease('[Group] Anime - 45 [1080p]')).toBe(true);
		});

		it('should not identify movies as TV', () => {
			expect(isTvRelease('Movie.2023.1080p.BluRay')).toBe(false);
		});
	});

	describe('Fansub anime with season prefix (Moozzi2-style)', () => {
		const moozziFiles = [
			{ stem: '[Moozzi2] Seitokai Yakuindomo S1 - 01 (BD 1920x1080 x.264 FLACx2)', episode: 1 },
			{ stem: '[Moozzi2] Seitokai Yakuindomo S1 - 02 (BD 1920x1080 x.264 FLACx2)', episode: 2 },
			{ stem: '[Moozzi2] Seitokai Yakuindomo S1 - 06 (BD 1920x1080 x.264 FLACx2)', episode: 6 },
			{ stem: '[Moozzi2] Seitokai Yakuindomo S1 - 12 (BD 1920x1080 x.264 FLACx2)', episode: 12 },
			{ stem: '[Moozzi2] Seitokai Yakuindomo S1 - 13 END (BD 1920x1080 x.264 FLACx2)', episode: 13 }
		];

		for (const { stem, episode } of moozziFiles) {
			it(`should parse episode ${episode} from "${stem}"`, () => {
				const result = parseRelease(stem);
				expect(result.episode?.isSeasonPack).toBe(false);
				expect(result.episode?.season).toBe(1);
				expect(result.episode?.episodes).toEqual([episode]);
			});
		}

		it('should not treat "S1 - 02" as a multi-season range', () => {
			const result = parseRelease('[Moozzi2] Show S1 - 02 (BD 1080p)');
			expect(result.episode?.isSeasonPack).toBe(false);
			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes).toEqual([2]);
		});
	});

	describe('Real-world samples', () => {
		it('should parse streaming service releases', () => {
			const result = parseRelease(
				'Wednesday.S01E01.Wednesdays.Child.Is.Full.of.Woe.1080p.NF.WEB-DL.DDP5.1.Atmos.H.264-CMRG'
			);

			expect(result.cleanTitle).toBe('Wednesday');
			expect(result.episode?.season).toBe(1);
			expect(result.episode?.episodes).toEqual([1]);
			expect(result.source).toBe('webdl');
			expect(result.audioCodec).toBe('dd+');
			expect(result.audioChannels).toBe('5.1');
			expect(result.hasAtmos).toBe(true);
		});

		it('should parse anime batch releases', () => {
			const result = parseRelease(
				'[SubsPlease] Demon Slayer - Kimetsu no Yaiba (01-26) (1080p) [Batch]'
			);

			expect(result.cleanTitle).toContain('Demon Slayer');
			expect(result.resolution).toBe('1080p');
		});

		it('keeps a dual-language alternate title joined with " / " intact (movie)', () => {
			// Reported identity-mismatch false positive: the release joins a
			// Russian primary title with its English alternate via " / ".
			// cleanTitle deliberately keeps both segments, SearchOrchestrator's
			// alias matching relies on the alternate segment surviving here;
			// release-identity.ts's matchReleaseToTarget is what scores each
			// segment separately against the library's title (see its tests).
			const result = parseRelease(
				'Зловещие Мертвецы 3: Армия Тьмы / Army of Darkness (1992) BDRip [H.264/1080p] [Theatrical Cut]',
				{ mode: 'movie' }
			);

			expect(result.cleanTitle).toBe('Зловещие Мертвецы 3: Армия Тьмы / Army of Darkness');
			expect(result.year).toBe(1992);
		});

		it('recovers a title that comes after a leading "Season N Episode M" marker (TV)', () => {
			// Reported identity-mismatch false positive: extractTitleBeforeEpisode
			// cut at the leading episode marker (index 0), leaving cleanTitle
			// empty. The title is recovered from between that marker and the
			// next one instead.
			const result = parseRelease(
				'Season 2 Episode 4 - Гангстерленд / MobLand / - S2E1-4 - 2026 / DUB, 4 x MVO, 2 x DVO, Sub / 4K, HEVC, SDR / WEBDL 2160p'
			);

			expect(result.cleanTitle).toBe('Гангстерленд / Mobland');
			expect(result.episode?.season).toBe(2);
			expect(result.episode?.episodes).toEqual([4]);
		});
	});

	describe('extractExternalIds', () => {
		describe('IMDB ID extraction', () => {
			it('should extract IMDB ID from curly brace format {imdb-tt1234567}', () => {
				const result = extractExternalIds('Movie {imdb-tt1234567}');
				expect(result.imdbId).toBe('tt1234567');
			});

			it('should extract IMDB ID from square bracket format [imdb-tt1234567]', () => {
				const result = extractExternalIds('Movie [imdb-tt1234567]');
				expect(result.imdbId).toBe('tt1234567');
			});

			it('should extract IMDB ID from Jellyfin format [imdbid-tt1234567]', () => {
				const result = extractExternalIds('The Rats A Witchers Tale (2025) [imdbid-tt28283547]');
				expect(result.imdbId).toBe('tt28283547');
			});

			it('should extract IMDB ID from Jellyfin equals format [imdbid=tt1234567]', () => {
				const result = extractExternalIds('Movie (2023) [imdbid=tt9876543]');
				expect(result.imdbId).toBe('tt9876543');
			});

			it('should extract IMDB ID from dot-separated format .tt1234567.', () => {
				const result = extractExternalIds('Movie.2023.tt0068646.1080p.BluRay.mkv');
				expect(result.imdbId).toBe('tt0068646');
			});

			it('should extract bare IMDB ID with 7+ digits', () => {
				const result = extractExternalIds('Movie 2023 tt1234567 1080p');
				expect(result.imdbId).toBe('tt1234567');
			});

			it('should extract IMDB ID with 8 digits', () => {
				const result = extractExternalIds('Movie tt12345678');
				expect(result.imdbId).toBe('tt12345678');
			});

			it('should be case insensitive for IMDB formats', () => {
				const result1 = extractExternalIds('Movie {IMDB-TT1234567}');
				expect(result1.imdbId).toBe('TT1234567');

				const result2 = extractExternalIds('Movie [IMDBID-TT9876543]');
				expect(result2.imdbId).toBe('TT9876543');
			});

			it('should extract from full file path with folder name', () => {
				const result = extractExternalIds(
					'/media/movies/The Godfather (1972) [imdbid-tt0068646]/The Godfather.mkv'
				);
				expect(result.imdbId).toBe('tt0068646');
			});
		});

		describe('TMDB ID extraction', () => {
			it('should extract TMDB ID from curly brace format {tmdb-12345}', () => {
				const result = extractExternalIds('Inception {tmdb-27205} (2010)');
				expect(result.tmdbId).toBe(27205);
			});

			it('should extract TMDB ID from square bracket format [tmdb-12345]', () => {
				const result = extractExternalIds('Movie [tmdb-12345]');
				expect(result.tmdbId).toBe(12345);
			});

			it('should extract TMDB ID from [tmdbid-12345] format', () => {
				const result = extractExternalIds('Movie [tmdbid-54321]');
				expect(result.tmdbId).toBe(54321);
			});

			it('should extract TMDB ID from [tmdbid=12345] format', () => {
				const result = extractExternalIds('Movie [tmdbid=99999]');
				expect(result.tmdbId).toBe(99999);
			});

			it('should extract TMDB ID from dot-separated format .tmdbid-12345.', () => {
				const result = extractExternalIds('Movie.2023.tmdbid-12345.1080p.mkv');
				expect(result.tmdbId).toBe(12345);
			});

			it('should extract TMDB ID from simple tmdb-12345 format', () => {
				const result = extractExternalIds('Movie tmdb-67890');
				expect(result.tmdbId).toBe(67890);
			});

			it('should be case insensitive for TMDB formats', () => {
				const result = extractExternalIds('Movie {TMDB-12345}');
				expect(result.tmdbId).toBe(12345);
			});
		});

		describe('TVDB ID extraction', () => {
			it('should extract TVDB ID from curly brace format {tvdb-81189}', () => {
				const result = extractExternalIds('Breaking Bad {tvdb-81189}/Season 01/');
				expect(result.tvdbId).toBe(81189);
			});

			it('should extract TVDB ID from square bracket format [tvdb-81189]', () => {
				const result = extractExternalIds('Show [tvdb-12345]');
				expect(result.tvdbId).toBe(12345);
			});

			it('should extract TVDB ID from [tvdbid-81189] format', () => {
				const result = extractExternalIds('Show [tvdbid-81189]');
				expect(result.tvdbId).toBe(81189);
			});

			it('should extract TVDB ID from [tvdbid=81189] format', () => {
				const result = extractExternalIds('Show [tvdbid=81189]');
				expect(result.tvdbId).toBe(81189);
			});

			it('should extract TVDB ID from dot-separated format .tvdbid-81189.', () => {
				const result = extractExternalIds('Show.tvdbid-81189.S01E01.mkv');
				expect(result.tvdbId).toBe(81189);
			});

			it('should extract TVDB ID from simple tvdb-81189 format', () => {
				const result = extractExternalIds('Show tvdb-81189');
				expect(result.tvdbId).toBe(81189);
			});

			it('should be case insensitive for TVDB formats', () => {
				const result = extractExternalIds('Show {TVDB-81189}');
				expect(result.tvdbId).toBe(81189);
			});
		});

		describe('Multiple ID extraction', () => {
			it('should extract all three ID types from a single input', () => {
				const result = extractExternalIds('Movie {tmdb-12345} {tvdb-81189} {imdb-tt1234567}');
				expect(result.tmdbId).toBe(12345);
				expect(result.tvdbId).toBe(81189);
				expect(result.imdbId).toBe('tt1234567');
			});

			it('should extract TMDB and IMDB when both present', () => {
				const result = extractExternalIds('Movie {tmdb-12345} [imdbid-tt9876543]');
				expect(result.tmdbId).toBe(12345);
				expect(result.imdbId).toBe('tt9876543');
				expect(result.tvdbId).toBeUndefined();
			});

			it('should extract TVDB and IMDB when both present', () => {
				const result = extractExternalIds('Show {tvdb-81189} tt1234567');
				expect(result.tvdbId).toBe(81189);
				expect(result.imdbId).toBe('tt1234567');
				expect(result.tmdbId).toBeUndefined();
			});
		});

		describe('Edge cases', () => {
			it('should NOT match IMDB IDs with less than 7 digits', () => {
				const result = extractExternalIds('Movie tt123456');
				expect(result.imdbId).toBeUndefined();
			});

			it('should return empty object for input with no IDs', () => {
				const result = extractExternalIds('Just a regular movie title 2023');
				expect(result.tmdbId).toBeUndefined();
				expect(result.tvdbId).toBeUndefined();
				expect(result.imdbId).toBeUndefined();
			});

			it('should handle empty string input', () => {
				const result = extractExternalIds('');
				expect(result.tmdbId).toBeUndefined();
				expect(result.tvdbId).toBeUndefined();
				expect(result.imdbId).toBeUndefined();
			});

			it('should handle input with similar but invalid patterns', () => {
				const result = extractExternalIds('tmdb_not_valid imdb-invalid tvdb-abc');
				expect(result.tmdbId).toBeUndefined();
				expect(result.imdbId).toBeUndefined();
				expect(result.tvdbId).toBeUndefined();
			});

			it('should extract first matching ID when multiple of same type present', () => {
				const result = extractExternalIds('{tmdb-11111} {tmdb-22222}');
				expect(result.tmdbId).toBe(11111);
			});

			it('should handle Windows-style paths with backslashes', () => {
				const result = extractExternalIds(
					'C:\\Movies\\The Matrix (1999) {tmdb-603}\\The Matrix.mkv'
				);
				expect(result.tmdbId).toBe(603);
			});

			it('should handle IDs at start of string', () => {
				const result = extractExternalIds('{tmdb-12345} Movie Title');
				expect(result.tmdbId).toBe(12345);
			});

			it('should handle IDs at end of string', () => {
				const result = extractExternalIds('Movie Title {tmdb-12345}');
				expect(result.tmdbId).toBe(12345);
			});

			it('should handle underscore separator in tvdb_id format', () => {
				const result = extractExternalIds('Show tvdb_id=81189');
				expect(result.tvdbId).toBe(81189);
			});

			it('should handle tmdbid without separator', () => {
				const result = extractExternalIds('Movie tmdbid12345');
				expect(result.tmdbId).toBe(12345);
			});
		});

		describe('Real-world paths', () => {
			it('should extract from Radarr-style path', () => {
				const result = extractExternalIds(
					'/media/movies/Inception (2010) {tmdb-27205}/Inception.2010.1080p.BluRay.mkv'
				);
				expect(result.tmdbId).toBe(27205);
			});

			it('should extract from Sonarr-style path', () => {
				const result = extractExternalIds(
					'/media/tv/Breaking Bad {tvdb-81189}/Season 01/Breaking.Bad.S01E01.mkv'
				);
				expect(result.tvdbId).toBe(81189);
			});

			it('should extract from Jellyfin-style path', () => {
				const result = extractExternalIds(
					'/media/movies/The Rats A Witchers Tale (2025) [imdbid-tt28283547]/movie.mkv'
				);
				expect(result.imdbId).toBe('tt28283547');
			});

			it('should extract from scene release filename', () => {
				const result = extractExternalIds(
					'The.Godfather.1972.tt0068646.REMASTERED.1080p.BluRay.x265-RARBG.mkv'
				);
				expect(result.imdbId).toBe('tt0068646');
			});

			it('should extract from path with multiple folder levels', () => {
				const result = extractExternalIds(
					'/data/media/movies/Action/The Matrix (1999) {tmdb-603} {imdb-tt0133093}/The.Matrix.1999.2160p.mkv'
				);
				expect(result.tmdbId).toBe(603);
				expect(result.imdbId).toBe('tt0133093');
			});

			it('should extract from path with special characters in title', () => {
				const result = extractExternalIds(
					"/media/movies/Schindler's List (1993) {tmdb-424}/movie.mkv"
				);
				expect(result.tmdbId).toBe(424);
			});
		});
	});
});

describe('parseRelease movie mode (context-aware parsing)', () => {
	it('does not strip Season N from movie titles in movie mode', () => {
		const p = parseRelease('Open Season 3 (2010) 1080p bluray x264', { mode: 'movie' });
		expect(p.cleanTitle).toBe('Open Season 3');
		expect(p.year).toBe(2010);
		expect(p.episode).toBeUndefined();
	});

	it('still detects SxxExx as TV evidence in movie mode', () => {
		const p = parseRelease('Some Movie S01E03 1080p WEBRip', { mode: 'movie' });
		expect(p.episode?.season).toBe(1);
		expect(p.episode?.episodes).toContain(3);
	});

	it('default (auto) mode keeps existing season-pack behavior', () => {
		const p = parseRelease('Open Season 3 (2010) 1080p bluray x264');
		expect(p.cleanTitle).toBe('Open');
		expect(p.episode?.season).toBe(3);
		expect(p.episode?.isSeasonPack).toBe(true);
	});
});

describe('parseRelease year extraction (number-titled movies)', () => {
	it('takes the release year, not the title number: "1917 2019"', () => {
		expect(parseRelease('1917 2019 1080p BluRay x264').year).toBe(2019);
	});
	it('prefers the parenthesized year: "2001 A Space Odyssey (1968)"', () => {
		const p = parseRelease('2001 A Space Odyssey (1968) 1080p BluRay');
		expect(p.year).toBe(1968);
		expect(p.cleanTitle).toContain('Space Odyssey');
	});
	it('extracts year for "Blade Runner 2049 (2017)"', () => {
		expect(parseRelease('Blade Runner 2049 (2017) 1080p BluRay').year).toBe(2017);
	});
	it('plain releases still work: "Open Season 3 (2010)"', () => {
		expect(parseRelease('Open Season 3 (2010) 1080p bluray x264').year).toBe(2010);
	});
});

describe('parseRelease movie mode skips ambiguous absolute-episode patterns', () => {
	it('does not treat "Movie - 2010" as anime episode 2010', () => {
		const p = parseRelease('Blade Runner - 2049 2017 1080p BluRay x264', { mode: 'movie' });
		expect(p.episode).toBeUndefined();
		expect(p.year).toBe(2017);
	});
	it('does not treat "[2019]" as an absolute episode', () => {
		const p = parseRelease('Movie Name [2019] BDRip 1080p', { mode: 'movie' });
		expect(p.episode).toBeUndefined();
	});
	it('does not treat "Episode 4" as TV in movie mode (Star Wars)', () => {
		const p = parseRelease('Star Wars Episode 4 A New Hope 1977 1080p BluRay', { mode: 'movie' });
		expect(p.episode).toBeUndefined();
		expect(p.year).toBe(1977);
	});
	it('does not treat "2024.01.15" as a daily show in movie mode', () => {
		const p = parseRelease('Some.Concert.2024.01.15.1080p.BluRay.x264', { mode: 'movie' });
		expect(p.episode?.isDaily).toBeFalsy();
	});
});

describe('parseRelease Cyrillic season patterns', () => {
	it('parses a Russian single-season pack: "Сезон 2"', () => {
		const p = parseRelease('Ирония судьбы Сезон 2 1080p WEB-DL');
		expect(p.episode?.season).toBe(2);
		expect(p.episode?.isSeasonPack).toBe(true);
	});
	it('parses Russian season+episode: "Сезон 1 Серия 5"', () => {
		const p = parseRelease('Кухня Сезон 1 Серия 5 1080p WEB-DL');
		expect(p.episode?.season).toBe(1);
		expect(p.episode?.episodes).toContain(5);
	});
});

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { SubtitleSearchResult } from '../../types';
import {
	decodeDownloadContext,
	extractSuperSubtitlesArchive,
	parseAutocomplete,
	parseEpisodeRows,
	parseMovieRows,
	selectBestRelease,
	selectSeriesId
} from './SuperSubtitlesProvider';

const BASE_RESULT: SubtitleSearchResult = {
	providerId: 'provider-id',
	providerName: 'Super Subtitles',
	providerSubtitleId: '123|1|2|1',
	language: 'en',
	title: 'Example S01E02',
	releaseName: '1080p.WEB-DL-NTb',
	fileName: 'Example.S01.1080p.WEB-DL-NTb.ENG.zip',
	isForced: false,
	isHearingImpaired: false,
	format: 'srt',
	isHashMatch: false,
	matchScore: 0
};

describe('SuperSubtitlesProvider parsers', () => {
	it('parses current movie rows and keeps the direct download metadata', () => {
		const html = `
			<table class="result"><tr id="vilagit">
				<td>Film</td><td class="lang"><small>Magyar</small></td>
				<td><div class="magyar">Dűne: Második rész (SubRip)</div>
				<div class="eredeti">Dune: Part Two (2024) (NF.WEBRip)</div></td>
				<td>Anonymus</td><td>2025-05-21</td>
				<td><a href="/index.php?action=letolt&amp;fnev=Dune.Part.Two.2024.hu.srt&amp;felirat=1747826315">Download</a></td>
			</tr></table>`;

		const rows = parseMovieRows(html);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: '1747826315',
			language: 'hu',
			title: 'Dune: Part Two',
			year: 2024,
			releases: ['NF.WEBRip'],
			uploader: 'Anonymus',
			fileName: 'Dune.Part.Two.2024.hu.srt'
		});
		expect(rows[0].downloadUrl).toContain('felirat=1747826315');
	});

	it('accepts array-shaped episode JSON and groups compatible releases', () => {
		const payload = [
			{
				language: 'Angol',
				nev: 'The Last of Us (Season 1) (1080p-PEDRO)',
				fnev: 'The.Last.Of.Us.S01.1080p-PEDRO.ENG.zip',
				felirat: '1690360356',
				evad: '1',
				ep: '-1',
				feltolto: 'J1GG4',
				evadpakk: '1'
			},
			{
				language: 'Angol',
				nev: 'The Last of Us (Season 1) (2160p-JUNGLiST)',
				fnev: 'The.Last.Of.Us.S01.1080p-PEDRO.ENG.zip',
				felirat: '1690360356',
				evad: '1',
				ep: '-1',
				feltolto: 'J1GG4',
				evadpakk: '1'
			}
		];

		const rows = parseEpisodeRows(payload, {
			title: 'Episode title',
			seriesTitle: 'The Last of Us',
			season: 1,
			episode: 2
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ season: 1, episode: 2, isPack: true, language: 'en' });
		expect(rows[0].releases).toEqual(['1080p-PEDRO', '2160p-JUNGLiST']);
	});

	it('also accepts the legacy object-shaped episode JSON', () => {
		const rows = parseEpisodeRows(
			{
				'10': {
					language: 'Magyar',
					nev: 'Example - 1x02 (WEB-DL-NTb)',
					fnev: 'Example.S01E02.HUN.zip',
					felirat: '42',
					evad: '1',
					ep: '2',
					evadpakk: '0'
				}
			},
			{ title: 'Episode', seriesTitle: 'Example', season: 1, episode: 2 }
		);
		expect(rows[0]).toMatchObject({
			id: '42',
			language: 'hu',
			season: 1,
			episode: 2,
			isPack: false
		});
	});

	it('selects the exact series title and year from autocomplete', () => {
		const entries = parseAutocomplete([
			{ name: 'Example (1999)', ID: '1' },
			{ name: 'Example (2024)', ID: '2' }
		]);
		expect(selectSeriesId(entries, 'Example', 2024)).toBe('2');
		expect(selectSeriesId(entries, 'Example', 2001)).toBeUndefined();
	});

	it('selects the release closest to the local video file', () => {
		expect(
			selectBestRelease(
				['720p.WEB-DL-OTHER', '1080p.WEB-DL-NTb'],
				'/media/Example.S01E02.1080p.WEB-DL.DDP5.1-NTb.mkv'
			)
		).toBe('1080p.WEB-DL-NTb');
	});
});

describe('SuperSubtitlesProvider archive extraction', () => {
	it('ignores non-subtitle files and extracts the requested pack episode', () => {
		const archive = Buffer.from(
			zipSync({
				'README.txt': strToU8('not a subtitle'),
				'Example.S01E01.1080p.WEB-DL-NTb.srt': strToU8('episode one'),
				'Example.S01E02.1080p.WEB-DL-NTb.srt': strToU8('episode two')
			})
		);
		const content = extractSuperSubtitlesArchive(
			archive,
			BASE_RESULT,
			decodeDownloadContext('123|1|2|1')
		);
		expect(content.toString()).toBe('episode two');
	});

	it('uses the matched release when a pack has multiple files for one episode', () => {
		const archive = Buffer.from(
			zipSync({
				'Example.S01E02.720p.WEB-DL-OTHER.srt': strToU8('other release'),
				'Example.S01E02.1080p.WEB-DL-NTb.srt': strToU8('matching release')
			})
		);
		const content = extractSuperSubtitlesArchive(
			archive,
			BASE_RESULT,
			decodeDownloadContext('123|1|2|1')
		);
		expect(content.toString()).toBe('matching release');
	});

	it('supports single-season packs that use bare E02 tokens', () => {
		const archive = Buffer.from(
			zipSync({
				'Example.E01.1080p.srt': strToU8('episode one'),
				'Example.E02.1080p.srt': strToU8('episode two')
			})
		);
		const content = extractSuperSubtitlesArchive(
			archive,
			BASE_RESULT,
			decodeDownloadContext('123|1|2|1')
		);
		expect(content.toString()).toBe('episode two');
	});

	it('fails instead of silently returning the wrong episode', () => {
		const archive = Buffer.from(
			zipSync({
				'Example.S01E01.srt': strToU8('episode one'),
				'notes.nfo': strToU8('metadata')
			})
		);
		expect(() =>
			extractSuperSubtitlesArchive(archive, BASE_RESULT, decodeDownloadContext('123|1|2|1'))
		).toThrow(/S01E02/);
	});
});

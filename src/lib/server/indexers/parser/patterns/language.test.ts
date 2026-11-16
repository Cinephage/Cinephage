import { describe, expect, it } from 'vitest';
import { extractAudioLanguages, extractLanguages, stripSubtitleClauses } from './language';

/**
 * Real titles, because the distinction only matters where releases actually
 * mix audio and subtitle groups: a RuTracker line like
 * `Dub + MVO + Sub Rus, Eng, Zho + Original Zho` carries Russian/Chinese audio
 * and an English subtitle, and the English tag used to count as audio.
 */
describe('stripSubtitleClauses', () => {
	it('drops a subtitle group but keeps the audio groups around it', () => {
		const title =
			'Bu feng zhui ying / The Shadow\u2019s Edge (Larry Yang) [2025, BDRip 1080p] Dub + MVO + VO + Sub Rus, Eng, Zho + Original Zho';
		expect(stripSubtitleClauses(title)).toBe(
			'Bu feng zhui ying / The Shadow\u2019s Edge (Larry Yang) [2025, BDRip 1080p] Dub + MVO + VO + Original Zho'
		);
	});

	it('drops an inline subtitle marker and what follows it', () => {
		expect(stripSubtitleClauses('Movie.2026.Sub.Eng.1080p')).toBe('Movie.2026');
	});

	it('leaves titles without a subtitle clause untouched', () => {
		const title = 'The Shadow\u2019s Edge 2025 iTA-CHi Bluray 2160p HEVC HDR x265-CYBER';
		expect(stripSubtitleClauses(title)).toBe(title);
	});

	it('does not treat a word merely starting with "sub" as a marker', () => {
		const title = 'The Substitute (1996) 1080p BluRay x264';
		expect(stripSubtitleClauses(title)).toBe(title);
	});
});

describe('extractAudioLanguages', () => {
	it('ignores subtitle-only language tags', () => {
		const title =
			'Bu feng zhui ying / The Shadow\u2019s Edge (Larry Yang) [2025, BDRip 1080p] Dub + MVO + VO + Sub Rus, Eng, Zho + Original Zho';
		expect(extractAudioLanguages(title).languages).not.toContain('en');
		expect(extractAudioLanguages(title).languages).toContain('orig');
	});

	it('sees subtitle tags while the raw extractor still reports them', () => {
		const title = 'Movie.2026.Sub.Eng.1080p.WEB-DL';
		expect(extractLanguages(title).languages).toContain('en');
		expect(extractAudioLanguages(title).languages).toEqual([]);
	});

	it('keeps audio language tags intact', () => {
		expect(extractAudioLanguages('Movie.2026.GERMAN.DL.1080p').languages).toContain('de');
		expect(extractAudioLanguages('Movie.2026.MULTi.1080p').languages).toContain('multi');
		expect(
			extractAudioLanguages('The Shadow\u2019s Edge 2025 iTA-CHi Bluray 2160p').languages
		).toEqual(['it', 'zh']);
	});
});

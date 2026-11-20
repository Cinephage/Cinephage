import { describe, it, expect } from 'vitest';
import {
	DEFAULT_MUSIC_PROFILE,
	gradeMusicRelease,
	parseMusicRelease,
	type MusicQualityProfile
} from './parse-release.js';

/** Titles taken from a live search, not invented. */
describe('parseMusicRelease', () => {
	it('reads a plain FLAC album name', () => {
		const parsed = parseMusicRelease('Daft Punk Discovery 2001 FLAC 88');

		expect(parsed).toMatchObject({ format: 'flac', lossless: true, year: 2001 });
		expect(parsed.bitrateKbps).toBeNull();
	});

	it('reads bit depth and sample rate from the 24-96 shorthand', () => {
		const parsed = parseMusicRelease('Daft Punk - Discovery (2001) [24-96 Hi Res] [FLAC]');

		expect(parsed).toMatchObject({ format: 'flac', bitDepth: 24, sampleRateKhz: 96, year: 2001 });
	});

	it('reads a bitrate written with an underscore or dash separator', () => {
		// Live title from TheRARBG: "… Asylum  Rap  Hip-Hop  (2026) 320_kbps Beats".
		const parsed = parseMusicRelease(
			'Inpatient (Chris Webby) - Asylum Rap Hip-Hop (2026) 320_kbps Beats'
		);

		expect(parsed.bitrateKbps).toBe(320);
	});

	it('reads a lossy bitrate without mistaking a year for one', () => {
		const parsed = parseMusicRelease('Daft Punk Discography 1997 2013 Mp3 320 88');

		expect(parsed).toMatchObject({ format: 'mp3', lossless: false, bitrateKbps: 320, year: 1997 });
	});

	it('recognises a vinyl rip by its usual markers', () => {
		const parsed = parseMusicRelease('Daft Punk - Homework (1997) (PBTHAL LP 24-96) FLAC 88');

		expect(parsed).toMatchObject({ source: 'vinyl', bitDepth: 24, sampleRateKhz: 96 });
	});

	it('recognises a web source and an unknown format', () => {
		expect(parseMusicRelease('Some Album 2020 WEB FLAC').source).toBe('web');
		const unknown = parseMusicRelease('Some Album 2020');
		expect(unknown.format).toBe('unknown');
		expect(unknown.lossless).toBe(false);
	});
});

describe('gradeMusicRelease — tiers, not seeders', () => {
	it('puts hi-res lossless on the top rung and 16-bit lossless one below', () => {
		const hires = gradeMusicRelease(DEFAULT_MUSIC_PROFILE, {
			title: 'Album (2021) [24-96] [FLAC]'
		});
		const cd = gradeMusicRelease(DEFAULT_MUSIC_PROFILE, { title: 'Album (2021) [FLAC]' });

		expect(hires.tierIndex).toBe(0);
		expect(cd.tierIndex).toBe(1);
		expect(hires.tierIndex).toBeLessThan(cd.tierIndex);
	});

	it('falls back to lossy only when the profile allows it', () => {
		const strict: MusicQualityProfile = { ...DEFAULT_MUSIC_PROFILE, allowFallback: false };

		const loose = gradeMusicRelease(DEFAULT_MUSIC_PROFILE, { title: 'Album 2020 MP3 320' });
		expect(loose.tierIndex).toBe(2);
		expect(loose.accepted).toBe(true);

		const strictGrade = gradeMusicRelease(strict, { title: 'Album 2020 MP3 320' });
		expect(strictGrade.accepted).toBe(false);
		expect(strictGrade.reasons.join(' ')).toMatch(/fallback is off/);
	});

	it('rejects a release no tier matches, and a size outside the bounds', () => {
		const profile: MusicQualityProfile = {
			...DEFAULT_MUSIC_PROFILE,
			minSizeMb: 50,
			maxSizeMb: 5000
		};

		expect(gradeMusicRelease(profile, { title: 'Album 2020' }).accepted).toBe(false);
		expect(
			gradeMusicRelease(profile, { title: 'Album 2020 FLAC', size: 10 * 1024 * 1024 }).accepted
		).toBe(false);
		expect(
			gradeMusicRelease(profile, { title: 'Album 2020 FLAC', size: 400 * 1024 * 1024 }).accepted
		).toBe(true);
	});

	it('uses the source only to break ties inside a rung', () => {
		const vinyl = gradeMusicRelease(DEFAULT_MUSIC_PROFILE, {
			title: 'Album (2021) (PBTHAL LP) FLAC'
		});
		const web = gradeMusicRelease(DEFAULT_MUSIC_PROFILE, { title: 'Album (2021) WEB FLAC' });

		expect(vinyl.tierIndex).toBe(web.tierIndex);
		expect(vinyl.score).toBeGreaterThan(web.score);
	});
});

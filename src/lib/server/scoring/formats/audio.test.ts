/**
 * Audio Format Tests
 *
 * Validates built-in audio formats against canonical parsed release attributes.
 */

import { describe, expect, it } from 'vitest';
import { matchFormats } from '../matcher.js';
import type { ReleaseAttributes } from '../types.js';
import {
	LOSSLESS_AUDIO_FORMATS,
	ATMOS_FORMATS,
	HQ_LOSSY_AUDIO_FORMATS,
	STANDARD_AUDIO_FORMATS,
	AUDIO_CHANNEL_FORMATS,
	ALL_AUDIO_FORMATS
} from './audio.js';

function createRelease(overrides: Partial<ReleaseAttributes> = {}): ReleaseAttributes {
	const hdr = overrides.hdr ?? null;
	return {
		title: 'Movie.2024.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.Atmos.7.1-GROUP',
		cleanTitle: 'Movie',
		year: 2024,
		resolution: '2160p',
		source: 'remux',
		codec: 'h265',
		hdr,
		hdrFormats: overrides.hdrFormats ?? (hdr ? [hdr] : []),
		audioCodec: 'truehd',
		audioChannels: '7.1',
		hasAtmos: true,
		releaseGroup: 'GROUP',
		streamingService: undefined,
		edition: undefined,
		languages: ['en'],
		isRemux: true,
		isRepack: false,
		isProper: false,
		is3d: false,
		...overrides
	};
}

describe('Audio Format Matching', () => {
	it('matches lossless codec formats using canonical audioCodec', () => {
		const release = createRelease({ audioCodec: 'truehd', hasAtmos: false });
		const matched = matchFormats(release, LOSSLESS_AUDIO_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('audio-truehd');
		expect(matched).not.toContain('audio-dts-hdma');
	});

	it('matches DTS:X correctly', () => {
		const release = createRelease({ audioCodec: 'dts-x', hasAtmos: false });
		const matched = matchFormats(release, LOSSLESS_AUDIO_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('audio-dts-x');
		expect(matched).not.toContain('audio-truehd');
	});

	it('matches Atmos as a separate stackable feature', () => {
		const release = createRelease({ audioCodec: 'dd+', hasAtmos: true, source: 'webdl' });
		const matched = matchFormats(release, ATMOS_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('audio-atmos');
	});

	it('does not match Atmos when hasAtmos is false', () => {
		const release = createRelease({ audioCodec: 'dd+', hasAtmos: false, source: 'webdl' });
		const matched = matchFormats(release, ATMOS_FORMATS).map((format) => format.format.id);

		expect(matched).not.toContain('audio-atmos');
	});

	it('matches high quality lossy codecs via audioCodec', () => {
		const release = createRelease({ audioCodec: 'dts-hd-hra', hasAtmos: false });
		const matched = matchFormats(release, HQ_LOSSY_AUDIO_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('audio-dts-hd-hra');
	});

	it('matches standard lossy codecs via audioCodec', () => {
		const release = createRelease({ audioCodec: 'dd+', hasAtmos: false, source: 'webdl' });
		const matched = matchFormats(release, STANDARD_AUDIO_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('audio-ddplus');
		expect(matched).not.toContain('audio-dd');
	});

	it('matches audio channel formats via audioChannels', () => {
		const release = createRelease({ audioChannels: '5.1', hasAtmos: false, audioCodec: 'aac' });
		const matched = matchFormats(release, AUDIO_CHANNEL_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('audio-channels-51');
		expect(matched).not.toContain('audio-channels-71');
	});

	it('keeps all built-in audio format IDs unique', () => {
		const ids = ALL_AUDIO_FORMATS.map((format) => format.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

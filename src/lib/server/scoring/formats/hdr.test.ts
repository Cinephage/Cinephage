import { describe, expect, it } from 'vitest';

import { matchFormats } from '../matcher.js';
import type { ReleaseAttributes } from '../types.js';
import {
	ALL_HDR_FORMATS,
	DOLBY_VISION_FORMATS,
	HDR10_FORMATS,
	OTHER_HDR_FORMATS,
	SDR_FORMAT
} from './hdr.js';

function createRelease(overrides: Partial<ReleaseAttributes> = {}): ReleaseAttributes {
	const hdr = overrides.hdr ?? null;
	return {
		title: 'Movie.2024.2160p.WEB-DL.H.265-GROUP',
		cleanTitle: 'Movie',
		year: 2024,
		resolution: '2160p',
		source: 'webdl',
		codec: 'h265',
		hdr,
		hdrFormats: overrides.hdrFormats ?? (hdr ? [hdr] : []),
		audioCodec: 'unknown',
		audioChannels: 'unknown',
		hasAtmos: false,
		releaseGroup: 'GROUP',
		isRemux: false,
		isRepack: false,
		isProper: false,
		is3d: false,
		languages: [],
		...overrides
	};
}

describe('HDR Formats', () => {
	it('should expose the expected registry counts', () => {
		expect(DOLBY_VISION_FORMATS).toHaveLength(1);
		expect(HDR10_FORMATS).toHaveLength(3);
		expect(OTHER_HDR_FORMATS).toHaveLength(2);
		expect(ALL_HDR_FORMATS.at(-1)?.id).toBe(SDR_FORMAT.id);
	});

	it('should match Dolby Vision as a single canonical format', () => {
		const release = createRelease({ hdr: 'dolby-vision' });
		const matched = matchFormats(release, ALL_HDR_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('hdr-dolby-vision');
	});

	it('should match HDR10+', () => {
		const release = createRelease({ hdr: 'hdr10+' });
		const matched = matchFormats(release, ALL_HDR_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('hdr-hdr10plus');
	});

	it('should match HDR10', () => {
		const release = createRelease({ hdr: 'hdr10' });
		const matched = matchFormats(release, ALL_HDR_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('hdr-hdr10');
	});

	it('should match generic HDR', () => {
		const release = createRelease({ hdr: 'hdr' });
		const matched = matchFormats(release, ALL_HDR_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('hdr-generic');
	});

	it('should match HLG', () => {
		const release = createRelease({ hdr: 'hlg' });
		const matched = matchFormats(release, ALL_HDR_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('hdr-hlg');
	});

	it('should match PQ', () => {
		const release = createRelease({ hdr: 'pq' });
		const matched = matchFormats(release, ALL_HDR_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('hdr-pq');
	});

	it('should treat null HDR as SDR', () => {
		const release = createRelease({ hdr: null });
		const matched = matchFormats(release, ALL_HDR_FORMATS).map((format) => format.format.id);

		expect(matched).toContain('hdr-sdr');
	});
});

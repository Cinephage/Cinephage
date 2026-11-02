import { describe, expect, it, vi } from 'vitest';

vi.mock('./scorer.js', () => ({
	parseRelease: (name: string) => ({
		title: name,
		cleanTitle: name,
		resolution: 'unknown',
		source: 'unknown',
		codec: 'unknown',
		hdr: null,
		hdrFormats: [],
		audioCodec: 'unknown',
		audioChannels: 'unknown',
		hasAtmos: false,
		languages: [],
		isRemux: false,
		isRepack: false,
		isProper: false,
		is3d: false
	})
}));

import { buildExistingAttrs } from './utils.js';

describe('buildExistingAttrs HDR handling (#640)', () => {
	it('restores the full stored HDR set', () => {
		const attrs = buildExistingAttrs({
			relativePath: 'Movie.2024.2160p.WEB-DL.DV.HDR10+.H.265-GRP.mkv',
			quality: { resolution: '2160p', hdr: 'dolby-vision', hdrFormats: ['dolby-vision', 'hdr10+'] }
		});

		expect(attrs?.hdrFormats).toEqual(['dolby-vision', 'hdr10+']);
		expect(attrs?.hdr).toBe('dolby-vision');
	});

	it('falls back to the scalar for rows written before hdrFormats existed', () => {
		const attrs = buildExistingAttrs({
			relativePath: 'Movie.2024.2160p.WEB-DL.DV.H.265-GRP.mkv',
			quality: { resolution: '2160p', hdr: 'dolby-vision' }
		});

		expect(attrs?.hdrFormats).toEqual(['dolby-vision']);
		expect(attrs?.hdr).toBe('dolby-vision');
	});

	it('normalizes a stored set into canonical order', () => {
		const attrs = buildExistingAttrs({
			relativePath: 'Movie.2024.2160p.H.265-GRP.mkv',
			quality: { resolution: '2160p', hdrFormats: ['hdr10+', 'dolby-vision'] }
		});

		expect(attrs?.hdrFormats).toEqual(['dolby-vision', 'hdr10+']);
		expect(attrs?.hdr).toBe('dolby-vision');
	});

	it('ignores non-canonical legacy labels instead of matching on them', () => {
		// Older backfills wrote display labels ("DV"); they must not be trusted
		// as canonical format values.
		const attrs = buildExistingAttrs({
			relativePath: 'Movie.2024.2160p.H.265-GRP.mkv',
			quality: { resolution: '2160p', hdr: 'DV' }
		});

		expect(attrs?.hdrFormats).toEqual([]);
		expect(attrs?.hdr).toBeNull();
	});

	it('leaves HDR empty when nothing was stored', () => {
		const attrs = buildExistingAttrs({
			relativePath: 'Movie.2024.2160p.H.265-GRP.mkv',
			quality: { resolution: '2160p' }
		});

		expect(attrs?.hdrFormats).toEqual([]);
		expect(attrs?.hdr).toBeNull();
	});
});

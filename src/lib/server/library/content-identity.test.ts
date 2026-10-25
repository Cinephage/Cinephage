import { describe, expect, it } from 'vitest';
import { contentAlreadyPresent } from './content-identity.js';

const MEDIA_INFO = {
	containerFormat: 'mkv',
	videoCodec: 'hevc',
	videoBitDepth: 10,
	width: 3840,
	height: 2160,
	runtime: 7200,
	audioCodec: 'eac3',
	audioChannels: 6,
	audioLanguages: ['eng'],
	subtitleLanguages: ['eng', 'spa']
};

describe('contentAlreadyPresent', () => {
	it('matches on infoHash alone, even with differing size/mediaInfo', () => {
		expect(
			contentAlreadyPresent({ infoHash: 'abc123', size: 1, mediaInfo: null }, 'abc123', 999, null)
		).toBe(true);
	});

	it('still matches on size/mediaInfo when infoHash differs (same bytes re-grabbed from a different release)', () => {
		expect(
			contentAlreadyPresent(
				{ infoHash: 'abc123', size: 100, mediaInfo: MEDIA_INFO },
				'def456',
				100,
				MEDIA_INFO
			)
		).toBe(true);
	});

	it('does not match when infoHash differs and mediaInfo also differs', () => {
		expect(
			contentAlreadyPresent(
				{ infoHash: 'abc123', size: 100, mediaInfo: MEDIA_INFO },
				'def456',
				100,
				{ ...MEDIA_INFO, videoCodec: 'avc' }
			)
		).toBe(false);
	});

	it('falls back to size + mediaInfo equality when no infoHash is available', () => {
		expect(
			contentAlreadyPresent({ infoHash: null, size: 100, mediaInfo: MEDIA_INFO }, null, 100, {
				...MEDIA_INFO
			})
		).toBe(true);
	});

	it('does not match when mediaInfo differs (e.g. a real upgrade)', () => {
		expect(
			contentAlreadyPresent({ infoHash: null, size: 100, mediaInfo: MEDIA_INFO }, null, 100, {
				...MEDIA_INFO,
				videoCodec: 'avc'
			})
		).toBe(false);
	});

	it('does not match when sizes differ', () => {
		expect(
			contentAlreadyPresent(
				{ infoHash: null, size: 100, mediaInfo: MEDIA_INFO },
				null,
				200,
				MEDIA_INFO
			)
		).toBe(false);
	});

	it('does not match when mediaInfo is missing on either side', () => {
		expect(
			contentAlreadyPresent({ infoHash: null, size: 100, mediaInfo: null }, null, 100, MEDIA_INFO)
		).toBe(false);
		expect(
			contentAlreadyPresent({ infoHash: null, size: 100, mediaInfo: MEDIA_INFO }, null, 100, null)
		).toBe(false);
	});

	it('treats array fields order-sensitively but value-equal arrays as equal', () => {
		expect(
			contentAlreadyPresent({ infoHash: null, size: 100, mediaInfo: MEDIA_INFO }, null, 100, {
				...MEDIA_INFO,
				audioLanguages: ['eng'],
				subtitleLanguages: ['eng', 'spa']
			})
		).toBe(true);
		expect(
			contentAlreadyPresent({ infoHash: null, size: 100, mediaInfo: MEDIA_INFO }, null, 100, {
				...MEDIA_INFO,
				subtitleLanguages: ['spa', 'eng']
			})
		).toBe(false);
	});

	it('skips the size/mediaInfo fallback for .strm candidates even when they match exactly', () => {
		expect(
			contentAlreadyPresent(
				{ infoHash: null, size: 100, mediaInfo: MEDIA_INFO },
				null,
				100,
				MEDIA_INFO,
				true
			)
		).toBe(false);
	});

	it('still trusts an infoHash match for .strm candidates', () => {
		expect(
			contentAlreadyPresent(
				{ infoHash: 'abc123', size: 100, mediaInfo: MEDIA_INFO },
				'abc123',
				999,
				null,
				true
			)
		).toBe(true);
	});
});

import { describe, it, expect } from 'vitest';
import { musicQualityLabel } from './release-quality.js';

describe('musicQualityLabel', () => {
	it('says the bitrate when the codec is missing instead of UNKNOWN', () => {
		expect(musicQualityLabel({ format: 'unknown', bitrateKbps: 320 })).toBe('320 kbps · codec?');
	});

	it('stays Unknown when the name states neither', () => {
		expect(musicQualityLabel({ format: 'unknown' })).toBe('Unknown');
	});

	it('reads a lossless ladder entry', () => {
		expect(musicQualityLabel({ format: 'flac', bitDepth: 24, sampleRateKhz: 96 })).toBe(
			'FLAC 24-bit/96'
		);
	});

	it('puts the bitrate after a lossy codec', () => {
		expect(musicQualityLabel({ format: 'mp3', bitrateKbps: 320 })).toBe('MP3 320');
	});
});

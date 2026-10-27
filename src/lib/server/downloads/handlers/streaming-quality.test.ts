import { describe, expect, it } from 'vitest';
import {
	buildStreamingQuality,
	resolutionFromHeight,
	resolveStreamingResolution
} from './streaming-quality.js';

describe('resolutionFromHeight', () => {
	it('maps real 4K heights to 2160p', () => {
		expect(resolutionFromHeight(2160)).toBe('2160p');
		expect(resolutionFromHeight(3840)).toBe('2160p');
	});

	it('maps the lower tiers', () => {
		expect(resolutionFromHeight(1080)).toBe('1080p');
		expect(resolutionFromHeight(720)).toBe('720p');
		expect(resolutionFromHeight(480)).toBe('480p');
		expect(resolutionFromHeight(360)).toBe('unknown');
	});

	it('returns undefined when no height is known', () => {
		expect(resolutionFromHeight(undefined)).toBeUndefined();
		expect(resolutionFromHeight(null)).toBeUndefined();
		expect(resolutionFromHeight(0)).toBeUndefined();
	});
});

describe('resolveStreamingResolution', () => {
	it('prefers the probed height over the release name', () => {
		expect(resolveStreamingResolution({ height: 2160 }, '1080p')).toBe('2160p');
		expect(resolveStreamingResolution({ height: 1080 }, '2160p')).toBe('1080p');
	});

	it('falls back to the parsed resolution when no height was probed', () => {
		expect(resolveStreamingResolution(undefined, '2160p')).toBe('2160p');
		expect(resolveStreamingResolution({}, '2160p')).toBe('2160p');
	});

	it('ignores the synthetic .strm placeholder dimensions', () => {
		// getStrmMediaInfo() returns 1920x1080 for an unprobed .strm; that is
		// not evidence of a 1080p source.
		expect(resolveStreamingResolution({ containerFormat: 'strm', height: 1080 }, '2160p')).toBe(
			'2160p'
		);
		expect(resolveStreamingResolution({ containerFormat: 'strm', height: 1080 }, 'unknown')).toBe(
			'unknown'
		);
	});

	it('reports unknown instead of defaulting to 1080p', () => {
		expect(resolveStreamingResolution(undefined, 'unknown')).toBe('unknown');
		expect(resolveStreamingResolution(undefined, undefined)).toBe('unknown');
	});
});

describe('buildStreamingQuality', () => {
	it('returns the streaming quality blob for the resolved resolution', () => {
		expect(buildStreamingQuality({ height: 2160 }, { resolution: '1080p' })).toEqual({
			resolution: '2160p',
			source: 'Streaming',
			codec: 'HLS',
			hdr: undefined
		});
	});
});

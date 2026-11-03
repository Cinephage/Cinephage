import { describe, it, expect } from 'vitest';
import { vadFromSamples, mergeCloseSegments } from './vad.js';
import type { TimeSpan } from './types.js';

/**
 * Build a Required<VadOptions> for tests.
 */
function testVadOptions(
	overrides: Partial<{
		sampleRate: number;
		frameSize: number;
		hopSize: number;
		thresholdMultiplier: number;
		minSpeechDurationMs: number;
		maxGapMs: number;
		ffmpegPath: string;
	}> = {}
) {
	return {
		sampleRate: 16000,
		frameSize: 512,
		hopSize: 256,
		thresholdMultiplier: 1.5,
		minSpeechDurationMs: 200,
		maxGapMs: 300,
		ffmpegPath: 'ffmpeg',
		...overrides
	};
}

/**
 * Generate a synthetic PCM signal: silence for a range, loud tone for another.
 * Values are Int16 [-32768, 32767].
 */
function generatePcm(
	totalSamples: number,
	segments: Array<{ startSample: number; endSample: number; amplitude: number }>
): Int16Array {
	const pcm = new Int16Array(totalSamples);
	for (const seg of segments) {
		for (let i = seg.startSample; i < seg.endSample && i < totalSamples; i++) {
			// Simple sine-ish wave to produce energy
			pcm[i] = Math.round(seg.amplitude * Math.sin((i * Math.PI * 2) / 64));
		}
	}
	return pcm;
}

describe('vad', () => {
	// =========================================================================
	// mergeCloseSegments
	// =========================================================================
	describe('mergeCloseSegments', () => {
		it('should return empty array for empty input', () => {
			expect(mergeCloseSegments([], 300)).toEqual([]);
		});

		it('should return single segment unchanged', () => {
			const segs: TimeSpan[] = [{ start: 100, end: 500 }];
			const result = mergeCloseSegments(segs, 300);
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ start: 100, end: 500 });
		});

		it('should merge segments separated by less than maxGap', () => {
			const segs: TimeSpan[] = [
				{ start: 100, end: 500 },
				{ start: 700, end: 1000 } // gap = 200ms < 300ms maxGap
			];
			const result = mergeCloseSegments(segs, 300);
			expect(result).toHaveLength(1);
			expect(result[0].start).toBe(100);
			expect(result[0].end).toBe(1000);
		});

		it('should not merge segments separated by more than maxGap', () => {
			const segs: TimeSpan[] = [
				{ start: 100, end: 500 },
				{ start: 900, end: 1200 } // gap = 400ms > 300ms maxGap
			];
			const result = mergeCloseSegments(segs, 300);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ start: 100, end: 500 });
			expect(result[1]).toEqual({ start: 900, end: 1200 });
		});

		it('should merge segments separated by exactly maxGap', () => {
			const segs: TimeSpan[] = [
				{ start: 0, end: 100 },
				{ start: 400, end: 600 } // gap = 300ms = maxGap
			];
			const result = mergeCloseSegments(segs, 300);
			expect(result).toHaveLength(1);
			expect(result[0].start).toBe(0);
			expect(result[0].end).toBe(600);
		});

		it('should merge multiple consecutive close segments', () => {
			const segs: TimeSpan[] = [
				{ start: 0, end: 100 },
				{ start: 200, end: 300 }, // gap 100
				{ start: 400, end: 500 }, // gap 100
				{ start: 600, end: 700 } // gap 100
			];
			const result = mergeCloseSegments(segs, 150);
			expect(result).toHaveLength(1);
			expect(result[0].start).toBe(0);
			expect(result[0].end).toBe(700);
		});

		it('should handle mix of mergeable and non-mergeable segments', () => {
			const segs: TimeSpan[] = [
				{ start: 0, end: 100 },
				{ start: 200, end: 300 }, // gap 100 - merge with first
				{ start: 1000, end: 1100 }, // gap 700 - new segment
				{ start: 1200, end: 1300 } // gap 100 - merge with third
			];
			const result = mergeCloseSegments(segs, 150);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ start: 0, end: 300 });
			expect(result[1]).toEqual({ start: 1000, end: 1300 });
		});

		it('should not mutate the input array', () => {
			const segs: TimeSpan[] = [
				{ start: 0, end: 100 },
				{ start: 200, end: 300 }
			];
			const origEnd = segs[0].end;
			mergeCloseSegments(segs, 300);
			expect(segs[0].end).toBe(origEnd);
		});
	});

	// =========================================================================
	// vadFromSamples
	// =========================================================================
	describe('vadFromSamples', () => {
		it('should return empty for empty samples', () => {
			const result = vadFromSamples(new Int16Array(0), testVadOptions());
			expect(result).toEqual([]);
		});

		it('should return empty for samples shorter than frame size', () => {
			// frameSize=512, so 100 samples can't form a frame
			const result = vadFromSamples(new Int16Array(100), testVadOptions());
			expect(result).toEqual([]);
		});

		it('should return empty for silence', () => {
			// All zeros - energy is 0, threshold is 0, no speech
			const silence = new Int16Array(16000); // 1 second of silence
			const result = vadFromSamples(silence, testVadOptions());
			expect(result).toEqual([]);
		});

		it('should detect a loud segment in silence', () => {
			const sampleRate = 16000;
			const totalSamples = sampleRate * 2; // 2 seconds
			// Loud segment from 0.5s to 1.5s
			const pcm = generatePcm(totalSamples, [
				{ startSample: sampleRate / 2, endSample: (sampleRate * 3) / 2, amplitude: 20000 }
			]);
			const result = vadFromSamples(pcm, testVadOptions());
			expect(result.length).toBeGreaterThanOrEqual(1);
			// The detected segment should be roughly around 500ms-1500ms
			const seg = result[0];
			expect(seg.start).toBeGreaterThanOrEqual(300); // some tolerance
			expect(seg.end).toBeLessThanOrEqual(1700);
		});

		it('should detect multiple speech segments', () => {
			const sampleRate = 16000;
			const totalSamples = sampleRate * 4; // 4 seconds
			// Two loud segments with a gap between them
			const pcm = generatePcm(totalSamples, [
				{ startSample: 0, endSample: sampleRate, amplitude: 25000 }, // 0-1s
				{ startSample: sampleRate * 2, endSample: sampleRate * 3, amplitude: 25000 } // 2-3s
			]);
			const result = vadFromSamples(
				pcm,
				testVadOptions({ maxGapMs: 100 }) // small gap so they don't merge
			);
			expect(result.length).toBeGreaterThanOrEqual(2);
		});

		it('should filter short segments below minSpeechDuration', () => {
			const sampleRate = 16000;
			const totalSamples = sampleRate * 2; // 2 seconds
			// Loud segment of ~150ms (2400 samples) - above VAD threshold but
			// below minSpeechDurationMs=500. With a large loud region to set a
			// meaningful mean energy, the short burst should still be filtered.
			const pcm = generatePcm(totalSamples, [
				// Long loud region (1s) to establish high mean energy
				{ startSample: 0, endSample: sampleRate, amplitude: 20000 },
				// Short burst that should be filtered at 500ms min duration
				{ startSample: sampleRate + 4000, endSample: sampleRate + 6400, amplitude: 20000 }
			]);
			// Use high minSpeechDuration so the short burst gets filtered
			const resultHigh = vadFromSamples(
				pcm,
				testVadOptions({ minSpeechDurationMs: 500, maxGapMs: 50 })
			);
			// With low minSpeechDuration, both segments should appear
			const resultLow = vadFromSamples(
				pcm,
				testVadOptions({ minSpeechDurationMs: 10, maxGapMs: 50 })
			);
			// resultLow should have more (or equal) segments than resultHigh,
			// since the high threshold filters short ones
			expect(resultLow.length).toBeGreaterThanOrEqual(resultHigh.length);
			// All segments in resultHigh should be at least 500ms
			for (const seg of resultHigh) {
				expect(seg.end - seg.start).toBeGreaterThanOrEqual(500);
			}
		});

		it('should merge close segments with maxGap', () => {
			const sampleRate = 16000;
			const totalSamples = sampleRate * 4; // 4 seconds
			// Two loud segments separated by a small silent gap (~100ms)
			const pcm = generatePcm(totalSamples, [
				{ startSample: 0, endSample: sampleRate, amplitude: 25000 }, // 0-1s
				{
					startSample: sampleRate + 1600,
					endSample: sampleRate * 2 + 1600,
					amplitude: 25000
				} // ~1.1-2.1s
			]);
			// With large maxGap the two segments should merge
			const merged = vadFromSamples(
				pcm,
				testVadOptions({ maxGapMs: 500, minSpeechDurationMs: 50 })
			);
			// With tiny maxGap the two segments should stay separate
			const separate = vadFromSamples(
				pcm,
				testVadOptions({ maxGapMs: 10, minSpeechDurationMs: 50 })
			);
			// merged should have fewer or equal segments than separate
			expect(merged.length).toBeLessThanOrEqual(separate.length);
			// With such a large maxGap, the two should merge into 1
			expect(merged.length).toBe(1);
		});

		it('should handle custom sample rate', () => {
			const sampleRate = 8000;
			const totalSamples = sampleRate * 2;
			const pcm = generatePcm(totalSamples, [
				{ startSample: sampleRate / 2, endSample: (sampleRate * 3) / 2, amplitude: 20000 }
			]);
			const result = vadFromSamples(
				pcm,
				testVadOptions({ sampleRate, frameSize: 256, hopSize: 128 })
			);
			expect(result.length).toBeGreaterThanOrEqual(1);
		});
	});
});

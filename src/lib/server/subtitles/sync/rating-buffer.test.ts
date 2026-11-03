import { describe, it, expect } from 'vitest';
import {
	constantRating,
	advanceRating,
	getRatingAt,
	addRatings,
	constantOffset,
	advanceOffset,
	getOffsetAt,
	advanceDual,
	DifferentialRatingBufferBuilder,
	ratingBufferMaximum,
	ratingBufferGetAt,
	iterateRatingBuffer,
	singleSpanRatings,
	addRatingToBuffer,
	shiftBufferSimple,
	extendBufferTo,
	leftToRightMaximum,
	combinedMaximumDual,
	separateDualSegments,
	simplifyRatingBuffer,
	offsetBufferGetAt,
	type RatingBuffer,
	type DualFullSegment,
	type OffsetBuffer
} from './rating-buffer.js';
import { standardScoring } from './scoring.js';

describe('rating-buffer', () => {
	// =========================================================================
	// RatingInfo operations
	// =========================================================================
	describe('RatingInfo', () => {
		it('constantRating should create zero-slope info', () => {
			const info = constantRating(5);
			expect(info.rating).toBe(5);
			expect(info.delta).toBe(0);
		});

		it('advanceRating should compute value at offset', () => {
			const info = { rating: 10, delta: 2 };
			const advanced = advanceRating(info, 5);
			expect(advanced.rating).toBe(20); // 10 + 2*5
			expect(advanced.delta).toBe(2);
		});

		it('getRatingAt should return value without modifying info', () => {
			const info = { rating: 10, delta: 3 };
			expect(getRatingAt(info, 4)).toBe(22); // 10 + 3*4
		});

		it('addRatings should sum both fields', () => {
			const a = { rating: 5, delta: 2 };
			const b = { rating: 3, delta: -1 };
			const sum = addRatings(a, b);
			expect(sum.rating).toBe(8);
			expect(sum.delta).toBe(1);
		});
	});

	// =========================================================================
	// OffsetInfo operations
	// =========================================================================
	describe('OffsetInfo', () => {
		it('constantOffset should create non-dragging offset', () => {
			const info = constantOffset(100);
			expect(info.offset).toBe(100);
			expect(info.drag).toBe(false);
		});

		it('advanceOffset should not change constant offset', () => {
			const info = constantOffset(100);
			const advanced = advanceOffset(info, 50);
			expect(advanced.offset).toBe(100);
		});

		it('advanceOffset should advance dragging offset', () => {
			const info = { offset: 100, drag: true };
			const advanced = advanceOffset(info, 50);
			expect(advanced.offset).toBe(150);
		});

		it('getOffsetAt should return constant for non-drag', () => {
			expect(getOffsetAt(constantOffset(42), 100)).toBe(42);
		});

		it('getOffsetAt should add position for drag', () => {
			expect(getOffsetAt({ offset: 42, drag: true }, 10)).toBe(52);
		});
	});

	// =========================================================================
	// DualInfo operations
	// =========================================================================
	describe('DualInfo', () => {
		it('advanceDual should advance both rating and offset', () => {
			const dual = {
				ratingInfo: { rating: 10, delta: 2 },
				offsetInfo: { offset: 5, drag: true }
			};
			const advanced = advanceDual(dual, 3);
			expect(advanced.ratingInfo.rating).toBe(16); // 10 + 2*3
			expect(advanced.offsetInfo.offset).toBe(8); // 5 + 3
		});
	});

	// =========================================================================
	// DifferentialRatingBufferBuilder
	// =========================================================================
	describe('DifferentialRatingBufferBuilder', () => {
		it('should build an empty buffer', () => {
			const builder = new DifferentialRatingBufferBuilder(0, 100);
			builder.extendToEnd();
			const buf = builder.build();
			expect(buf.start).toBe(0);
			expect(buf.segments).toHaveLength(1);
			expect(buf.segments[0].endPoint).toBe(100);
			expect(buf.segments[0].data.rating).toBe(0);
			expect(buf.segments[0].data.delta).toBe(0);
		});

		it('should accumulate delta-delta at the same endpoint', () => {
			const builder = new DifferentialRatingBufferBuilder(0, 100);
			builder.addSegment(50, 1);
			builder.addSegment(50, 2); // same endpoint
			builder.extendToEnd();
			const buf = builder.build();
			// First segment [0, 50): rating=0, delta=0
			// But internal dd=3 at endpoint 50
			expect(buf.segments.length).toBeGreaterThanOrEqual(1);
		});

		it('should produce a single-slope buffer for one changepoint', () => {
			const builder = new DifferentialRatingBufferBuilder(0, 100);
			builder.addSegment(50, 0.5);
			builder.extendToEnd();
			const buf = builder.build();
			// Before 50: rating=0, delta=0
			// After 50: delta becomes 0.5
			expect(buf.start).toBe(0);
			expect(buf.segments.length).toBe(2);
			expect(buf.segments[0].data.delta).toBe(0);
			expect(buf.segments[1].data.delta).toBe(0.5);
		});
	});

	// =========================================================================
	// Rating Buffer operations
	// =========================================================================
	describe('ratingBufferMaximum', () => {
		it('should find maximum rating and offset', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [
					{ endPoint: 50, data: { rating: 0, delta: 1 } }, // rises to 49 at offset 49
					{ endPoint: 100, data: { rating: 50, delta: -1 } } // falls from 50
				]
			};
			const { rating, offset } = ratingBufferMaximum(buf);
			expect(rating).toBe(50);
			expect(offset).toBe(50); // start of second segment
		});

		it('should handle flat buffer', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [{ endPoint: 100, data: { rating: 0, delta: 0 } }]
			};
			const { rating, offset } = ratingBufferMaximum(buf);
			expect(rating).toBe(0);
			expect(offset).toBe(0);
		});
	});

	describe('ratingBufferGetAt', () => {
		it('should interpolate within a segment', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [{ endPoint: 100, data: { rating: 10, delta: 0.5 } }]
			};
			expect(ratingBufferGetAt(buf, 0)).toBe(10);
			expect(ratingBufferGetAt(buf, 20)).toBe(20); // 10 + 0.5*20
		});

		it('should return 0 for offset outside buffer', () => {
			const buf: RatingBuffer = {
				start: 10,
				segments: [{ endPoint: 20, data: { rating: 5, delta: 0 } }]
			};
			expect(ratingBufferGetAt(buf, 0)).toBe(0); // before start
			expect(ratingBufferGetAt(buf, 25)).toBe(0); // after end
		});
	});

	describe('iterateRatingBuffer', () => {
		it('should yield full segments with start points', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [
					{ endPoint: 50, data: { rating: 0, delta: 1 } },
					{ endPoint: 100, data: { rating: 50, delta: 0 } }
				]
			};
			const fullSegs = [...iterateRatingBuffer(buf)];
			expect(fullSegs).toHaveLength(2);
			expect(fullSegs[0].start).toBe(0);
			expect(fullSegs[0].end).toBe(50);
			expect(fullSegs[1].start).toBe(50);
			expect(fullSegs[1].end).toBe(100);
		});
	});

	// =========================================================================
	// Buffer modification operations
	// =========================================================================
	describe('addRatingToBuffer', () => {
		it('should add constant to all segment ratings', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [
					{ endPoint: 50, data: { rating: 10, delta: 1 } },
					{ endPoint: 100, data: { rating: 20, delta: 0 } }
				]
			};
			const result = addRatingToBuffer(buf, 5);
			expect(result.segments[0].data.rating).toBe(15);
			expect(result.segments[1].data.rating).toBe(25);
			// Slopes unchanged
			expect(result.segments[0].data.delta).toBe(1);
			expect(result.segments[1].data.delta).toBe(0);
		});
	});

	describe('shiftBufferSimple', () => {
		it('should shift all endpoints by constant', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [
					{ endPoint: 50, data: { rating: 10, delta: 1 } },
					{ endPoint: 100, data: { rating: 20, delta: 0 } }
				]
			};
			const result = shiftBufferSimple(buf, 10);
			expect(result.segments[0].endPoint).toBe(60);
			expect(result.segments[1].endPoint).toBe(110);
			// Rating data unchanged
			expect(result.segments[0].data.rating).toBe(10);
		});
	});

	describe('extendBufferTo', () => {
		it('should add a zero segment to extend range', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [{ endPoint: 50, data: { rating: 10, delta: 0 } }]
			};
			const result = extendBufferTo(buf, 100);
			expect(result.segments).toHaveLength(2);
			expect(result.segments[1].endPoint).toBe(100);
			expect(result.segments[1].data.rating).toBe(0);
		});

		it('should not extend if already covers the range', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [{ endPoint: 100, data: { rating: 10, delta: 0 } }]
			};
			const result = extendBufferTo(buf, 50);
			expect(result.segments).toHaveLength(1);
		});

		it('should handle empty buffer', () => {
			const buf: RatingBuffer = { start: 0, segments: [] };
			const result = extendBufferTo(buf, 100);
			expect(result.segments).toHaveLength(1);
			expect(result.segments[0].endPoint).toBe(100);
		});
	});

	// =========================================================================
	// Single span ratings
	// =========================================================================
	describe('singleSpanRatings', () => {
		it('should compute rating buffer for a single span against refs', () => {
			const ref = [{ start: 1000, end: 2000 }];
			const inSpan = { start: 0, end: 1000 };
			const buf = singleSpanRatings(ref, inSpan, standardScoring, -2000, 3000);
			expect(buf.start).toBe(-2000);
			expect(buf.segments.length).toBeGreaterThan(0);

			// At offset 1000 (shift inSpan to 1000-2000), should get maximum rating
			const ratingAtBest = ratingBufferGetAt(buf, 1000);
			expect(ratingAtBest).toBeGreaterThan(0);
		});

		it('should return zero-valued buffer when spans dont overlap at any offset', () => {
			const ref = [{ start: 100, end: 200 }];
			const inSpan = { start: 0, end: 100 };
			// Offset range doesn't include any useful position
			const buf = singleSpanRatings(ref, inSpan, standardScoring, -1000, -500);
			// All ratings should be 0 or near-zero
			const { rating } = ratingBufferMaximum(buf);
			expect(rating).toBe(0);
		});
	});

	// =========================================================================
	// leftToRightMaximum
	// =========================================================================
	describe('leftToRightMaximum', () => {
		it('should propagate maximum forward', () => {
			const segs: DualFullSegment[] = [
				{
					start: 0,
					end: 50,
					data: {
						ratingInfo: { rating: 10, delta: 0 },
						offsetInfo: { offset: 0, drag: false }
					}
				},
				{
					start: 50,
					end: 100,
					data: {
						ratingInfo: { rating: 5, delta: 0 },
						offsetInfo: { offset: 50, drag: false }
					}
				}
			];
			const result = leftToRightMaximum(segs, 0);
			// The maximum at offset 0 is 10. At offset 50+ the input is 5, but max should stay 10.
			expect(result.length).toBeGreaterThanOrEqual(1);
			// Last segment should have rating >= 10
			const lastSeg = result[result.length - 1];
			expect(lastSeg.data.ratingInfo.rating).toBeGreaterThanOrEqual(10);
		});

		it('should handle rising segments', () => {
			const segs: DualFullSegment[] = [
				{
					start: 0,
					end: 100,
					data: {
						ratingInfo: { rating: 0, delta: 1 },
						offsetInfo: { offset: 0, drag: true }
					}
				}
			];
			const result = leftToRightMaximum(segs, 0);
			// Rising segment - the maximum at each point IS the segment itself
			expect(result.length).toBe(1);
			expect(result[0].data.ratingInfo.delta).toBe(1);
		});
	});

	// =========================================================================
	// combinedMaximumDual
	// =========================================================================
	describe('combinedMaximumDual', () => {
		it('should pick the higher of two flat segments', () => {
			const a = {
				start: 0,
				segments: [
					{
						endPoint: 100,
						data: {
							ratingInfo: { rating: 10, delta: 0 },
							offsetInfo: { offset: 0, drag: false }
						}
					}
				]
			};
			const b = {
				start: 0,
				segments: [
					{
						endPoint: 100,
						data: {
							ratingInfo: { rating: 20, delta: 0 },
							offsetInfo: { offset: 5, drag: false }
						}
					}
				]
			};
			const result = combinedMaximumDual(a, b);
			expect(result.length).toBe(1);
			expect(result[0].data.ratingInfo.rating).toBe(20);
			expect(result[0].data.offsetInfo.offset).toBe(5);
		});

		it('should handle crossover between segments', () => {
			const a = {
				start: 0,
				segments: [
					{
						endPoint: 100,
						data: {
							ratingInfo: { rating: 10, delta: 1 }, // 10 -> 109
							offsetInfo: { offset: 0, drag: false }
						}
					}
				]
			};
			const b = {
				start: 0,
				segments: [
					{
						endPoint: 100,
						data: {
							ratingInfo: { rating: 50, delta: 0 }, // constant 50
							offsetInfo: { offset: 5, drag: false }
						}
					}
				]
			};
			const result = combinedMaximumDual(a, b);
			// b starts higher (50 > 10), but a crosses over at some point
			// Should produce at least 2 segments
			expect(result.length).toBeGreaterThanOrEqual(2);
		});
	});

	// =========================================================================
	// separateDualSegments
	// =========================================================================
	describe('separateDualSegments', () => {
		it('should separate into rating and offset buffers', () => {
			const segs: DualFullSegment[] = [
				{
					start: 0,
					end: 50,
					data: {
						ratingInfo: { rating: 10, delta: 1 },
						offsetInfo: { offset: 0, drag: true }
					}
				},
				{
					start: 50,
					end: 100,
					data: {
						ratingInfo: { rating: 60, delta: 0 },
						offsetInfo: { offset: 42, drag: false }
					}
				}
			];
			const { ratingBuffer, offsetBuffer } = separateDualSegments(0, segs);
			expect(ratingBuffer.start).toBe(0);
			expect(ratingBuffer.segments.length).toBeGreaterThanOrEqual(2);
			expect(offsetBuffer.start).toBe(0);
			expect(offsetBuffer.segments.length).toBeGreaterThanOrEqual(2);
		});

		it('should merge adjacent segments with same slope', () => {
			const segs: DualFullSegment[] = [
				{
					start: 0,
					end: 50,
					data: {
						ratingInfo: { rating: 0, delta: 0 },
						offsetInfo: { offset: 5, drag: false }
					}
				},
				{
					start: 50,
					end: 100,
					data: {
						ratingInfo: { rating: 0, delta: 0 }, // same slope as previous
						offsetInfo: { offset: 5, drag: false } // same offset as previous
					}
				}
			];
			const { ratingBuffer, offsetBuffer } = separateDualSegments(0, segs);
			// Should merge into single segments
			expect(ratingBuffer.segments).toHaveLength(1);
			expect(offsetBuffer.segments).toHaveLength(1);
		});
	});

	// =========================================================================
	// simplifyRatingBuffer
	// =========================================================================
	describe('simplifyRatingBuffer', () => {
		it('should return buffer unchanged if at or below maxSegments', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [
					{ endPoint: 50, data: { rating: 0, delta: 1 } },
					{ endPoint: 100, data: { rating: 50, delta: 0 } }
				]
			};
			const result = simplifyRatingBuffer(buf, 5);
			expect(result.segments).toHaveLength(2);
		});

		it('should reduce segments to maxSegments by merging similar slopes', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [
					{ endPoint: 20, data: { rating: 0, delta: 1.0 } },
					{ endPoint: 40, data: { rating: 20, delta: 1.01 } }, // very similar to first
					{ endPoint: 60, data: { rating: 40, delta: 0 } },
					{ endPoint: 80, data: { rating: 40, delta: -1 } },
					{ endPoint: 100, data: { rating: 20, delta: -2 } }
				]
			};
			const result = simplifyRatingBuffer(buf, 3);
			expect(result.segments).toHaveLength(3);
			expect(result.start).toBe(0);
			// Last endpoint should still be 100
			expect(result.segments[result.segments.length - 1].endPoint).toBe(100);
		});

		it('should merge to exactly maxSegments', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: Array.from({ length: 20 }, (_, i) => ({
					endPoint: (i + 1) * 10,
					data: { rating: i * 5, delta: i * 0.1 }
				}))
			};
			const result = simplifyRatingBuffer(buf, 5);
			expect(result.segments).toHaveLength(5);
		});

		it('should handle single segment', () => {
			const buf: RatingBuffer = {
				start: 0,
				segments: [{ endPoint: 100, data: { rating: 10, delta: 0.5 } }]
			};
			const result = simplifyRatingBuffer(buf, 1);
			expect(result.segments).toHaveLength(1);
		});

		it('should preserve start point', () => {
			const buf: RatingBuffer = {
				start: -500,
				segments: [
					{ endPoint: 0, data: { rating: 0, delta: 1 } },
					{ endPoint: 250, data: { rating: 500, delta: 0 } },
					{ endPoint: 500, data: { rating: 500, delta: -1 } }
				]
			};
			const result = simplifyRatingBuffer(buf, 2);
			expect(result.start).toBe(-500);
			expect(result.segments).toHaveLength(2);
		});
	});

	// =========================================================================
	// offsetBufferGetAt
	// =========================================================================
	describe('offsetBufferGetAt', () => {
		it('should return constant offset for non-drag segment', () => {
			const buf = {
				start: 0,
				segments: [{ endPoint: 100, data: { offset: 42, drag: false } }]
			};
			expect(offsetBufferGetAt(buf, 0)).toBe(42);
			expect(offsetBufferGetAt(buf, 50)).toBe(42);
			expect(offsetBufferGetAt(buf, 99)).toBe(42);
		});

		it('should return dragging offset', () => {
			const buf = {
				start: 0,
				segments: [{ endPoint: 100, data: { offset: 10, drag: true } }]
			};
			expect(offsetBufferGetAt(buf, 0)).toBe(10);
			expect(offsetBufferGetAt(buf, 50)).toBe(60);
			expect(offsetBufferGetAt(buf, 99)).toBe(109);
		});

		it('should find correct segment in multi-segment buffer', () => {
			const buf = {
				start: 0,
				segments: [
					{ endPoint: 50, data: { offset: 100, drag: false } },
					{ endPoint: 100, data: { offset: 200, drag: false } }
				]
			};
			expect(offsetBufferGetAt(buf, 25)).toBe(100);
			expect(offsetBufferGetAt(buf, 75)).toBe(200);
		});

		it('should fallback to last segment for out-of-range offset', () => {
			const buf = {
				start: 0,
				segments: [{ endPoint: 50, data: { offset: 42, drag: false } }]
			};
			// Offset beyond end
			const result = offsetBufferGetAt(buf, 100);
			expect(result).toBe(42);
		});

		it('should return t for empty buffer', () => {
			const buf: OffsetBuffer = { start: 0, segments: [] };
			expect(offsetBufferGetAt(buf, 75)).toBe(75);
		});

		it('should handle drag segment at end of buffer', () => {
			const buf = {
				start: 0,
				segments: [
					{ endPoint: 50, data: { offset: 0, drag: false } },
					{ endPoint: 100, data: { offset: 50, drag: true } }
				]
			};
			// In second segment (50-100), drag=true, offset starts at 50
			expect(offsetBufferGetAt(buf, 60)).toBe(60); // 50 + (60-50)
		});
	});
});

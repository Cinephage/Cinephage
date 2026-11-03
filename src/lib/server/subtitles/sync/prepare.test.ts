import { describe, it, expect } from 'vitest';
import { prepareTimeSpans } from './prepare.js';
import type { TimeSpan } from './types.js';

describe('prepare', () => {
	describe('prepareTimeSpans', () => {
		it('should return empty for empty input', () => {
			const result = prepareTimeSpans([]);
			expect(result.spans).toEqual([]);
			expect(result.indices).toEqual([]);
		});

		it('should pass through already-sorted non-overlapping spans', () => {
			const spans: TimeSpan[] = [
				{ start: 100, end: 200 },
				{ start: 300, end: 400 },
				{ start: 500, end: 600 }
			];
			const result = prepareTimeSpans(spans);
			expect(result.spans).toEqual(spans);
			expect(result.indices).toEqual([0, 1, 2]);
		});

		it('should sort unsorted spans and maintain index mapping', () => {
			const spans: TimeSpan[] = [
				{ start: 500, end: 600 },
				{ start: 100, end: 200 },
				{ start: 300, end: 400 }
			];
			const result = prepareTimeSpans(spans);
			expect(result.spans).toEqual([
				{ start: 100, end: 200 },
				{ start: 300, end: 400 },
				{ start: 500, end: 600 }
			]);
			// Original index 0 (500-600) -> sorted index 2
			// Original index 1 (100-200) -> sorted index 0
			// Original index 2 (300-400) -> sorted index 1
			expect(result.indices[0]).toBe(2);
			expect(result.indices[1]).toBe(0);
			expect(result.indices[2]).toBe(1);
		});

		it('should merge overlapping spans', () => {
			const spans: TimeSpan[] = [
				{ start: 100, end: 300 },
				{ start: 200, end: 400 }
			];
			const result = prepareTimeSpans(spans);
			expect(result.spans).toEqual([{ start: 100, end: 400 }]);
			// Both original spans map to the merged span at index 0
			expect(result.indices[0]).toBe(0);
			expect(result.indices[1]).toBe(0);
		});

		it('should merge adjacent overlapping spans but not non-overlapping', () => {
			const spans: TimeSpan[] = [
				{ start: 100, end: 300 },
				{ start: 200, end: 400 },
				{ start: 600, end: 800 }
			];
			const result = prepareTimeSpans(spans);
			expect(result.spans).toEqual([
				{ start: 100, end: 400 },
				{ start: 600, end: 800 }
			]);
			expect(result.indices[0]).toBe(0);
			expect(result.indices[1]).toBe(0);
			expect(result.indices[2]).toBe(1);
		});

		it('should remove zero-length spans', () => {
			const spans: TimeSpan[] = [
				{ start: 100, end: 200 },
				{ start: 300, end: 300 }, // zero-length
				{ start: 400, end: 500 }
			];
			const result = prepareTimeSpans(spans);
			expect(result.spans).toEqual([
				{ start: 100, end: 200 },
				{ start: 400, end: 500 }
			]);
			// The zero-length span at 300 is closer to span at 400-500 (distance 100)
			// than span at 100-200 (distance 100) - equal distance, goes to previous
			expect(result.indices[0]).toBe(0);
			expect(result.indices[2]).toBe(1);
		});

		it('should handle all zero-length spans', () => {
			const spans: TimeSpan[] = [
				{ start: 100, end: 100 },
				{ start: 200, end: 200 }
			];
			const result = prepareTimeSpans(spans);
			expect(result.spans).toEqual([]);
			expect(result.indices).toEqual([]);
		});

		it('should handle a single span', () => {
			const spans: TimeSpan[] = [{ start: 100, end: 200 }];
			const result = prepareTimeSpans(spans);
			expect(result.spans).toEqual([{ start: 100, end: 200 }]);
			expect(result.indices).toEqual([0]);
		});

		it('should handle sort + merge + remove in combination', () => {
			const spans: TimeSpan[] = [
				{ start: 500, end: 500 }, // zero-length, will be removed
				{ start: 300, end: 400 }, // out of order
				{ start: 100, end: 250 }, // overlaps with next when sorted
				{ start: 200, end: 350 } // overlaps with previous when sorted
			];
			const result = prepareTimeSpans(spans);
			// After sort: [100-250, 200-350, 300-400, 500-500]
			// After merge: [100-400, 500-500]
			// After remove zero: [100-400]
			expect(result.spans).toEqual([{ start: 100, end: 400 }]);
		});

		it('should handle many overlapping spans', () => {
			const spans: TimeSpan[] = [
				{ start: 0, end: 100 },
				{ start: 50, end: 150 },
				{ start: 100, end: 200 },
				{ start: 150, end: 250 },
				{ start: 400, end: 500 }
			];
			const result = prepareTimeSpans(spans);
			expect(result.spans).toEqual([
				{ start: 0, end: 250 },
				{ start: 400, end: 500 }
			]);
		});

		it('should preserve correct index mapping through full pipeline', () => {
			const spans: TimeSpan[] = [
				{ start: 300, end: 400 },
				{ start: 100, end: 200 }
			];
			const result = prepareTimeSpans(spans);
			// After sort: [100-200, 300-400] - no overlap, no zero-length
			expect(result.spans).toEqual([
				{ start: 100, end: 200 },
				{ start: 300, end: 400 }
			]);
			// Original[0] = 300-400 -> processed index 1
			// Original[1] = 100-200 -> processed index 0
			expect(result.indices[0]).toBe(1);
			expect(result.indices[1]).toBe(0);
		});
	});
});

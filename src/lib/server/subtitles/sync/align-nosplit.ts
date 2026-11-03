/**
 * Constant-Offset (No-Split) Alignment
 *
 * Port of alass-core `align_constant_delta`, `align_constant_delta_bucket_sort`,
 * and `align_constant_delta_merge_sort` from alass.rs to TypeScript.
 *
 * Finds the single best constant time offset to apply to all incorrect subtitle
 * spans so they best match the reference spans.
 *
 * Two strategies are available and auto-selected based on data density:
 *
 * 1. **Bucket sort** (dense): Allocates an array spanning the full offset range,
 *    accumulates delta-delta values at changepoints, then sweeps to find the max.
 *    O(n*m + range) time, O(range) memory.
 *
 * 2. **Merge sort** (sparse): Collects all changepoints, sorts them, then sweeps.
 *    O(n*m * log(n*m)) time, O(n*m) memory.
 *
 * The auto selector uses the same heuristic as alass: if the number of entries
 * (4 * n * m) exceeds 10% of the offset range, use bucket sort.
 */

import type { TimeSpan, TimeDelta, ScoreFunction, NosplitResult } from './types.js';
import { computeRatingDeltaDelta } from './scoring.js';

/**
 * Maximum offset range (in ms) for which bucket sort will be used.
 * Above this threshold, merge sort is forced to cap memory usage.
 * 2,000,000 ms = ~33 minutes of offset range → Float64Array of ~16MB.
 */
const MAX_BUCKET_SORT_RANGE = 2_000_000;

/**
 * Compute the offset bounds for alignment.
 * Returns [minOffset, maxOffset] - the range of possible constant offsets.
 *
 * Port of alass-core `Aligner::get_offsets_bounds`.
 */
export function getOffsetBounds(refSpans: TimeSpan[], inSpans: TimeSpan[]): [TimeDelta, TimeDelta] {
	const inStart = inSpans[0].start;
	const inEnd = inSpans[inSpans.length - 1].end;
	const refStart = refSpans[0].start;
	const refEnd = refSpans[refSpans.length - 1].end;

	return [refStart - inEnd, refEnd - inStart];
}

/**
 * Bucket-sort based constant-offset alignment.
 *
 * Allocates a flat array for all possible offsets, accumulates the
 * second-derivative (delta-delta) at each changepoint, then integrates
 * twice (delta-delta → delta → rating) to find the global maximum.
 *
 * Port of alass-core `align_constant_delta_bucket_sort`.
 */
export function alignConstantDeltaBucketSort(
	refSpans: TimeSpan[],
	inSpans: TimeSpan[],
	scoreFn: ScoreFunction
): NosplitResult {
	const [minOffset, maxOffset] = getOffsetBounds(refSpans, inSpans);
	const len = maxOffset - minOffset;

	if (len <= 0) {
		return { delta: minOffset, score: 0 };
	}

	// Allocate delta-delta buffer (one entry per millisecond offset)
	const deltas = new Float64Array(len + 1);

	// Accumulate changepoints
	for (const refSpan of refSpans) {
		for (const inSpan of inSpans) {
			const dd = computeRatingDeltaDelta(
				inSpan.end - inSpan.start,
				refSpan.end - refSpan.start,
				scoreFn
			);

			if (dd === 0) continue;

			// Four changepoints per pair (trapezoidal shape)
			const cp1 = refSpan.start - inSpan.end - minOffset;
			const cp2 = refSpan.end - inSpan.end - minOffset;
			const cp3 = refSpan.start - inSpan.start - minOffset;
			const cp4 = refSpan.end - inSpan.start - minOffset;

			if (cp1 >= 0 && cp1 <= len) deltas[cp1] += dd;
			if (cp2 >= 0 && cp2 <= len) deltas[cp2] -= dd;
			if (cp3 >= 0 && cp3 <= len) deltas[cp3] -= dd;
			if (cp4 >= 0 && cp4 <= len) deltas[cp4] += dd;
		}
	}

	// Integrate delta-delta → delta → rating, tracking maximum
	let delta = 0;
	let rating = 0;
	let maxRating = 0;
	let bestOffset = minOffset;

	for (let sigma = 0; sigma <= len; sigma++) {
		rating += delta;
		delta += deltas[sigma];
		if (rating > maxRating) {
			maxRating = rating;
			bestOffset = sigma + minOffset;
		}
	}

	return { delta: bestOffset, score: maxRating };
}

/**
 * Merge-sort based constant-offset alignment.
 *
 * Collects all changepoints as (time, delta-delta) pairs, sorts by time,
 * then sweeps to find the global maximum. Better than bucket sort when
 * the offset range is very large but the number of span pairs is small.
 *
 * Port of alass-core `align_constant_delta_merge_sort`.
 */
export function alignConstantDeltaMergeSort(
	refSpans: TimeSpan[],
	inSpans: TimeSpan[],
	scoreFn: ScoreFunction
): NosplitResult {
	// For each incorrect span, compute 4 arrays of changepoints (one per ref span),
	// each array already sorted by time because ref spans are sorted.
	// Then merge the 4 arrays for each incorrect span, and finally merge all incorrect spans.

	// Collect changepoints per incorrect span, 4 categories
	const allChangepoints: Array<{ time: number; dd: number }> = [];

	for (const inSpan of inSpans) {
		const rise: Array<{ time: number; dd: number }> = [];
		const up: Array<{ time: number; dd: number }> = [];
		const fall: Array<{ time: number; dd: number }> = [];
		const down: Array<{ time: number; dd: number }> = [];

		for (const refSpan of refSpans) {
			const inLen = inSpan.end - inSpan.start;
			const refLen = refSpan.end - refSpan.start;
			const dd = computeRatingDeltaDelta(inLen, refLen, scoreFn);
			if (dd === 0) continue;

			let riseTime: number, upTime: number, fallTime: number, downTime: number;

			if (inLen < refLen) {
				riseTime = refSpan.start - inLen;
				upTime = refSpan.start;
				fallTime = refSpan.end - inLen;
				downTime = refSpan.end;
			} else {
				riseTime = refSpan.start - inLen;
				upTime = refSpan.end - inLen;
				fallTime = refSpan.start;
				downTime = refSpan.end;
			}

			// Adjust relative to incorrect span start
			rise.push({ time: riseTime - inSpan.start, dd });
			up.push({ time: upTime - inSpan.start, dd: -dd });
			fall.push({ time: fallTime - inSpan.start, dd: -dd });
			down.push({ time: downTime - inSpan.start, dd });
		}

		// Each array is already sorted (ref spans sorted by start)
		// Merge pairs then merge the two halves
		const merged1 = mergeSortedChangepoints(rise, up);
		const merged2 = mergeSortedChangepoints(fall, down);
		const merged = mergeSortedChangepoints(merged1, merged2);

		for (const cp of merged) {
			allChangepoints.push(cp);
		}
	}

	if (allChangepoints.length === 0) {
		const [minOffset] = getOffsetBounds(refSpans, inSpans);
		return { delta: minOffset, score: 0 };
	}

	// Sort all changepoints by time
	allChangepoints.sort((a, b) => a.time - b.time);

	// Sweep to find maximum rating
	let delta = 0;
	let rating = 0;
	let maxRating = 0;
	let bestOffset = allChangepoints[0].time;

	for (let i = 0; i < allChangepoints.length - 1; i++) {
		delta += allChangepoints[i].dd;
		const timeDiff = allChangepoints[i + 1].time - allChangepoints[i].time;
		rating += delta * timeDiff;
		if (rating > maxRating) {
			maxRating = rating;
			bestOffset = allChangepoints[i + 1].time;
		}
	}

	return { delta: bestOffset, score: maxRating };
}

/**
 * Merge two sorted changepoint arrays.
 */
function mergeSortedChangepoints(
	a: Array<{ time: number; dd: number }>,
	b: Array<{ time: number; dd: number }>
): Array<{ time: number; dd: number }> {
	const result: Array<{ time: number; dd: number }> = [];
	let ai = 0;
	let bi = 0;
	while (ai < a.length && bi < b.length) {
		if (a[ai].time <= b[bi].time) {
			result.push(a[ai++]);
		} else {
			result.push(b[bi++]);
		}
	}
	while (ai < a.length) result.push(a[ai++]);
	while (bi < b.length) result.push(b[bi++]);
	return result;
}

/**
 * Auto-selecting constant-offset alignment.
 *
 * Picks bucket sort or merge sort based on the density ratio,
 * matching the heuristic in alass-core `align_constant_delta`.
 *
 * Port of alass-core `Aligner::align_constant_delta`.
 */
export function alignNosplit(
	refSpans: TimeSpan[],
	inSpans: TimeSpan[],
	scoreFn: ScoreFunction
): NosplitResult {
	if (refSpans.length === 0 || inSpans.length === 0) {
		return { delta: 0, score: 0 };
	}

	const [minOffset, maxOffset] = getOffsetBounds(refSpans, inSpans);
	const numSlots = maxOffset - minOffset;
	const numEntries = inSpans.length * refSpans.length * 4;

	if (numSlots <= 0) {
		return { delta: minOffset, score: 0 };
	}

	// Force merge sort when the offset range is too large for bucket sort allocation.
	// This caps the max Float64Array at ~16MB instead of potentially ~110MB+.
	if (numSlots > MAX_BUCKET_SORT_RANGE) {
		return alignConstantDeltaMergeSort(refSpans, inSpans, scoreFn);
	}

	// Use bucket sort when entries are dense relative to the offset range
	if (numEntries > numSlots * 0.1) {
		return alignConstantDeltaBucketSort(refSpans, inSpans, scoreFn);
	} else {
		return alignConstantDeltaMergeSort(refSpans, inSpans, scoreFn);
	}
}

/**
 * Split-Aware Alignment
 *
 * Port of alass-core `Aligner::align_with_splits` from alass.rs to TypeScript.
 *
 * This algorithm uses dynamic programming over incorrect spans to find
 * per-span offsets that maximize alignment quality while penalizing splits
 * (offset discontinuities between consecutive spans).
 *
 * At each step i, we maintain a cumulative rating buffer that maps
 * offset → best total rating achievable using spans [0..i] with that offset
 * for span i. We combine two candidates:
 *
 * 1. **No-split**: Use the same offset as span i-1 (no penalty).
 * 2. **Split**: Use the best offset for spans [0..i-1] minus the split penalty,
 *    shifted to account for the gap between spans.
 *
 * The pointwise maximum of these two options gives the new cumulative buffer.
 * We also store offset buffers at each step to trace back the per-span offsets.
 */

import type { TimeSpan, TimeDelta, ScoreFunction, ProgressHandler, SplitResult } from './types.js';
import {
	type RatingBuffer,
	type OffsetBuffer,
	type DualSegment,
	type DualFullSegment,
	singleSpanRatings,
	addRatingToBuffer,
	shiftBufferSimple,
	extendBufferTo,
	ratingBufferMaximum,
	offsetBufferGetAt,
	iterateRatingBuffer,
	advanceDual,
	leftToRightMaximum,
	combinedMaximumDual,
	separateDualSegments
} from './rating-buffer.js';
import { getOffsetBounds } from './align-nosplit.js';

/**
 * Split-aware alignment with dynamic programming.
 *
 * Finds per-span offsets that maximize alignment quality while penalizing
 * offset discontinuities (splits) between consecutive spans.
 *
 * Port of alass-core `Aligner::align_with_splits`.
 *
 * @param refSpans - Reference time spans (sorted, non-overlapping)
 * @param inSpans - Incorrect time spans to align (sorted, non-overlapping)
 * @param splitPenalty - Penalty for changing offset between consecutive spans
 * @param scoreFn - Scoring function for span pair quality
 * @param progress - Progress handler for long operations
 * @returns Per-span offsets and total alignment score
 */
export function alignWithSplits(
	refSpans: TimeSpan[],
	inSpans: TimeSpan[],
	splitPenalty: number,
	scoreFn: ScoreFunction,
	progress?: ProgressHandler
): SplitResult {
	if (inSpans.length === 0 || refSpans.length === 0) {
		return { deltas: [], score: 0 };
	}

	progress?.init?.(inSpans.length);

	const [rawMinOffset, rawMaxOffset] = getOffsetBounds(refSpans, inSpans);
	const minOffset = rawMinOffset - 1;
	const maxOffset = rawMaxOffset + 1;

	// Offset buffers for backtracking: offsetBuffers[i] maps offset_of_span[i+1] → offset_of_span[i]
	const offsetBuffers: OffsetBuffer[] = [];

	// Initialize cumulative rating buffer with first span's single-span ratings
	let cumulativeRatingBuffer = singleSpanRatings(
		refSpans,
		inSpans[0],
		scoreFn,
		minOffset,
		maxOffset
	);

	progress?.inc?.();

	// Dynamic programming: for each subsequent span
	for (let lineNr = 0; lineNr < inSpans.length - 1; lineNr++) {
		const lastInSpan = inSpans[lineNr];
		const inSpan = inSpans[lineNr + 1];
		const spanDistance = inSpan.start - lastInSpan.end;

		// -----------------------------------------------------------
		// Candidate 1: SPLIT - use best offset from previous spans, shifted
		// Apply split penalty, shift by span distance, compute left-to-right max
		// -----------------------------------------------------------
		const splitRatingBuf = extendBufferTo(
			shiftBufferSimple(addRatingToBuffer(cumulativeRatingBuffer, -splitPenalty), -spanDistance),
			maxOffset
		);

		// Convert to dual full segments with dragging offsets
		const splitDualFull: DualFullSegment[] = [];
		for (const seg of iterateRatingBuffer(splitRatingBuf)) {
			splitDualFull.push({
				start: seg.start,
				end: seg.end,
				data: {
					ratingInfo: seg.data,
					offsetInfo: { offset: seg.start + spanDistance, drag: true }
				}
			});
		}
		const bestSplitFull = leftToRightMaximum(splitDualFull, splitRatingBuf.start);

		// Convert to DualSegment[] (drop start points)
		const splitSegments: DualSegment[] = bestSplitFull.map((fs) => ({
			endPoint: fs.end,
			data: fs.data
		}));

		// -----------------------------------------------------------
		// Candidate 2: NO-SPLIT - use same offset as current span (identity mapping)
		// -----------------------------------------------------------
		const nosplitDualFull: DualFullSegment[] = [];
		for (const seg of iterateRatingBuffer(cumulativeRatingBuffer)) {
			nosplitDualFull.push({
				start: seg.start,
				end: seg.end,
				data: {
					ratingInfo: seg.data,
					offsetInfo: { offset: seg.start, drag: true }
				}
			});
		}
		const nosplitSegments: DualSegment[] = nosplitDualFull.map((fs) => ({
			endPoint: fs.end,
			data: fs.data
		}));

		// -----------------------------------------------------------
		// Compute single-span ratings for current span
		// -----------------------------------------------------------
		const singleRatings = singleSpanRatings(refSpans, inSpan, scoreFn, minOffset, maxOffset);

		// -----------------------------------------------------------
		// Combine: take pointwise max of nosplit and split candidates
		// -----------------------------------------------------------
		const combinedFull = combinedMaximumDual(
			{ start: cumulativeRatingBuffer.start, segments: nosplitSegments },
			{ start: splitRatingBuf.start, segments: splitSegments }
		);

		// Add single-span ratings to combined result
		const combinedWithSingleRatings = addDualFullWithRating(combinedFull, singleRatings);

		// Separate into rating and offset buffers
		const separated = separateDualSegments(minOffset, combinedWithSingleRatings);

		cumulativeRatingBuffer = separated.ratingBuffer;
		offsetBuffers.push(separated.offsetBuffer);

		progress?.inc?.();
	}

	// -----------------------------------------------------------
	// Extract per-span offsets by backtracking through offset buffers
	// -----------------------------------------------------------
	const { rating: totalRating, offset: lastBestOffset } =
		ratingBufferMaximum(cumulativeRatingBuffer);

	const resultDeltas: TimeDelta[] = [];
	resultDeltas.push(lastBestOffset);

	let spanOffset = lastBestOffset;
	for (let i = offsetBuffers.length - 1; i >= 0; i--) {
		spanOffset = offsetBufferGetAt(offsetBuffers[i], spanOffset);
		resultDeltas.push(spanOffset);
	}

	// Reverse since we built back-to-front
	resultDeltas.reverse();

	progress?.finish?.();

	return { deltas: resultDeltas, score: totalRating };
}

/**
 * Add single-span ratings to a dual full segment sequence.
 * This combines the combined maximum (which tracks offsets) with
 * the per-span rating contribution.
 */
function addDualFullWithRating(
	dualSegs: DualFullSegment[],
	ratingBuf: RatingBuffer
): DualFullSegment[] {
	const result: DualFullSegment[] = [];
	let di = 0;
	let ri = 0;
	let ratingSegStart = ratingBuf.start;

	if (dualSegs.length === 0 || ratingBuf.segments.length === 0) return dualSegs;

	// eslint-disable-next-line no-useless-assignment
	let dualSeg = dualSegs[0];
	// eslint-disable-next-line no-useless-assignment
	let ratSeg = ratingBuf.segments[0];

	while (di < dualSegs.length && ri < ratingBuf.segments.length) {
		dualSeg = dualSegs[di];
		ratSeg = ratingBuf.segments[ri];

		const dualEnd = dualSeg.end;
		const ratEnd = ratSeg.endPoint;

		const segEnd = Math.min(dualEnd, ratEnd);
		const segStart = Math.max(dualSeg.start, ratingSegStart);

		if (segStart < segEnd) {
			// Compute the advanced data for both
			const dualData = advanceDual(dualSeg.data, segStart - dualSeg.start);
			const ratData = {
				rating: ratSeg.data.rating + ratSeg.data.delta * (segStart - ratingSegStart),
				delta: ratSeg.data.delta
			};

			result.push({
				start: segStart,
				end: segEnd,
				data: {
					ratingInfo: {
						rating: dualData.ratingInfo.rating + ratData.rating,
						delta: dualData.ratingInfo.delta + ratData.delta
					},
					offsetInfo: dualData.offsetInfo
				}
			});
		}

		if (dualEnd <= ratEnd) {
			di++;
		}
		if (ratEnd <= dualEnd) {
			ratingSegStart = ratEnd;
			ri++;
		}
	}

	return result;
}

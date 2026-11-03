/**
 * Piecewise-Linear Rating Buffer
 *
 * Port of alass-core segments.rs data structures to TypeScript.
 *
 * The rating buffer represents a piecewise-linear function of offset → rating.
 * Each segment stores a start rating and a delta (slope), so the rating at any
 * point within the segment is: rating + delta * (offset - segmentStart).
 *
 * Key data structures:
 *
 * - `RatingSegment`: A segment with an end_point and (rating, delta) data.
 * - `RatingBuffer`: A sequence of RatingSegments covering [start, lastEndPoint].
 * - `OffsetSegment`: A segment storing which offset produced the best rating.
 * - `DifferentialRatingBufferBuilder`: Builds a rating buffer from delta-delta changepoints.
 *
 * For the split-aware alignment, we also track which offset produced the best
 * rating at each point, using "dual" segments that carry both rating and offset info.
 */

import type { TimeDelta, TimeSpan } from './types.js';
import { computeRatingDeltaDelta } from './scoring.js';

// =============================================================================
// Rating Info - stores piecewise-linear function value at segment start
// =============================================================================

/**
 * Rating information for a segment.
 * The rating at offset `t` within the segment is: `rating + delta * t`
 * where `t` is measured from the segment's start point.
 */
export interface RatingInfo {
	/** Rating value at the start of this segment */
	rating: number;
	/** Slope of the rating within this segment (change per ms) */
	delta: number;
}

/**
 * Create a constant-valued RatingInfo (zero slope).
 */
export function constantRating(rating: number): RatingInfo {
	return { rating, delta: 0 };
}

/**
 * Advance a RatingInfo by `len` milliseconds (compute value at offset + len).
 */
export function advanceRating(info: RatingInfo, len: TimeDelta): RatingInfo {
	return {
		rating: info.rating + info.delta * len,
		delta: info.delta
	};
}

/**
 * Get the rating at a given offset within the segment.
 */
export function getRatingAt(info: RatingInfo, len: TimeDelta): number {
	return info.rating + info.delta * len;
}

/**
 * Add two RatingInfo objects (superimpose two piecewise-linear functions).
 */
export function addRatings(a: RatingInfo, b: RatingInfo): RatingInfo {
	return {
		rating: a.rating + b.rating,
		delta: a.delta + b.delta
	};
}

// =============================================================================
// Offset Info - tracks which offset produced the best rating
// =============================================================================

/**
 * Offset information for a segment.
 * When `drag` is true, the offset increases by 1 per ms within the segment
 * (meaning "use the current position as the offset").
 * When `drag` is false, the offset is constant (meaning "use a fixed offset").
 */
export interface OffsetInfo {
	/** The offset value at the start of this segment */
	offset: number;
	/** If true, offset increases by 1 per ms (tracks the position) */
	drag: boolean;
}

/**
 * Create a constant (non-dragging) OffsetInfo.
 */
export function constantOffset(offset: number): OffsetInfo {
	return { offset, drag: false };
}

/**
 * Advance an OffsetInfo by `len` milliseconds.
 */
export function advanceOffset(info: OffsetInfo, len: TimeDelta): OffsetInfo {
	if (info.drag) {
		return { offset: info.offset + len, drag: true };
	}
	return info;
}

/**
 * Get the offset at a given position within the segment.
 */
export function getOffsetAt(info: OffsetInfo, len: TimeDelta): number {
	return info.drag ? info.offset + len : info.offset;
}

// =============================================================================
// Dual Info - combines rating and offset tracking
// =============================================================================

/**
 * Combined rating + offset info for a segment.
 */
export interface DualInfo {
	ratingInfo: RatingInfo;
	offsetInfo: OffsetInfo;
}

/**
 * Advance a DualInfo by `len` milliseconds.
 */
export function advanceDual(info: DualInfo, len: TimeDelta): DualInfo {
	return {
		ratingInfo: advanceRating(info.ratingInfo, len),
		offsetInfo: advanceOffset(info.offsetInfo, len)
	};
}

// =============================================================================
// Segment types
// =============================================================================

/**
 * A segment defined by its end point and associated data.
 * The segment spans from the previous segment's end point (or the buffer's start)
 * to this segment's end point.
 */
export interface Segment<D> {
	endPoint: number;
	data: D;
}

export type RatingSegment = Segment<RatingInfo>;
export type OffsetSegment = Segment<OffsetInfo>;
export type DualSegment = Segment<DualInfo>;

/**
 * A segment with explicit start and end points.
 */
export interface FullSegment<D> {
	start: number;
	end: number;
	data: D;
}

export type RatingFullSegment = FullSegment<RatingInfo>;
export type DualFullSegment = FullSegment<DualInfo>;

// =============================================================================
// Rating Buffer
// =============================================================================

/**
 * A piecewise-linear rating function over an offset range.
 * Stored as a start point and a sequence of segments, each ending at a specific point.
 */
export interface RatingBuffer {
	start: number;
	segments: RatingSegment[];
}

/**
 * Find the maximum rating and the offset at which it occurs.
 *
 * Port of alass-core `RatingBuffer::maximum`.
 */
export function ratingBufferMaximum(buf: RatingBuffer): { rating: number; offset: number } {
	let maxRating = 0;
	let maxOffset = buf.start;
	let segStart = buf.start;

	for (const seg of buf.segments) {
		const len = seg.endPoint - segStart;
		const startRating = seg.data.rating;
		const endRating = seg.data.rating + seg.data.delta * (len - 1);

		if (startRating > maxRating) {
			maxRating = startRating;
			maxOffset = segStart;
		}
		if (endRating > maxRating) {
			maxRating = endRating;
			maxOffset = seg.endPoint - 1;
		}

		segStart = seg.endPoint;
	}

	return { rating: maxRating, offset: maxOffset };
}

/**
 * Get the rating at a specific offset within the buffer.
 */
export function ratingBufferGetAt(buf: RatingBuffer, offset: number): number {
	let segStart = buf.start;
	for (const seg of buf.segments) {
		if (offset >= segStart && offset < seg.endPoint) {
			return seg.data.rating + seg.data.delta * (offset - segStart);
		}
		segStart = seg.endPoint;
	}
	return 0;
}

/**
 * Iterate over a RatingBuffer, yielding full segments with start points.
 */
export function* iterateRatingBuffer(buf: RatingBuffer): Generator<RatingFullSegment> {
	let segStart = buf.start;
	for (const seg of buf.segments) {
		yield { start: segStart, end: seg.endPoint, data: seg.data };
		segStart = seg.endPoint;
	}
}

// =============================================================================
// Offset Buffer
// =============================================================================

/**
 * A piecewise offset function over an offset range.
 * Used to trace back which offset was chosen for a span.
 */
export interface OffsetBuffer {
	start: number;
	segments: OffsetSegment[];
}

/**
 * Get the offset value at a specific point in the buffer.
 *
 * Port of alass-core `OffsetBuffer::get_offset_at`.
 */
export function offsetBufferGetAt(buf: OffsetBuffer, t: number): number {
	let segStart = buf.start;
	for (const seg of buf.segments) {
		if (t >= segStart && t < seg.endPoint) {
			return seg.data.drag ? seg.data.offset + (t - segStart) : seg.data.offset;
		}
		segStart = seg.endPoint;
	}
	// Fallback: return the last segment's end offset
	if (buf.segments.length > 0) {
		const lastSeg = buf.segments[buf.segments.length - 1];
		const lastStart =
			buf.segments.length > 1 ? buf.segments[buf.segments.length - 2].endPoint : buf.start;
		const len = lastSeg.endPoint - lastStart;
		return lastSeg.data.drag ? lastSeg.data.offset + len - 1 : lastSeg.data.offset;
	}
	return t;
}

// =============================================================================
// Differential Rating Buffer Builder
// =============================================================================

/**
 * Builds a RatingBuffer from delta-delta changepoints.
 *
 * The builder accumulates second-derivative changepoints (delta-delta values)
 * and integrates them twice to produce the final rating curve:
 *   delta-delta → delta → rating
 *
 * Port of alass-core `DifferentialRatingBufferBuilder`.
 */
export class DifferentialRatingBufferBuilder {
	private readonly _start: number;
	private readonly _end: number;
	private readonly _buffer: Array<{ endPoint: number; deltaDelta: number }>;

	constructor(start: number, end: number) {
		this._start = start;
		this._end = end;
		this._buffer = [];
	}

	/**
	 * Add a delta-delta changepoint at the given end point.
	 * If the last segment has the same end point, accumulate the delta-delta.
	 */
	addSegment(endPoint: number, deltaDelta: number): void {
		if (this._buffer.length > 0) {
			const last = this._buffer[this._buffer.length - 1];
			if (last.endPoint === endPoint) {
				last.deltaDelta += deltaDelta;
				return;
			}
		}
		this._buffer.push({ endPoint, deltaDelta });
	}

	/**
	 * Extend the buffer to the configured end point.
	 */
	extendToEnd(): void {
		this.addSegment(this._end, 0);
	}

	/**
	 * Build the final RatingBuffer by integrating delta-delta → delta → rating.
	 *
	 * Port of alass-core `DifferentialRatingBuffer::into_rating_iter`.
	 */
	build(): RatingBuffer {
		const segments: RatingSegment[] = [];
		let rating = 0;
		let delta = 0;
		let lastEnd = this._start;

		for (const entry of this._buffer) {
			segments.push({
				endPoint: entry.endPoint,
				data: { rating, delta }
			});

			// Advance rating by current delta * segment length, then apply delta-delta
			rating += delta * (entry.endPoint - lastEnd);
			delta += entry.deltaDelta;
			lastEnd = entry.endPoint;
		}

		return { start: this._start, segments };
	}
}

// =============================================================================
// Single-Span Ratings
// =============================================================================

/**
 * Compute the rating buffer for a single incorrect span against all reference spans.
 *
 * This produces a piecewise-linear function of offset → rating representing
 * how well a single incorrect span matches all reference spans at each offset.
 *
 * Port of alass-core `Aligner::single_span_ratings`.
 */
export function singleSpanRatings(
	refSpans: TimeSpan[],
	inSpan: TimeSpan,
	scoreFn: (a: TimeDelta, b: TimeDelta) => number,
	minOffset: number,
	maxOffset: number
): RatingBuffer {
	const builder = new DifferentialRatingBufferBuilder(minOffset, maxOffset);

	// Compute all changepoints (4 per reference span)
	const timepoints: Array<{ time: number; dd: number }> = [];

	for (const refSpan of refSpans) {
		const inLen = inSpan.end - inSpan.start;
		const refSpanLen = refSpan.end - refSpan.start;
		const dd = computeRatingDeltaDelta(refSpanLen, inLen, scoreFn);

		if (dd === 0) continue;

		timepoints.push({ time: refSpan.start - inSpan.end, dd });
		timepoints.push({ time: refSpan.end - inSpan.end, dd: -dd });
		timepoints.push({ time: refSpan.start - inSpan.start, dd: -dd });
		timepoints.push({ time: refSpan.end - inSpan.start, dd });
	}

	// Sort changepoints - they form 4 sorted subsequences that we merge
	// For simplicity and correctness, just sort all of them
	timepoints.sort((a, b) => a.time - b.time);

	for (const tp of timepoints) {
		if (tp.time > minOffset && tp.time <= maxOffset) {
			builder.addSegment(tp.time, tp.dd);
		}
	}

	builder.extendToEnd();
	return builder.build();
}

// =============================================================================
// Rating Buffer Operations
// =============================================================================

/**
 * Add a constant rating delta to all segments in a buffer.
 * Used for applying split penalty.
 *
 * Port of alass-core `RatingIterator::add_rating`.
 */
export function addRatingToBuffer(buf: RatingBuffer, ratingDelta: number): RatingBuffer {
	return {
		start: buf.start,
		segments: buf.segments.map((seg) => ({
			endPoint: seg.endPoint,
			data: {
				rating: seg.data.rating + ratingDelta,
				delta: seg.data.delta
			}
		}))
	};
}

/**
 * Shift a rating buffer's timeline by a constant.
 * This shifts the endpoint positions but not the rating values.
 *
 * Port of alass-core `SegmentIterator::shift_simple`.
 */
export function shiftBufferSimple(buf: RatingBuffer, t: TimeDelta): RatingBuffer {
	return {
		start: buf.start,
		segments: buf.segments.map((seg) => ({
			endPoint: seg.endPoint + t,
			data: seg.data
		}))
	};
}

/**
 * Extend a rating buffer to cover up to `endPoint` with zero rating.
 *
 * Port of alass-core `RatingIterator::extend_to`.
 */
export function extendBufferTo(buf: RatingBuffer, endPoint: number): RatingBuffer {
	if (buf.segments.length === 0) {
		return {
			start: buf.start,
			segments: [{ endPoint, data: { rating: 0, delta: 0 } }]
		};
	}

	const lastEnd = buf.segments[buf.segments.length - 1].endPoint;
	if (lastEnd >= endPoint) return buf;

	return {
		start: buf.start,
		segments: [...buf.segments, { endPoint, data: { rating: 0, delta: 0 } }]
	};
}

// =============================================================================
// Left-to-Right Maximum
// =============================================================================

/**
 * Compute the left-to-right cumulative maximum of a dual segment sequence.
 *
 * At each point, the output is max(input[start..point]).
 * When the input rating exceeds the current maximum, we switch to tracking it.
 * When a crossover happens within a segment (linear crossing), we split it.
 *
 * Port of alass-core `LeftToRightMaximumIterator`.
 */
export function leftToRightMaximum(
	segments: DualFullSegment[],
	startPoint: number
): DualFullSegment[] {
	const result: DualFullSegment[] = [];
	let bestRating = 0;
	let bestOffset = startPoint;

	for (const seg of segments) {
		const len = seg.end - seg.start;
		const startRating = seg.data.ratingInfo.rating;
		const endRating = seg.data.ratingInfo.rating + seg.data.ratingInfo.delta * (len - 1);

		if (startRating <= bestRating && endRating <= bestRating) {
			// Current max is better throughout - emit constant segment
			result.push({
				start: seg.start,
				end: seg.end,
				data: {
					ratingInfo: constantRating(bestRating),
					offsetInfo: constantOffset(bestOffset)
				}
			});
		} else if (startRating >= bestRating) {
			if (startRating >= endRating) {
				// Start is the new best, and segment is declining
				bestRating = startRating;
				bestOffset = seg.data.offsetInfo.offset;
				result.push({
					start: seg.start,
					end: seg.end,
					data: {
						ratingInfo: constantRating(bestRating),
						offsetInfo: constantOffset(bestOffset)
					}
				});
			} else {
				// Start is better than previous best, and segment is rising
				bestRating = endRating;
				bestOffset = seg.data.offsetInfo.drag
					? seg.data.offsetInfo.offset + (len - 1)
					: seg.data.offsetInfo.offset;
				result.push(seg);
			}
		} else {
			// startRating < bestRating && endRating > bestRating
			// Crossover within segment - find the switch point
			const switchDelta = bestRating - startRating;
			const slope = seg.data.ratingInfo.delta;
			const switchPoint = Math.floor(switchDelta / slope) + 1;

			if (switchPoint > 0 && switchPoint < len) {
				// First part: constant at best
				result.push({
					start: seg.start,
					end: seg.start + switchPoint,
					data: {
						ratingInfo: constantRating(bestRating),
						offsetInfo: constantOffset(bestOffset)
					}
				});

				// Second part: the rising segment
				const advancedDual = advanceDual(seg.data, switchPoint);
				result.push({
					start: seg.start + switchPoint,
					end: seg.end,
					data: advancedDual
				});

				bestRating = endRating;
				bestOffset = seg.data.offsetInfo.drag
					? seg.data.offsetInfo.offset + (len - 1)
					: seg.data.offsetInfo.offset;
			} else {
				// Edge case: emit as rising
				bestRating = endRating;
				bestOffset = seg.data.offsetInfo.drag
					? seg.data.offsetInfo.offset + (len - 1)
					: seg.data.offsetInfo.offset;
				result.push(seg);
			}
		}
	}

	return result;
}

// =============================================================================
// Combined Maximum of Two Dual Segment Sequences
// =============================================================================

/**
 * Compute the pointwise maximum of two dual segment sequences.
 * Both must cover the same range.
 *
 * At each point, picks whichever sequence has the higher rating,
 * splitting segments at crossover points.
 *
 * Port of alass-core `combined_maximum_of_dual_iterators`.
 */
export function combinedMaximumDual(
	a: { start: number; segments: DualSegment[] },
	b: { start: number; segments: DualSegment[] }
): DualFullSegment[] {
	const result: DualFullSegment[] = [];

	let ai = 0;
	let bi = 0;
	let aSeg = a.segments[0];
	let bSeg = b.segments[0];
	let segStart = a.start;

	while (ai < a.segments.length && bi < b.segments.length) {
		let segEnd: number;
		let len: number;

		if (aSeg.endPoint < bSeg.endPoint) {
			segEnd = aSeg.endPoint;
			len = segEnd - segStart;

			const maxSegs = generateMaximumSegments(segStart, segEnd, len, aSeg.data, bSeg.data);
			result.push(...maxSegs);

			segStart = segEnd;
			ai++;
			bSeg = {
				endPoint: bSeg.endPoint,
				data: advanceDual(bSeg.data, len)
			};
			if (ai < a.segments.length) aSeg = a.segments[ai];
		} else if (bSeg.endPoint < aSeg.endPoint) {
			segEnd = bSeg.endPoint;
			len = segEnd - segStart;

			const maxSegs = generateMaximumSegments(segStart, segEnd, len, aSeg.data, bSeg.data);
			result.push(...maxSegs);

			segStart = segEnd;
			bi++;
			aSeg = {
				endPoint: aSeg.endPoint,
				data: advanceDual(aSeg.data, len)
			};
			if (bi < b.segments.length) bSeg = b.segments[bi];
		} else {
			// Same end point
			segEnd = aSeg.endPoint;
			len = segEnd - segStart;

			const maxSegs = generateMaximumSegments(segStart, segEnd, len, aSeg.data, bSeg.data);
			result.push(...maxSegs);

			segStart = segEnd;
			ai++;
			bi++;
			if (ai < a.segments.length) aSeg = a.segments[ai];
			if (bi < b.segments.length) bSeg = b.segments[bi];
		}
	}

	return result;
}

/**
 * Generate maximum segments for a sub-range where two dual segments overlap.
 * May produce 1 or 2 segments if there's a crossover.
 */
function generateMaximumSegments(
	segStart: number,
	segEnd: number,
	len: number,
	data1: DualInfo,
	data2: DualInfo
): DualFullSegment[] {
	const startRating1 = data1.ratingInfo.rating;
	const startRating2 = data2.ratingInfo.rating;
	const endRating1 = getRatingAt(data1.ratingInfo, len);
	const endRating2 = getRatingAt(data2.ratingInfo, len);

	if (startRating1 >= startRating2 && endRating1 >= endRating2) {
		// First is better throughout
		return [{ start: segStart, end: segEnd, data: data1 }];
	}
	if (startRating1 <= startRating2 && endRating1 <= endRating2) {
		// Second is better throughout
		return [{ start: segStart, end: segEnd, data: data2 }];
	}

	// Crossover within segment
	const delta1 = data1.ratingInfo.delta;
	const delta2 = data2.ratingInfo.delta;
	const deltaDiff = delta1 - delta2;

	if (deltaDiff === 0) {
		// Parallel lines - shouldn't happen given the conditions above, but handle gracefully
		return [
			{
				start: segStart,
				end: segEnd,
				data: startRating1 >= startRating2 ? data1 : data2
			}
		];
	}

	// Switch point: startRating2 - startRating1 = (delta1 - delta2) * x
	const switchPoint = Math.floor((startRating2 - startRating1) / deltaDiff) + 1;

	if (switchPoint <= 0 || switchPoint >= len) {
		// Edge case
		return [
			{
				start: segStart,
				end: segEnd,
				data: startRating1 > startRating2 ? data1 : data2
			}
		];
	}

	if (startRating1 > startRating2) {
		// First starts above, second ends above
		return [
			{
				start: segStart,
				end: segStart + switchPoint,
				data: data1
			},
			{
				start: segStart + switchPoint,
				end: segEnd,
				data: advanceDual(data2, switchPoint)
			}
		];
	} else {
		// Second starts above, first ends above
		return [
			{
				start: segStart,
				end: segStart + switchPoint,
				data: data2
			},
			{
				start: segStart + switchPoint,
				end: segEnd,
				data: advanceDual(data1, switchPoint)
			}
		];
	}
}

// =============================================================================
// Separate Dual Buffer
// =============================================================================

/**
 * Maximum segment count before a rating buffer is compacted.
 * When a buffer exceeds this, adjacent segments with the smallest
 * delta differences are merged to reduce memory usage.
 */
const MAX_RATING_SEGMENTS = 10_000;

/**
 * Simplify a rating buffer by merging adjacent segments with the most
 * similar slopes, until the segment count is at or below `maxSegments`.
 *
 * This is a defense-in-depth measure: in normal subtitle-to-subtitle
 * alignment, segment counts stay manageable. But with dense VAD references,
 * accumulated DP iterations could grow segment counts beyond what's practical.
 */
export function simplifyRatingBuffer(buf: RatingBuffer, maxSegments: number): RatingBuffer {
	if (buf.segments.length <= maxSegments) return buf;

	const segments = buf.segments.map((s) => ({
		endPoint: s.endPoint,
		data: { ...s.data }
	}));

	while (segments.length > maxSegments) {
		// Find adjacent pair with smallest delta difference
		let minDiff = Infinity;
		let minIdx = 0;

		for (let i = 0; i < segments.length - 1; i++) {
			const diff = Math.abs(segments[i].data.delta - segments[i + 1].data.delta);
			if (diff < minDiff) {
				minDiff = diff;
				minIdx = i;
			}
		}

		// Merge segments[minIdx] and segments[minIdx + 1]:
		// Keep the first segment's data (rating, delta), extend its endpoint
		segments[minIdx].endPoint = segments[minIdx + 1].endPoint;
		segments.splice(minIdx + 1, 1);
	}

	return { start: buf.start, segments };
}

/**
 * Result of separating a dual segment sequence into rating and offset buffers.
 */
export interface SeparateDualBuffer {
	ratingBuffer: RatingBuffer;
	offsetBuffer: OffsetBuffer;
}

/**
 * Separate a dual segment sequence into independent rating and offset buffers.
 * Simplifies the segments to reduce memory usage by merging adjacent segments
 * with nearly-identical slopes (within epsilon tolerance).
 */
export function separateDualSegments(
	start: number,
	segments: DualFullSegment[]
): SeparateDualBuffer {
	const ratingSegments: RatingSegment[] = [];
	const offsetSegments: OffsetSegment[] = [];

	// Simplify rating segments (merge adjacent segments with nearly-equal delta).
	// Using 1e-6 epsilon rather than 1e-12 to more aggressively merge segments
	// whose slopes only differ due to floating-point accumulation, reducing
	// segment proliferation in the DP loop.
	let prevRatingDelta: number | null = null;
	for (const seg of segments) {
		if (
			ratingSegments.length > 0 &&
			prevRatingDelta !== null &&
			Math.abs(seg.data.ratingInfo.delta - prevRatingDelta) < 1e-6
		) {
			// Nearly same slope - extend previous segment
			ratingSegments[ratingSegments.length - 1].endPoint = seg.end;
		} else {
			ratingSegments.push({
				endPoint: seg.end,
				data: { ...seg.data.ratingInfo }
			});
		}
		prevRatingDelta = seg.data.ratingInfo.delta;
	}

	// Simplify offset segments (merge adjacent with same offset and drag)
	for (const seg of segments) {
		if (
			offsetSegments.length > 0 &&
			offsetSegments[offsetSegments.length - 1].data.drag === seg.data.offsetInfo.drag &&
			!seg.data.offsetInfo.drag &&
			offsetSegments[offsetSegments.length - 1].data.offset === seg.data.offsetInfo.offset
		) {
			// Same constant offset - extend
			offsetSegments[offsetSegments.length - 1].endPoint = seg.end;
		} else {
			offsetSegments.push({
				endPoint: seg.end,
				data: { ...seg.data.offsetInfo }
			});
		}
	}

	return {
		ratingBuffer: simplifyRatingBuffer({ start, segments: ratingSegments }, MAX_RATING_SEGMENTS),
		offsetBuffer: { start, segments: offsetSegments }
	};
}

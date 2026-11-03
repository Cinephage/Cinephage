/**
 * TimeSpan Preprocessing
 *
 * Port of alass-core timespan_ops.rs to TypeScript.
 *
 * Prepares raw TimeSpan arrays for the alignment algorithm by:
 * 1. Sorting by start time
 * 2. Merging overlapping spans
 * 3. Removing zero-length spans
 *
 * Each step maintains an index mapping from the original span positions
 * to the new (processed) positions, which is critical for the split-aware
 * alignment to map deltas back to original cues.
 */

import type { TimeSpan } from './types.js';

/**
 * Result of preparing time spans.
 */
export interface PreparedSpans {
	/** Processed spans (sorted, non-overlapping, non-zero) */
	spans: TimeSpan[];
	/** Mapping: indices[originalIndex] = processedIndex */
	indices: number[];
}

/**
 * Sort spans by start time, maintaining index mapping.
 */
function sortByStart(spans: TimeSpan[]): { spans: TimeSpan[]; indices: number[] } {
	if (spans.length === 0) return { spans: [], indices: [] };

	// Create indexed pairs and sort by start time
	const indexed = spans.map((span, i) => ({ span, originalIndex: i }));
	indexed.sort((a, b) => a.span.start - b.span.start);

	// Build mapping: original index -> sorted index
	const mapping = new Array<number>(spans.length);
	for (let sortedIdx = 0; sortedIdx < indexed.length; sortedIdx++) {
		mapping[indexed[sortedIdx].originalIndex] = sortedIdx;
	}

	return {
		spans: indexed.map((item) => item.span),
		indices: mapping
	};
}

/**
 * Merge overlapping spans into non-overlapping spans.
 * Input must be sorted by start time.
 */
function mergeOverlapping(spans: TimeSpan[]): { spans: TimeSpan[]; indices: number[] } {
	if (spans.length === 0) return { spans: [], indices: [] };

	const result: TimeSpan[] = [];
	const mapping: number[] = [];
	let currentEnd = spans[0].start; // Guarantees no overlap with first span

	for (const span of spans) {
		if (span.start < currentEnd) {
			// Overlapping - extend current span
			const lastIdx = result.length - 1;
			currentEnd = Math.max(currentEnd, span.end);
			result[lastIdx] = { start: result[lastIdx].start, end: currentEnd };
		} else {
			// Non-overlapping - start new span
			result.push({ start: span.start, end: span.end });
			currentEnd = span.end;
		}

		// This original span maps to the last result span
		mapping.push(result.length - 1);
	}

	return { spans: result, indices: mapping };
}

/**
 * Remove zero-length spans, grouping them with nearest non-zero neighbor.
 * Input must be sorted and non-overlapping.
 */
function removeZeroLength(spans: TimeSpan[]): { spans: TimeSpan[]; indices: number[] } {
	const nonZero = spans.filter((span) => span.end - span.start > 0);
	if (nonZero.length === 0) return { spans: [], indices: [] };

	let newIndex = 0;
	const indices: number[] = [];

	for (const span of spans) {
		if (span.end - span.start > 0) {
			// Non-zero span - maps to its position in the nonZero array
			indices.push(newIndex);
			newIndex++;
			continue;
		}

		// Zero-length span - assign to nearest non-zero neighbor
		const prevSpan = newIndex > 0 ? nonZero[newIndex - 1] : null;
		const nextSpan = newIndex < nonZero.length ? nonZero[newIndex] : null;

		if (prevSpan === null && nextSpan === null) {
			// Should not happen since nonZero.length > 0
			indices.push(0);
		} else if (prevSpan === null) {
			indices.push(newIndex);
		} else if (nextSpan === null) {
			indices.push(newIndex - 1);
		} else {
			// Pick the closer one
			const distPrev =
				span.start >= prevSpan.end ? span.start - prevSpan.end : prevSpan.start - span.end;
			const distNext =
				nextSpan.start >= span.end ? nextSpan.start - span.end : span.start - nextSpan.end;
			indices.push(distPrev <= distNext ? newIndex - 1 : newIndex);
		}
	}

	return { spans: nonZero, indices };
}

/**
 * Full preprocessing pipeline for TimeSpan arrays.
 *
 * Applies three transformations in order:
 * 1. Sort by start time
 * 2. Merge overlapping spans
 * 3. Remove zero-length spans
 *
 * Returns processed spans and an index mapping so that
 * `result.indices[originalIndex]` gives the index in `result.spans`
 * that contains the original span.
 *
 * Port of alass-core `prepare_time_spans()`.
 */
export function prepareTimeSpans(spans: TimeSpan[]): PreparedSpans {
	if (spans.length === 0) return { spans: [], indices: [] };

	type Operation = (s: TimeSpan[]) => { spans: TimeSpan[]; indices: number[] };
	const operations: Operation[] = [sortByStart, mergeOverlapping, removeZeroLength];

	let currentSpans = spans;
	let mapping = Array.from({ length: spans.length }, (_, i) => i);

	for (const operation of operations) {
		const result = operation(currentSpans);
		if (result.spans.length === 0) {
			return { spans: [], indices: [] };
		}
		// Compose mappings: mapping[i] was the old index, result.indices maps old -> new
		mapping = mapping.map((oldIdx) => result.indices[oldIdx]);
		currentSpans = result.spans;
	}

	return { spans: currentSpans, indices: mapping };
}

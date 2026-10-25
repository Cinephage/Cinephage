/**
 * Subtitle Sync Engine — High-Level Orchestrator
 *
 * Provides the main entry point for subtitle synchronization.
 * Handles the full pipeline:
 *
 * 1. Read input files (reference subtitle/video + incorrect subtitle)
 * 2. Parse subtitles to TimeSpan arrays
 * 3. If reference is video, extract speech segments via VAD
 * 4. Preprocess spans (sort, merge, remove zero-length)
 * 5. Run alignment (nosplit or split-aware)
 * 6. Map per-span deltas back to original cues
 * 7. Apply deltas to the subtitle content
 * 8. Write the synced subtitle file
 */

import { readFile, writeFile } from 'node:fs/promises';

import type { SyncOptions, SyncResult, TimeDelta, TimeSpan } from './types.js';
import { NO_PROGRESS } from './types.js';
import { parseSubtitleToSpans, parseSubtitleToCues, applyDeltas, detectFormat } from './parsers.js';
import { prepareTimeSpans } from './prepare.js';
import { standardScoring, denormalizeSplitPenalty } from './scoring.js';
import { alignNosplit } from './align-nosplit.js';
import { alignWithSplits } from './align-split.js';
import { extractSpeechSegments, mergeCloseSegments } from './vad.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SubtitleSyncEngine', logDomain: 'subtitles' });

/**
 * Maximum number of VAD speech segments to pass to alignment.
 * If VAD produces more than this, we progressively merge nearby segments.
 * 5000 spans is generous for accurate alignment while keeping memory bounded.
 */
const MAX_VAD_SPANS = 5000;

/**
 * Synchronize a subtitle file to a reference (another subtitle or video).
 *
 * This is the main entry point for the native subtitle sync engine.
 *
 * @param options - Sync configuration
 * @returns Sync result with offset info and status
 */
export async function syncSubtitles(options: SyncOptions): Promise<SyncResult> {
	const startTime = performance.now();
	const progress = options.progress ?? NO_PROGRESS;
	const splitPenalty = options.splitPenalty ?? 7;
	const noSplits = options.noSplits ?? false;

	try {
		// Step 1: Read incorrect subtitle file
		const subtitleContent = await readFile(options.subtitlePath, 'utf-8');
		const subtitleFormat = detectFormat(subtitleContent);

		if (subtitleFormat === 'unknown') {
			return {
				success: false,
				offsetMs: 0,
				splitCount: 0,
				score: 0,
				error: `Unsupported subtitle format: ${options.subtitlePath}`,
				alignmentTimeMs: performance.now() - startTime
			};
		}

		// Step 2: Parse incorrect subtitle to spans
		const rawInSpans = parseSubtitleToSpans(subtitleContent, subtitleFormat);
		const inCues = parseSubtitleToCues(subtitleContent, subtitleFormat);

		if (rawInSpans.length === 0) {
			return {
				success: false,
				offsetMs: 0,
				splitCount: 0,
				score: 0,
				error: 'No subtitle cues found in input file',
				alignmentTimeMs: performance.now() - startTime
			};
		}

		// Step 3: Get reference spans
		let rawRefSpans: TimeSpan[];

		if (options.referenceType === 'video') {
			// Extract speech segments from video via VAD
			logger.info('Extracting speech segments from video for sync reference...');
			rawRefSpans = await extractSpeechSegments(options.referencePath);

			// Downsample if VAD produced too many segments (memory protection)
			if (rawRefSpans.length > MAX_VAD_SPANS) {
				const originalCount = rawRefSpans.length;
				rawRefSpans = downsampleSpans(rawRefSpans, MAX_VAD_SPANS);
				logger.info(
					`Downsampled VAD segments: ${originalCount} → ${rawRefSpans.length} (max ${MAX_VAD_SPANS})`
				);
			}
		} else {
			// Parse reference subtitle
			const refContent = await readFile(options.referencePath, 'utf-8');
			rawRefSpans = parseSubtitleToSpans(refContent);
		}

		if (rawRefSpans.length === 0) {
			return {
				success: false,
				offsetMs: 0,
				splitCount: 0,
				score: 0,
				error: 'No reference spans found (empty reference)',
				alignmentTimeMs: performance.now() - startTime
			};
		}

		// Step 4: Preprocess spans
		const prepRef = prepareTimeSpans(rawRefSpans);
		const prepIn = prepareTimeSpans(rawInSpans);

		if (prepRef.spans.length === 0 || prepIn.spans.length === 0) {
			return {
				success: false,
				offsetMs: 0,
				splitCount: 0,
				score: 0,
				error: 'No valid spans after preprocessing',
				alignmentTimeMs: performance.now() - startTime
			};
		}

		// Step 5: Run alignment
		// Force nosplit mode for video references — split-mode DP with dense VAD
		// segments causes excessive memory usage and produces worse results.
		// This matches alass's default behavior for audio-based alignment.
		const effectiveNoSplits = noSplits || options.referenceType === 'video';
		let perPreparedSpanDeltas: TimeDelta[];
		let score: number;
		let splitCount: number;

		if (options.referenceType === 'video' && !noSplits) {
			logger.info(
				'Using constant-offset mode for video reference (split mode disabled for memory safety)'
			);
		}

		if (effectiveNoSplits || prepIn.spans.length === 1) {
			// Constant-offset mode
			const result = alignNosplit(prepRef.spans, prepIn.spans, standardScoring);
			perPreparedSpanDeltas = new Array(prepIn.spans.length).fill(result.delta);
			score = result.score;
			splitCount = 1;

			logger.info(
				`No-split alignment complete: offset=${result.delta}ms, score=${result.score.toFixed(4)}`
			);
		} else {
			// Split-aware mode
			const penalty = denormalizeSplitPenalty(
				prepRef.spans.length,
				prepIn.spans.length,
				splitPenalty
			);

			const result = alignWithSplits(
				prepRef.spans,
				prepIn.spans,
				penalty,
				standardScoring,
				progress
			);

			perPreparedSpanDeltas = result.deltas;
			score = result.score;

			// Count distinct offsets
			const uniqueDeltas = new Set(result.deltas);
			splitCount = uniqueDeltas.size;

			logger.info(
				`Split alignment complete: ${splitCount} distinct offsets, score=${result.score.toFixed(4)}`
			);
		}

		// Step 6: Map prepared-span deltas back to original cue deltas
		const perCueDeltas = mapDeltasToCues(perPreparedSpanDeltas, prepIn.indices, inCues.length);

		// Compute primary offset (median of per-cue deltas)
		const sortedDeltas = [...perCueDeltas].sort((a, b) => a - b);
		const primaryOffset = sortedDeltas[Math.floor(sortedDeltas.length / 2)];

		// Step 7: Apply deltas and write output
		const syncedContent = applyDeltas(subtitleContent, perCueDeltas, subtitleFormat);
		const outputPath = options.outputPath ?? options.subtitlePath;
		await writeFile(
			outputPath,
			syncedContent,
			options.outputPath ? { encoding: 'utf-8', flag: 'wx' } : 'utf-8'
		);

		logger.info(`Synced subtitle written to ${outputPath}`);

		const alignmentTimeMs = performance.now() - startTime;

		return {
			success: true,
			offsetMs: primaryOffset,
			perCueDeltas: splitCount > 1 ? perCueDeltas : undefined,
			splitCount,
			score,
			alignmentTimeMs
		};
	} catch (error) {
		const alignmentTimeMs = performance.now() - startTime;
		const message = error instanceof Error ? error.message : String(error);

		logger.error(`Subtitle sync failed: ${message}`);

		return {
			success: false,
			offsetMs: 0,
			splitCount: 0,
			score: 0,
			error: message,
			alignmentTimeMs
		};
	}
}

/**
 * Map per-prepared-span deltas back to per-original-cue deltas.
 *
 * The preprocessing pipeline may have merged/reordered spans, so we
 * need the index mapping to assign the correct delta to each original cue.
 *
 * @param preparedDeltas - One delta per prepared span
 * @param indices - Mapping from original index to prepared index
 * @param numCues - Number of original cues
 */
export function mapDeltasToCues(
	preparedDeltas: TimeDelta[],
	indices: number[],
	numCues: number
): TimeDelta[] {
	const cueDeltas = new Array<TimeDelta>(numCues);

	for (let i = 0; i < numCues; i++) {
		if (i < indices.length) {
			const prepIdx = indices[i];
			cueDeltas[i] = prepIdx < preparedDeltas.length ? preparedDeltas[prepIdx] : 0;
		} else {
			cueDeltas[i] = 0;
		}
	}

	return cueDeltas;
}

/**
 * Quick constant-offset sync (convenience function).
 *
 * Parses, aligns with nosplit, applies offset, and returns the result.
 * Useful for simple cases where you just need a single offset.
 */
export async function quickOffsetSync(
	subtitlePath: string,
	referencePath: string,
	referenceType: 'video' | 'subtitle' = 'subtitle',
	outputPath?: string
): Promise<SyncResult> {
	return syncSubtitles({
		referenceType,
		referencePath,
		subtitlePath,
		outputPath,
		noSplits: true
	});
}

/**
 * Downsample a span array by progressively merging close segments.
 *
 * Increases the merge gap until the span count is at or below `maxCount`.
 * Starts with a 500ms gap and doubles each iteration.
 *
 * @param spans - Input time spans (must be sorted by start time)
 * @param maxCount - Maximum number of spans to return
 * @returns Downsampled spans
 */
export function downsampleSpans(spans: TimeSpan[], maxCount: number): TimeSpan[] {
	let result = spans;
	let gap = 500;

	while (result.length > maxCount && gap < 60000) {
		result = mergeCloseSegments(result, gap);
		gap *= 2;
	}

	return result;
}

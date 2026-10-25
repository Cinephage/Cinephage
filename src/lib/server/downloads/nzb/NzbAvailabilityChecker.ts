/**
 * NzbAvailabilityChecker - Verifies NZB articles exist on NNTP servers before grab.
 *
 * Samples segments from the NZB and checks if they exist on configured NNTP providers.
 * This prevents sending doomed downloads to download clients that will fail with "cannot be completed".
 */

import { getNntpManager } from '#lib/server/streaming/usenet/NntpManager.js';
import { parseNzb } from '#lib/server/streaming/usenet/NzbParser.js';
import type { NzbSegment } from '#lib/server/streaming/usenet/types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

export interface AvailabilityResult {
	available: boolean;
	completionPercentage: number;
	checkedSegments: number;
	missingSegments: number;
	reason?: string;
	/** True if the check was skipped (NNTP unavailable) rather than failed */
	skipped?: boolean;
}

export interface AvailabilityCheckOptions {
	/** Number of segments to sample (default: 20) */
	sampleSize?: number;
	/** Minimum completion percentage to consider available (default: 90) */
	minCompletion?: number;
	/** Timeout for the entire check in ms (default: 15000) */
	timeoutMs?: number;
}

/**
 * Sample segments from array: first N, last N, and random from middle.
 */
function sampleSegments(segments: NzbSegment[], sampleSize: number): NzbSegment[] {
	if (segments.length <= sampleSize) {
		return segments;
	}

	const result: NzbSegment[] = [];
	const edgeCount = Math.min(5, Math.floor(sampleSize / 4));
	const middleCount = sampleSize - edgeCount * 2;

	// First N segments
	for (let i = 0; i < edgeCount && i < segments.length; i++) {
		result.push(segments[i]);
	}

	// Last N segments
	for (let i = Math.max(0, segments.length - edgeCount); i < segments.length; i++) {
		if (!result.includes(segments[i])) {
			result.push(segments[i]);
		}
	}

	// Random segments from middle
	const middleStart = edgeCount;
	const middleEnd = segments.length - edgeCount;
	if (middleEnd > middleStart) {
		const middleSegments = segments.slice(middleStart, middleEnd);
		const shuffled = middleSegments.sort(() => Math.random() - 0.5);
		for (let i = 0; i < middleCount && i < shuffled.length; i++) {
			if (!result.includes(shuffled[i])) {
				result.push(shuffled[i]);
			}
		}
	}

	return result;
}

/**
 * Check if NZB articles are available on NNTP servers.
 *
 * @param nzbContent - Raw NZB file content
 * @param options - Check options
 * @returns Availability result with completion percentage
 */
export async function checkNzbAvailability(
	nzbContent: Buffer | string,
	options: AvailabilityCheckOptions = {}
): Promise<AvailabilityResult> {
	const { sampleSize = 20, minCompletion = 90, timeoutMs = 15000 } = options;

	const nntpManager = getNntpManager();

	// Skip check if no NNTP servers configured or not ready
	if (nntpManager.status !== 'ready' || nntpManager.providerCount === 0) {
		logger.warn(
			{
				status: nntpManager.status,
				providerCount: nntpManager.providerCount
			},
			'[NzbAvailabilityChecker] Cannot verify availability - NNTP not available'
		);
		return {
			available: false,
			skipped: true,
			completionPercentage: 0,
			checkedSegments: 0,
			missingSegments: 0,
			reason: 'NNTP servers not configured or unavailable - cannot verify article availability'
		};
	}

	try {
		// Parse NZB to extract segments
		const parsed = parseNzb(nzbContent);
		const allSegments = parsed.files.flatMap((f) => f.segments);

		if (allSegments.length === 0) {
			logger.warn('[NzbAvailabilityChecker] NZB has no segments');
			return {
				available: false,
				completionPercentage: 0,
				checkedSegments: 0,
				missingSegments: 0,
				reason: 'NZB contains no segments'
			};
		}

		// Sample segments for checking
		const sample = sampleSegments(allSegments, sampleSize);

		logger.debug(
			{
				totalSegments: allSegments.length,
				sampleSize: sample.length,
				fileCount: parsed.files.length
			},
			'[NzbAvailabilityChecker] Checking availability'
		);

		// Check each segment with timeout
		let found = 0;
		let checked = 0;
		const startTime = Date.now();

		for (const segment of sample) {
			// Check timeout
			if (Date.now() - startTime > timeoutMs) {
				logger.warn(
					{
						checked,
						found,
						timeoutMs
					},
					'[NzbAvailabilityChecker] Check timed out'
				);
				break;
			}

			try {
				const exists = await nntpManager.articleExists(segment.messageId);
				if (exists) {
					found++;
				}
				checked++;
			} catch (error) {
				// Count as checked but not found
				checked++;
				logger.debug(
					{
						messageId: segment.messageId.slice(0, 30),
						error: error instanceof Error ? error.message : 'Unknown'
					},
					'[NzbAvailabilityChecker] Segment check failed'
				);
			}
		}

		// Calculate completion
		const completionPercentage = checked > 0 ? Math.round((found / checked) * 100) : 0;
		const available = completionPercentage >= minCompletion;

		logger.info(
			{
				available,
				completionPercentage,
				checked,
				found,
				missing: checked - found,
				totalSegments: allSegments.length
			},
			'[NzbAvailabilityChecker] Availability check complete'
		);

		return {
			available,
			completionPercentage,
			checkedSegments: checked,
			missingSegments: checked - found,
			reason: available
				? undefined
				: `Only ${completionPercentage}% of sampled articles found on usenet (${found}/${checked})`
		};
	} catch (error) {
		// If NZB parsing fails or other error, return as unavailable with error
		logger.error(
			{
				error: error instanceof Error ? error.message : 'Unknown error'
			},
			'[NzbAvailabilityChecker] Check failed'
		);

		return {
			available: false,
			completionPercentage: 0,
			checkedSegments: 0,
			missingSegments: 0,
			reason: `Availability check failed: ${error instanceof Error ? error.message : 'Unknown'}`
		};
	}
}

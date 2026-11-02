/**
 * Resolution Pattern Matching
 *
 * Extracts video resolution from release titles (2160p, 1080p, 720p, 480p)
 */

import type { Resolution } from '../types.js';

interface ResolutionMatch {
	resolution: Resolution;
	matchedText: string;
	index: number;
}

/**
 * Resolution patterns ordered by specificity (most specific first)
 */
const RESOLUTION_PATTERNS: Array<{ pattern: RegExp; resolution: Resolution }> = [
	// Explicit numeric resolutions - checked before marketing aliases below so
	// a title stating both (e.g. "1080p UHD BluRay", an encode sourced from
	// UHD/4K media but authored at 1080p) resolves to what it actually is.
	{ pattern: /\b2160p?\b/i, resolution: '2160p' },
	{ pattern: /\b3840\s*x\s*2160\b/i, resolution: '2160p' },

	{ pattern: /\b1080p?\b/i, resolution: '1080p' },
	{ pattern: /\b1920\s*x\s*1080\b/i, resolution: '1080p' },
	{ pattern: /\bfhd\b/i, resolution: '1080p' },
	{ pattern: /\bfull\s*hd\b/i, resolution: '1080p' },

	{ pattern: /\b720p?\b/i, resolution: '720p' },
	{ pattern: /\b1280\s*x\s*720\b/i, resolution: '720p' },
	{ pattern: /\bhd\s*720\b/i, resolution: '720p' },

	{ pattern: /\b480p?\b/i, resolution: '480p' },
	{ pattern: /\b640\s*x\s*480\b/i, resolution: '480p' },
	{ pattern: /\b576p?\b/i, resolution: '480p' },
	{ pattern: /\b480i\b/i, resolution: '480p' },
	{ pattern: /\bsd\b/i, resolution: '480p' },
	{ pattern: /\bdvdrip\b/i, resolution: '480p' },

	// 4K/UHD marketing aliases - fallback only. A real explicit resolution
	// token elsewhere in the title always wins (see above); these only match
	// when no explicit numeric resolution was stated.
	{ pattern: /\b4k\b/i, resolution: '2160p' },
	{ pattern: /\buhd\b/i, resolution: '2160p' }
];

/**
 * Extract resolution from a release title
 *
 * @param title - The release title to parse
 * @returns Resolution match info or null if not found
 */
export function extractResolution(title: string): ResolutionMatch | null {
	for (const { pattern, resolution } of RESOLUTION_PATTERNS) {
		const match = title.match(pattern);
		if (match) {
			return {
				resolution,
				matchedText: match[0],
				index: match.index ?? 0
			};
		}
	}
	return null;
}

/**
 * Check if a string likely contains resolution info
 */
export function hasResolutionInfo(title: string): boolean {
	return RESOLUTION_PATTERNS.some(({ pattern }) => pattern.test(title));
}

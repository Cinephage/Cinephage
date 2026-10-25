/**
 * Format Condition Matcher
 *
 * Evaluates releases against custom format conditions to determine matches.
 * Implements the condition logic: required conditions must ALL match,
 * optional conditions use OR logic (at least one must match).
 */

import { languageMatches } from '#lib/server/languages/audio-preference.js';
import { createSafeRegex } from '#lib/server/indexers/engine/safeRegex.js';
import type {
	CustomFormat,
	FormatCondition,
	ConditionMatchResult,
	MatchedFormat,
	ReleaseAttributes
} from './types.js';

// =============================================================================
// Regex Pattern Cache
// =============================================================================

const patternCache = new Map<string, RegExp>();

const NEVER_MATCHES = /(?!)/;

/**
 * Get a compiled regex pattern, using cache for performance.
 *
 * Patterns come from admin-authored custom formats but run against every
 * scraped release title, so they go through createSafeRegex: a pathological
 * pattern (nested quantifiers, overlapping alternation) or an over-long one
 * is rejected instead of hanging each release evaluation. Rejected and
 * invalid patterns compile to a never-matching regex, not an error — a bad
 * format must degrade scoring for itself only.
 */
function getPattern(pattern: string): RegExp {
	let regex = patternCache.get(pattern);
	if (!regex) {
		regex = createSafeRegex(pattern, 'i') ?? NEVER_MATCHES;
		patternCache.set(pattern, regex);
	}
	return regex;
}

// =============================================================================
// Condition Evaluation
// =============================================================================

/**
 * Evaluate a single condition against release attributes
 */
export function evaluateCondition(
	condition: FormatCondition,
	release: ReleaseAttributes
): ConditionMatchResult {
	let rawMatch = false;

	switch (condition.type) {
		case 'resolution':
			rawMatch = condition.resolution === release.resolution;
			break;

		case 'source':
			rawMatch = condition.source === release.source;
			break;

		case 'release_title':
			if (condition.pattern) {
				const pattern = getPattern(condition.pattern);
				rawMatch = pattern.test(release.title);
			}
			break;

		case 'release_group':
			if (condition.pattern && release.releaseGroup) {
				const pattern = getPattern(condition.pattern);
				rawMatch = pattern.test(release.releaseGroup);
			} else if (condition.pattern && !release.releaseGroup) {
				// No release group detected - check if pattern is for "missing"
				rawMatch = false;
			}
			break;

		case 'codec':
			rawMatch = condition.codec === release.codec;
			break;

		case 'audio_codec':
			rawMatch = condition.audioCodec === release.audioCodec;
			break;

		case 'audio_channels':
			rawMatch = condition.audioChannels === release.audioChannels;
			break;

		case 'audio_atmos':
			rawMatch = release.hasAtmos === true;
			break;

		case 'hdr':
			// Handle null HDR (SDR) matching
			if (condition.hdr === null || condition.hdr === 'sdr') {
				rawMatch = release.hdr === null || release.hdr === 'sdr';
			} else {
				rawMatch = condition.hdr === release.hdr;
			}
			break;

		case 'streaming_service':
			rawMatch =
				condition.streamingService?.toLowerCase() === release.streamingService?.toLowerCase();
			break;

		case 'flag':
			switch (condition.flag) {
				case 'isRemux':
					rawMatch = release.isRemux;
					break;
				case 'isRepack':
					rawMatch = release.isRepack;
					break;
				case 'isProper':
					rawMatch = release.isProper;
					break;
				case 'is3d':
					rawMatch = release.is3d;
					break;
				default:
					rawMatch = false;
			}
			break;

		case 'indexer':
			// Match by indexer name (case-insensitive)
			if (condition.indexer && release.indexerName) {
				rawMatch = condition.indexer.toLowerCase() === release.indexerName.toLowerCase();
			}
			break;

		case 'language':
			// Match a language tag (base-tag fallback, eng→en) or one of the
			// parser's pseudo-codes against the parsed language tokens.
			if (condition.language) {
				const tokens = release.languages ?? [];
				if (condition.language === 'multi' || condition.language === 'orig') {
					rawMatch = tokens.includes(condition.language);
				} else {
					rawMatch = tokens.some(
						(tag) => tag !== 'multi' && tag !== 'orig' && languageMatches(tag, condition.language!)
					);
				}
			}
			break;
	}

	// Apply negation
	const matches = condition.negate ? !rawMatch : rawMatch;

	return {
		condition,
		rawMatch,
		matches
	};
}

/**
 * Evaluate all conditions for a format against a release
 *
 * Logic:
 * - ALL required conditions must match (AND logic)
 * - At least ONE optional condition must match if any exist (OR logic)
 * - If no optional conditions exist, only required conditions matter
 */
export function evaluateFormat(
	format: CustomFormat,
	release: ReleaseAttributes
): { matches: boolean; results: ConditionMatchResult[] } {
	const results: ConditionMatchResult[] = [];

	const requiredConditions: ConditionMatchResult[] = [];
	const optionalConditions: ConditionMatchResult[] = [];

	// Evaluate all conditions
	for (const condition of format.conditions) {
		const result = evaluateCondition(condition, release);
		results.push(result);

		if (condition.required) {
			requiredConditions.push(result);
		} else {
			optionalConditions.push(result);
		}
	}

	// Check required conditions (ALL must match)
	const allRequiredMatch = requiredConditions.every((r) => r.matches);

	if (!allRequiredMatch) {
		return { matches: false, results };
	}

	// Check optional conditions (at least ONE must match, if any exist)
	if (optionalConditions.length > 0) {
		const anyOptionalMatches = optionalConditions.some((r) => r.matches);
		return { matches: anyOptionalMatches, results };
	}

	// No optional conditions, all required matched
	return { matches: true, results };
}

// =============================================================================
// Format Matching
// =============================================================================

/**
 * Match a release against all provided formats
 * Returns all formats that match the release
 */
export function matchFormats(release: ReleaseAttributes, formats: CustomFormat[]): MatchedFormat[] {
	const matched: MatchedFormat[] = [];

	for (const format of formats) {
		const { matches, results } = evaluateFormat(format, release);

		if (matches) {
			matched.push({
				format,
				conditionResults: results
			});
		}
	}

	return matched;
}

/**
 * Check if a release matches a specific format by ID
 */
export function matchesFormat(release: ReleaseAttributes, format: CustomFormat): boolean {
	const { matches } = evaluateFormat(format, release);
	return matches;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Extract release attributes from a parsed release
 * Bridges the parser output to scoring input
 */
export function extractAttributes(parsed: {
	originalTitle: string;
	cleanTitle: string;
	year?: number;
	resolution: string;
	source: string;
	codec: string;
	hdr: string | null;
	audioCodec: string;
	audioChannels: string;
	hasAtmos: boolean;
	releaseGroup?: string;
	languages: string[];
	streamingService?: string;
	edition?: string;
	isRemux: boolean;
	isRepack: boolean;
	isProper: boolean;
	is3d: boolean;
	episode?: {
		isSeasonPack: boolean;
		isCompleteSeries: boolean;
	};
}): ReleaseAttributes {
	return {
		title: parsed.originalTitle,
		cleanTitle: parsed.cleanTitle,
		year: parsed.year,
		resolution: parsed.resolution as ReleaseAttributes['resolution'],
		source: parsed.source as ReleaseAttributes['source'],
		codec: parsed.codec as ReleaseAttributes['codec'],
		hdr: parsed.hdr as ReleaseAttributes['hdr'],
		audioCodec: parsed.audioCodec as ReleaseAttributes['audioCodec'],
		audioChannels: parsed.audioChannels as ReleaseAttributes['audioChannels'],
		hasAtmos: parsed.hasAtmos,
		releaseGroup: parsed.releaseGroup,
		streamingService: parsed.streamingService ?? detectStreamingService(parsed.originalTitle),
		edition: parsed.edition,
		languages: parsed.languages,
		isRemux: parsed.isRemux,
		isRepack: parsed.isRepack,
		isProper: parsed.isProper,
		is3d: parsed.is3d,
		isSeasonPack: parsed.episode?.isSeasonPack,
		isCompleteSeries: parsed.episode?.isCompleteSeries
	};
}

/**
 * Detect streaming service from release title
 */
function detectStreamingService(title: string): string | undefined {
	const services: Record<string, RegExp> = {
		AMZN: /\b(AMZN|Amazon)\b/i,
		NF: /\b(NF|Netflix)\b/i,
		ATVP: /\b(ATVP|AppleTV\+?)\b/i,
		DSNP: /\b(DSNP|Disney\+?)\b/i,
		HMAX: /\b(HMAX|HBOMax)\b/i,
		MAX: /\bMAX\b/,
		PCOK: /\b(PCOK|Peacock)\b/i,
		PMTP: /\b(PMTP|Paramount\+?)\b/i,
		HULU: /\bHULU\b/i,
		iT: /\b(iT|iTunes)\b/i,
		STAN: /\bSTAN\b/i,
		CRAV: /\b(CRAV|Crave)\b/i,
		NOW: /\bNOW\b/,
		SHO: /\b(SHO|Showtime)\b/i,
		ROKU: /\bROKU\b/i
	};

	for (const [service, pattern] of Object.entries(services)) {
		if (pattern.test(title)) {
			return service;
		}
	}

	return undefined;
}

/**
 * Clear the pattern cache (useful for testing)
 */
export function clearPatternCache(): void {
	patternCache.clear();
}

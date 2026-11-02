/**
 * Safe regex utilities to prevent ReDoS attacks.
 * Validates regex patterns and provides safe execution.
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

/**
 * Inline regex flags commonly found in Cardigann/Prowlarr definitions.
 * JavaScript does not support PCRE-style inline groups like `(?i)` directly,
 * so we normalize leading flag groups into RegExp flags.
 */
const INLINE_FLAG_MAP: Record<string, string> = {
	i: 'i',
	m: 'm',
	s: 's',
	u: 'u'
};

/**
 * Maximum input length to process with regex.
 */
const MAX_INPUT_LENGTH = 100000;

/**
 * Patterns that indicate potentially dangerous regex constructs.
 * These can cause exponential backtracking (ReDoS).
 */
const DANGEROUS_PATTERNS = [
	// Nested quantifiers: (a+)+ or (a*)*
	/\([^)]*[+*]\)[+*]/,
	// Overlapping alternation with quantifiers: (a|a)+
	/\([^)]*\|[^)]*\)[+*]/,
	// Backreferences with quantifiers can be dangerous
	/\\[1-9][+*]/,
	// Very long character classes with quantifiers
	/\[[^\]]{50,}\][+*]/
];

/**
 * Check if a regex pattern contains potentially dangerous constructs.
 * Returns true if the pattern appears safe, false if it might cause ReDoS.
 */
export function isPatternSafe(pattern: string): boolean {
	// Empty patterns are safe
	if (!pattern) return true;

	// Very long patterns are suspicious
	if (pattern.length > 500) {
		logger.warn({ length: pattern.length }, 'Regex pattern too long');
		return false;
	}

	// Check for dangerous constructs
	for (const dangerous of DANGEROUS_PATTERNS) {
		if (dangerous.test(pattern)) {
			logger.warn(
				{
					pattern: pattern.substring(0, 100)
				},
				'Potentially dangerous regex pattern detected'
			);
			return false;
		}
	}

	return true;
}

/**
 * Normalize leading PCRE-style inline flag groups (e.g. `(?i)` / `(?-i)`).
 * Returns a JavaScript-compatible pattern + merged flag string.
 */
function normalizePatternAndFlags(
	pattern: string,
	flags?: string
): { pattern: string; flags: string } {
	let normalizedPattern = pattern;
	let normalizedFlags = flags ?? '';

	const addFlag = (flag: string): void => {
		if (!normalizedFlags.includes(flag)) {
			normalizedFlags += flag;
		}
	};

	const removeFlag = (flag: string): void => {
		normalizedFlags = normalizedFlags
			.split('')
			.filter((existing) => existing !== flag)
			.join('');
	};

	while (true) {
		const inlineMatch = normalizedPattern.match(/^\(\?([a-zA-Z-]+)\)/);
		if (!inlineMatch) break;

		const inlineFlags = inlineMatch[1];
		normalizedPattern = normalizedPattern.slice(inlineMatch[0].length);

		let removeMode = false;
		for (const char of inlineFlags) {
			if (char === '-') {
				removeMode = true;
				continue;
			}

			const mapped = INLINE_FLAG_MAP[char.toLowerCase()];
			if (!mapped) continue;

			if (removeMode) {
				removeFlag(mapped);
			} else {
				addFlag(mapped);
			}
		}
	}

	return {
		pattern: normalizedPattern,
		flags: normalizedFlags
	};
}

/**
 * Safely create a RegExp, returning null if the pattern is invalid or dangerous.
 */
export function createSafeRegex(pattern: string, flags?: string): RegExp | null {
	const normalized = normalizePatternAndFlags(pattern, flags);

	// Validate pattern safety
	if (!isPatternSafe(normalized.pattern)) {
		return null;
	}

	try {
		return new RegExp(normalized.pattern, normalized.flags);
	} catch (err) {
		logger.warn(
			{
				pattern: pattern.substring(0, 100),
				error: err instanceof Error ? err.message : 'Unknown error'
			},
			'Invalid regex pattern'
		);
		return null;
	}
}

/**
 * Safely execute a regex match with input length limits.
 * Returns null if the input is too long or the regex fails.
 */
export function safeMatch(input: string, regex: RegExp): RegExpMatchArray | null {
	// Limit input length to prevent slow operations
	if (input.length > MAX_INPUT_LENGTH) {
		logger.warn(
			{
				length: input.length,
				limit: MAX_INPUT_LENGTH
			},
			'Input too long for regex match'
		);
		return null;
	}

	try {
		return input.match(regex);
	} catch (err) {
		logger.warn(
			{
				error: err instanceof Error ? err.message : 'Unknown error'
			},
			'Regex match failed'
		);
		return null;
	}
}

/**
 * Safely execute a regex replace with input length limits.
 * Returns the original string if the operation fails.
 */
export function safeReplace(input: string, regex: RegExp, replacement: string): string {
	// Limit input length to prevent slow operations
	if (input.length > MAX_INPUT_LENGTH) {
		logger.warn(
			{
				length: input.length,
				limit: MAX_INPUT_LENGTH
			},
			'Input too long for regex replace'
		);
		return input;
	}

	try {
		return input.replace(regex, replacement);
	} catch (err) {
		logger.warn(
			{
				error: err instanceof Error ? err.message : 'Unknown error'
			},
			'Regex replace failed'
		);
		return input;
	}
}

/**
 * Provider Mixins - Based on Bazarr/Subliminal architecture
 *
 * Reusable behaviors that can be applied to providers:
 * - RetryMixin: Automatic retry with exponential backoff
 * - ArchiveMixin: ZIP/RAR extraction for subtitle packs
 * - PunctuationMixin: Title normalization for matching
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import { unzipSync } from 'fflate';

// ============================================================================
// RETRY MIXIN
// ============================================================================

/**
 * Retry configuration
 */
export interface RetryConfig {
	/** Maximum number of retry attempts */
	maxAttempts?: number;
	/** Initial delay in milliseconds */
	initialDelay?: number;
	/** Maximum delay in milliseconds */
	maxDelay?: number;
	/** Backoff multiplier */
	backoffMultiplier?: number;
	/** Error types to retry on */
	retryOn?: (new (...args: unknown[]) => Error)[];
	/** Error types to NOT retry on */
	noRetryOn?: (new (...args: unknown[]) => Error)[];
	/** Custom retry condition */
	shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: Required<
	Pick<RetryConfig, 'maxAttempts' | 'initialDelay' | 'maxDelay' | 'backoffMultiplier'>
> = {
	maxAttempts: 3,
	initialDelay: 1000,
	maxDelay: 30000,
	backoffMultiplier: 2
};

/**
 * Retry decorator for provider methods
 *
 * Usage:
 * ```typescript
 * class MyProvider extends BaseSubtitleProvider {
 *   @retry({ maxAttempts: 3 })
 *   async search(...) { ... }
 * }
 * ```
 */
export function retry(config: RetryConfig = {}) {
	return function (
		_target: unknown,
		propertyKey: string,
		descriptor: PropertyDescriptor
	): PropertyDescriptor {
		const originalMethod = descriptor.value;

		descriptor.value = async function (...args: unknown[]) {
			return executeWithRetry(
				() => originalMethod.apply(this, args),
				{
					...DEFAULT_RETRY_CONFIG,
					...config
				},
				propertyKey
			);
		};

		return descriptor;
	};
}

/**
 * Execute a function with retry logic
 */
export async function executeWithRetry<T>(
	fn: () => Promise<T>,
	config: RetryConfig = {},
	operationName = 'operation'
): Promise<T> {
	const {
		maxAttempts = DEFAULT_RETRY_CONFIG.maxAttempts,
		initialDelay = DEFAULT_RETRY_CONFIG.initialDelay,
		maxDelay = DEFAULT_RETRY_CONFIG.maxDelay,
		backoffMultiplier = DEFAULT_RETRY_CONFIG.backoffMultiplier,
		retryOn,
		noRetryOn,
		shouldRetry
	} = config;

	let lastError: Error | undefined;
	let delay = initialDelay;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if we should retry
			if (!shouldRetryError(lastError, attempt, { retryOn, noRetryOn, shouldRetry, maxAttempts })) {
				throw lastError;
			}

			// Don't wait after last attempt
			if (attempt < maxAttempts) {
				logger.debug(
					{
						error: lastError.message
					},
					`[Retry] ${operationName} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`
				);

				await sleep(delay);
				delay = Math.min(delay * backoffMultiplier, maxDelay);
			}
		}
	}

	throw lastError;
}

/**
 * Check if an error should trigger a retry
 */
function shouldRetryError(
	error: Error,
	attempt: number,
	config: Pick<RetryConfig, 'retryOn' | 'noRetryOn' | 'shouldRetry' | 'maxAttempts'>
): boolean {
	const { retryOn, noRetryOn, shouldRetry, maxAttempts = 3 } = config;

	// Already at max attempts
	if (attempt >= maxAttempts) {
		return false;
	}

	// Custom retry condition
	if (shouldRetry) {
		return shouldRetry(error, attempt);
	}

	// Check noRetryOn list first (blacklist)
	if (noRetryOn) {
		for (const ErrorType of noRetryOn) {
			if (error instanceof ErrorType) {
				return false;
			}
		}
	}

	// Check retryOn list (whitelist)
	if (retryOn) {
		for (const ErrorType of retryOn) {
			if (error instanceof ErrorType) {
				return true;
			}
		}
		return false; // Not in whitelist
	}

	// Default: retry on network-like errors
	const retryableMessages = [
		'timeout',
		'ETIMEDOUT',
		'ECONNRESET',
		'ECONNREFUSED',
		'socket hang up',
		'network',
		'fetch failed',
		'503',
		'502',
		'429'
	];

	const errorMessage = error.message.toLowerCase();
	return retryableMessages.some((msg) => errorMessage.includes(msg.toLowerCase()));
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// REINITIALIZE ON ERROR DECORATOR
// ============================================================================

/**
 * Decorator that reinitializes provider on specific exceptions
 *
 * Based on Bazarr's reinitialize_on_error decorator
 */
export function reinitializeOnError(
	exceptions: (new (...args: unknown[]) => Error)[],
	maxAttempts = 1
) {
	return function (
		_target: unknown,
		propertyKey: string,
		descriptor: PropertyDescriptor
	): PropertyDescriptor {
		const originalMethod = descriptor.value;

		descriptor.value = async function (
			this: { reinitialize(): Promise<void> },
			...args: unknown[]
		) {
			let attempt = 0;

			while (attempt <= maxAttempts) {
				try {
					return await originalMethod.apply(this, args);
				} catch (error) {
					const isMatchingException = exceptions.some(
						(ExceptionType) => error instanceof ExceptionType
					);

					if (isMatchingException && attempt < maxAttempts) {
						attempt++;
						logger.warn(
							`[${propertyKey}] Caught exception, reinitializing provider (attempt ${attempt}/${maxAttempts})`
						);
						await this.reinitialize();
						continue;
					}

					throw error;
				}
			}
		};

		return descriptor;
	};
}

// ============================================================================
// ARCHIVE MIXIN
// ============================================================================

/**
 * Extracted file from archive
 */
export interface ExtractedFile {
	filename: string;
	content: Buffer;
}

/**
 * Archive extraction options
 */
export interface ArchiveExtractionOptions {
	/** Only extract subtitle files */
	subtitlesOnly?: boolean;
	/** Preferred language code to match in filename */
	preferredLanguage?: string;
	/** Episode number to match in pack */
	episodeNumber?: number;
}

/**
 * Subtitle file extensions
 */
const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.sub', '.vtt'];

/**
 * Check if a file is a subtitle file
 */
export function isSubtitleFile(filename: string): boolean {
	const lower = filename.toLowerCase();
	return SUBTITLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Extract subtitle from a ZIP archive
 *
 * Based on Bazarr's ProviderSubtitleArchiveMixin
 */
export function extractFromZip(
	data: Buffer,
	options: ArchiveExtractionOptions = {}
): ExtractedFile | undefined {
	const { subtitlesOnly = true, preferredLanguage, episodeNumber } = options;

	try {
		const decompressed = unzipSync(new Uint8Array(data));
		const files: ExtractedFile[] = [];

		for (const [filename, content] of Object.entries(decompressed)) {
			// Skip directories
			if (filename.endsWith('/')) continue;

			// Filter to subtitles only
			if (subtitlesOnly && !isSubtitleFile(filename)) continue;

			files.push({
				filename,
				content: Buffer.from(content as Uint8Array)
			});
		}

		if (files.length === 0) {
			return undefined;
		}

		// If only one file, return it
		if (files.length === 1) {
			return files[0];
		}

		// Try to find best match
		return findBestSubtitleInArchive(files, { preferredLanguage, episodeNumber });
	} catch (error) {
		logger.warn(
			{
				error: error instanceof Error ? error.message : String(error)
			},
			'Failed to extract ZIP archive'
		);
		return undefined;
	}
}

/**
 * Find the best subtitle file in an archive
 */
function findBestSubtitleInArchive(
	files: ExtractedFile[],
	options: Pick<ArchiveExtractionOptions, 'preferredLanguage' | 'episodeNumber'>
): ExtractedFile | undefined {
	const { preferredLanguage, episodeNumber } = options;

	// Score each file
	const scored = files.map((file) => {
		let score = 0;
		const lowerFilename = file.filename.toLowerCase();

		// Prefer SRT format
		if (lowerFilename.endsWith('.srt')) score += 10;

		// Prefer matching language
		if (preferredLanguage) {
			if (lowerFilename.includes(preferredLanguage.toLowerCase())) {
				score += 20;
			}
		}

		// Prefer matching episode number
		if (episodeNumber !== undefined) {
			const episodePatterns = [
				new RegExp(`e${String(episodeNumber).padStart(2, '0')}`, 'i'),
				new RegExp(`\\.${episodeNumber}\\.`, 'i'),
				new RegExp(`episode\\.?${episodeNumber}`, 'i')
			];
			if (episodePatterns.some((p) => p.test(file.filename))) {
				score += 30;
			}
		}

		// Prefer larger files (more likely to be complete)
		score += Math.min(file.content.length / 10000, 5);

		return { file, score };
	});

	// Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	return scored[0]?.file;
}

/**
 * Extract all subtitles from a ZIP archive (for packs)
 */
export function extractAllFromZip(data: Buffer): ExtractedFile[] {
	try {
		const decompressed = unzipSync(new Uint8Array(data));
		const files: ExtractedFile[] = [];

		for (const [filename, content] of Object.entries(decompressed)) {
			if (filename.endsWith('/')) continue;
			if (!isSubtitleFile(filename)) continue;

			files.push({
				filename,
				content: Buffer.from(content as Uint8Array)
			});
		}

		return files;
	} catch (error) {
		logger.warn(
			{
				error: error instanceof Error ? error.message : String(error)
			},
			'Failed to extract ZIP archive'
		);
		return [];
	}
}

// ============================================================================
// PUNCTUATION MIXIN
// ============================================================================

/**
 * Punctuation and title normalization utilities
 *
 * Based on Bazarr's PunctuationMixin
 */
export const PunctuationMixin = {
	/**
	 * Clean punctuation from a string for matching
	 *
	 * Fixes show IDs for stuff like "Mr. Robot" -> "Mr Robot"
	 */
	cleanPunctuation(s: string): string {
		return s
			.replace(/[.,:;!?'"()[\]{}]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	},

	/**
	 * Normalize title for matching
	 *
	 * - Lowercase
	 * - Remove punctuation
	 * - Remove common articles
	 * - Normalize whitespace
	 */
	normalizeTitle(title: string): string {
		let normalized = title.toLowerCase();

		// Remove punctuation
		normalized = this.cleanPunctuation(normalized);

		// Remove common articles
		const articles = ['the', 'a', 'an', 'der', 'die', 'das', 'le', 'la', 'les', 'el', 'los', 'las'];
		for (const article of articles) {
			const pattern = new RegExp(`^${article}\\s+`, 'i');
			normalized = normalized.replace(pattern, '');
		}

		// Normalize whitespace
		normalized = normalized.replace(/\s+/g, ' ').trim();

		return normalized;
	},

	/**
	 * Check if two titles match (with normalization)
	 */
	titlesMatch(title1: string, title2: string): boolean {
		return this.normalizeTitle(title1) === this.normalizeTitle(title2);
	},

	/**
	 * Normalize series title for episode matching
	 *
	 * Handles variations like:
	 * - "Grey's Anatomy" vs "Greys Anatomy"
	 * - "The Office (US)" vs "The Office"
	 */
	normalizeSeriesTitle(series: string): string {
		let normalized = this.normalizeTitle(series);

		// Remove country/year suffixes in parentheses
		normalized = normalized.replace(/\s*\([^)]*\)\s*$/, '');

		// Remove common country suffixes
		const countrySuffixes = ['us', 'uk', 'au'];
		for (const suffix of countrySuffixes) {
			const pattern = new RegExp(`\\s+${suffix}$`, 'i');
			normalized = normalized.replace(pattern, '');
		}

		// Remove trailing year suffixes (e.g., "Home Town 2023" -> "Home Town")
		normalized = normalized.replace(/\s+(?:19|20)\d{2}$/, '');

		return normalized.trim();
	},

	/**
	 * Check if two series titles match
	 */
	seriesTitlesMatch(series1: string, series2: string): boolean {
		return this.normalizeSeriesTitle(series1) === this.normalizeSeriesTitle(series2);
	}
};

// ============================================================================
// RATE LIMIT MIXIN
// ============================================================================

/**
 * Simple rate limiter for provider requests.
 *
 * `acquire()` is serialized: concurrent callers (tier searches run providers
 * with `Promise.all`) queue behind one another instead of all reading the same
 * token count, waking together, and driving it negative.
 */
export class RateLimiter {
	private tokens: number;
	private lastRefill: number;
	private readonly maxTokens: number;
	private readonly refillRate: number; // tokens per second
	private acquireChain: Promise<void> = Promise.resolve();

	constructor(requestsPerMinute: number) {
		this.maxTokens = requestsPerMinute;
		this.tokens = this.maxTokens;
		this.refillRate = requestsPerMinute / 60;
		this.lastRefill = Date.now();
	}

	/**
	 * Try to acquire a token for making a request
	 */
	async acquire(): Promise<void> {
		const run = this.acquireChain.then(() => this.waitForToken());
		// Keep the chain alive even if a waiter throws.
		this.acquireChain = run.catch(() => {});
		return run;
	}

	private async waitForToken(): Promise<void> {
		this.refill();
		while (this.tokens < 1) {
			const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.refillRate) * 1000));
			await sleep(waitMs);
			this.refill();
		}
		this.tokens -= 1;
	}

	/**
	 * Check if a request can be made immediately
	 */
	canMakeRequest(): boolean {
		this.refill();
		return this.tokens >= 1;
	}

	/**
	 * Get time until next token is available (in ms)
	 */
	getWaitTime(): number {
		this.refill();
		if (this.tokens >= 1) return 0;
		return (1 / this.refillRate) * 1000;
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = (now - this.lastRefill) / 1000;
		const newTokens = elapsed * this.refillRate;

		this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
		this.lastRefill = now;
	}
}

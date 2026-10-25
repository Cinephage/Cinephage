/**
 * HTTP Retry Policy - Resilience layer for transient failures.
 *
 * Implements exponential backoff retry for:
 * - 5xx server errors (except 501 Not Implemented)
 * - 408 Request Timeout
 * - 429 Too Many Requests (with Retry-After header support)
 * - Network errors (ECONNRESET, ETIMEDOUT, etc.)
 *
 * Does NOT retry:
 * - 4xx client errors (except 408, 429)
 * - Cloudflare challenges (handled separately)
 * - Authentication failures
 */

import { createChildLogger } from '#lib/logging/index.js';

const log = createChildLogger({ module: 'RetryPolicy' });

/** Configuration for retry behavior */
export interface RetryConfig {
	/** Maximum number of retry attempts (default: 3) */
	maxRetries?: number;
	/** Initial delay in ms before first retry (default: 1000) */
	initialDelayMs?: number;
	/** Maximum delay in ms between retries (default: 30000) */
	maxDelayMs?: number;
	/** Multiplier for exponential backoff (default: 2) */
	backoffMultiplier?: number;
	/** Jitter factor to randomize delays 0-1 (default: 0.1) */
	jitterFactor?: number;
	/** Additional status codes to retry on */
	additionalRetryableCodes?: number[];
}

/** Result of a retry operation */
export interface RetryResult<T> {
	/** The successful result */
	result: T;
	/** Number of attempts made (1 = no retries needed) */
	attempts: number;
	/** Total time spent including delays */
	totalTimeMs: number;
}

/** Context passed to the retry operation */
export interface RetryContext {
	/** Current attempt number (1-based) */
	attempt: number;
	/** Previous error if retrying */
	lastError?: Error;
	/** Time elapsed so far */
	elapsedMs: number;
}

/**
 * Determines if an error/response should be retried.
 */
export interface RetryDecision {
	/** Whether to retry */
	shouldRetry: boolean;
	/** Suggested delay in ms (e.g., from Retry-After header) */
	suggestedDelayMs?: number;
	/** Reason for the decision */
	reason: string;
}

/** Default retry status codes */
const DEFAULT_RETRYABLE_STATUS_CODES = new Set([
	408, // Request Timeout
	429, // Too Many Requests
	500, // Internal Server Error
	502, // Bad Gateway
	503, // Service Unavailable
	504 // Gateway Timeout
]);

/**
 * Cloudflare origin errors - these indicate the origin server is down.
 * Retrying these wastes time since the origin won't recover in seconds.
 * Better to fail fast and trigger failover to alternate URLs.
 */
const CLOUDFLARE_ORIGIN_ERRORS = new Set([
	521, // Cloudflare: Web Server Is Down
	522, // Cloudflare: Connection Timed Out
	523, // Cloudflare: Origin Is Unreachable
	524, // Cloudflare: A Timeout Occurred
	530 // Cloudflare: Origin DNS Error
]);

/**
 * Cloudflare errors that may be worth a single retry (SSL/transient issues)
 */
const CLOUDFLARE_TRANSIENT_ERRORS = new Set([
	520, // Cloudflare: Unknown Error
	525, // Cloudflare: SSL Handshake Failed
	526, // Cloudflare: Invalid SSL Certificate
	527 // Cloudflare: Railgun Error
]);

/** Network error codes that indicate transient issues */
const RETRYABLE_ERROR_CODES = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'ENOTFOUND',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'EPIPE',
	'EAI_AGAIN',
	'ECONNABORTED',
	'ENETDOWN',
	'EHOSTDOWN',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET'
]);

/**
 * Check if a status code is a Cloudflare origin error (origin server is down).
 * These should NOT be retried - fail fast and trigger failover instead.
 */
export function isCloudflareOriginError(status: number): boolean {
	return CLOUDFLARE_ORIGIN_ERRORS.has(status);
}

/**
 * Check if a status code is a Cloudflare transient error (worth one retry).
 */
export function isCloudflareTransientError(status: number): boolean {
	return CLOUDFLARE_TRANSIENT_ERRORS.has(status);
}

/**
 * Check if an HTTP status code is retryable.
 * Cloudflare origin errors are NOT retryable to allow faster failover.
 */
export function isRetryableStatusCode(status: number, additionalCodes?: number[]): boolean {
	// Cloudflare origin errors should NOT be retried - fail fast for failover
	if (CLOUDFLARE_ORIGIN_ERRORS.has(status)) {
		return false;
	}
	// Cloudflare transient errors get one retry attempt
	if (CLOUDFLARE_TRANSIENT_ERRORS.has(status)) {
		return true;
	}
	if (DEFAULT_RETRYABLE_STATUS_CODES.has(status)) {
		return true;
	}
	if (additionalCodes?.includes(status)) {
		return true;
	}
	return false;
}

/**
 * Check if an error is a retryable network error.
 */
export function isRetryableNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	// Check error code
	const errorCode = (error as NodeJS.ErrnoException).code;
	if (errorCode && RETRYABLE_ERROR_CODES.has(errorCode)) {
		return true;
	}

	// Check error message for common patterns
	const message = error.message.toLowerCase();
	if (
		message.includes('network') ||
		message.includes('timeout') ||
		message.includes('connection') ||
		message.includes('socket') ||
		message.includes('econnreset') ||
		message.includes('fetch failed')
	) {
		return true;
	}

	return false;
}

/**
 * Parse Retry-After header value.
 * @returns Delay in milliseconds, or undefined if not parseable
 */
export function parseRetryAfter(headers: Headers): number | undefined {
	const retryAfter = headers.get('Retry-After');
	if (!retryAfter) {
		return undefined;
	}

	// Try parsing as seconds (integer)
	const seconds = parseInt(retryAfter, 10);
	if (!isNaN(seconds) && seconds > 0) {
		return seconds * 1000;
	}

	// Try parsing as HTTP date
	const date = new Date(retryAfter);
	if (!isNaN(date.getTime())) {
		const delayMs = date.getTime() - Date.now();
		return delayMs > 0 ? delayMs : undefined;
	}

	return undefined;
}

/**
 * Calculate delay for next retry attempt with exponential backoff and jitter.
 */
export function calculateRetryDelay(
	attempt: number,
	config: RetryConfig,
	suggestedDelayMs?: number
): number {
	const {
		initialDelayMs = 1000,
		maxDelayMs = 30000,
		backoffMultiplier = 2,
		jitterFactor = 0.1
	} = config;

	// If server suggested a delay (Retry-After), respect it
	if (suggestedDelayMs !== undefined) {
		// Cap at maxDelayMs but don't go below initialDelayMs
		return Math.min(Math.max(suggestedDelayMs, initialDelayMs), maxDelayMs);
	}

	// Calculate exponential backoff: initialDelay * (multiplier ^ (attempt - 1))
	const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);

	// Cap at maximum
	const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

	// Add jitter to prevent thundering herd
	const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);
	const finalDelay = Math.max(0, cappedDelay + jitter);

	return Math.round(finalDelay);
}

/**
 * Retry policy for HTTP requests.
 *
 * Wraps an async operation with automatic retry on transient failures.
 */
export class RetryPolicy {
	private readonly config: Required<RetryConfig>;

	constructor(config: RetryConfig = {}) {
		this.config = {
			maxRetries: config.maxRetries ?? 3,
			initialDelayMs: config.initialDelayMs ?? 1000,
			maxDelayMs: config.maxDelayMs ?? 30000,
			backoffMultiplier: config.backoffMultiplier ?? 2,
			jitterFactor: config.jitterFactor ?? 0.1,
			additionalRetryableCodes: config.additionalRetryableCodes ?? []
		};
	}

	/**
	 * Execute an operation with retry logic.
	 *
	 * @param operation - The async operation to execute
	 * @param shouldRetry - Optional custom retry decision function
	 * @returns The successful result with retry metadata
	 */
	async execute<T>(
		operation: (context: RetryContext) => Promise<T>,
		shouldRetry?: (error: unknown, context: RetryContext) => RetryDecision
	): Promise<RetryResult<T>> {
		const startTime = Date.now();
		let lastError: Error | undefined;

		for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt++) {
			const context: RetryContext = {
				attempt,
				lastError,
				elapsedMs: Date.now() - startTime
			};

			try {
				const result = await operation(context);
				return {
					result,
					attempts: attempt,
					totalTimeMs: Date.now() - startTime
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Check if we've exhausted retries
				if (attempt > this.config.maxRetries) {
					throw lastError;
				}

				// Determine if we should retry
				const decision = shouldRetry ? shouldRetry(error, context) : this.defaultShouldRetry(error);

				if (!decision.shouldRetry) {
					log.debug(
						{
							attempt,
							reason: decision.reason,
							error: lastError.message
						},
						'Not retrying'
					);
					throw lastError;
				}

				// Calculate delay
				const delay = calculateRetryDelay(attempt, this.config, decision.suggestedDelayMs);

				log.debug(
					{
						attempt,
						maxRetries: this.config.maxRetries,
						delayMs: delay,
						reason: decision.reason,
						error: lastError.message
					},
					'Retrying after delay'
				);

				await this.delay(delay);
			}
		}

		// Should never reach here, but TypeScript needs this
		throw lastError ?? new Error('Retry exhausted');
	}

	/**
	 * Default retry decision based on error type.
	 */
	private defaultShouldRetry(error: unknown): RetryDecision {
		// Check for network errors
		if (isRetryableNetworkError(error)) {
			return {
				shouldRetry: true,
				reason: 'Network error'
			};
		}

		// Check for HTTP errors with status codes
		if (error instanceof Error) {
			// Try to extract status code from error message
			const statusMatch = error.message.match(/HTTP (\d+)/);
			if (statusMatch) {
				const status = parseInt(statusMatch[1], 10);
				if (isRetryableStatusCode(status, this.config.additionalRetryableCodes)) {
					return {
						shouldRetry: true,
						reason: `HTTP ${status}`
					};
				}
			}
		}

		return {
			shouldRetry: false,
			reason: 'Non-retryable error'
		};
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * HTTP-specific retry decision maker.
 *
 * Use this with RetryPolicy.execute() when you have access to the response.
 */
export function createHttpRetryDecision(
	status: number,
	headers: Headers,
	additionalCodes?: number[]
): RetryDecision {
	// Don't retry 501 Not Implemented
	if (status === 501) {
		return {
			shouldRetry: false,
			reason: 'HTTP 501 Not Implemented'
		};
	}

	if (isRetryableStatusCode(status, additionalCodes)) {
		return {
			shouldRetry: true,
			suggestedDelayMs: parseRetryAfter(headers),
			reason: `HTTP ${status}`
		};
	}

	return {
		shouldRetry: false,
		reason: `HTTP ${status} not retryable`
	};
}

/**
 * Create a default retry policy with sensible defaults.
 */
export function createDefaultRetryPolicy(): RetryPolicy {
	return new RetryPolicy({
		maxRetries: 2,
		initialDelayMs: 1000,
		maxDelayMs: 10000,
		backoffMultiplier: 2,
		jitterFactor: 0.1
	});
}

/**
 * Create an aggressive retry policy for important requests.
 */
export function createAggressiveRetryPolicy(): RetryPolicy {
	return new RetryPolicy({
		maxRetries: 4,
		initialDelayMs: 500,
		maxDelayMs: 30000,
		backoffMultiplier: 2,
		jitterFactor: 0.2
	});
}

/**
 * Create a conservative retry policy for rate-limited endpoints.
 */
export function createConservativeRetryPolicy(): RetryPolicy {
	return new RetryPolicy({
		maxRetries: 2,
		initialDelayMs: 2000,
		maxDelayMs: 60000,
		backoffMultiplier: 3,
		jitterFactor: 0.3
	});
}

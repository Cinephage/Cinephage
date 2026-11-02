/**
 * Status and health tracking types.
 */

/** Indexer health status */
export type HealthStatus = 'healthy' | 'warning' | 'failing' | 'disabled';

/** Why an indexer is currently auto-disabled */
export type DisabledReason = 'consecutive_failures' | 'quota_exceeded' | 'manual';

/** Single failure record */
export interface FailureRecord {
	timestamp: Date;
	message: string;
	requestUrl?: string;
}

/** Indexer status snapshot */
export interface IndexerStatus {
	indexerId: string;

	/** Whether the indexer is enabled by user */
	isEnabled: boolean;

	/** Whether the indexer is disabled due to failures */
	isDisabled: boolean;

	/** When the indexer was auto-disabled */
	disabledAt?: Date;

	/** When the indexer can be retried */
	disabledUntil?: Date;

	/** Why the indexer is currently auto-disabled, if it is */
	disabledReason?: DisabledReason;

	/** Overall health assessment */
	health: HealthStatus;

	/** Consecutive failure count */
	consecutiveFailures: number;

	/** Last N failures for debugging */
	recentFailures: FailureRecord[];

	/** Last successful request */
	lastSuccess?: Date;

	/** Last failed request */
	lastFailure?: Date;

	/** Total request count (since startup) */
	totalRequests: number;

	/** Total failure count (since startup) */
	totalFailures: number;

	/** Average response time (ms) */
	avgResponseTime?: number;

	/** Priority (from config) */
	priority: number;
}

/** Status tracker configuration */
export interface StatusTrackerConfig {
	/** Failures before auto-disable */
	failuresBeforeDisable: number;
	/** Maximum recent failures to keep */
	maxRecentFailures: number;
	/** Base backoff time (ms) */
	baseBackoffMs: number;
	/** Maximum backoff time (ms) */
	maxBackoffMs: number;
	/** Backoff multiplier */
	backoffMultiplier: number;
	/** Minimum time between consecutive-failure increments (ms) */
	minFailureIncrementIntervalMs: number;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.round(parsed);
}

/** Default configuration */
export const DEFAULT_STATUS_CONFIG: StatusTrackerConfig = {
	failuresBeforeDisable: parsePositiveIntEnv('INDEXER_FAILURES_BEFORE_DISABLE', 3),
	maxRecentFailures: 10,
	baseBackoffMs: parsePositiveIntEnv('INDEXER_BACKOFF_BASE_MS', 5_000), // 5 seconds
	maxBackoffMs: parsePositiveIntEnv('INDEXER_BACKOFF_MAX_MS', 60_000), // 1 minute
	backoffMultiplier: parsePositiveIntEnv('INDEXER_BACKOFF_MULTIPLIER', 2),
	minFailureIncrementIntervalMs: parsePositiveIntEnv(
		'INDEXER_FAILURE_INCREMENT_INTERVAL_MS',
		30_000
	)
};

/**
 * Heuristic match for an indexer reporting its own API quota was exhausted
 * (e.g. "Daily API request limit of 10000 reached", "Rate limit exceeded",
 * "Too many requests"). These are authoritative, not flaky - the indexer is
 * telling us outright that further requests will fail - so they get disabled
 * immediately rather than waiting for several consecutive failures, and for
 * a much longer window than the generic failure backoff (which resets in
 * under a minute and would otherwise keep re-hitting the same exhausted quota).
 */
const QUOTA_EXCEEDED_PATTERN =
	/\b(daily|hourly|api|request|rate)\s*(limit|quota)\b.*\b(reached|exceeded|hit)\b|\b(limit|quota)\s*(reached|exceeded)\b|\btoo many requests\b|\brate[\s-]?limit(ed)?\b/i;

export function isQuotaExceededMessage(message: string): boolean {
	return QUOTA_EXCEEDED_PATTERN.test(message);
}

/**
 * Next UTC midnight strictly after `from`. Most indexer API quotas reset on
 * a calendar-day boundary; this is a reasonable default retry point when the
 * indexer doesn't tell us its actual reset time.
 */
export function nextUtcMidnight(from: Date = new Date()): Date {
	const next = new Date(
		Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1, 0, 0, 0, 0)
	);
	return next;
}

/** Create a default status for a new indexer */
export function createDefaultStatus(
	indexerId: string,
	enabled: boolean = true,
	priority: number = 25
): IndexerStatus {
	return {
		indexerId,
		isEnabled: enabled,
		isDisabled: false,
		health: 'healthy',
		consecutiveFailures: 0,
		recentFailures: [],
		totalRequests: 0,
		totalFailures: 0,
		priority
	};
}

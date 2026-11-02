/**
 * Rate limiting types.
 */

/** Rate limit configuration */
export interface RateLimitConfig {
	/** Maximum requests in the period */
	requests: number;
	/** Period in milliseconds */
	periodMs: number;
	/** Optional burst allowance */
	burst?: number;
}

/**
 * Default rate limit applied when an indexer has no explicit `requestdelay`
 * (YAML definitions) or user-configured rate limit. Kept conservative: many
 * real indexer accounts (especially Usenet) enforce much stricter API quotas
 * than this, and a large automatic/manual search can otherwise burn through
 * a real quota in minutes before the user notices.
 */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
	requests: 12,
	periodMs: 60_000,
	burst: 2
};

/** Convert from YAML format (seconds) to internal format (ms) */
export function fromYamlRateLimit(yaml: {
	requests: number;
	period: number;
	burst?: number;
}): RateLimitConfig {
	return {
		requests: yaml.requests,
		periodMs: yaml.period * 1000,
		burst: yaml.burst
	};
}

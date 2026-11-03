/**
 * Captcha Solver Types
 *
 * TypeScript interfaces for the Camoufox-based anti-bot/captcha solving system.
 */

import type { Cookie } from 'playwright-core';

/**
 * Detected challenge types that the solver can handle
 */
export type ChallengeType =
	| 'cloudflare' // Cloudflare "checking your browser" interstitial
	| 'cloudflare_turnstile' // Cloudflare Turnstile widget
	| 'cloudflare_managed' // Cloudflare managed challenge (JS challenge)
	| 'ddos_guard' // DDoS-Guard protection
	| 'unknown'; // Unknown challenge type

/**
 * Result of challenge detection
 */
export interface ChallengeDetectionResult {
	/** Whether a challenge was detected */
	detected: boolean;
	/** Type of challenge if detected */
	type: ChallengeType;
	/** Confidence level 0-1 */
	confidence: number;
}

/**
 * Result of a solve attempt
 */
export interface SolveResult {
	/** Whether the solve was successful */
	success: boolean;
	/** Cookies obtained from solving (includes cf_clearance, etc.) */
	cookies: Cookie[];
	/** User-Agent string used during the solve */
	userAgent: string;
	/** Time taken to solve in milliseconds */
	solveTimeMs: number;
	/** Challenge type that was solved */
	challengeType: ChallengeType;
	/** Error message if solve failed */
	error?: string;
	/** Additional response details */
	response?: {
		/** Final URL after redirects */
		url: string;
		/** HTTP status code */
		status: number;
	};
}

/**
 * Cached solve result for reuse
 */
export interface CachedSolveResult {
	/** Domain this result is for */
	domain: string;
	/** Cookies from the solve */
	cookies: Cookie[];
	/** User-Agent used during solve */
	userAgent: string;
	/** When this cache entry was created */
	createdAt: Date;
	/** When this cache entry expires */
	expiresAt: Date;
}

/**
 * Configuration for the captcha solver
 */
export interface CaptchaSolverConfig {
	/** Master enable/disable toggle */
	enabled: boolean;
	/** Maximum time to wait for a solve (seconds) */
	timeoutSeconds: number;
	/** How long to cache successful solves (seconds) */
	cacheTtlSeconds: number;
	/** Run browser in headless mode */
	headless: boolean;
	/** Optional proxy configuration */
	proxy?: ProxyConfig;
}

/**
 * Proxy configuration
 */
export interface ProxyConfig {
	/** Proxy server URL (e.g., http://proxy.example.com:8080) */
	url: string;
	/** Proxy username for authentication */
	username?: string;
	/** Proxy password for authentication */
	password?: string;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: CaptchaSolverConfig = {
	enabled: true,
	timeoutSeconds: 60,
	cacheTtlSeconds: 3600, // 1 hour
	headless: true
};

/**
 * Request to solve a challenge
 */
export interface SolveRequest {
	/** URL to solve challenge for */
	url: string;
	/** Maximum wait time in seconds (optional, uses config default) */
	timeout?: number;
	/** Additional cookies to include in request */
	cookies?: Cookie[];
	/** Proxy override for this request */
	proxy?: ProxyConfig;
	/** Abort signal - closes the browser and cancels the solve when fired */
	signal?: AbortSignal;
}

/**
 * Request to fetch a page through the browser (bypasses TLS fingerprinting)
 */
export interface BrowserFetchRequest {
	/** URL to fetch */
	url: string;
	/** HTTP method (default: GET) */
	method?: 'GET' | 'POST';
	/** POST body (for POST requests) */
	body?: string;
	/** Content-Type for POST body */
	contentType?: string;
	/** Maximum wait time in seconds */
	timeout?: number;
	/** Proxy override for this request */
	proxy?: ProxyConfig;
	/** Abort signal - closes the browser and cancels the fetch when fired */
	signal?: AbortSignal;
	/**
	 * When true, only the clearance cookies + user agent are needed; the page
	 * body may be skipped to save memory. Callers that only want cf_clearance
	 * (e.g. to replay via an impersonating HTTP client) should set this.
	 */
	returnOnlyCookies?: boolean;
	/** Cookies to inject into the browser context before navigation (e.g. tracker session cookies). */
	cookies?: Cookie[];
	/**
	 * Fetch a binary resource (e.g. a .torrent file) instead of an HTML page.
	 * The challenge is solved via page navigation as usual, but the payload is
	 * retrieved through the browser context's request client (shares cookies and
	 * user agent, passes Cloudflare) and returned as `data` instead of `body`.
	 */
	binary?: boolean;
	/** Referer header for binary fetches (some trackers require it for downloads). */
	referer?: string;
}

/**
 * Result of a browser fetch
 */
export interface BrowserFetchResult {
	/** Whether the fetch was successful */
	success: boolean;
	/** Response body (HTML/text) */
	body: string;
	/** Binary payload when `binary: true` was requested (e.g. .torrent bytes) */
	data?: Buffer;
	/** Final URL after redirects */
	url: string;
	/** HTTP status code */
	status: number;
	/** Response headers */
	headers?: Record<string, string | undefined>;
	/** Cookies captured from the browser */
	cookies?: Cookie[];
	/** User-Agent string used for the request */
	userAgent?: string;
	/** Error message if fetch failed */
	error?: string;
	/** Time taken in milliseconds */
	timeMs: number;
}

/**
 * Solver statistics for monitoring
 */
export interface SolverStats {
	/** Total solve attempts */
	totalAttempts: number;
	/** Successful solves */
	successCount: number;
	/** Failed solves */
	failureCount: number;
	/** Cache hits */
	cacheHits: number;
	/** Average solve time in ms */
	avgSolveTimeMs: number;
	/** Current cache size */
	cacheSize: number;
	/** Total browser fetch attempts */
	fetchAttempts: number;
	/** Successful browser fetches */
	fetchSuccessCount: number;
	/** Failed browser fetches */
	fetchFailureCount: number;
	/** Average fetch time in ms */
	avgFetchTimeMs: number;
	/** Last solve timestamp */
	lastSolveAt?: Date;
	/** Last fetch timestamp */
	lastFetchAt?: Date;
	/** Last error if any */
	lastError?: string;
}

/**
 * Health status for the solver service
 */
export interface SolverHealth {
	/** Whether the solver is available */
	available: boolean;
	/** Current status */
	status: 'ready' | 'busy' | 'disabled' | 'error' | 'initializing';
	/** Browser availability */
	browserAvailable: boolean;
	/** Error message if status is 'error' */
	error?: string;
	/** Statistics */
	stats: SolverStats;
}

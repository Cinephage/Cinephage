import type { RequestEvent } from '@sveltejs/kit';

interface RateLimitEntry {
	count: number;
	resetTime: number;
}

// In-memory store for rate limiting
// In production with multiple instances, use Redis
const rateLimitStore = new Map<string, RateLimitEntry>();

interface RateLimitConfig {
	windowMs: number; // Time window in milliseconds
	maxRequests: number; // Max requests per window
}

function hasAuthenticatedUserSession(event: RequestEvent): boolean {
	return Boolean(event.locals.user);
}

function isStreamingApiKeyRoute(pathname: string): boolean {
	if (pathname.startsWith('/api/streaming/')) {
		return true;
	}
	if (pathname === '/api/livetv/playlist.m3u' || pathname.startsWith('/api/livetv/playlist.m3u/')) {
		return true;
	}
	if (pathname === '/api/livetv/epg.xml' || pathname.startsWith('/api/livetv/epg.xml/')) {
		return true;
	}
	if (pathname.startsWith('/api/livetv/stream/')) {
		return true;
	}

	return false;
}

function shouldEnforceApiRateLimit(event: RequestEvent): boolean {
	const pathname = event.url.pathname;

	if (!pathname.startsWith('/api/')) {
		return false;
	}

	// Better Auth enforces its own database-backed limiter on /api/auth —
	// a second in-memory limit here would double-lock sign-in attempts.
	if (pathname.startsWith('/api/auth/')) {
		return false;
	}

	// Streaming/LiveTV playback routes already require a validated API key
	// and are governed by per-key limits in Better Auth.
	if (isStreamingApiKeyRoute(pathname) && event.locals.apiKey) {
		return false;
	}

	// Internal authenticated UI traffic should not be throttled by shared IP limits.
	return !hasAuthenticatedUserSession(event);
}

// Default rate limits
const DEFAULT_API_LIMIT: RateLimitConfig = {
	windowMs: 15 * 60 * 1000, // 15 minutes
	maxRequests: 100
};

const STREAMING_LIMIT: RateLimitConfig = {
	windowMs: 60 * 1000, // 1 minute
	maxRequests: 30
};

const ACTIVITY_API_LIMIT: RateLimitConfig = {
	windowMs: 15 * 60 * 1000, // 15 minutes
	maxRequests: 300
};

const ACTIVITY_STREAM_LIMIT: RateLimitConfig = {
	windowMs: 15 * 60 * 1000, // 15 minutes
	maxRequests: 300
};

/**
 * Check if an IP address is in a private/local network range
 * RFC1918 private ranges + loopback + link-local
 */
function isPrivateIp(ip: string): boolean {
	// Handle IPv4-mapped IPv6 addresses
	if (ip.startsWith('::ffff:')) {
		ip = ip.slice(7);
	}

	// IPv4 ranges
	if (ip.includes('.')) {
		const parts = ip.split('.').map(Number);
		if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
			// 10.0.0.0/8
			if (parts[0] === 10) return true;
			// 172.16.0.0/12
			if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
			// 192.168.0.0/16
			if (parts[0] === 192 && parts[1] === 168) return true;
			// 127.0.0.0/8 (loopback)
			if (parts[0] === 127) return true;
			// 169.254.0.0/16 (link-local/APIPA)
			if (parts[0] === 169 && parts[1] === 254) return true;
		}
	}

	// IPv6
	if (ip.includes(':')) {
		// ::1 (loopback)
		if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
		// fc00::/7 (unique local)
		if (/^fc[0-9a-f]/i.test(ip)) return true;
		// fe80::/10 (link-local)
		if (/^fe80:/i.test(ip)) return true;
	}

	return false;
}

/**
 * Get rate limit key from request
 * Uses IP address + user agent hash for identification
 *
 * Security: Prevents IP spoofing by only trusting X-Forwarded-For when
 * the direct connection comes from a private IP (indicating a reverse proxy)
 */
function getRateLimitKey(event: RequestEvent, prefix: string): string {
	const forwardedFor = event.request.headers.get('x-forwarded-for');
	const clientAddress = event.getClientAddress();
	const userAgent = event.request.headers.get('user-agent') || 'unknown';

	let ip: string;

	// Only trust X-Forwarded-For if the direct connection is from a private IP
	// (indicating we're behind a reverse proxy)
	if (forwardedFor && isPrivateIp(clientAddress)) {
		// Get the rightmost untrusted IP from the chain
		// This prevents clients from spoofing their IP by adding entries to the header
		const ips = forwardedFor.split(',').map((ip) => ip.trim());
		// Find the last IP that's NOT from a private range (the actual client)
		let clientIp = clientAddress;
		for (let i = ips.length - 1; i >= 0; i--) {
			if (!isPrivateIp(ips[i])) {
				clientIp = ips[i];
				break;
			}
		}
		ip = clientIp;
	} else {
		// Direct connection - use the actual client address
		ip = clientAddress;
	}

	// Simple hash of IP + user agent prefix
	const hash = `${prefix}:${ip}:${userAgent.slice(0, 50)}`;
	return hash;
}

/**
 * Check if request is within rate limit
 * Returns true if allowed, false if rate limited
 */
function isWithinLimit(key: string, config: RateLimitConfig): boolean {
	const now = Date.now();
	const entry = rateLimitStore.get(key);

	if (!entry || now > entry.resetTime) {
		// First request or window expired - create new entry
		rateLimitStore.set(key, {
			count: 1,
			resetTime: now + config.windowMs
		});
		return true;
	}

	if (entry.count >= config.maxRequests) {
		return false;
	}

	entry.count++;
	return true;
}

/**
 * Get remaining requests and reset time for headers
 */
function getRateLimitInfo(
	key: string,
	config: RateLimitConfig
): { remaining: number; resetTime: number } {
	const entry = rateLimitStore.get(key);

	if (!entry) {
		return { remaining: config.maxRequests - 1, resetTime: Date.now() + config.windowMs };
	}

	return {
		remaining: Math.max(0, config.maxRequests - entry.count),
		resetTime: entry.resetTime
	};
}

/**
 * Check rate limit for API requests
 * Returns null if allowed, or a Response if rate limited
 */
export function checkApiRateLimit(event: RequestEvent): Response | null {
	if (!shouldEnforceApiRateLimit(event)) {
		return null;
	}

	const pathname = event.url.pathname;

	// Determine rate limit config based on route
	let config: RateLimitConfig;
	let keyPrefix: string;

	// Activity SSE is long-lived and should not compete with general API quota.
	if (pathname.startsWith('/api/activity/stream')) {
		config = ACTIVITY_STREAM_LIMIT;
		keyPrefix = 'activity-stream';
	} else if (pathname.startsWith('/api/activity')) {
		config = ACTIVITY_API_LIMIT;
		keyPrefix = 'activity';
	} else if (pathname.startsWith('/api/streaming/') || pathname.startsWith('/api/livetv/stream/')) {
		config = STREAMING_LIMIT;
		keyPrefix = 'stream';
	} else {
		config = DEFAULT_API_LIMIT;
		keyPrefix = 'api';
	}

	const key = getRateLimitKey(event, keyPrefix);

	if (!isWithinLimit(key, config)) {
		const info = getRateLimitInfo(key, config);

		return new Response(
			JSON.stringify({
				success: false,
				error: 'Rate limit exceeded. Please try again later.',
				code: 'RATE_LIMITED'
			}),
			{
				status: 429,
				headers: {
					'Content-Type': 'application/json',
					'X-RateLimit-Limit': String(config.maxRequests),
					'X-RateLimit-Remaining': '0',
					'X-RateLimit-Reset': String(Math.ceil(info.resetTime / 1000)),
					'Retry-After': String(Math.ceil((info.resetTime - Date.now()) / 1000))
				}
			}
		);
	}

	return null;
}

/**
 * Middleware to apply rate limiting to API routes
 * Usage in hooks or individual routes
 */
export function applyRateLimitHeaders(event: RequestEvent, response: Response): Response {
	if (!shouldEnforceApiRateLimit(event)) {
		return response;
	}

	const pathname = event.url.pathname;

	// Determine rate limit config
	let config: RateLimitConfig;
	let keyPrefix: string;

	if (pathname.startsWith('/api/activity/stream')) {
		config = ACTIVITY_STREAM_LIMIT;
		keyPrefix = 'activity-stream';
	} else if (pathname.startsWith('/api/activity')) {
		config = ACTIVITY_API_LIMIT;
		keyPrefix = 'activity';
	} else if (pathname.startsWith('/api/streaming/') || pathname.startsWith('/api/livetv/stream/')) {
		config = STREAMING_LIMIT;
		keyPrefix = 'stream';
	} else {
		config = DEFAULT_API_LIMIT;
		keyPrefix = 'api';
	}

	const key = getRateLimitKey(event, keyPrefix);
	const info = getRateLimitInfo(key, config);

	// Clone response and add headers
	const newResponse = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});

	newResponse.headers.set('X-RateLimit-Limit', String(config.maxRequests));
	newResponse.headers.set('X-RateLimit-Remaining', String(info.remaining));
	newResponse.headers.set('X-RateLimit-Reset', String(Math.ceil(info.resetTime / 1000)));

	return newResponse;
}

/**
 * Cleanup old rate limit entries periodically
 */
export function cleanupRateLimits(): void {
	const now = Date.now();
	for (const [key, entry] of rateLimitStore.entries()) {
		if (now > entry.resetTime) {
			rateLimitStore.delete(key);
		}
	}
}

// Run cleanup every 10 minutes without blocking process exit.
const cleanupInterval = setInterval(cleanupRateLimits, 10 * 60 * 1000);
if (cleanupInterval.unref) {
	cleanupInterval.unref();
}

/**
 * SSRF Protection Utilities
 *
 * Provides URL validation and secure fetch functions to prevent
 * Server-Side Request Forgery attacks in proxy endpoints.
 *
 * Two layers of protection:
 *  1. isUrlSafe() — sync, validates the hostname string (fast-path / pre-check)
 *  2. resolveAndValidateUrl() — async, resolves DNS then validates the resolved IP
 *     This prevents DNS rebinding attacks where a hostname resolves to a private IP.
 */

import { promises as dns } from 'node:dns';
import { PROXY_FETCH_TIMEOUT_MS } from '#lib/server/streaming/constants.js';

// Allowed URL schemes
export const ALLOWED_SCHEMES = ['http:', 'https:'];

// Maximum redirects to follow
export const MAX_REDIRECTS = 5;

// Private IP ranges that should be blocked (SSRF protection)
// Covers both IPv4 and IPv6 private/reserved ranges
export const PRIVATE_IP_PATTERNS = [
	// IPv4 private & reserved
	/^127\./, // 127.0.0.0/8 (localhost)
	/^10\./, // 10.0.0.0/8 (private)
	/^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12 (private)
	/^192\.168\./, // 192.168.0.0/16 (private)
	/^169\.254\./, // 169.254.0.0/16 (link-local)
	/^0\./, // 0.0.0.0/8
	/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./, // 100.64.0.0/10 (CGNAT)
	/^192\.0\.0\./, // 192.0.0.0/24 (IETF protocol assignments)
	/^192\.0\.2\./, // 192.0.2.0/24 (TEST-NET-1)
	/^198\.51\.100\./, // 198.51.100.0/24 (TEST-NET-2)
	/^203\.0\.113\./, // 203.0.113.0/24 (TEST-NET-3)

	// IPv6 private & reserved
	/^::1$/, // IPv6 localhost
	/^::$/, // IPv6 unspecified
	/^fc00:/i, // IPv6 unique local (fc00::/7)
	/^fd[0-9a-f]{2}:/i, // IPv6 unique local (fd00::/8 — the commonly used half)
	/^fe80:/i, // IPv6 link-local (fe80::/10)
	/^::ffff:(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.)/i, // IPv4-mapped IPv6 (::ffff:x.x.x.x) pointing to private IPv4
	/^::ffff:0\./i, // IPv4-mapped unspecified
	/^64:ff9b::(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/i, // NAT64 well-known prefix with private IPv4
	/^100::/i, // Discard prefix (100::/64)
	/^2001:db8:/i // Documentation prefix (2001:db8::/32)
];

export const BLOCKED_HOSTNAMES = ['localhost', 'localhost.localdomain', '0.0.0.0'];

export interface UrlSafetyResult {
	safe: boolean;
	reason?: string;
}

/**
 * Check if an IP address (v4 or v6) matches any private/reserved range.
 */
function isPrivateIp(ip: string): boolean {
	const mappedIpv4 = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (mappedIpv4) {
		const high = parseInt(mappedIpv4[1], 16);
		const low = parseInt(mappedIpv4[2], 16);
		const ipv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
		if (isPrivateIp(ipv4)) return true;
	}

	for (const pattern of PRIVATE_IP_PATTERNS) {
		if (pattern.test(ip)) {
			return true;
		}
	}
	return false;
}

/**
 * Validates that a URL is safe to proxy (not internal/private network).
 *
 * This is a **synchronous** fast-path that checks the hostname string only.
 * It catches obvious cases (literal IPs, blocked hostnames) but cannot
 * prevent DNS rebinding. For full protection, use resolveAndValidateUrl().
 */
export function isUrlSafe(urlString: string): UrlSafetyResult {
	try {
		const url = new URL(urlString);

		// Check scheme
		if (!ALLOWED_SCHEMES.includes(url.protocol)) {
			return { safe: false, reason: `Invalid scheme: ${url.protocol}` };
		}

		// url.hostname strips brackets from IPv6 (e.g., "[::1]" → "::1")
		const hostname = normalizeHostname(url.hostname);

		// Check for blocked hostnames
		if (BLOCKED_HOSTNAMES.includes(hostname)) {
			return { safe: false, reason: 'Blocked hostname' };
		}

		// Check for private IP patterns (works for both raw IPs and IPv6 without brackets)
		if (isPrivateIp(hostname)) {
			return { safe: false, reason: 'Private/internal IP address' };
		}

		return { safe: true };
	} catch {
		return { safe: false, reason: 'Invalid URL format' };
	}
}

/**
 * Resolves a URL's hostname via DNS, then validates the resolved IP address.
 *
 * This prevents DNS rebinding attacks where an attacker's hostname resolves
 * to a private IP. The function:
 *  1. Runs the sync isUrlSafe() check first (fast reject of obvious cases)
 *  2. If the hostname is not already a literal IP, resolves it via DNS
 *  3. Validates the resolved IP against private/reserved ranges
 *
 * Use this for all proxy/fetch operations where the URL comes from user input.
 */
export async function resolveAndValidateUrl(urlString: string): Promise<UrlSafetyResult> {
	// Step 1: sync pre-check
	const syncResult = isUrlSafe(urlString);
	if (!syncResult.safe) {
		return syncResult;
	}

	// Step 2: DNS resolution check
	try {
		const url = new URL(urlString);
		const hostname = normalizeHostname(url.hostname);

		// If hostname is already a literal IP, isUrlSafe already validated it
		if (isLiteralIp(hostname)) {
			return { safe: true };
		}

		// Resolve hostname to IPs and reject if any result is private/reserved.
		const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
		for (const { address } of addresses) {
			if (isPrivateIp(address)) {
				return {
					safe: false,
					reason: `Hostname '${hostname}' resolves to private IP: ${address}`
				};
			}
		}

		return { safe: true };
	} catch (error) {
		// DNS resolution failure — treat as unsafe (fail-closed)
		const message = error instanceof Error ? error.message : String(error);
		return { safe: false, reason: `DNS resolution failed: ${message}` };
	}
}

/**
 * Check if a hostname string is a literal IP address (v4 or v6).
 */
function isLiteralIp(hostname: string): boolean {
	// IPv4: digits and dots only
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
		return true;
	}
	// IPv6: contains colons (URL parser already strips brackets)
	if (hostname.includes(':')) {
		return true;
	}
	return false;
}

function normalizeHostname(hostname: string): string {
	const lowerHostname = hostname.toLowerCase();
	return lowerHostname.startsWith('[') && lowerHostname.endsWith(']')
		? lowerHostname.slice(1, -1)
		: lowerHostname;
}

/**
 * Fetch with timeout using AbortController
 */
export async function fetchWithTimeout(
	url: string,
	options: RequestInit,
	timeoutMs: number = PROXY_FETCH_TIMEOUT_MS
): Promise<Response> {
	const controller = new AbortController();
	const externalSignal = options.signal;
	const abortFromExternal = () => controller.abort(externalSignal?.reason);
	if (externalSignal?.aborted) abortFromExternal();
	else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, {
			...options,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timeoutId);
		externalSignal?.removeEventListener('abort', abortFromExternal);
	}
}

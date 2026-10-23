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

export const BLOCKED_HOSTNAMES = ['localhost', 'localhost.localdomain', '0.0.0.0'];

export interface UrlSafetyResult {
	safe: boolean;
	reason?: string;
}

/** Parse a dotted-quad IPv4 into a 32-bit integer, or null when invalid. */
function ipv4ToInt(ip: string): number | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = (value << 8) + octet;
	}
	return value >>> 0;
}

/** CIDR ranges that must never be reachable from a proxied fetch. */
const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
	['0.0.0.0', 8], // "this network"
	['10.0.0.0', 8], // RFC1918
	['100.64.0.0', 10], // CGNAT
	['127.0.0.0', 8], // loopback
	['169.254.0.0', 16], // link-local (cloud metadata)
	['172.16.0.0', 12], // RFC1918
	['192.0.0.0', 24], // IETF protocol assignments
	['192.0.2.0', 24], // TEST-NET-1
	['192.88.99.0', 24], // 6to4 relay anycast
	['192.168.0.0', 16], // RFC1918
	['198.18.0.0', 15], // benchmarking
	['198.51.100.0', 24], // TEST-NET-2
	['203.0.113.0', 24], // TEST-NET-3
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4] // reserved, includes 255.255.255.255
];

function isBlockedIpv4(ip: string): boolean {
	const value = ipv4ToInt(ip);
	if (value === null) return true; // Unparseable: fail closed.
	for (const [base, bits] of BLOCKED_IPV4_RANGES) {
		const baseValue = ipv4ToInt(base)!;
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		if ((value & mask) === (baseValue & mask)) return true;
	}
	return false;
}

/**
 * Expand an IPv6 address to its eight 16-bit groups.
 * Handles `::` shorthand and a trailing embedded IPv4 (`::ffff:1.2.3.4`).
 */
function expandIpv6(ip: string): number[] | null {
	let address = ip.toLowerCase();

	// Strip a zone id (`%eth0`) if present.
	const zoneIndex = address.indexOf('%');
	if (zoneIndex !== -1) address = address.slice(0, zoneIndex);

	// Convert a trailing dotted IPv4 into two hex groups.
	const embeddedV4 = address.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (embeddedV4) {
		const value = ipv4ToInt(embeddedV4[2]);
		if (value === null) return null;
		address = `${embeddedV4[1]}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
	}

	const halves = address.split('::');
	if (halves.length > 2) return null;

	const parseGroups = (part: string): number[] | null => {
		if (part === '') return [];
		const groups: number[] = [];
		for (const group of part.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
			groups.push(parseInt(group, 16));
		}
		return groups;
	};

	const head = parseGroups(halves[0]);
	const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
	if (!head || !tail) return null;

	if (halves.length === 1) {
		return head.length === 8 ? head : null;
	}
	const fill = 8 - head.length - tail.length;
	if (fill < 0) return null;
	return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * True for IPv6 addresses that are loopback, unspecified, link-local,
 * unique-local, multicast, or encode an IPv4 address that is itself blocked.
 */
function isBlockedIpv6(ip: string): boolean {
	const groups = expandIpv6(ip);
	if (!groups) return true; // Unparseable: fail closed.

	const first = groups[0];
	const allZeroPrefix = groups.slice(0, 5).every((group) => group === 0);

	// :: and ::1
	if (allZeroPrefix && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) {
		return true;
	}

	const ipv4FromLowGroups = (): string =>
		`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;

	// IPv4-mapped ::ffff:a.b.c.d — groups 0-4 zero, group 5 is ffff.
	if (allZeroPrefix && groups[5] === 0xffff) {
		return isBlockedIpv4(ipv4FromLowGroups());
	}
	// IPv4-translated ::ffff:0:a.b.c.d — groups 0-3 zero, group 4 ffff,
	// group 5 zero. (RFC 2765 / SIIT.)
	if (groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0) {
		return isBlockedIpv4(ipv4FromLowGroups());
	}
	// Deprecated IPv4-compatible ::a.b.c.d — groups 0-5 zero.
	if (allZeroPrefix && groups[5] === 0) {
		return isBlockedIpv4(ipv4FromLowGroups());
	}

	// fc00::/7 unique local (fc00:: through fdff::).
	if ((first & 0xfe00) === 0xfc00) return true;
	// fe80::/10 link-local (fe80:: through febf::).
	if ((first & 0xffc0) === 0xfe80) return true;
	// fec0::/10 deprecated site-local.
	if ((first & 0xffc0) === 0xfec0) return true;
	// ff00::/8 multicast.
	if ((first & 0xff00) === 0xff00) return true;
	// 64:ff9b::/96 NAT64 and 64:ff9b:1::/48 local-use NAT64.
	if (first === 0x64 && groups[1] === 0xff9b) {
		const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
		return groups[2] === 0 ? isBlockedIpv4(ipv4) : true;
	}
	// 2002::/16 6to4 embeds an IPv4 address in groups 1-2.
	if (first === 0x2002) {
		const ipv4 = `${groups[1] >> 8}.${groups[1] & 0xff}.${groups[2] >> 8}.${groups[2] & 0xff}`;
		if (isBlockedIpv4(ipv4)) return true;
	}
	// 2001::/32 Teredo and 2001:db8::/32 documentation.
	if (first === 0x2001) {
		if (groups[1] === 0x0000) return true;
		if (groups[1] === 0x0db8) return true;
	}
	// 100::/64 discard prefix: 0100:0000:0000:0000::/64.
	if (first === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) return true;

	return false;
}

/**
 * Check if an IP address (v4 or v6) is private, reserved, or otherwise
 * unreachable from the public internet. Unparseable input fails closed, so
 * callers must only pass something they believe to be an address.
 */
export function isPrivateIp(ip: string): boolean {
	const normalized = ip.trim().replace(/^\[|\]$/g, '');

	if (normalized.includes(':')) {
		return isBlockedIpv6(normalized);
	}
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) {
		return isBlockedIpv4(normalized);
	}
	// Not an IP literal — treat as blocked so no caller mistakes it for an address.
	return true;
}

/** True when the hostname is an IPv4 or IPv6 literal rather than a DNS name. */
function isIpLiteral(hostname: string): boolean {
	const normalized = hostname.trim().replace(/^\[|\]$/g, '');
	if (normalized.includes(':')) return true;
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(normalized);
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

		// A DNS name is not an IP: only literal addresses are checked here.
		// Hostnames are resolved and checked in resolveAndValidateUrl().
		if (isIpLiteral(hostname) && isPrivateIp(hostname)) {
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
 * Fetch a URL that came from outside the app, with SSRF protection baked in.
 *
 * Every caller of this function is a proxy or media fetch whose URL is
 * attacker-influenced (a `.strm` target, a playlist segment, a provider
 * download link), so validation is not optional. It:
 *  1. runs {@link resolveAndValidateUrl} (scheme, hostname, resolved IP);
 *  2. pins the socket to the exact address that passed, closing the
 *     resolve-then-connect rebinding window;
 *  3. aborts on timeout and forwards the caller's signal.
 *
 * Returns the upstream response, or throws `UnsafeUrlError` when the URL is
 * rejected so callers can map it to a 400/502 without inspecting a result.
 */
export class UnsafeUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsafeUrlError';
	}
}

export async function fetchWithTimeout(
	url: string,
	options: RequestInit,
	timeoutMs: number = PROXY_FETCH_TIMEOUT_MS
): Promise<Response> {
	const validation = await resolveAndValidateUrl(url);
	if (!validation.safe) {
		throw new UnsafeUrlError(validation.reason ?? 'URL rejected by SSRF policy');
	}

	const controller = new AbortController();
	const externalSignal = options.signal;
	const abortFromExternal = () => controller.abort(externalSignal?.reason);
	if (externalSignal?.aborted) abortFromExternal();
	else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	// Literal IPs have no DNS step to race, so no dispatcher is needed.
	const parsed = new URL(url);
	const hostname = normalizeHostname(parsed.hostname);

	try {
		if (isIpLiteral(hostname)) {
			// Literal IPs have no DNS step to race, so global fetch is fine.
			return await fetch(url, { ...options, signal: controller.signal });
		}

		// Hostname: resolve, then pin the connection to the address that passed.
		// The Agent MUST come from the same undici copy as the fetch that uses
		// it — Node's global fetch is the *bundled* undici, whose Dispatcher
		// interface differs from the npm package's, and mixing them fails at
		// connect time with `invalid onRequestStart method`.
		const { Agent, fetch: undiciFetch } = await import('undici');

		const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
		const pinned = addresses[0];
		if (!pinned) {
			throw new UnsafeUrlError(`No address resolved for '${hostname}'`);
		}
		const agent = new Agent({
			connect: {
				lookup: (_lookupHost, _lookupOptions, callback) => {
					callback(null, [{ address: pinned.address, family: pinned.family }]);
				}
			}
		});

		try {
			// undici's RequestInit differs from the DOM type (its `body` excludes
			// Blob); the values are compatible at runtime. undici's Response
			// implements the standard Response surface the callers rely on.
			const init = {
				...options,
				signal: controller.signal,
				dispatcher: agent
			} as unknown as Parameters<typeof undiciFetch>[1];
			const response = (await undiciFetch(url, init)) as unknown as Response;
			return response;
		} finally {
			await agent.close().catch(() => {});
		}
	} finally {
		clearTimeout(timeoutId);
		externalSignal?.removeEventListener('abort', abortFromExternal);
	}
}

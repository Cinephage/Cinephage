/**
 * Trusted targets for .strm probing.
 *
 * The SSRF policy in `http/ssrf-protection.ts` answers one question: may this
 * server fetch a URL an anonymous caller handed it? A `.strm` target is a
 * different question, because Cinephage writes those files itself. The URL in
 * the file is a streaming origin resolved from our own settings, and on a
 * self-hosted deployment that origin is a LAN address or a Docker service name
 * (`http://cinephage:3000` -> 172.19.0.5). Screening it with the public-only
 * rule rejects every probe we would ever make, so the probe falls back to
 * synthetic media info and the reprobe task reports it as a hard failure.
 *
 * Trust stays narrow and explicit:
 *   - the hosts of the streaming origins this instance is configured to use
 *     (the same ones it stamps into .strm files), and
 *   - anything the operator lists in STRM_PROBE_ALLOWED_HOSTS.
 *
 * Arbitrary private targets - the cloud metadata endpoint, an unrelated LAN
 * service - stay blocked, so a .strm dropped into the download folder is still
 * harmless.
 */

import { getStreamingBaseUrl } from '#lib/server/streaming/settings.js';

/** Comma-separated hostnames or literal IPs that .strm probing may reach privately. */
export const STRM_PROBE_ALLOWED_HOSTS_ENV = 'STRM_PROBE_ALLOWED_HOSTS';

/** How long a resolved trust list is reused, in ms. A reprobe walks the whole library. */
const TRUSTED_HOSTS_TTL_MS = 30_000;

let cache: { hosts: string[]; expiresAt: number } | null = null;

/**
 * Split a raw `STRM_PROBE_ALLOWED_HOSTS` value into entries. Entries are
 * lowercased and deduplicated; a `host:port` entry keeps its port, and the
 * matcher drops it again when comparing hostnames.
 */
export function parseTrustedHostList(raw: string | undefined): string[] {
	if (!raw) return [];
	const entries = raw
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
	return [...new Set(entries)];
}

/** Host of a URL, or null when it is absent or unparseable. */
function hostOf(candidate: string | null | undefined): string | null {
	if (!candidate) return null;
	try {
		return new URL(candidate).hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

/** Settings-derived streaming origin, or null when the subsystem is unavailable. */
async function resolveConfiguredBaseUrl(): Promise<string | null> {
	try {
		const baseUrl = await getStreamingBaseUrl('');
		return baseUrl || null;
	} catch {
		return null;
	}
}

/**
 * Hosts of every streaming origin this instance is configured to use: the
 * settings-derived origin (what new .strm files are written with) and
 * PUBLIC_BASE_URL, which older files may still carry. Both are operator-chosen
 * origins of ours, so both are trusted; unparseable entries are dropped rather
 * than failing the probe.
 */
export async function resolveConfiguredOriginHosts(): Promise<string[]> {
	const candidates = [await resolveConfiguredBaseUrl(), process.env.PUBLIC_BASE_URL];
	const hosts = candidates.map((candidate) => hostOf(candidate)).filter((host) => host !== null);
	return [...new Set(hosts)];
}

/**
 * Hosts that .strm probing may reach even when they resolve to a private address.
 * Cached briefly because one reprobe issues a probe per file.
 */
export async function getStrmProbeTrustedHosts(): Promise<string[]> {
	const now = Date.now();
	if (cache && cache.expiresAt > now) return cache.hosts;

	const hosts = parseTrustedHostList(process.env[STRM_PROBE_ALLOWED_HOSTS_ENV]);
	hosts.push(...(await resolveConfiguredOriginHosts()));

	const resolved = [...new Set(hosts)];
	cache = { hosts: resolved, expiresAt: now + TRUSTED_HOSTS_TTL_MS };
	return resolved;
}

/** Drop the cached trust list (tests, and any caller that changes the origin). */
export function resetStrmProbeTrustCache(): void {
	cache = null;
}

/**
 * Explain why a .strm target was rejected, naming the fix when the rejection is
 * only about what the target resolves to. The hint matters: the operator sees
 * this string in the reprobe report, not in a log.
 */
export function describeStrmTargetRejection(reason: string | undefined): string {
	const detail = reason ?? 'URL rejected by SSRF policy';
	if (!/private/i.test(detail)) return detail;
	return `${detail}. Declare the host in ${STRM_PROBE_ALLOWED_HOSTS_ENV} (or set PUBLIC_BASE_URL) to allow probing it.`;
}

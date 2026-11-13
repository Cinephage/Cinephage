/**
 * Per-host browser-session memo for Cloudflare solves.
 *
 * A solve produces a pair, not a cookie: the cookies and the User-Agent that
 * earned them. `cf_clearance` is issued against the client that passed the
 * challenge, so the two have to travel together. Keeping only the cookies,
 * which is what this codebase did, throws the solve away: the next request
 * looks like a different client, gets challenged again, and pays for another
 * browser launch.
 *
 * Prowlarr keeps the same memo (`IndexerProxies/FlareSolverr`: the solved UA is
 * cached per host and injected in `PreRequest`), and Jackett lets
 * FlareSolverrSharp's `ClearanceHandler` carry it inside the handler. One memo,
 * used by both `IndexerHttp` and `AuthManager`, is what stops the two paths
 * from solving the same host independently.
 *
 * Deliberately in memory: the value is a fingerprint, not a credential. After a
 * restart the first request may need one fresh solve, which is cheaper than
 * persisting a User-Agent the tracker's rules may have moved past.
 */

/** A solved session goes stale the way a challenge cookie does. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface SolvedSession {
	userAgent: string;
	solvedAt: number;
}

const sessions = new Map<string, SolvedSession>();

function normaliseHost(host: string): string {
	return host.trim().toLowerCase().replace(/^www\./, '');
}

/** Host of a URL, or undefined when the URL cannot be parsed. */
export function hostOf(url: string | undefined | null): string | undefined {
	if (!url) return undefined;
	try {
		return normaliseHost(new URL(url).hostname);
	} catch {
		return undefined;
	}
}

/**
 * Record the User-Agent a browser solve used against this host.
 */
export function rememberSolvedUserAgent(host: string, userAgent?: string | null): void {
	if (!host || !userAgent) return;
	sessions.set(normaliseHost(host), { userAgent, solvedAt: Date.now() });
}

/**
 * The User-Agent to present to this host, or undefined when nothing has been
 * solved for it (or the solve has gone stale).
 */
export function getSolvedUserAgent(host: string, now: number = Date.now()): string | undefined {
	const key = normaliseHost(host);
	const entry = sessions.get(key);
	if (!entry) return undefined;
	if (now - entry.solvedAt > DEFAULT_TTL_MS) {
		sessions.delete(key);
		return undefined;
	}
	return entry.userAgent;
}

/** Test seam: drop every memo. */
export function clearSolvedSessions(): void {
	sessions.clear();
}

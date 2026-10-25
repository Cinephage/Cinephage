/**
 * URL guards for Live TV provider fetches.
 *
 * Playlist/portal content is third-party data: a malicious M3U can declare an
 * `x-tvg-url` that the EPG sync then fetches and persists. Every provider
 * fetch goes through resolveHttpUrl so non-http(s) schemes are refused before
 * any request, and content-derived URLs are only honored when they parse as
 * ordinary web URLs.
 *
 * Note: hosts are not restricted to public ranges on purpose — LAN-hosted IPTV
 * aggregators are a legitimate deployment shape for this feature. The guard
 * exists to stop scheme abuse and malformed values, not to police topology.
 */

export function resolveHttpUrl(raw: string | null | undefined): URL | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return null;
		}
		return url;
	} catch {
		return null;
	}
}

/**
 * Shared HLS Playlist URL Rewriting
 *
 * Unified implementation for rewriting URLs in HLS playlists to route through
 * proxy endpoints. Used by both the Live TV stream proxy and the general
 * streaming proxy.
 *
 * The core parsing logic is the same everywhere - only the proxy URL format
 * differs between consumers. Callers provide a `makeProxyUrl` callback that
 * builds the final proxy URL for each rewritten entry.
 */

/**
 * Callback that builds a proxy URL for an absolute stream/playlist URL.
 *
 * @param absoluteUrl - The fully resolved upstream URL
 * @param isSegment - true for media segments (.ts/.aac/.mp4), false for playlists
 * @returns The proxy URL to substitute into the playlist
 */
export type ProxyUrlBuilder = (absoluteUrl: string, isSegment: boolean) => string;

/**
 * Resolve a potentially relative URL to absolute.
 *
 * Handles:
 * - Absolute URLs (http:// or https://)
 * - Protocol-relative URLs (//)
 * - Root-relative URLs (/)
 * - Path-relative URLs (resolved against basePath)
 *
 * Preserves query parameters from the base URL for authentication tokens
 * on relative URLs (common in Stalker portal playlists).
 */
export function resolveHlsUrl(url: string, base: URL, basePath: string): string {
	void basePath;
	if (url.startsWith('http://') || url.startsWith('https://')) {
		return url;
	}
	if (url.startsWith('//')) {
		return `${base.protocol}${url}`;
	}

	const resolved = new URL(url, base);
	// Providers commonly put an auth token on the playlist URL and omit it from
	// relative entries. URL resolution correctly normalizes ../ and ./ first.
	if (!url.startsWith('/') && !resolved.search && base.search) {
		resolved.search = base.search;
	} else if (url.startsWith('/') && !resolved.search && base.search) {
		resolved.search = base.search;
	}
	return resolved.toString();
}

/**
 * HLS tags that can contain URI= attributes needing rewriting.
 *
 * Covers all HLS specification tags with embedded URIs:
 * - EXT-X-MEDIA: alternate renditions (audio, subtitles)
 * - EXT-X-KEY: encryption key URLs
 * - EXT-X-MAP: initialization segment
 * - EXT-X-I-FRAME-STREAM-INF: I-frame playlists
 * - EXT-X-STREAM-INF: variant stream playlists (URI on next line, but some
 *   implementations embed it in the tag)
 */
const URI_BEARING_TAGS = [
	'#EXT-X-MEDIA:',
	'#EXT-X-KEY:',
	'#EXT-X-MAP:',
	'#EXT-X-I-FRAME-STREAM-INF:',
	'#EXT-X-STREAM-INF:',
	'#EXT-X-PART:',
	'#EXT-X-PRELOAD-HINT:',
	'#EXT-X-RENDITION-REPORT:'
];

/**
 * Rewrite all URLs in an HLS playlist to use a proxy endpoint.
 *
 * This is the single shared implementation that replaces the 4 near-identical
 * copies previously spread across:
 * - /api/livetv/stream/[lineupId]/+server.ts
 * - /api/livetv/stream/[lineupId]/[...path]/+server.ts
 * - /lib/server/streaming/utils/http.ts
 * - the streaming session playlist rewriter
 *
 * @param playlist - Raw HLS playlist text
 * @param playlistUrl - The original URL of this playlist (for resolving relative URLs)
 * @param makeProxyUrl - Callback to build the proxy URL for each entry
 * @returns Rewritten playlist text
 */
export function rewriteHlsPlaylistUrls(
	playlist: string,
	playlistUrl: string,
	makeProxyUrl: ProxyUrlBuilder
): string {
	const lines = playlist.split('\n');
	const result: string[] = [];

	const base = new URL(playlistUrl);
	const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

	let previousWasExtinf = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Handle URI= attributes in HLS tags
		if (URI_BEARING_TAGS.some((tag) => trimmed.startsWith(tag))) {
			const uriMatch = line.match(/URI="([^"]+)"/);
			if (uriMatch) {
				const originalUri = uriMatch[1];
				const absoluteUri = resolveHlsUrl(originalUri, base, basePath);
				const isSegment =
					trimmed.startsWith('#EXT-X-MAP:') ||
					trimmed.startsWith('#EXT-X-PART:') ||
					trimmed.startsWith('#EXT-X-PRELOAD-HINT:');
				const proxyUri = makeProxyUrl(absoluteUri, isSegment);
				result.push(line.replace(`URI="${originalUri}"`, `URI="${proxyUri}"`));
				continue;
			}
		}

		// Track EXTINF lines - the next URL line is always a segment
		if (trimmed.startsWith('#EXTINF:')) {
			result.push(line);
			previousWasExtinf = true;
			continue;
		}

		// Keep other comments and empty lines as-is
		if (line.startsWith('#') || trimmed === '') {
			result.push(line);
			previousWasExtinf = false;
			continue;
		}

		// URL line - rewrite it
		if (trimmed) {
			try {
				const absoluteUrl = resolveHlsUrl(trimmed, base, basePath);
				const isSegment =
					previousWasExtinf ||
					trimmed.includes('.ts') ||
					trimmed.includes('.aac') ||
					trimmed.includes('.mp4');
				result.push(makeProxyUrl(absoluteUrl, isSegment));
			} catch {
				// Malformed URL - keep original
				result.push(line);
			}
		} else {
			result.push(line);
		}
		previousWasExtinf = false;
	}

	return result.join('\n');
}

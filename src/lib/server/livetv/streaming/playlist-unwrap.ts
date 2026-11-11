/**
 * Cinephage unwrap hints embedded in HLS playlists.
 *
 * The signed Cinephage playlist route stamps `#EXT-X-CINEPHAGE-UNWRAP:<scheme>`
 * on the playlist it actually served. That tag is authoritative per response:
 * a channel's detail payload describes the preferred feed, but the playlist can
 * fall back to another provider (daddylive -> zlive) between the detail call and
 * playback. The fallback changes which headers the segments need, and the tag is
 * the only place that says so.
 *
 * Known schemes:
 * - `daddylive-camo-1`: no request headers; segments are camouflaged containers
 *   unwrapped by the camo sniff chain.
 * - `zlive-referer-1`: every playlist and segment request needs
 *   `Referer: https://zlive.st/`; segments are plain MPEG-TS.
 */

export const CINEPHAGE_UNWRAP_TAG = '#EXT-X-CINEPHAGE-UNWRAP:';
export const ZLIVE_UNWRAP_SCHEME = 'zlive-referer-1';
export const ZLIVE_REFERER = 'https://zlive.st/';

/** Headers a given unwrap scheme requires on playlist and segment requests. */
export function unwrapHeadersForScheme(scheme: string): Record<string, string> | undefined {
	switch (scheme.trim().toLowerCase()) {
		case ZLIVE_UNWRAP_SCHEME:
			return { Referer: ZLIVE_REFERER };
		default:
			return undefined;
	}
}

/** Read the unwrap hint from a playlist, if the API stamped one. */
export function playlistUnwrapHeaders(playlist: string): Record<string, string> | undefined {
	for (const line of playlist.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith(CINEPHAGE_UNWRAP_TAG)) continue;
		return unwrapHeadersForScheme(trimmed.slice(CINEPHAGE_UNWRAP_TAG.length));
	}
	return undefined;
}

/**
 * Overlay the playlist's unwrap headers on the provider headers resolved from
 * the channel detail. The playlist wins: it describes the feed that is actually
 * being served.
 */
export function mergePlaylistUnwrapHeaders(
	base: Record<string, string> | undefined,
	playlist: string
): Record<string, string> | undefined {
	const playlistHeaders = playlistUnwrapHeaders(playlist);
	if (!playlistHeaders) return base;
	return { ...(base ?? {}), ...playlistHeaders };
}

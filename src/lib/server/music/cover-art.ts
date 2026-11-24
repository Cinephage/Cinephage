/**
 * Cover Art Archive URL for a release group. The archive redirects to the
 * front image when one exists and 404s otherwise, so callers treat it as
 * best-effort art.
 */
export function coverArtUrl(releaseGroupMbid: string, size: 250 | 500 = 250): string {
	return `https://coverartarchive.org/release-group/${encodeURIComponent(releaseGroupMbid)}/front-${size}`;
}

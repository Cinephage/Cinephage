/**
 * Client-safe URL scheme helpers.
 *
 * Svelte does not filter `href={value}`: whatever string is bound lands in the
 * DOM verbatim, so `javascript:...` from external metadata or a URL parameter
 * becomes script execution in the app origin. Every user- or provider-derived
 * URL that reaches an anchor must pass through here first.
 */

/** Schemes that are safe to place in an href. */
const SAFE_HREF_SCHEMES = new Set(['http:', 'https:', 'magnet:', 'mailto:']);

/**
 * Return `value` when it is an absolute URL with a safe scheme, otherwise null.
 * Protocol-relative (`//host/path`) and relative paths are accepted for the
 * same-origin cases callers already rely on.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	// Relative or protocol-relative: not executable, no scheme to abuse.
	if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	return SAFE_HREF_SCHEMES.has(parsed.protocol) ? trimmed : null;
}

/** True when `value` is an http(s) or magnet URL. */
export function isSafeExternalUrl(value: string | null | undefined): boolean {
	return safeExternalUrl(value) !== null;
}

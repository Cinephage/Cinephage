import type { DownloadClientConfig } from './interfaces.js';

export function buildBaseUrl(config: DownloadClientConfig, defaultPath: string): string {
	const protocol = config.useSsl ? 'https' : 'http';
	const base = `${protocol}://${config.host}:${config.port}`;
	const urlBase = config.urlBase?.trim().replace(/^\/+|\/+$/g, '');
	if (!urlBase) {
		return `${base}/${defaultPath.replace(/^\/+/, '')}`;
	}
	return `${base}/${urlBase.replace(/^\/+/, '')}/${defaultPath.replace(/^\/+/, '')}`;
}

export function getBasicAuthHeader(
	username: string | undefined | null,
	password: string | undefined | null
): string | null {
	if (!username) return null;
	const pw = password ?? '';
	const encoded = Buffer.from(`${username}:${pw}`).toString('base64');
	return `Basic ${encoded}`;
}

const CATEGORY_UNSAFE_CHARS = /[^A-Za-z0-9 _.-]/g;

/**
 * Sanitize a category name for use as a single filesystem path segment.
 * Categories are free text from client settings (min length 1, no charset
 * check) but get joined directly into paths the daemon writes to; an
 * unsanitized `/` or `\` silently nests directories, and `..` traverses out of
 * the download root. Strips anything outside a safe charset, then rejects
 * the traversal segments `.` / `..` outright. Returns '' for anything that
 * sanitizes to nothing, matching joinCategoryPath's blank-category fallback.
 */
export function sanitizeCategorySegment(category: string): string {
	const stripped = category.trim().replace(CATEGORY_UNSAFE_CHARS, '');
	if (stripped === '' || stripped === '.' || stripped === '..') return '';
	return stripped;
}

/**
 * Join a client default path with a category name (Radarr-style `[category]`
 * subdirectory). Returns '' when either side is blank so callers fall back
 * to current behavior. Explicit savePath always wins at the call site.
 */
export function joinCategoryPath(basePath: string, category: string): string {
	const base = basePath.trim().replace(/\/+$/, '');
	const name = sanitizeCategorySegment(category);
	return base && name ? `${base}/${name}` : '';
}

/**
 * Path Mapping Service
 *
 * Translates paths between download client's view and actual local paths.
 * Uses the downloadPathLocal field configured in download clients.
 *
 * Example:
 * - Client reports: /downloads/torrents/Movie.Name.2024/movie.mkv
 * - downloadPathLocal: /mnt/storage/downloads/torrents
 * - Client's save_path prefix: /downloads/torrents
 * - Result: /mnt/storage/downloads/torrents/Movie.Name.2024/movie.mkv
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

/**
 * Path mapping configuration for a download client
 */
export interface PathMappingConfig {
	/** The local path where files actually exist (what Cinephage sees) */
	localPath: string;
	/** The path reported by the client (optional, auto-detected if not set) */
	remotePath?: string;
}

/**
 * Result of path mapping operation
 */
export interface PathMappingResult {
	/** The mapped path */
	path: string;
	/** Whether the mapping was exact (true) or a best-guess (false) */
	exact: boolean;
	/** Warning message if best-guess was used */
	warning?: string;
}

/**
 * Path mapping options for dual folder support (SABnzbd temp + completed).
 */
export interface PathMappingOptions {
	/** Local path for completed downloads */
	completeLocalPath: string | null | undefined;
	/** Remote path for completed downloads (as client reports) */
	completeRemotePath?: string | null;
	/** Local path for temp/incomplete downloads (SABnzbd only) */
	tempLocalPath?: string | null;
	/** Remote path for temp/incomplete downloads (SABnzbd only) */
	tempRemotePath?: string | null;
}

function joinMappedPath(localBasePath: string, relativePath: string): string {
	const normalizedLocal = normalizePath(localBasePath, true);
	const normalizedRelative = normalizeRelativePath(relativePath);

	if (!normalizedRelative) {
		return normalizedLocal;
	}

	const relativeParts = normalizedRelative.split('/').filter(Boolean);
	const localParts = normalizedLocal.split('/').filter(Boolean);

	// Avoid duplicated segment joins like:
	// remote: /downloads + local: /mnt/rutorrent/completed + client: /downloads/completed/file
	// old: /mnt/rutorrent/completed/completed/file
	// new: /mnt/rutorrent/completed/file
	if (localParts.length > 0 && relativeParts.length > 0) {
		const localTail = localParts[localParts.length - 1].toLowerCase();
		const relativeHead = relativeParts[0].toLowerCase();
		if (localTail === relativeHead) {
			const remainder = relativeParts.slice(1).join('/');
			return remainder ? `${normalizedLocal}/${remainder}` : normalizedLocal;
		}
	}

	return `${normalizedLocal}/${normalizedRelative}`;
}

function normalizePath(path: string, trimTrailingSlash = false): string {
	const normalized = path.replace(/\\/g, '/');
	return trimTrailingSlash ? normalized.replace(/\/+$/, '') : normalized;
}

function normalizeRelativePath(path: string): string {
	return normalizePath(path).replace(/^\/+/, '');
}

/**
 * Segment-boundary prefix match: returns the remainder of `clientPath` after
 * `prefix` (empty string when equal, no leading slash) when `prefix` covers
 * whole path segments, or null when it does not match.
 *
 * A raw string startsWith is not path-aware: a configured remote base of
 * '/downloads/complete' would also capture a client-reported
 * '/downloads/completed/...' path (e.g. Transmission's own completed
 * directory differing from the folder configured in Cinephage) and slice
 * mid-segment, yielding a bogus 'd/<name>' remainder that points imports at
 * a nonexistent path.
 */
function matchPathSegmentPrefix(clientPath: string, prefix: string): string | null {
	if (clientPath === prefix) {
		return '';
	}
	if (clientPath.startsWith(`${prefix}/`)) {
		return clientPath.slice(prefix.length + 1);
	}
	return null;
}

/**
 * Find `prefix` in `clientPath` only when the match both starts and ends on
 * path-segment boundaries, returning its index (or -1). Keeps the heuristic
 * prefix scan from matching '/complete' inside '/completed'.
 */
function findPrefixOnSegmentBoundary(clientPath: string, prefix: string): number {
	const index = clientPath.indexOf(prefix);
	if (index === -1) {
		return -1;
	}
	const startsOnBoundary = index === 0 || clientPath[index - 1] === '/';
	const endIndex = index + prefix.length;
	const endsOnBoundary = endIndex === clientPath.length || clientPath[endIndex] === '/';
	return startsOnBoundary && endsOnBoundary ? index : -1;
}

/**
 * Map a path from client's perspective to local filesystem path.
 * Returns extended result with exact flag and optional warning.
 *
 * `exact` is true only for authoritative resolutions: a configured completed
 * or temp remote mapping that matched, or a client path that already lives
 * under the configured local base (same-host clients). Everything else -
 * common-prefix detection, folder-name alignment, best-guess - is a heuristic
 * and is reported as such so callers can surface misconfigurations (e.g. a
 * Transmission session dir of '/downloads/completed' against a configured
 * '/downloads/complete' base) instead of silently importing from a wrong path.
 *
 * @param clientPath - Path as reported by the download client
 * @param options - Path mapping options
 * @returns The mapped local path with metadata about mapping quality
 */
export function mapClientPathToLocalWithResult(
	clientPath: string,
	options: PathMappingOptions
): PathMappingResult {
	const { completeLocalPath, completeRemotePath, tempLocalPath, tempRemotePath } = options;

	// Normalize client path
	const normalizedClientPath = normalizePath(clientPath, true);

	// Try completed folder mapping first
	if (completeLocalPath && completeRemotePath) {
		const normalizedLocal = normalizePath(completeLocalPath, true);
		const normalizedRemote = normalizePath(completeRemotePath, true);

		const relativePath = matchPathSegmentPrefix(normalizedClientPath, normalizedRemote);
		if (relativePath !== null) {
			const mappedPath = joinMappedPath(normalizedLocal, relativePath);

			logger.debug(
				{
					clientPath,
					completeRemotePath,
					completeLocalPath,
					mappedPath
				},
				'Path mapped (completed folder)'
			);

			return { path: mappedPath, exact: true };
		}
	}

	// Try temp folder mapping (SABnzbd incomplete downloads)
	if (tempLocalPath && tempRemotePath) {
		const normalizedTempLocal = normalizePath(tempLocalPath, true);
		const normalizedTempRemote = normalizePath(tempRemotePath, true);

		const relativePath = matchPathSegmentPrefix(normalizedClientPath, normalizedTempRemote);
		if (relativePath !== null) {
			const mappedPath = joinMappedPath(normalizedTempLocal, relativePath);

			logger.debug(
				{
					clientPath,
					tempRemotePath,
					tempLocalPath,
					mappedPath
				},
				'Path mapped (temp folder)'
			);

			return { path: mappedPath, exact: true };
		}
	}

	// If no local paths configured, pass through unchanged
	if (!completeLocalPath) {
		return { path: clientPath, exact: false, warning: 'No local path configured' };
	}

	const normalizedLocal = normalizePath(completeLocalPath, true);

	// The client already reports a path under the configured local base
	// (same-host clients) - pass through unchanged. needsPathMapping() applies
	// the same rule; segment-aware so '/downloads' cannot capture '/downloads2'.
	if (matchPathSegmentPrefix(normalizedClientPath, normalizedLocal) !== null) {
		return { path: normalizedClientPath, exact: true };
	}

	const heuristicWarning =
		`Path mapping used heuristics: client reported "${clientPath}" did not match the configured ` +
		`mapping (local "${completeLocalPath}", remote "${completeRemotePath ?? 'not set'}")`;

	// Try to intelligently detect the common directory structure
	const commonPrefixes = ['/downloads', '/data', '/torrents', '/complete', '/finished', '/media'];

	for (const prefix of commonPrefixes) {
		const prefixIndex = findPrefixOnSegmentBoundary(normalizedClientPath, prefix);
		if (prefixIndex !== -1) {
			if (normalizedLocal.endsWith(prefix)) {
				const relativePath = normalizedClientPath.slice(prefixIndex + prefix.length);
				return { path: normalizedLocal + relativePath, exact: false, warning: heuristicWarning };
			}

			const localPrefixEnd = normalizedLocal.lastIndexOf('/');
			if (localPrefixEnd !== -1) {
				const relativePath = normalizedClientPath.slice(prefixIndex + prefix.length);
				if (relativePath) {
					return {
						path: normalizedLocal + relativePath,
						exact: false,
						warning: heuristicWarning
					};
				}
			}
		}
	}

	// Try to match folder names
	// Split both paths and find common subfolder
	const clientParts = normalizedClientPath.split('/').filter(Boolean);
	const localParts = normalizedLocal.split('/').filter(Boolean);

	// Find where they might align (e.g., both have "torrents" or "movies" folder)
	for (let i = 0; i < clientParts.length; i++) {
		const clientFolder = clientParts[i];
		const localIndex = localParts.lastIndexOf(clientFolder);

		if (localIndex !== -1 && localIndex === localParts.length - 1) {
			// Found matching folder at end of local path
			// Take everything after this folder from client path
			const relativeParts = clientParts.slice(i + 1);
			if (relativeParts.length > 0) {
				return {
					path: normalizedLocal + '/' + relativeParts.join('/'),
					exact: false,
					warning: heuristicWarning
				};
			}
			return { path: normalizedLocal, exact: false, warning: heuristicWarning };
		}
	}

	// If all else fails, just use the filename/last folder from client path
	// and append to local path
	const lastPart = clientParts[clientParts.length - 1];
	if (lastPart && !normalizedLocal.endsWith(lastPart)) {
		const guessedPath = `${normalizedLocal}/${lastPart}`;
		logger.warn(
			{
				clientPath,
				completeLocalPath,
				result: guessedPath
			},
			'Could not determine path mapping, using best guess'
		);
		return {
			path: guessedPath,
			exact: false,
			warning: `Path mapping used best-guess: client reported "${clientPath}" but no exact mapping found`
		};
	}

	return { path: normalizedLocal, exact: false, warning: heuristicWarning };
}

/**
 * Map a path from client's perspective to local filesystem path.
 * Silent variant of {@link mapClientPathToLocalWithResult} - identical
 * resolution, without the mapping-quality metadata.
 *
 * @param clientPath - Path as reported by the download client
 * @param localBasePath - Local base path for completed downloads
 * @param clientBasePath - Client's base path for completed downloads
 * @param tempLocalPath - Local base path for temp downloads (SABnzbd)
 * @param tempRemotePath - Client's base path for temp downloads (SABnzbd)
 * @returns The mapped local path, or original if no mapping possible
 */
export function mapClientPathToLocal(
	clientPath: string,
	localBasePath: string | null | undefined,
	clientBasePath?: string | null,
	tempLocalPath?: string | null,
	tempRemotePath?: string | null
): string {
	return mapClientPathToLocalWithResult(clientPath, {
		completeLocalPath: localBasePath,
		completeRemotePath: clientBasePath,
		tempLocalPath,
		tempRemotePath
	}).path;
}

/**
 * Extract the content path (file or folder containing files) from a download.
 * Handles both single-file and multi-file torrents.
 *
 * @param savePath - The save path from the download client
 * @param contentPath - The content path (may be same as save_path for single files)
 * @param localBasePath - Local base path for completed downloads
 * @param clientBasePath - Client's base path for completed downloads
 * @param tempLocalPath - Local base path for temp downloads (SABnzbd)
 * @param tempRemotePath - Client's base path for temp downloads (SABnzbd)
 * @returns The mapped path to the actual content
 */
export function getContentPath(
	savePath: string,
	contentPath: string | undefined,
	localBasePath: string | null | undefined,
	clientBasePath?: string | null,
	tempLocalPath?: string | null,
	tempRemotePath?: string | null
): string {
	// If content_path is provided and different from save_path, use it
	// (indicates the actual file/folder name within save_path)
	const pathToMap = contentPath || savePath;

	return mapClientPathToLocal(
		pathToMap,
		localBasePath,
		clientBasePath,
		tempLocalPath,
		tempRemotePath
	);
}

/**
 * Check if a path appears to be a remote/docker path that needs mapping
 */
export function needsPathMapping(path: string, localBasePath: string | null | undefined): boolean {
	if (!localBasePath || !path) {
		return false;
	}

	const normalizedPath = normalizePath(path);
	const normalizedLocalBasePath = normalizePath(localBasePath);

	// If the path already starts with the local base, no mapping needed
	if (normalizedPath.startsWith(normalizedLocalBasePath)) {
		return false;
	}

	return true;
}

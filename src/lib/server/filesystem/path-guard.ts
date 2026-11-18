import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RootFolderService } from '#lib/server/downloadClients/RootFolderService.js';

/**
 * Trees the browse/import surfaces must never touch.
 *
 * This is a denylist, not an allowlist. An allowlist can only name the mount
 * points that existed when it was written, so any deployment that binds media
 * somewhere else (`-v /pool2:/media2`, an LXC bind mount, a fresh ZFS dataset)
 * is locked out of its own media - and because the root folder picker runs
 * through the same guard, it cannot reach the path it would have to register to
 * escape the list (bug #676). Denying the OS-critical trees plus the app's own
 * data directory keeps the scanner out of /proc and the picker out of the auth
 * database, while every media mount stays browsable.
 *
 * This is a guardrail, not the security boundary. Every caller is already
 * admin-gated (browse is absent from the viewer allowlist in hooks.server.ts,
 * the import routes call requireAdmin), and playback containment is enforced
 * separately by isPathInsideManagedRoot. Configured root folders stay the
 * intentional escape hatch: they are allowed even when they sit inside a
 * blocked tree.
 */
const BLOCKED_PATHS = [
	'/etc',
	'/proc',
	'/sys',
	'/dev',
	'/boot',
	'/bin',
	'/sbin',
	'/lib',
	'/lib32',
	'/lib64',
	'/usr',
	'/run',
	'/root',
	'/app',
	'/config',
	'/var',
	'/tmp'
];

/**
 * The app's own config/data directory: database, auth secret, logs. Mirrors the
 * DATA_DIR resolution used by db/connection.ts (relative paths resolve against
 * the process cwd).
 */
function appDataDir(): string {
	return process.env.DATA_DIR || 'data';
}

function isPathWithinScope(pathToCheck: string, scopePath: string): boolean {
	const normalizedPath = resolve(pathToCheck);
	const normalizedScope = resolve(scopePath);
	if (normalizedPath === normalizedScope) {
		return true;
	}
	if (normalizedScope === '/') {
		return normalizedPath.startsWith('/');
	}
	return normalizedPath.startsWith(normalizedScope + '/');
}

async function canonicalizePath(pathToCheck: string): Promise<string> {
	try {
		return await realpath(pathToCheck);
	} catch {
		return resolve(pathToCheck);
	}
}

const ROOT_PATHS_TTL_MS = 30_000;

let cachedRootFolderPaths: string[] | null = null;
let cachedRootFolderPathsAt = 0;

/**
 * Resolve configured root folder paths with a short TTL cache.
 *
 * Resolving root folders is expensive: getFolders() runs a DB query plus a
 * temp-dir write test and statfs calls per root folder. Hot loops (filesystem
 * browsing, bulk import validation) call this once per entry; without caching
 * the cost multiplies by entries x root folders and can freeze the event loop
 * on large directories or slow disks.
 */
async function getRootFolderPaths(): Promise<string[]> {
	const now = Date.now();
	if (cachedRootFolderPaths !== null && now - cachedRootFolderPathsAt < ROOT_PATHS_TTL_MS) {
		return cachedRootFolderPaths;
	}

	const rootFolderService = new RootFolderService();
	const rootFolders = await rootFolderService.getFolders();
	const paths = await Promise.all(rootFolders.map((folder) => canonicalizePath(folder.path)));

	cachedRootFolderPaths = paths;
	cachedRootFolderPathsAt = now;
	return paths;
}

/**
 * Drop the cached root folder paths. Call after any root folder mutation
 * (create, update, delete) so subsequent checks see the new configuration.
 */
export function invalidateRootFolderPathCache(): void {
	cachedRootFolderPaths = null;
	cachedRootFolderPathsAt = 0;
}

export async function isPathInsideManagedRoot(requestedPath: string): Promise<boolean> {
	const normalizedPath = await canonicalizePath(requestedPath);
	const rootFolderPaths = await getRootFolderPaths();
	return rootFolderPaths.some((rootPath) => isPathWithinScope(normalizedPath, rootPath));
}

export async function isManagedRootPath(requestedPath: string): Promise<boolean> {
	const normalizedPath = await canonicalizePath(requestedPath);
	const rootFolderPaths = await getRootFolderPaths();
	return rootFolderPaths.some((rootPath) => rootPath === normalizedPath);
}

let blockedPathsCache: { dataDir: string; paths: Promise<string[]> } | null = null;

/**
 * Canonicalized blocked prefixes, resolved once per DATA_DIR value.
 *
 * The browse listing validates one path per directory child, so re-resolving
 * the static prefixes on every call would put a realpath syscall storm on the
 * event loop - the same shape as bug #495. The cache is keyed by the configured
 * data dir so an env change (tests, restarts) is picked up without a stale
 * entry.
 */
function getBlockedPaths(): Promise<string[]> {
	const dataDir = appDataDir();
	if (blockedPathsCache?.dataDir !== dataDir) {
		blockedPathsCache = {
			dataDir,
			paths: Promise.all(
				[...BLOCKED_PATHS, dataDir].map((candidate) => canonicalizePath(candidate))
			)
		};
	}
	return blockedPathsCache.paths;
}

function isWithinAnyBlockedPath(pathToCheck: string, blockedPaths: string[]): boolean {
	return blockedPaths.some((blockedPath) => isPathWithinScope(pathToCheck, blockedPath));
}

/**
 * Validate a filesystem path is inside allowed boundaries.
 *
 * Blocked:
 * - OS-critical trees and the app's own data directory (BLOCKED_PATHS)
 *
 * Everything else is allowed, so non-standard mount names need no
 * configuration. Configured root folders are always allowed, including their
 * ancestors (the picker has to descend from / into them) - a root folder inside
 * a blocked tree is the operator explicitly saying media lives there.
 */
export async function isPathAllowed(requestedPath: string): Promise<boolean> {
	const normalizedPath = await canonicalizePath(requestedPath);
	const rootFolderPaths = await getRootFolderPaths();

	for (const normalizedRootPath of rootFolderPaths) {
		if (
			isPathWithinScope(normalizedPath, normalizedRootPath) ||
			isPathWithinScope(normalizedRootPath, normalizedPath)
		) {
			return true;
		}
	}

	return !isWithinAnyBlockedPath(normalizedPath, await getBlockedPaths());
}

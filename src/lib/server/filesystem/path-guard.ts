import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { RootFolderService } from '#lib/server/downloadClients/RootFolderService.js';

// Bases the browse/import surfaces may touch. Deliberately NOT '/': with the
// filesystem root in this list every absolute path is "allowed" and the whole
// guard becomes a no-op. A deployment whose media lives outside these bases
// plus the configured root folders (the intended escape hatch for exotic
// mount points) should register that path as a root folder in settings.
const COMMON_BASE_PATHS = [
	'/mnt',
	'/media',
	'/srv',
	'/data',
	'/storage',
	'/home',
	'/opt',
	'/vol',
	'/downloads',
	// Scratch space: test fixtures and the occasional download client land
	// here; browsing it is admin-only and low-sensitivity.
	'/tmp',
	'/var/tmp'
];

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

/**
 * Validate a filesystem path is within allowed boundaries.
 *
 * Allowed:
 * - User home directory
 * - Configured root folders
 * - Common mount base paths
 */
export async function isPathAllowed(requestedPath: string): Promise<boolean> {
	const normalizedPath = await canonicalizePath(requestedPath);
	const homeDir = await canonicalizePath(homedir());

	if (isPathWithinScope(normalizedPath, homeDir) || isPathWithinScope(homeDir, normalizedPath)) {
		return true;
	}

	const rootFolderPaths = await getRootFolderPaths();

	for (const normalizedRootPath of rootFolderPaths) {
		if (
			isPathWithinScope(normalizedPath, normalizedRootPath) ||
			isPathWithinScope(normalizedRootPath, normalizedPath)
		) {
			return true;
		}
	}

	for (const basePath of COMMON_BASE_PATHS) {
		const normalizedBasePath = await canonicalizePath(basePath);
		if (
			isPathWithinScope(normalizedPath, normalizedBasePath) ||
			isPathWithinScope(normalizedBasePath, normalizedPath)
		) {
			return true;
		}
	}

	return false;
}

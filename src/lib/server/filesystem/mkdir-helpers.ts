/**
 * Shared helpers for creating media files and directories with traversable,
 * readable permissions.
 *
 * The container entrypoint sets a process-wide `umask 077` so newly created
 * app-internal files (database, WAL/SHM, logs, caches, which hold secrets)
 * are not accessible to everyone. That umask applies to everything the Node
 * process creates, though - including media library files and folders - so
 * without these helpers, a freshly created movie/show folder ends up `0700`
 * and a freshly written media file `0600`, unreadable by a media server
 * running under a different UID (e.g. Plex at PUID 99 vs Cinephage at PUID
 * 1000). See GitHub issue #617.
 */

import { mkdir, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({
	module: 'filesystem/mkdir-helpers',
	logDomain: 'system' as const
});

/** Standard traversable/readable permissions for media directories. */
const MEDIA_DIR_MODE = 0o755;

/** Standard readable permissions for media files (umask 077 would otherwise land them at 0600). */
export const MEDIA_FILE_MODE = 0o644;

/**
 * Create a directory (and any missing parents) with traversable permissions,
 * overriding the umask-truncated mode that `mkdir` would otherwise apply.
 * Only newly created directories are touched - an already-existing ancestor
 * keeps whatever permissions it already has.
 */
export async function ensureMediaDirectory(dirPath: string): Promise<void> {
	const missing: string[] = [];
	let current: string | null = dirPath;

	while (current !== null) {
		let exists = true;
		try {
			await stat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
			exists = false;
		}

		if (exists) break;

		missing.push(current);
		const parent = dirname(current);
		current = parent === current ? null : parent;
	}

	await mkdir(dirPath, { recursive: true });

	for (const dir of missing) {
		try {
			await chmod(dir, MEDIA_DIR_MODE);
		} catch {
			// Best-effort - a chmod failure (e.g. unsupported on the filesystem)
			// shouldn't fail directory creation itself.
		}
	}
}

/**
 * Apply standard readable permissions to a freshly written media file,
 * overriding the umask-truncated mode `writeFile` would otherwise leave
 * (`0600` under the container's `umask 077`). Only for files inside media
 * library roots - app-internal files under DATA_DIR intentionally stay
 * umask-private.
 */
export async function applyMediaFileMode(
	filePath: string,
	mode: number = MEDIA_FILE_MODE
): Promise<void> {
	try {
		await chmod(filePath, mode);
	} catch (error) {
		// Best-effort - a chmod failure (e.g. unsupported on the filesystem)
		// shouldn't fail the write that produced the file.
		logger.warn(
			{
				filePath,
				mode: mode.toString(8),
				error: error instanceof Error ? error.message : String(error)
			},
			'[mkdir-helpers] Failed to apply media file permissions'
		);
	}
}

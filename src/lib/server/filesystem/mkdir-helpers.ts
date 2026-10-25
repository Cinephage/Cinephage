/**
 * Shared helper for creating media directories with traversable permissions.
 *
 * The container entrypoint sets a process-wide `umask 077` so newly created
 * app-internal files (database, WAL/SHM, logs, caches, which hold secrets)
 * are not accessible to everyone. That umask applies to every directory the
 * Node process creates, though - including media library folders - so
 * without this, a freshly created movie/show folder ends up `0700`,
 * unreadable by a media server running under a different UID (e.g. Plex at
 * PUID 99 vs Cinephage at PUID 1000). See GitHub issue #617.
 */

import { mkdir, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Standard traversable/readable permissions for media directories. */
const MEDIA_DIR_MODE = 0o755;

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

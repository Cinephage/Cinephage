/**
 * Read-only destination guard.
 *
 * Root folders can be marked read-only for virtual mounts (NZBDav, rclone
 * remotes, anything catalogued but not writable). The guard is enforced at
 * several entry points, but the audit found write paths that bypass it:
 * debrid materialization, `.strm` creation, sidecar/NFO regeneration and
 * subtitle sync all wrote into read-only roots.
 *
 * These helpers are the single place that answers "may I write here?", so new
 * call sites do not have to re-derive it from the root folder row.
 */

import { eq } from 'drizzle-orm';
import { isAbsolute, relative, resolve } from 'node:path';

import { db } from '#lib/server/db/index.js';
import { rootFolders } from '#lib/server/db/schema.js';

export interface WritableCheck {
	writable: boolean;
	reason?: string;
	rootFolderId?: string;
}

function isWithin(target: string, root: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Check whether `targetPath` may be written to.
 *
 * A path is rejected when the root folder containing it is marked read-only.
 * A path inside no managed root is allowed here (debrid materialization and
 * other callers validate containment against their own known root); this
 * helper answers only the read-only question.
 */
export async function checkDestinationWritable(targetPath: string): Promise<WritableCheck> {
	const roots = await db.select().from(rootFolders);

	for (const root of roots) {
		if (!isWithin(targetPath, root.path)) continue;
		if (root.readOnly) {
			return {
				writable: false,
				reason: `Root folder '${root.name}' is read-only`,
				rootFolderId: root.id
			};
		}
		return { writable: true, rootFolderId: root.id };
	}

	// Not inside any managed root: not this guard's call. Callers that require
	// a managed destination do their own containment validation.
	return { writable: true };
}

/** Throw when `targetPath` is not writable. */
export async function assertDestinationWritable(targetPath: string): Promise<void> {
	const check = await checkDestinationWritable(targetPath);
	if (!check.writable) {
		throw new Error(check.reason ?? 'Destination is not writable');
	}
}

/** Check by root folder id (skips path matching when the id is known). */
export async function isRootFolderWritable(rootFolderId: string): Promise<boolean> {
	const [root] = await db
		.select({ readOnly: rootFolders.readOnly })
		.from(rootFolders)
		.where(eq(rootFolders.id, rootFolderId))
		.limit(1);
	return root ? !root.readOnly : false;
}

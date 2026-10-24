/**
 * One-shot repair for media files and folders that were created while the
 * container's process-wide `umask 077` truncated their modes (issue #617):
 * a library built in that window (or by any other 077-umask writer) has
 * directories at `0700` and files at `0600`, which a media server running
 * under a different UID cannot traverse or read.
 *
 * The walk only touches entries that carry the umask signature - no group
 * or other permission bits at all - and leaves everything else (0755/0644
 * trees, deliberately customized 0660/0640 modes) untouched. Read-only
 * roots are skipped: they are catalogue-only and chmod is a write.
 */

import { chmod, lstat, readdir, realpath } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { rootFolders } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { MEDIA_FILE_MODE } from './mkdir-helpers.js';

const logger = createChildLogger({
	module: 'filesystem/permission-repair',
	logDomain: 'system' as const
});

/** Umask 077 strips every group/other bit; any mode retaining some is deliberate. */
const UMASK_SIGNATURE_MASK = 0o077;

const MAX_RECORDED_ERRORS = 100;

export interface PermissionRepairRootResult {
	rootFolderId: string;
	name: string;
	path: string;
	skipped: boolean;
	skipReason?: string | null;
}

export interface PermissionRepairSummary {
	scanned: number;
	dirsFixed: number;
	filesFixed: number;
	roots: PermissionRepairRootResult[];
	errors: string[];
	errorsTruncated: boolean;
}

export interface PermissionRepairStatus {
	running: boolean;
	lastResult: PermissionRepairSummary | null;
	lastError: string | null;
}

function emptySummary(): PermissionRepairSummary {
	return { scanned: 0, dirsFixed: 0, filesFixed: 0, roots: [], errors: [], errorsTruncated: false };
}

function recordError(summary: PermissionRepairSummary, path: string, error: unknown): void {
	const message = `${path}: ${error instanceof Error ? error.message : String(error)}`;
	if (summary.errors.length < MAX_RECORDED_ERRORS) {
		summary.errors.push(message);
	} else {
		summary.errorsTruncated = true;
	}
}

async function tryChmod(
	path: string,
	mode: number,
	summary: PermissionRepairSummary
): Promise<boolean> {
	try {
		await chmod(path, mode);
		return true;
	} catch (error) {
		// Best-effort per entry (EPERM on exotic mounts, races with deletes) -
		// one unwritable entry must not abort the walk.
		recordError(summary, path, error);
		return false;
	}
}

async function repairTree(dir: string, summary: PermissionRepairSummary): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		recordError(summary, dir, error);
		return;
	}

	for (const entry of entries) {
		const entryPath = join(dir, entry.name);
		let stats;
		try {
			stats = await lstat(entryPath);
		} catch (error) {
			recordError(summary, entryPath, error);
			continue;
		}
		summary.scanned += 1;

		// Never follow symlinks - the walk must stay inside the root it was given.
		if (stats.isSymbolicLink()) continue;

		if (stats.isDirectory()) {
			if ((stats.mode & UMASK_SIGNATURE_MASK) === 0) {
				if (await tryChmod(entryPath, 0o755, summary)) summary.dirsFixed += 1;
			}
			await repairTree(entryPath, summary);
		} else if (stats.isFile()) {
			if ((stats.mode & UMASK_SIGNATURE_MASK) === 0) {
				if (await tryChmod(entryPath, MEDIA_FILE_MODE, summary)) summary.filesFixed += 1;
			}
		}
	}
}

export interface RepairableRoot {
	id: string;
	name: string;
	path: string;
	readOnly: boolean | null;
}

/** Repair a single root folder, appending its outcome to the shared summary. */
export async function repairRootFolderPermissions(
	root: RepairableRoot,
	summary: PermissionRepairSummary = emptySummary()
): Promise<PermissionRepairSummary> {
	if (root.readOnly) {
		summary.roots.push({
			rootFolderId: root.id,
			name: root.name,
			path: root.path,
			skipped: true,
			skipReason: 'Read-only root folder'
		});
		return summary;
	}

	try {
		// Walk the real path so a symlinked root cannot carry us outside it.
		const realRoot = await realpath(root.path);
		summary.roots.push({
			rootFolderId: root.id,
			name: root.name,
			path: root.path,
			skipped: false,
			skipReason: null
		});
		await repairTree(realRoot, summary);
	} catch (error) {
		summary.roots.push({
			rootFolderId: root.id,
			name: root.name,
			path: root.path,
			skipped: true,
			skipReason: `Root folder is not accessible: ${
				error instanceof Error ? error.message : String(error)
			}`
		});
	}
	return summary;
}

/** Repair every configured root folder sequentially. */
export async function repairAllRootFolders(): Promise<PermissionRepairSummary> {
	const summary = emptySummary();
	const rows = await db
		.select({
			id: rootFolders.id,
			name: rootFolders.name,
			path: rootFolders.path,
			readOnly: rootFolders.readOnly
		})
		.from(rootFolders)
		.orderBy(asc(rootFolders.path));

	for (const row of rows) {
		await repairRootFolderPermissions(row, summary);
	}
	return summary;
}

let running = false;
let lastResult: PermissionRepairSummary | null = null;
let lastError: string | null = null;

export function getPermissionRepairStatus(): PermissionRepairStatus {
	return { running, lastResult, lastError };
}

/**
 * Kick off a repair pass in the background. Resolves to false (without
 * starting anything) when a repair is already in progress.
 */
export function startPermissionRepair(): boolean {
	if (running) return false;
	running = true;
	lastError = null;

	void repairAllRootFolders()
		.then((result) => {
			lastResult = result;
			logger.info(
				{
					scanned: result.scanned,
					dirsFixed: result.dirsFixed,
					filesFixed: result.filesFixed
				},
				'[permission-repair] Media permission repair finished'
			);
		})
		.catch((error) => {
			lastError = error instanceof Error ? error.message : String(error);
			logger.error({ err: error }, '[permission-repair] Media permission repair failed');
		})
		.finally(() => {
			running = false;
		});

	return true;
}

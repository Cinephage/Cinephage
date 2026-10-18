import { cp, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolvePathWithinRoot } from './delete-helpers.js';
import { ensureMediaDirectory } from './mkdir-helpers.js';

export type DirectoryMoveMode = 'noop' | 'rename' | 'copy-delete';

export interface DirectoryMoveResult {
	sourcePath: string;
	destPath: string;
	mode: DirectoryMoveMode;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * Move a media-relative directory from one root folder to another safely.
 * - Uses atomic rename when possible.
 * - Falls back to copy+delete for cross-device moves (EXDEV).
 */
export async function moveDirectoryWithinRoots(
	sourceRootPath: string,
	relativePath: string,
	destRootPath: string
): Promise<DirectoryMoveResult> {
	const sourcePath = resolvePathWithinRoot(sourceRootPath, relativePath);
	const destPath = resolvePathWithinRoot(destRootPath, relativePath);

	if (sourcePath === destPath) {
		return { sourcePath, destPath, mode: 'noop' };
	}

	if (!(await pathExists(sourcePath))) {
		throw new Error(`Source path does not exist: ${sourcePath}`);
	}

	if (await pathExists(destPath)) {
		throw new Error(`Destination path already exists: ${destPath}`);
	}

	await ensureMediaDirectory(dirname(destPath));

	try {
		await rename(sourcePath, destPath);
		return { sourcePath, destPath, mode: 'rename' };
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== 'EXDEV') {
			throw error;
		}

		await cp(sourcePath, destPath, {
			recursive: true,
			force: false,
			errorOnExist: true,
			preserveTimestamps: true
		});
		await rm(sourcePath, { recursive: true, force: false });
		return { sourcePath, destPath, mode: 'copy-delete' };
	}
}

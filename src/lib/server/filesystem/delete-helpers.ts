import { lstat, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Containment check for a destructive path operation.
 *
 * Equality is deliberately NOT "inside": a media-relative path of `.` resolves
 * to the root itself. MediaMatcher stores exactly that for a file sitting in
 * the root of a library (`dirname('Movie.2024.mkv') === '.'`), so accepting
 * equality let a single delete request `rm -rf` the whole library root.
 */
function isPathStrictlyWithinRoot(pathToCheck: string, rootPath: string): boolean {
	const rel = relative(rootPath, pathToCheck);
	if (rel === '') return false;
	return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Reject a relative path that names the root itself (`.`, `./`, empty, or any
 * path that normalizes back to the root).
 */
function assertNamesChild(
	relativePath: string,
	normalizedRoot: string,
	resolvedPath: string
): void {
	if (resolvedPath === normalizedRoot) {
		throw new Error(
			`Refusing to operate on the root folder itself (relative path: "${relativePath}")`
		);
	}
}

/**
 * Resolve a media-relative path under a root folder and ensure it names a
 * child of that root.
 *
 * The check is string-based and cannot see through a symlinked path component:
 * a DB `path` of `link/sub` where `link` points outside the root passes here.
 * Destructive callers must use {@link assertNoSymlinkEscape} before removing.
 */
export function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
	const normalizedRoot = resolve(rootPath);
	const resolvedPath = resolve(join(normalizedRoot, relativePath));

	// Equality is checked before containment so a root-level path reports the
	// real reason instead of a misleading "outside root" traversal error.
	assertNamesChild(relativePath, normalizedRoot, resolvedPath);

	if (!isPathStrictlyWithinRoot(resolvedPath, normalizedRoot)) {
		throw new Error(
			`Path traversal detected: ${resolvedPath} is outside root folder ${normalizedRoot}`
		);
	}

	return resolvedPath;
}

/**
 * Resolve the parent directory of `targetPath` to its real location and verify
 * it is still inside `rootPath`. Catches symlinked path components, which the
 * string checks above cannot. The target itself may not exist yet.
 */
export async function assertNoSymlinkEscape(rootPath: string, targetPath: string): Promise<void> {
	const realRoot = await realpath(resolve(rootPath));

	// Walk up until an existing ancestor is found: the nearest existing parent
	// determines where the kernel would actually act.
	let probe = resolve(targetPath);
	for (;;) {
		try {
			const realProbe = await realpath(probe);
			if (realProbe !== realRoot && !isPathStrictlyWithinRoot(realProbe, realRoot)) {
				throw new Error(
					`Path escapes root folder through a symlink: ${targetPath} resolves to ${realProbe}`
				);
			}
			return;
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			// Our own rejection must not be swallowed by the ENOENT retry below.
			if (err.message?.startsWith('Path escapes root folder')) throw error;
			if (err.code !== 'ENOENT') throw error;
			const parent = resolve(probe, '..');
			if (parent === probe) return;
			probe = parent;
		}
	}
}

/**
 * Delete a directory recursively, constrained to the given root folder.
 *
 * Refuses to act on the root itself and on paths that escape it via a symlink.
 */
export async function deleteDirectoryWithinRoot(
	rootPath: string,
	relativePath: string
): Promise<string> {
	const resolvedPath = resolvePathWithinRoot(rootPath, relativePath);
	await assertNoSymlinkEscape(rootPath, resolvedPath);

	// Re-check the target itself: a symlink at the final component would make
	// rm remove the link, which is harmless, but a symlinked directory is what
	// realpath already rejected above. lstat here documents that intent.
	try {
		const stats = await lstat(resolvedPath);
		if (!stats.isDirectory()) {
			throw new Error(`Refusing to delete a non-directory path: ${resolvedPath}`);
		}
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== 'ENOENT') throw error;
		return resolvedPath;
	}

	await rm(resolvedPath, { recursive: true, force: true });
	return resolvedPath;
}

/**
 * True when `relativePath` names the root folder itself rather than a child.
 * MediaMatcher stores `.` for a file that sits at the top of a library root,
 * which is the case this guards.
 */
export function namesRootItself(rootPath: string, relativePath: string): boolean {
	const normalizedRoot = resolve(rootPath);
	return resolve(join(normalizedRoot, relativePath)) === normalizedRoot;
}

/**
 * Delete specific files under a root, resolving each media-relative path
 * strictly inside it. Used for media tracked at the root level, where deleting
 * the containing directory would take the whole library with it.
 */
export async function deleteFilesWithinRoot(
	rootPath: string,
	relativePaths: string[]
): Promise<string[]> {
	const deleted: string[] = [];
	for (const relativePath of relativePaths) {
		const resolvedPath = resolvePathWithinRoot(rootPath, relativePath);
		await assertNoSymlinkEscape(rootPath, resolvedPath);
		await rm(resolvedPath, { force: true });
		deleted.push(resolvedPath);
	}
	return deleted;
}

/** Exposed for tests: the separator-aware containment predicate. */
export const __testing = { isPathStrictlyWithinRoot, sep };

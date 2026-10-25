/**
 * File Transfer Service
 *
 * Handles moving/copying/hardlinking files from download location to library.
 * Always prefers hardlinks to save disk space and preserve source files.
 *
 * Transfer Strategy:
 * - ImportMode.Auto: Always try hardlink first (with copy fallback), then delete source if canMoveFiles=true
 * - ImportMode.Copy: Always copy (for cross-device or read-only sources)
 * - ImportMode.Move: Always move (for explicit move requests)
 * - ImportMode.HardlinkOrCopy: Hardlink with copy fallback, never delete source
 */

import {
	link,
	stat,
	statfs,
	readdir,
	unlink,
	rmdir,
	rename,
	lstat,
	readlink,
	realpath,
	symlink,
	open,
	chmod
} from 'fs/promises';
import { ensureMediaDirectory } from '#lib/server/filesystem/mkdir-helpers.js';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join, dirname, basename, extname, resolve } from 'path';
import { createChildLogger } from '#lib/logging/index.js';
import {
	VIDEO_EXTENSIONS,
	isVideoFile as isBaseVideoFile,
	DANGEROUS_EXTENSIONS,
	EXECUTABLE_EXTENSIONS
} from '#lib/config/constants.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

/**
 * Copy a file without preserving the source mode bits. Node's built-in
 * copyFile performs an implicit fchmod on the destination after the data copy,
 * which fails with EPERM on filesystems without per-file permission bits
 * (exfat, FAT). A plain stream copy never chmods, so it succeeds everywhere;
 * permission handling is owned by applyFilePermissions where requested.
 */
async function copyFileNoChmod(source: string, dest: string): Promise<void> {
	await pipeline(createReadStream(source), createWriteStream(dest));
}

/**
 * Transfer mode for files (low-level operation)
 * Follows Radarr's TransferMode enum pattern
 */
export type TransferMode = 'hardlink' | 'copy' | 'move' | 'symlink' | 'skip-duplicate';

/**
 * Import mode for deciding how to transfer files (high-level intent)
 * Follows Radarr's ImportMode enum pattern
 *
 * @see Radarr: NzbDrone.Core/MediaFiles/MovieImport/ImportMode.cs
 */
export enum ImportMode {
	/**
	 * Auto-detect: Always try hardlink first (with copy fallback).
	 * If canMoveFiles=true, delete source after successful transfer.
	 * This is the recommended default for all imports.
	 */
	Auto = 'auto',

	/**
	 * Always move the file (rename or copy+delete)
	 * Only use when explicitly requested
	 */
	Move = 'move',

	/**
	 * Always copy (keep source intact)
	 * Use for read-only sources or when explicitly requested
	 */
	Copy = 'copy',

	/**
	 * Try hardlink first, fall back to copy, never delete source
	 * Use when you explicitly want to preserve source files
	 */
	HardlinkOrCopy = 'hardlinkOrCopy',

	/**
	 * Create a symlink in the library pointing at the source file.
	 * The source is never moved or deleted. If the source is itself a
	 * symlink, the library link resolves to the real target via realpath
	 * to avoid fragile chains.
	 */
	Symlink = 'symlink'
}

/**
 * Result of a file transfer operation
 */
export interface TransferResult {
	success: boolean;
	sourcePath: string;
	destPath: string;
	mode: TransferMode;
	error?: string;
	sizeBytes?: number;
}

/**
 * Options for file transfer with import mode support
 */
export interface TransferOptions {
	/** Import mode to use (default: Auto) */
	importMode?: ImportMode;
	/** Whether source can be moved (false = seeding torrent) */
	canMoveFiles?: boolean;
	/** Whether to preserve symlinks instead of copying target */
	preserveSymlinks?: boolean;
	/** Try hardlink before falling back to copy (default: true). Set false to always copy. */
	preferHardlink?: boolean;
}

/**
 * Check if two paths are on the same filesystem (for hardlink compatibility)
 */
async function isSameFilesystem(path1: string, path2: string): Promise<boolean> {
	try {
		const stat1 = await stat(path1);
		const stat2 = await stat(dirname(path2)); // Check dest directory

		// Compare device IDs
		return stat1.dev === stat2.dev;
	} catch {
		return false;
	}
}

/**
 * Ensure a media directory exists, creating it (and any missing parents)
 * with traversable permissions. See `ensureMediaDirectory` for why this
 * can't just be a plain `mkdir`.
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
	await ensureMediaDirectory(dirPath);
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get file size in bytes
 */
export async function getFileSize(filePath: string): Promise<number> {
	const stats = await stat(filePath);
	return stats.size;
}

/**
 * Check if a path is a symbolic link
 */
export async function isSymlink(filePath: string): Promise<boolean> {
	try {
		const stats = await lstat(filePath);
		return stats.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Transfer a single file using hardlink (preferred), symlink preservation, or copy
 *
 * @param source - Source file path
 * @param dest - Destination file path
 * @param preferHardlink - Whether to try hardlink first (default: true)
 * @param preserveSymlinks - Whether to preserve symlinks instead of copying content (default: false)
 * @returns Transfer result
 */
export async function transferFile(
	source: string,
	dest: string,
	preferHardlink = true,
	preserveSymlinks = false
): Promise<TransferResult> {
	try {
		// Ensure destination directory exists
		await ensureDirectory(dirname(dest));

		// Check if destination already exists
		if (await fileExists(dest)) {
			logger.warn({ dest }, 'Destination file already exists, will overwrite');
			await unlink(dest);
		}

		// Check if source is a symlink and preservation is enabled
		if (preserveSymlinks && (await isSymlink(source))) {
			const linkTarget = await readlink(source);
			await symlink(linkTarget, dest);

			// Get size from the actual target for reporting (stat follows symlinks)
			const sizeBytes = await getFileSize(source);

			logger.debug({ source, dest, target: linkTarget }, 'Symlink preserved');

			return {
				success: true,
				sourcePath: source,
				destPath: dest,
				mode: 'symlink',
				sizeBytes
			};
		}

		// Get file size
		const sizeBytes = await getFileSize(source);

		// Try hardlink first if preferred
		if (preferHardlink) {
			const sameFs = await isSameFilesystem(source, dest);

			if (sameFs) {
				try {
					await link(source, dest);
					logger.debug({ source, dest }, 'File hardlinked successfully');

					return {
						success: true,
						sourcePath: source,
						destPath: dest,
						mode: 'hardlink',
						sizeBytes
					};
				} catch (error) {
					const err = error as NodeJS.ErrnoException;
					// isSameFilesystem()'s st_dev comparison can't see pool/disk
					// boundaries on FUSE-backed setups (e.g. Unraid mergerfs), so
					// link() can still throw EXDEV here even though the same-fs
					// check passed. Falling back to copy silently doubles disk
					// usage for the file's size, so this must be visible at the
					// default log floor (Issue #597), not buried at debug.
					logger.warn(
						{
							code: err.code,
							error: err.message,
							sourceDir: dirname(source),
							destDir: dirname(dest),
							sizeBytes
						},
						'Hardlink failed, falling back to copy (this duplicates disk usage for the file)'
					);
				}
			} else {
				logger.info(
					{
						source: basename(source),
						dest: basename(dest)
					},
					'Hardlink not possible (source and destination on different filesystems), falling back to copy'
				);
			}
		}

		// Fall back to copy
		await copyFileNoChmod(source, dest);
		logger.debug({ source, dest }, 'File copied successfully');

		return {
			success: true,
			sourcePath: source,
			destPath: dest,
			mode: 'copy',
			sizeBytes
		};
	} catch (error) {
		const err = error as Error;
		logger.error(
			{
				source,
				dest,
				error: err.message
			},
			'File transfer failed'
		);

		return {
			success: false,
			sourcePath: source,
			destPath: dest,
			mode: preferHardlink ? 'hardlink' : 'copy',
			error: err.message
		};
	}
}

/**
 * Move a file (rename if same filesystem, copy+delete if different).
 *
 * Safety guarantees:
 * - Returns success immediately (no-op) when source and destination resolve
 *   to the same absolute path.
 * - Refuses to move a file when the destination is a child of the source
 *   (prevents recursive/degenerate moves that lose data).
 * - Verifies the source file exists BEFORE touching the destination, so a
 *   missing source fails cleanly without collateral damage.
 * - Only unlinks the destination when it is definitely a different file.
 */
export async function moveFile(source: string, dest: string): Promise<TransferResult> {
	try {
		const resolvedSource = resolve(source);
		const resolvedDest = resolve(dest);

		// No-op: source and destination are the same file.
		if (resolvedSource === resolvedDest) {
			let sizeBytes: number | undefined;
			try {
				sizeBytes = await getFileSize(resolvedSource);
			} catch {
				return {
					success: false,
					sourcePath: source,
					destPath: dest,
					mode: 'move',
					error: `Source and destination are the same path, but the file does not exist: ${resolvedSource}`
				};
			}
			return {
				success: true,
				sourcePath: source,
				destPath: dest,
				mode: 'move',
				sizeBytes
			};
		}

		// Parent-path collision: refuse to move a file into one of its own
		// descendant directories.  Pattern: Radarr's DiskTransferService.
		const sourceDir = resolvedSource.endsWith('/') ? resolvedSource.slice(0, -1) : resolvedSource;
		if (resolvedDest.startsWith(sourceDir + '/') || resolvedDest.startsWith(sourceDir + '\\')) {
			return {
				success: false,
				sourcePath: source,
				destPath: dest,
				mode: 'move',
				error: `Destination is a child of the source path: ${resolvedDest}`
			};
		}

		// Verify source exists BEFORE touching destination.
		let sizeBytes: number | undefined;
		try {
			sizeBytes = await getFileSize(resolvedSource);
		} catch (error) {
			return {
				success: false,
				sourcePath: source,
				destPath: dest,
				mode: 'move',
				error: `Source file not found: ${(error as Error).message}`
			};
		}

		await ensureDirectory(dirname(dest));

		// Remove pre-existing destination (safe — we already confirmed source !== dest).
		if (await fileExists(dest)) {
			await unlink(dest);
		}

		// Try rename first (fast if same filesystem).
		try {
			await rename(source, dest);
			return {
				success: true,
				sourcePath: source,
				destPath: dest,
				mode: 'move',
				sizeBytes
			};
		} catch {
			// Cross-device move — copy then delete source.
			await copyFileNoChmod(source, dest);
			await unlink(source);

			return {
				success: true,
				sourcePath: source,
				destPath: dest,
				mode: 'move',
				sizeBytes
			};
		}
	} catch (error) {
		return {
			success: false,
			sourcePath: source,
			destPath: dest,
			mode: 'move',
			error: (error as Error).message
		};
	}
}

/**
 * Creates a symlink at `dest` pointing to `source`. If `source` is itself a
 * symlink, `realpath` is used to resolve the full chain so the library link
 * points at the real file rather than creating a fragile chain through the
 * download folder.
 */
export async function createSymlinkImport(source: string, dest: string): Promise<TransferResult> {
	try {
		await ensureDirectory(dirname(dest));

		// Use lstat (not stat) so we detect and remove dangling symlinks too;
		// stat follows the link and throws ENOENT if the target is gone, which
		// would leave the stale symlink in place and cause symlink() to fail with EEXIST.
		try {
			await lstat(dest);
			await unlink(dest);
		} catch {
			// dest doesn't exist — nothing to remove
		}

		// Resolve any symlink chain so the library link is as stable as possible
		let linkTarget = source;
		if (await isSymlink(source)) {
			try {
				linkTarget = await realpath(source);
			} catch {
				// Broken or inaccessible symlink - fall back to the source path directly
				linkTarget = source;
			}
		}

		await symlink(linkTarget, dest);

		let sizeBytes: number | undefined;
		try {
			sizeBytes = await getFileSize(source);
		} catch {
			// non-fatal
		}

		logger.debug({ source, dest, linkTarget }, '[FileTransfer] Symlink import created');

		return { success: true, sourcePath: source, destPath: dest, mode: 'symlink', sizeBytes };
	} catch (error) {
		return {
			success: false,
			sourcePath: source,
			destPath: dest,
			mode: 'symlink',
			error: (error as Error).message
		};
	}
}

/**
 * Transfer a file using ImportMode to determine the transfer strategy.
 * Follows Radarr's pattern for handling seeding torrents vs usenet.
 *
 * @param source - Source file path
 * @param dest - Destination file path
 * @param options - Transfer options including ImportMode and canMoveFiles
 * @returns Transfer result
 */
export async function transferFileWithMode(
	source: string,
	dest: string,
	options: TransferOptions = {}
): Promise<TransferResult> {
	const {
		importMode = ImportMode.Auto,
		canMoveFiles = true,
		preserveSymlinks = false,
		preferHardlink = true
	} = options;

	// Determine effective transfer mode based on ImportMode
	let effectiveMode: ImportMode;
	let deleteSourceAfter = false;

	switch (importMode) {
		case ImportMode.Auto:
			// Always use hardlink/copy first (hardlink is instant and space-efficient)
			// If canMoveFiles=true, we'll delete source after successful transfer
			effectiveMode = ImportMode.HardlinkOrCopy;
			deleteSourceAfter = canMoveFiles;
			logger.debug(
				{
					canMoveFiles,
					deleteSourceAfter,
					source: basename(source)
				},
				'Auto import mode: hardlink first, delete source after'
			);
			break;

		case ImportMode.Move:
		case ImportMode.Copy:
		case ImportMode.HardlinkOrCopy:
		case ImportMode.Symlink:
			effectiveMode = importMode;
			break;

		default:
			effectiveMode = ImportMode.HardlinkOrCopy;
	}

	// Execute based on effective mode
	let result: TransferResult;

	switch (effectiveMode) {
		case ImportMode.Move:
			return moveFile(source, dest);

		case ImportMode.Copy:
			return transferFile(source, dest, false, preserveSymlinks);

		case ImportMode.Symlink:
			return createSymlinkImport(source, dest);

		case ImportMode.HardlinkOrCopy:
		default:
			result = await transferFile(source, dest, preferHardlink, preserveSymlinks);
			break;
	}

	// If transfer succeeded and we should delete source, do it now
	if (result.success && deleteSourceAfter) {
		try {
			await unlink(source);
			logger.debug(
				{
					source: basename(source)
				},
				'Source file deleted after successful hardlink/copy'
			);
			// Update mode to reflect the full operation
			result.mode = 'move';
		} catch (error) {
			// Non-fatal: file is already in library, source deletion is just cleanup
			logger.warn(
				{
					source,
					error: (error as Error).message
				},
				'Failed to delete source after transfer (non-fatal)'
			);
		}
	}

	return result;
}

/**
 * Options for batch transfer
 */
export interface BatchTransferOptions {
	/** Prefer hardlinks over copies */
	preferHardlink?: boolean;
	/** File extensions to transfer (e.g., ['.mkv', '.mp4']) */
	extensions?: string[];
	/** Preserve folder structure relative to source root */
	preserveStructure?: boolean;
}

/**
 * Batch transfer result
 */
export interface BatchTransferResult {
	success: boolean;
	totalFiles: number;
	successfulFiles: number;
	failedFiles: number;
	totalBytes: number;
	hardlinkedCount: number;
	copiedCount: number;
	results: TransferResult[];
	errors: string[];
}

/**
 * Transfer all matching files from a directory
 */
export async function transferDirectory(
	sourceDir: string,
	destDir: string,
	options: BatchTransferOptions = {}
): Promise<BatchTransferResult> {
	const { preferHardlink = true, extensions, preserveStructure = true } = options;

	const result: BatchTransferResult = {
		success: true,
		totalFiles: 0,
		successfulFiles: 0,
		failedFiles: 0,
		totalBytes: 0,
		hardlinkedCount: 0,
		copiedCount: 0,
		results: [],
		errors: []
	};

	try {
		const files = await findFilesRecursive(sourceDir, extensions);
		result.totalFiles = files.length;

		for (const file of files) {
			// Calculate destination path
			let destPath: string;
			if (preserveStructure) {
				const relativePath = file.slice(sourceDir.length).replace(/^\/+/, '');
				destPath = join(destDir, relativePath);
			} else {
				destPath = join(destDir, basename(file));
			}

			const transferResult = await transferFile(file, destPath, preferHardlink);
			result.results.push(transferResult);

			if (transferResult.success) {
				result.successfulFiles++;
				result.totalBytes += transferResult.sizeBytes || 0;

				if (transferResult.mode === 'hardlink') {
					result.hardlinkedCount++;
				} else {
					result.copiedCount++;
				}
			} else {
				result.failedFiles++;
				result.errors.push(`${file}: ${transferResult.error}`);
			}
		}

		result.success = result.failedFiles === 0;
	} catch (error) {
		result.success = false;
		result.errors.push((error as Error).message);
	}

	return result;
}

/**
 * Recursively find files in a directory
 */
async function findFilesRecursive(dir: string, extensions?: string[]): Promise<string[]> {
	const files: string[] = [];

	try {
		const entries = await readdir(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			if (entry.isDirectory()) {
				// Skip hidden directories and system folders
				if (entry.name.startsWith('.') || entry.name.startsWith('@')) {
					continue;
				}
				const subFiles = await findFilesRecursive(fullPath, extensions);
				files.push(...subFiles);
			} else if (entry.isFile()) {
				// Filter by extension if specified
				if (extensions && extensions.length > 0) {
					const ext = extname(entry.name).toLowerCase();
					if (!extensions.includes(ext)) {
						// Fallback: check magic numbers for extensionless files
						if (ext === '' && (await isVideoFileByMagic(fullPath))) {
							files.push(fullPath);
						}
						continue;
					}
				}
				files.push(fullPath);
			} else if (entry.isSymbolicLink()) {
				// Dirent symlinks are neither files nor directories.
				// Include symlinked files (useful for Altmount/NZBDav Rclone mounts),
				// but avoid recursing through symlinked directories.
				try {
					const targetStats = await stat(fullPath);
					if (!targetStats.isFile()) {
						continue;
					}
				} catch {
					// Broken/unreadable symlink - skip
					continue;
				}

				// Filter by extension if specified
				if (extensions && extensions.length > 0) {
					const ext = extname(entry.name).toLowerCase();
					if (!extensions.includes(ext)) {
						// Fallback: check magic numbers for extensionless symlinked files
						if (ext === '' && (await isVideoFileByMagic(fullPath))) {
							files.push(fullPath);
						}
						continue;
					}
				}
				files.push(fullPath);
			}
		}
	} catch (error) {
		logger.warn(
			{
				dir,
				error: (error as Error).message
			},
			'Failed to read directory'
		);
	}

	return files;
}

const FILE_TRANSFER_EXTRA_EXTENSIONS = ['.strm'] as const;

export function isVideoFile(filePath: string): boolean {
	return isBaseVideoFile(filePath, FILE_TRANSFER_EXTRA_EXTENSIONS);
}

/**
 * Video file magic number signatures for fallback detection
 */
interface MagicSignature {
	magic: Buffer;
	offset: number;
	format: string;
	extra?: { magic: Buffer; offset: number };
}

const VIDEO_MAGIC_SIGNATURES: MagicSignature[] = [
	{ magic: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), offset: 0, format: 'mkv/webm' },
	{ magic: Buffer.from('ftyp'), offset: 4, format: 'mp4/mov/m4v' },
	{
		magic: Buffer.from('RIFF'),
		offset: 0,
		format: 'avi',
		extra: { magic: Buffer.from('AVI '), offset: 8 }
	},
	{ magic: Buffer.from('FLV'), offset: 0, format: 'flv' }
];

/**
 * Check if a file is a video by reading its magic bytes.
 * Used as fallback when file has no extension.
 */
export async function isVideoFileByMagic(filePath: string): Promise<boolean> {
	let fd;
	try {
		fd = await open(filePath, 'r');
		const buffer = Buffer.alloc(12);
		await fd.read(buffer, 0, 12, 0);

		for (const sig of VIDEO_MAGIC_SIGNATURES) {
			const slice = buffer.subarray(sig.offset, sig.offset + sig.magic.length);
			if (slice.equals(sig.magic)) {
				// Additional check for formats that need secondary verification (like AVI)
				if (sig.extra) {
					const extraSlice = buffer.subarray(
						sig.extra.offset,
						sig.extra.offset + sig.extra.magic.length
					);
					if (!extraSlice.equals(sig.extra.magic)) continue;
				}
				return true;
			}
		}
		return false;
	} catch {
		return false;
	} finally {
		await fd?.close();
	}
}

/**
 * Find all video files in a directory
 */
export async function findVideoFiles(dir: string): Promise<string[]> {
	return findFilesRecursive(dir, [...VIDEO_EXTENSIONS, '.strm']);
}

/**
 * Returns available disk space in bytes for the filesystem containing `targetPath`.
 * Throws if the path doesn't exist or statfs fails.
 */
export async function getAvailableDiskSpaceBytes(targetPath: string): Promise<number> {
	const fs = await statfs(targetPath);
	return fs.bavail * fs.bsize;
}

/**
 * Checks whether the filesystem containing `targetPath` has at least
 * `minimumFreeSpaceGb` GB of free space. Returns false (not enough space) or
 * true (ok). Never throws - logs a warning and returns true on stat failure so
 * that a transient error doesn't block every import.
 */
export async function hasSufficientDiskSpace(
	targetPath: string,
	minimumFreeSpaceGb: number
): Promise<boolean> {
	if (minimumFreeSpaceGb <= 0) return true;
	try {
		const available = await getAvailableDiskSpaceBytes(targetPath);
		const minimumBytes = minimumFreeSpaceGb * 1024 * 1024 * 1024;
		return available >= minimumBytes;
	} catch (err) {
		logger.warn(
			{ targetPath, error: err instanceof Error ? err.message : String(err) },
			'[FileTransfer] Could not check disk space - allowing import to proceed'
		);
		return true;
	}
}

/** Default file mode applied when neither chmodFile nor preservePermissions is configured. */
const DEFAULT_MEDIA_FILE_MODE = 0o644;

/**
 * Applies file permissions to `destPath` after a transfer.
 * Priority: explicit `chmodFile` value > `preservePermissions` (copy from source) > default 644.
 *
 * The default matters because of the container's umask: the entrypoint sets
 * a process-wide `umask 077` to keep app-internal secrets private, but that
 * also applies to a freshly copied/moved media file, which would otherwise
 * land `0600` - unreadable by a media server running under a different UID
 * (e.g. Plex). A hardlinked file shares the source's inode/mode already, so
 * this intentionally still normalizes it to 644 for consistency across
 * transfer modes rather than leaving it at whatever the source happened to
 * have. See GitHub issue #617.
 *
 * Never throws - logs a warning on failure so a permission error never blocks an import.
 */
export async function applyFilePermissions(
	destPath: string,
	sourcePath: string,
	preservePermissions: boolean,
	chmodFile: string
): Promise<void> {
	try {
		if (chmodFile) {
			await chmod(destPath, parseInt(chmodFile, 8));
		} else if (preservePermissions) {
			const sourceStat = await stat(sourcePath);
			await chmod(destPath, sourceStat.mode & 0o777);
		} else {
			await chmod(destPath, DEFAULT_MEDIA_FILE_MODE);
		}
	} catch (err) {
		logger.warn(
			{ destPath, error: (err as Error).message },
			'[FileTransfer] Failed to apply file permissions'
		);
	}
}

/**
 * Copies or moves sidecar files (subtitles, NFO, artwork, etc.) from `sourceDir`
 * to `destDir`. Only files whose lowercase extension appears in `extensions` are
 * transferred. The source directory is scanned non-recursively. Files that already
 * exist at the destination are skipped with a warning.
 *
 * `doMove` mirrors what happened to the main video file: true = move, false = copy.
 */
const ALWAYS_BLOCKED_EXTS = new Set<string>([
	...(DANGEROUS_EXTENSIONS as readonly string[]),
	...(EXECUTABLE_EXTENSIONS as readonly string[])
]);

export async function copyExtraFiles(
	sourceDir: string,
	destDir: string,
	extensions: string[],
	doMove: boolean,
	permissions?: { preservePermissions: boolean; chmodFile: string }
): Promise<void> {
	if (extensions.length === 0) return;
	const normalizedExts = extensions
		.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`))
		.filter((e) => !ALWAYS_BLOCKED_EXTS.has(e));
	let entries: string[];
	try {
		entries = await readdir(sourceDir);
	} catch {
		return;
	}
	for (const name of entries) {
		const ext = extname(name).toLowerCase();
		if (!normalizedExts.includes(ext)) continue;
		const src = join(sourceDir, name);
		const dst = join(destDir, name);
		try {
			const srcStat = await stat(src);
			if (!srcStat.isFile()) continue;
			if (await fileExists(dst)) {
				logger.debug({ dst }, '[FileTransfer] Extra file already exists at destination, skipping');
				continue;
			}
			if (doMove) {
				await moveFile(src, dst);
			} else {
				await copyFileNoChmod(src, dst);
			}
			if (permissions) {
				await applyFilePermissions(
					dst,
					src,
					permissions.preservePermissions,
					permissions.chmodFile
				);
			}
			logger.debug({ src, dst, doMove }, '[FileTransfer] Imported extra file');
		} catch (err) {
			logger.warn(
				{ src, dst, error: (err as Error).message },
				'[FileTransfer] Failed to import extra file'
			);
		}
	}
}

/**
 * Moves `filePath` into a `.trash` folder at the root of the library, preserving
 * the path structure beneath `rootFolderPath` so files from different media never
 * collide. The original file is removed; the DB record is untouched by this call.
 */
export async function moveToRecycleBin(filePath: string, rootFolderPath: string): Promise<void> {
	const normalizedRoot = rootFolderPath.endsWith('/')
		? rootFolderPath.slice(0, -1)
		: rootFolderPath;
	const relativePath = filePath.startsWith(normalizedRoot + '/')
		? filePath.slice(normalizedRoot.length + 1)
		: filePath.replace(/^\/+/, '');
	const trashPath = join(normalizedRoot, '.trash', relativePath);
	const result = await moveFile(filePath, trashPath);
	if (!result.success) {
		throw new Error(`Failed to move file to recycle bin: ${result.error}`);
	}
	logger.info({ from: filePath, to: trashPath }, '[FileTransfer] Moved file to recycle bin');
}

/**
 * Delete (or recycle, when enabled) a physical file. Centralizes the
 * recycle-vs-unlink decision so every movie-file delete path honors the
 * global recycleEnabled setting consistently. No-op when the file is missing.
 * Filesystem errors PROPAGATE — callers are expected to catch (each delete
 * path wraps this in its own try/catch and continues with DB cleanup).
 */
export async function deletePhysicalFile(
	filePath: string,
	recycleEnabled: boolean,
	rootFolderPath: string
): Promise<void> {
	if (await fileExists(filePath)) {
		if (recycleEnabled) {
			await moveToRecycleBin(filePath, rootFolderPath);
		} else {
			await unlink(filePath);
		}
	}
}

/**
 * Walks up from `startPath` toward `stopAt`, removing each directory that is
 * empty (no remaining files or subdirectories). Stops before removing `stopAt`
 * itself. Safe to call after a move; silently skips non-empty dirs.
 */
export async function removeEmptyDirectories(startPath: string, stopAt: string): Promise<void> {
	const normalizedStop = stopAt.endsWith('/') ? stopAt : stopAt + '/';
	let current = startPath;

	while (current.startsWith(normalizedStop) && current !== stopAt) {
		let entries: string[];
		try {
			const dirEntries = await readdir(current);
			entries = dirEntries;
		} catch {
			break;
		}

		if (entries.length > 0) break;

		try {
			await rmdir(current);
			logger.debug({ dir: current }, '[FileTransfer] Removed empty directory after move');
		} catch {
			break;
		}

		current = current.substring(0, current.lastIndexOf('/')) || '/';
	}
}

import { opendir } from 'node:fs/promises';
import { join, dirname, relative, extname, isAbsolute, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import { isVideoFile } from '#lib/server/library/media-info.js';
import { DOWNLOAD } from '#lib/config/constants.js';
import type { DiscoveredFile } from '#lib/server/library/disk-scan.js';
import {
	matchIgnore,
	classifyFile,
	recognizeStructure,
	type CompiledPatterns
} from '#lib/server/library/patterns/PatternRecognitionService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

// Hardcoded fallback patterns — used only when ScannerOptions.patterns is
// absent (backward-compatible path). When patterns are provided, the
// PatternRecognitionService handles all filtering.
const EXCLUDED_FOLDER_PATTERNS = [
	/^\./,
	/^@/,
	/^#recycle$/i,
	/^lost\+found$/i,
	/^\$recycle\.bin$/i,
	/^system volume information$/i,
	/^thumbs\.db$/i,
	/^\.ds_store$/i,
	/^samples?$/i,
	/^extras?$/i,
	/^featurettes?$/i,
	/^behind[\s._-]?the[\s._-]?scenes?$/i,
	/^deleted[\s._-]?scenes?$/i,
	/^subs?$/i,
	/^subtitles?$/i
];

// Patterns only excluded at shallow depth (≤1 from root). At depth ≥2 the
// same name is a valid TV season folder (e.g. a show's own Specials/ dir).
const SHALLOW_EXCLUDED_FOLDER_PATTERNS = [/^specials?$/i];

const SAMPLE_PATTERNS = [/\bsample\b/i];

export interface ScannerOptions {
	batchSize: number;
	customExcludedFolders: string[];
	blockedExtensions: string[];
	/**
	 * Full file paths already tracked by the library or recorded as recent
	 * rename targets. Ancestor directories of these paths must be traversed
	 * even when their names match a generic exclusion such as /^\./.
	 */
	alwaysScanPaths: string[];
	patterns?: CompiledPatterns;
}

const DEFAULT_OPTIONS: ScannerOptions = {
	batchSize: 500,
	customExcludedFolders: [],
	blockedExtensions: [],
	alwaysScanPaths: []
};

function shouldExcludeFolderLegacy(name: string, customPatterns: string[]): boolean {
	if (EXCLUDED_FOLDER_PATTERNS.some((pattern) => pattern.test(name))) return true;
	const lower = name.toLowerCase();
	if (customPatterns.some((p) => p.toLowerCase() === lower)) return true;
	// Skip directories whose name is exactly a video-file pattern (e.g. "matrix.mkv/").
	// isVideoFile() uses path.extname(), which only tests the LAST extension, so
	// "my.mkv.assets" (ext: .assets) and "render.mp4_temp" (ext: .mp4_temp) are
	// NOT excluded — only names whose final segment is a recognised video extension.
	const folderExt = extname(name).toLowerCase();
	return folderExt.length > 1 && isVideoFile(name);
}

function shouldExcludeFileLegacy(
	fileName: string,
	filePath: string,
	customPatterns: string[],
	blockedExtensions: string[],
	skipFolderExclusions = false
): boolean {
	if (SAMPLE_PATTERNS.some((pattern) => pattern.test(fileName))) return true;

	if (blockedExtensions.length > 0) {
		const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
		if (blockedExtensions.includes(ext)) return true;
	}
	if (skipFolderExclusions) return false;

	// Only check directory segments — the final part is the filename itself,
	// not a directory, so shouldExcludeFolderLegacy must not test it (our
	// video-extension check would otherwise exclude every .mkv/.mp4 file).
	const pathParts = filePath.split('/');
	for (let i = 0; i < pathParts.length - 1; i++) {
		if (shouldExcludeFolderLegacy(pathParts[i], customPatterns)) return true;
	}

	return false;
}

export class StreamingDiskScanner {
	private options: ScannerOptions;
	private alwaysScanDirectories = new Set<string>();

	constructor(options: Partial<ScannerOptions> = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	get hasPatterns(): boolean {
		return this.options.patterns !== undefined;
	}

	async *scan(rootPath: string): AsyncGenerator<DiscoveredFile[]> {
		let batch: DiscoveredFile[] = [];
		this.alwaysScanDirectories = this.buildAlwaysScanDirectories(rootPath);

		for await (const file of this.walkDirectory(rootPath, rootPath)) {
			batch.push(file);
			if (batch.length >= this.options.batchSize) {
				yield batch;
				batch = [];
			}
		}

		if (batch.length > 0) {
			yield batch;
		}
	}

	private buildAlwaysScanDirectories(rootPath: string): Set<string> {
		const directories = new Set<string>();
		const resolvedRoot = resolve(rootPath);

		for (const path of this.options.alwaysScanPaths) {
			let current = dirname(resolve(path));
			const relativeToRoot = relative(resolvedRoot, current);
			if (
				relativeToRoot === '..' ||
				relativeToRoot.startsWith(`..${sep}`) ||
				isAbsolute(relativeToRoot)
			) {
				continue;
			}

			while (true) {
				directories.add(current);
				if (current === resolvedRoot) break;
				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}
		}

		return directories;
	}

	private shouldExcludeFolder(name: string, fullPath: string, depth: number): boolean {
		if (this.alwaysScanDirectories.has(resolve(fullPath))) return false;

		const { patterns, customExcludedFolders } = this.options;
		if (patterns) {
			// Folder-level ignore: test with trailing slash so directory
			// patterns match consistently.
			const relPath = name + '/';
			return matchIgnore(relPath, patterns);
		}
		if (depth >= 1 && SHALLOW_EXCLUDED_FOLDER_PATTERNS.some((p) => p.test(name))) return false;
		return shouldExcludeFolderLegacy(name, customExcludedFolders);
	}

	private shouldExcludeFile(relPath: string, fileName: string, fullPath: string): boolean {
		const { patterns, customExcludedFolders, blockedExtensions } = this.options;
		if (patterns) {
			return matchIgnore(relPath, patterns);
		}
		return shouldExcludeFileLegacy(
			fileName,
			relPath,
			customExcludedFolders,
			blockedExtensions,
			this.alwaysScanDirectories.has(resolve(dirname(fullPath)))
		);
	}

	private classify(relPath: string): 'main' | 'bonus' {
		const { patterns } = this.options;
		if (patterns) {
			return classifyFile(relPath, patterns) ?? 'main';
		}
		return 'main';
	}

	private async *walkDirectory(
		rootPath: string,
		currentPath: string,
		depth = 0
	): AsyncGenerator<DiscoveredFile> {
		let dirHandle: Awaited<ReturnType<typeof opendir>>;
		try {
			dirHandle = await opendir(currentPath);
		} catch (error) {
			const fsError = error as NodeJS.ErrnoException;
			const isRootPath = depth === 0 && currentPath === rootPath;
			if (
				(fsError?.code === 'ENOENT' || fsError?.code === 'EACCES' || fsError?.code === 'EPERM') &&
				!isRootPath
			) {
				logger.debug(
					{ currentPath, code: fsError.code },
					'[StreamingScanner] Skipping inaccessible directory'
				);
				return;
			}
			throw error;
		}

		for await (const entry of dirHandle) {
			const fullPath = join(currentPath, entry.name);

			if (entry.isDirectory()) {
				if (this.shouldExcludeFolder(entry.name, fullPath, depth)) {
					logger.debug(
						{ folder: entry.name, path: fullPath, depth },
						'[StreamingScanner] Skipping excluded folder'
					);
					continue;
				}

				yield* this.walkDirectory(rootPath, fullPath, depth + 1);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				if (!isVideoFile(entry.name)) continue;

				const relativePath = relative(rootPath, fullPath);

				if (this.shouldExcludeFile(relativePath, entry.name, fullPath)) continue;

				try {
					const stats = await stat(fullPath);

					if (entry.isSymbolicLink() && !stats.isFile()) continue;

					if (
						stats.size < DOWNLOAD.MIN_SCAN_SIZE_BYTES &&
						!entry.name.toLowerCase().endsWith('.strm')
					) {
						continue;
					}

					const contentCategory = this.classify(relativePath);
					const structureMatch = this.options.patterns
						? recognizeStructure(relativePath, this.options.patterns)
						: null;

					yield {
						path: fullPath,
						relativePath,
						size: stats.size,
						modifiedAt: stats.mtime,
						parentFolder: dirname(relativePath) || '.',
						contentCategory,
						structureMatch
					};
				} catch (statError) {
					logger.warn(
						{ fullPath, error: statError instanceof Error ? statError.message : String(statError) },
						'[StreamingScanner] Could not stat file'
					);
				}
			}
		}
	}
}

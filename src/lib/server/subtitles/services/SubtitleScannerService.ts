/**
 * Subtitle Scanner Service
 *
 * Discovers and reconciles existing subtitle files on disk.
 * Integrates with the library scanner to detect subtitles alongside video files.
 *
 * Path base (Phase 3 Task 5):
 * - movie rows are stored relative to the movie folder;
 * - episode rows are stored relative to the directory of the owning episode file
 *   (including the season folder when present).
 * Both are produced by `toStoredRelativePath` and read back by
 * `resolveStoredSubtitlePath`, so scanner, download/delete and sync share one
 * definition. Migration 141 rewrote legacy episode rows onto this base.
 *
 * Reconciliation replaces the old insert-only behavior: a scan compares
 * discovered sidecars against stored rows (identity = owner + stored relative
 * path) and inserts/updates/deletes in one transaction per media item.
 */

import { readdir, realpath, stat } from 'fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname, posix, relative } from 'path';
import { db } from '#lib/server/db/index.js';
import {
	subtitles,
	subtitleHistory,
	movies,
	movieFiles,
	episodes,
	episodeFiles,
	rootFolders,
	series
} from '#lib/server/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import type { SubtitleFormat, LanguageCode } from '../types';
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '#lib/logging/index.js';
import {
	resolveStoredSubtitlePaths,
	toStoredRelativePath,
	type StoredSubtitleRow
} from '../subtitle-paths';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import { normalizeLanguageCode } from '#lib/shared/languages.js';
import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';
import { LanguageSettingsService } from './LanguageSettingsService.js';

/** Common subtitle file extensions */
const SUBTITLE_EXTENSIONS = ['.srt', '.sub', '.ass', '.ssa', '.vtt', '.idx'];

/**
 * Language patterns in subtitle filenames
 * Ordered from most specific to least specific to ensure correct matching
 * Regional variants (like pt-br, zh-tw) are checked before base languages
 */
const LANGUAGE_PATTERNS: Array<{ pattern: RegExp; code: LanguageCode }> = [
	// Regional variants - must come FIRST (more specific patterns)
	{ pattern: /\.(?:pt[-_]?br|brazilian|bra)\./i, code: 'pt-br' },
	{ pattern: /\.(?:pt[-_]?pt|portuguese[-_]?portugal)\./i, code: 'pt' },
	{ pattern: /\.(?:zh[-_]?tw|zh[-_]?hant|traditional[-_]?chinese|cht)\./i, code: 'zh-tw' },
	{ pattern: /\.(?:zh[-_]?cn|zh[-_]?hans|simplified[-_]?chinese|chs)\./i, code: 'zh-cn' },
	{ pattern: /\.(?:es[-_]?la|spanish[-_]?latin|lat)\./i, code: 'es-la' },
	{ pattern: /\.(?:fr[-_]?ca|french[-_]?canada)\./i, code: 'fr-ca' },
	// Full language names
	{ pattern: /\.english\./i, code: 'en' },
	{ pattern: /\.spanish\./i, code: 'es' },
	{ pattern: /\.french\./i, code: 'fr' },
	{ pattern: /\.german\./i, code: 'de' },
	{ pattern: /\.italian\./i, code: 'it' },
	{ pattern: /\.portuguese\./i, code: 'pt' },
	{ pattern: /\.russian\./i, code: 'ru' },
	{ pattern: /\.chinese\./i, code: 'zh' },
	{ pattern: /\.japanese\./i, code: 'ja' },
	{ pattern: /\.korean\./i, code: 'ko' },
	{ pattern: /\.arabic\./i, code: 'ar' },
	{ pattern: /\.hindi\./i, code: 'hi' },
	{ pattern: /\.dutch\./i, code: 'nl' },
	{ pattern: /\.polish\./i, code: 'pl' },
	{ pattern: /\.swedish\./i, code: 'sv' },
	{ pattern: /\.norwegian\./i, code: 'no' },
	{ pattern: /\.danish\./i, code: 'da' },
	{ pattern: /\.finnish\./i, code: 'fi' },
	{ pattern: /\.greek\./i, code: 'el' },
	{ pattern: /\.turkish\./i, code: 'tr' },
	{ pattern: /\.hebrew\./i, code: 'he' },
	{ pattern: /\.thai\./i, code: 'th' },
	{ pattern: /\.vietnamese\./i, code: 'vi' },
	{ pattern: /\.czech\./i, code: 'cs' },
	{ pattern: /\.hungarian\./i, code: 'hu' },
	{ pattern: /\.romanian\./i, code: 'ro' },
	{ pattern: /\.bulgarian\./i, code: 'bg' },
	{ pattern: /\.ukrainian\./i, code: 'uk' },
	{ pattern: /\.indonesian\./i, code: 'id' },
	{ pattern: /\.malay\./i, code: 'ms' },
	{ pattern: /\.croatian\./i, code: 'hr' },
	{ pattern: /\.serbian\./i, code: 'sr' },
	{ pattern: /\.slovak\./i, code: 'sk' },
	{ pattern: /\.slovenian\./i, code: 'sl' },
	{ pattern: /\.persian\./i, code: 'fa' },
	{ pattern: /\.farsi\./i, code: 'fa' },
	{ pattern: /\.bengali\./i, code: 'bn' },
	{ pattern: /\.tamil\./i, code: 'ta' },
	{ pattern: /\.telugu\./i, code: 'te' },
	{ pattern: /\.icelandic\./i, code: 'is' },
	{ pattern: /\.catalan\./i, code: 'ca' },
	// ISO 639-1 codes (2-letter) - order matters, check longer variants first
	{ pattern: /\.en\./i, code: 'en' },
	{ pattern: /\.es\./i, code: 'es' },
	{ pattern: /\.fr\./i, code: 'fr' },
	{ pattern: /\.de\./i, code: 'de' },
	{ pattern: /\.it\./i, code: 'it' },
	{ pattern: /\.pt\./i, code: 'pt' },
	{ pattern: /\.ru\./i, code: 'ru' },
	{ pattern: /\.zh\./i, code: 'zh' },
	{ pattern: /\.ja\./i, code: 'ja' },
	{ pattern: /\.ko\./i, code: 'ko' },
	{ pattern: /\.ar\./i, code: 'ar' },
	// Note: .hi. is ambiguous - could be Hindi or Hearing Impaired. Handled specially.
	{ pattern: /\.nl\./i, code: 'nl' },
	{ pattern: /\.pl\./i, code: 'pl' },
	{ pattern: /\.sv\./i, code: 'sv' },
	{ pattern: /\.no\./i, code: 'no' },
	{ pattern: /\.da\./i, code: 'da' },
	{ pattern: /\.fi\./i, code: 'fi' },
	{ pattern: /\.el\./i, code: 'el' },
	{ pattern: /\.tr\./i, code: 'tr' },
	{ pattern: /\.he\./i, code: 'he' },
	{ pattern: /\.th\./i, code: 'th' },
	{ pattern: /\.vi\./i, code: 'vi' },
	{ pattern: /\.cs\./i, code: 'cs' },
	{ pattern: /\.hu\./i, code: 'hu' },
	{ pattern: /\.ro\./i, code: 'ro' },
	{ pattern: /\.bg\./i, code: 'bg' },
	{ pattern: /\.uk\./i, code: 'uk' },
	{ pattern: /\.id\./i, code: 'id' },
	{ pattern: /\.ms\./i, code: 'ms' },
	{ pattern: /\.hr\./i, code: 'hr' },
	{ pattern: /\.sr\./i, code: 'sr' },
	{ pattern: /\.sk\./i, code: 'sk' },
	{ pattern: /\.sl\./i, code: 'sl' },
	{ pattern: /\.fa\./i, code: 'fa' },
	{ pattern: /\.bn\./i, code: 'bn' },
	{ pattern: /\.ta\./i, code: 'ta' },
	{ pattern: /\.te\./i, code: 'te' },
	{ pattern: /\.is\./i, code: 'is' },
	{ pattern: /\.ca\./i, code: 'ca' },
	// 3-letter ISO 639-2 codes
	{ pattern: /\.eng\./i, code: 'en' },
	{ pattern: /\.spa\./i, code: 'es' },
	{ pattern: /\.fre\./i, code: 'fr' },
	{ pattern: /\.ger\./i, code: 'de' },
	{ pattern: /\.deu\./i, code: 'de' },
	{ pattern: /\.ita\./i, code: 'it' },
	{ pattern: /\.por\./i, code: 'pt' },
	{ pattern: /\.pob\./i, code: 'pt-br' }, // Common for Brazilian Portuguese
	{ pattern: /\.rus\./i, code: 'ru' },
	{ pattern: /\.chi\./i, code: 'zh' },
	{ pattern: /\.zho\./i, code: 'zh' },
	{ pattern: /\.jpn\./i, code: 'ja' },
	{ pattern: /\.kor\./i, code: 'ko' },
	{ pattern: /\.ara\./i, code: 'ar' },
	{ pattern: /\.hin\./i, code: 'hi' },
	{ pattern: /\.dut\./i, code: 'nl' },
	{ pattern: /\.nld\./i, code: 'nl' },
	{ pattern: /\.pol\./i, code: 'pl' },
	{ pattern: /\.swe\./i, code: 'sv' },
	{ pattern: /\.nor\./i, code: 'no' },
	{ pattern: /\.dan\./i, code: 'da' },
	{ pattern: /\.fin\./i, code: 'fi' },
	{ pattern: /\.gre\./i, code: 'el' },
	{ pattern: /\.ell\./i, code: 'el' },
	{ pattern: /\.tur\./i, code: 'tr' },
	{ pattern: /\.heb\./i, code: 'he' },
	{ pattern: /\.tha\./i, code: 'th' },
	{ pattern: /\.vie\./i, code: 'vi' },
	{ pattern: /\.cze\./i, code: 'cs' },
	{ pattern: /\.ces\./i, code: 'cs' },
	{ pattern: /\.hun\./i, code: 'hu' },
	{ pattern: /\.rum\./i, code: 'ro' },
	{ pattern: /\.ron\./i, code: 'ro' },
	{ pattern: /\.bul\./i, code: 'bg' },
	{ pattern: /\.ukr\./i, code: 'uk' },
	{ pattern: /\.ind\./i, code: 'id' },
	{ pattern: /\.may\./i, code: 'ms' },
	{ pattern: /\.msa\./i, code: 'ms' },
	{ pattern: /\.hrv\./i, code: 'hr' },
	{ pattern: /\.srp\./i, code: 'sr' },
	{ pattern: /\.slo\./i, code: 'sk' },
	{ pattern: /\.slk\./i, code: 'sk' },
	{ pattern: /\.slv\./i, code: 'sl' },
	{ pattern: /\.per\./i, code: 'fa' },
	{ pattern: /\.fas\./i, code: 'fa' },
	{ pattern: /\.ben\./i, code: 'bn' },
	{ pattern: /\.tam\./i, code: 'ta' },
	{ pattern: /\.tel\./i, code: 'te' },
	{ pattern: /\.ice\./i, code: 'is' },
	{ pattern: /\.isl\./i, code: 'is' },
	{ pattern: /\.cat\./i, code: 'ca' }
];

/** Patterns for detecting forced/HI subtitles */
const FORCED_PATTERN = /\.forced\./i;
const HI_PATTERNS = [/\.hi\./i, /\.sdh\./i, /\.cc\./i, /hearing[_\s-]?impaired/i];

/**
 * Numbers that commonly appear in release names but are not episode numbers.
 * Used by the absolute-episode fallback parser to avoid matching 1080/720 etc.
 */
const COMMON_VIDEO_NUMBERS = new Set([264, 265, 480, 576, 720, 1080, 2160, 4320]);

interface DiscoveredSubtitle {
	path: string;
	relativePath: string;
	size: number;
	language: LanguageCode;
	isForced: boolean;
	isHearingImpaired: boolean;
	format: SubtitleFormat;
	videoFileName?: string;
}

/** A sidecar that the scanner should persist, keyed by owner + stored path. */
interface DesiredSubtitle {
	/** movieId or episodeId, depending on the scanned media item. */
	ownerId: string;
	/** Value to store in `subtitles.relative_path` (movie-folder- or episode-dir-relative). */
	relativePath: string;
	/** Absolute path on disk (used for reassignment detection). */
	absPath: string;
	language: LanguageCode;
	isForced: boolean;
	isHearingImpaired: boolean;
	format: SubtitleFormat;
	size: number;
	movieFileId: string | null;
}

/** Result counters for a scan, surfaced by the scan API. */
export interface SubtitleScanResult {
	discovered: number;
	/** Newly inserted rows. */
	added: number;
	/** Alias of `added`, kept for existing API consumers. */
	registered: number;
	/** Rows whose metadata changed. */
	updated: number;
	/** Rows deleted because their file no longer exists on disk. */
	removed: number;
	/** Rows that were already up to date. */
	unchanged: number;
	/** Discovered sidecars that could not be associated / had no owner. */
	skipped: number;
	/** Skipped sidecars with the reason they were not associated. */
	ambiguous: string[];
	errors: string[];
}

type EpisodeFileRow = typeof episodeFiles.$inferSelect;

function emptyResult(): SubtitleScanResult {
	return {
		discovered: 0,
		added: 0,
		registered: 0,
		updated: 0,
		removed: 0,
		unchanged: 0,
		skipped: 0,
		ambiguous: [],
		errors: []
	};
}

/** Directory of a relative path, normalized to forward slashes; '' when at the base. */
function relativeDir(relativePath: string): string {
	const normalized = relativePath.replace(/\\/g, '/');
	const dir = posix.dirname(normalized);
	return dir === '.' ? '' : dir;
}

/** Base name of a path without its extension. */
function stemOf(pathLike: string): string {
	return basename(pathLike, extname(pathLike));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

/**
 * Parse a season/episode marker from a file name.
 * Returns a canonical key (`s01e02` for SxxExx / NxNN, or `abs:5` for a lone
 * absolute episode number) or null when no marker is present.
 */
export function parseEpisodeMarker(name: string): string | null {
	const se = /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})(?![0-9])/i.exec(name);
	if (se) return `s${Number(se[1])}e${Number(se[2])}`;

	const x = /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?![0-9])/i.exec(name);
	if (x) return `s${Number(x[1])}e${Number(x[2])}`;

	// Absolute episode number: accept a lone numeric token that is not a common
	// video number (resolution/codec). Only unambiguous when exactly one remains.
	const tokenPattern = /(?:^|[ ._\-[\]()])(\d{1,3})(?=$|[ ._\-[\]()])/g;
	const numbers: number[] = [];
	for (const match of name.matchAll(tokenPattern)) {
		const num = Number(match[1]);
		if (num > 0 && !COMMON_VIDEO_NUMBERS.has(num)) numbers.push(num);
	}
	const uniqueNumbers = [...new Set(numbers)];
	if (uniqueNumbers.length === 1) return `abs:${uniqueNumbers[0]}`;

	return null;
}

class SubtitleScannerService {
	private static instance: SubtitleScannerService | null = null;
	// Undetermined language — never assume a specific language (spec §2.2)
	private fallbackLanguage: LanguageCode = 'und';

	private constructor() {}

	static getInstance(): SubtitleScannerService {
		if (!SubtitleScannerService.instance) {
			SubtitleScannerService.instance = new SubtitleScannerService();
		}
		return SubtitleScannerService.instance;
	}

	/**
	 * Check if a file is a subtitle file
	 */
	isSubtitleFile(fileName: string): boolean {
		const ext = extname(fileName).toLowerCase();
		return SUBTITLE_EXTENSIONS.includes(ext);
	}

	/**
	 * Detect language from subtitle filename
	 * Uses pattern matching and normalizes the result through the centralized language module
	 */
	detectLanguage(fileName: string): LanguageCode {
		// First, check for .hi. which is ambiguous (Hindi vs Hearing Impaired)
		// If the file also has SDH or CC markers, .hi. likely means Hearing Impaired, not Hindi
		const hasOtherHiMarkers =
			/\.sdh\./i.test(fileName) ||
			/\.cc\./i.test(fileName) ||
			/hearing[_\s-]?impaired/i.test(fileName);

		for (const { pattern, code } of LANGUAGE_PATTERNS) {
			if (pattern.test(fileName)) {
				// Skip .hi. interpretation as Hindi if file has other HI markers
				if (code === 'hi' && pattern.source.includes('.hi.') && hasOtherHiMarkers) {
					continue;
				}
				// Normalize the code through the shared language module
				return normalizeLanguageCode(code);
			}
		}
		// Undetermined fallback when no language could be detected from the filename
		return this.fallbackLanguage;
	}

	/**
	 * Check if subtitle is forced
	 */
	isForced(fileName: string): boolean {
		return FORCED_PATTERN.test(fileName);
	}

	/**
	 * Check if subtitle is for hearing impaired
	 */
	isHearingImpaired(fileName: string): boolean {
		return HI_PATTERNS.some((pattern) => pattern.test(fileName));
	}

	/**
	 * Get subtitle format from extension
	 */
	getFormat(fileName: string): SubtitleFormat {
		const ext = extname(fileName).toLowerCase();
		switch (ext) {
			case '.srt':
				return 'srt';
			case '.ass':
			case '.ssa':
				return 'ass';
			case '.sub':
				return 'sub';
			case '.vtt':
				return 'vtt';
			default:
				return 'unknown';
		}
	}

	/**
	 * Discover subtitle files in a directory
	 */
	async discoverSubtitles(
		directoryPath: string,
		rootPath: string,
		assumedLanguage?: LanguageCode | null
	): Promise<DiscoveredSubtitle[]> {
		const subtitleFiles: DiscoveredSubtitle[] = [];

		try {
			const entries = await readdir(directoryPath, { withFileTypes: true });
			const realRootPath = await realpath(rootPath);

			for (const entry of entries) {
				const fullPath = join(directoryPath, entry.name);

				if (entry.isDirectory()) {
					// Skip system folders
					if (entry.name.startsWith('.') || entry.name.startsWith('@')) {
						continue;
					}
					// Recursively scan subdirectories
					const subResults = await this.discoverSubtitles(fullPath, rootPath, assumedLanguage);
					subtitleFiles.push(...subResults);
				} else if (this.isSubtitleFile(entry.name)) {
					try {
						const stats = await stat(fullPath);
						if (!stats.isFile()) continue;
						const realFilePath = await realpath(fullPath);
						const pathFromRoot = relative(realRootPath, realFilePath);
						if (pathFromRoot === '..' || pathFromRoot.split(/[\\/]+/)[0] === '..') continue;
						const relativePath = relative(rootPath, fullPath)
							.split(/[\\/]+/)
							.join('/');
						const baseName = basename(fullPath);

						// Try to find associated video file
						const videoFileName = this.findAssociatedVideoFileName(baseName);

						const detectedLanguage = this.detectLanguage(baseName);
						subtitleFiles.push({
							path: fullPath,
							relativePath,
							size: stats.size,
							// `unknown_subtitle_policy = assume-language` may map an
							// undetermined filename to the configured language.
							language:
								detectedLanguage === 'und' && assumedLanguage ? assumedLanguage : detectedLanguage,
							isForced: this.isForced(baseName),
							isHearingImpaired: this.isHearingImpaired(baseName),
							format: this.getFormat(baseName),
							videoFileName
						});
					} catch (error) {
						logger.warn({ path: fullPath, error }, 'Could not stat subtitle file');
					}
				}
			}
		} catch (error) {
			const fsError = error as NodeJS.ErrnoException;
			if (fsError?.code === 'ENOENT') {
				// Expected under the file-row-driven model: items whose files
				// vanished between scheduling and the readdir, or folders not
				// present on disk (wanted-but-missing media).
				logger.debug(
					{ directoryPath },
					'Subtitle scan target folder not present on disk; skipping'
				);
				return subtitleFiles;
			}
			logger.error({ directoryPath, error }, 'Error reading directory for subtitles');
		}

		return subtitleFiles;
	}

	/**
	 * Resolve the configured assumed language for undetermined subtitles.
	 * Returns null unless `unknown_subtitle_policy` is 'assume-language' and the
	 * configured language canonicalizes to a real tag (never English by default).
	 */
	private async resolveAssumedLanguage(): Promise<LanguageCode | null> {
		try {
			const settings = await LanguageSettingsService.getInstance().get();
			if (settings.unknownSubtitlePolicy !== 'assume-language' || !settings.assumedLanguage) {
				return null;
			}
			const tag = normalizeLanguageTag(settings.assumedLanguage);
			return tag === 'und' ? null : (tag as LanguageCode);
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				'Failed to resolve assumed subtitle language; falling back to und'
			);
			return null;
		}
	}

	/**
	 * Extract likely video filename from subtitle filename
	 * E.g., "Movie.2024.en.srt" -> "Movie.2024"
	 */
	private findAssociatedVideoFileName(subtitleFileName: string): string | undefined {
		// Strip the extension, then re-add a trailing separator sentinel so an
		// end-of-name token ("Movie.2024.1080p.en") still matches the
		// `\.lang\.`-style suffix patterns that rely on a trailing delimiter.
		let name = `${this.videoBaseName(subtitleFileName)}.`;

		// Remove language tags
		for (const { pattern } of LANGUAGE_PATTERNS) {
			name = name.replace(pattern, '.');
		}

		// Remove forced/HI tags
		name = name.replace(FORCED_PATTERN, '.');
		for (const pattern of HI_PATTERNS) {
			name = name.replace(pattern, '.');
		}

		// Clean up double dots and trailing dots
		name = name.replace(/\.+/g, '.').replace(/\.$/, '');

		return name || undefined;
	}

	/**
	 * Compute the video base name (without extension) of a movie file's relative path.
	 * E.g. "Movie.2024.2160p.mkv" -> "Movie.2024.2160p".
	 */
	private videoBaseName(relativePath: string): string {
		return basename(relativePath, extname(relativePath));
	}

	/**
	 * Scan and reconcile subtitles for a movie.
	 *
	 * Movie rows are stored relative to the movie folder (unchanged behavior);
	 * the sidecar is linked to the quality tier whose base name it matches.
	 */
	async scanMovieSubtitles(movieId: string): Promise<SubtitleScanResult> {
		const result = emptyResult();

		try {
			const movie = await db.query.movies.findFirst({
				where: eq(movies.id, movieId)
			});

			if (!movie) {
				result.errors.push(`Movie not found: ${movieId}`);
				return result;
			}

			if (!movie.rootFolderId) {
				result.errors.push(`Movie has no root folder: ${movieId}`);
				return result;
			}

			const rootFolder = await db.query.rootFolders.findFirst({
				where: eq(rootFolders.id, movie.rootFolderId)
			});

			if (!rootFolder) {
				result.errors.push(`Root folder not found`);
				return result;
			}

			// Load this movie's files so each sidecar can be linked to the specific
			// quality tier it belongs to (multi-quality support).
			const movieFilesList = await db
				.select({ id: movieFiles.id, relativePath: movieFiles.relativePath })
				.from(movieFiles)
				.where(eq(movieFiles.movieId, movieId));

			const moviePath = join(rootFolder.path, movie.path);
			// File-row-driven discovery (Sonarr parity): a movie with no files has
			// nothing to discover and its folder is not guaranteed to exist
			// (wanted-but-missing entries). Skip the directory read, but still
			// reconcile stored rows below so stale subtitle rows die with their
			// media file.
			const discovered =
				movieFilesList.length > 0
					? await this.discoverSubtitles(moviePath, moviePath, await this.resolveAssumedLanguage())
					: [];
			result.discovered = discovered.length;

			// Map lowercased video base name -> movie file id. Matching is
			// case-insensitive because subtitle files commonly differ in case from
			// their video (e.g. "MOVIE.2024.EN.SRT" next to "Movie.2024.mkv") and
			// the deployment target is a case-sensitive Linux filesystem. Ambiguous
			// base names (claimed by more than one file) are excluded so the sidecar
			// stays unlinked as a safe default rather than guessing.
			const baseNameToMovieFileId = new Map<string, string>();
			const ambiguousBaseNames = new Set<string>();
			for (const mf of movieFilesList) {
				const baseName = this.videoBaseName(mf.relativePath).toLowerCase();
				if (baseNameToMovieFileId.has(baseName)) {
					ambiguousBaseNames.add(baseName);
				} else {
					baseNameToMovieFileId.set(baseName, mf.id);
				}
			}

			const desired: DesiredSubtitle[] = [];
			for (const sub of discovered) {
				const lookupKey = sub.videoFileName?.toLowerCase();
				const movieFileId =
					lookupKey && !ambiguousBaseNames.has(lookupKey)
						? baseNameToMovieFileId.get(lookupKey)
						: undefined;

				desired.push({
					ownerId: movieId,
					relativePath: toStoredRelativePath(sub.path, moviePath),
					absPath: sub.path,
					language: sub.language,
					isForced: sub.isForced,
					isHearingImpaired: sub.isHearingImpaired,
					format: sub.format,
					size: sub.size,
					movieFileId: movieFileId ?? null
				});
			}

			const storedRows = await db.query.subtitles.findMany({
				where: eq(subtitles.movieId, movieId)
			});
			const storedAbsPaths = await resolveStoredSubtitlePaths(storedRows);

			this.reconcileItem(result, 'movie', desired, storedRows, storedAbsPaths);
		} catch (error) {
			result.errors.push(error instanceof Error ? error.message : 'Unknown error');
		}

		return result;
	}

	/**
	 * Scan and reconcile subtitles for a series.
	 *
	 * Episode rows are stored relative to the directory of the owning episode
	 * file. Sidecars are associated unambiguously (exact stem, then SxxExx /
	 * absolute marker, then proximity only for a single-episode directory);
	 * anything else is skipped and reported instead of attaching to the first
	 * episode in a shared season folder.
	 */
	async scanSeriesSubtitles(seriesId: string): Promise<SubtitleScanResult> {
		const result = emptyResult();

		try {
			const seriesData = await db.query.series.findFirst({
				where: eq(series.id, seriesId)
			});

			if (!seriesData) {
				result.errors.push(`Series not found: ${seriesId}`);
				return result;
			}

			if (!seriesData.rootFolderId) {
				result.errors.push(`Series has no root folder: ${seriesId}`);
				return result;
			}

			const rootFolder = await db.query.rootFolders.findFirst({
				where: eq(rootFolders.id, seriesData.rootFolderId)
			});

			if (!rootFolder) {
				result.errors.push(`Root folder not found`);
				return result;
			}

			// Get all episode files to match subtitles
			const epFiles = await db
				.select()
				.from(episodeFiles)
				.where(eq(episodeFiles.seriesId, seriesId));

			const seriesPath = join(rootFolder.path, seriesData.path);
			// File-row-driven discovery (Sonarr parity): a series with no files
			// has nothing to discover and its folder is not guaranteed to exist.
			// Stored rows are still reconciled below so subtitle rows outliving
			// their media file are cleaned up.
			const discovered =
				epFiles.length > 0
					? await this.discoverSubtitles(
							seriesPath,
							seriesPath,
							await this.resolveAssumedLanguage()
						)
					: [];
			result.discovered = discovered.length;

			const filesByDir = this.indexEpisodeFilesByDir(epFiles);

			const desired: DesiredSubtitle[] = [];
			for (const sub of discovered) {
				const association = this.associateSeriesSidecar(sub, filesByDir);
				if ('skipped' in association) {
					result.skipped++;
					result.ambiguous.push(`${sub.relativePath}: ${association.skipped}`);
					continue;
				}

				const episodeIds = uniqueStrings(association.episodeIds);
				if (episodeIds.length === 0) {
					result.skipped++;
					result.ambiguous.push(`${sub.relativePath}: episode file has no episode id`);
					continue;
				}

				const episodeDir = relativeDir(association.episodeFile.relativePath);
				const baseDirAbs = episodeDir ? join(seriesPath, episodeDir) : seriesPath;
				const storedRelativePath = toStoredRelativePath(sub.path, baseDirAbs);

				// A multi-episode file's sidecar satisfies every episode it holds:
				// one subtitle row per episode, so each can be marked satisfied.
				for (const episodeId of episodeIds) {
					desired.push({
						ownerId: episodeId,
						relativePath: storedRelativePath,
						absPath: sub.path,
						language: sub.language,
						isForced: sub.isForced,
						isHearingImpaired: sub.isHearingImpaired,
						format: sub.format,
						size: sub.size,
						movieFileId: null
					});
				}
			}

			// Owner-keyed stored rows: every episode of the series regardless of
			// current files (mirrors the movie side), so a subtitle row whose
			// episode lost its media file is visible to the deletion pass
			// instead of being frozen as an orphan.
			const seriesEpisodeIds = await db
				.select({ id: episodes.id })
				.from(episodes)
				.where(eq(episodes.seriesId, seriesId));
			const storedRows =
				seriesEpisodeIds.length > 0
					? await db.query.subtitles.findMany({
							where: inArray(
								subtitles.episodeId,
								seriesEpisodeIds.map((episode) => episode.id)
							)
						})
					: [];
			const storedAbsPaths = await resolveStoredSubtitlePaths(storedRows);

			this.reconcileItem(result, 'episode', desired, storedRows, storedAbsPaths);
		} catch (error) {
			result.errors.push(error instanceof Error ? error.message : 'Unknown error');
		}

		return result;
	}

	/**
	 * Index episode files by their (series-relative) directory.
	 */
	private indexEpisodeFilesByDir(epFiles: EpisodeFileRow[]): Map<string, EpisodeFileRow[]> {
		const byDir = new Map<string, EpisodeFileRow[]>();
		for (const file of epFiles) {
			const dir = relativeDir(file.relativePath);
			const list = byDir.get(dir);
			if (list) list.push(file);
			else byDir.set(dir, [file]);
		}
		return byDir;
	}

	/**
	 * Associate a discovered sidecar with an episode using, in order:
	 *   (a) exact video-stem match against an episode file basename in the same directory;
	 *   (b) parsed SxxExx / absolute episode number matching an episode file in the same directory;
	 *   (c) directory proximity, but ONLY when the directory holds exactly one episode file.
	 * Anything else is skipped with a reason. Never defaults to `episodeIds[0]`
	 * across a shared season directory.
	 */
	private associateSeriesSidecar(
		sub: DiscoveredSubtitle,
		filesByDir: Map<string, EpisodeFileRow[]>
	): { episodeIds: string[]; episodeFile: EpisodeFileRow } | { skipped: string } {
		const sidecarDir = relativeDir(sub.relativePath);
		const candidates = filesByDir.get(sidecarDir) ?? [];
		const context = sidecarDir === '' ? 'series root' : `"${sidecarDir}"`;

		if (candidates.length === 0) {
			return { skipped: `no episode file in ${context}` };
		}

		// (a) Exact (stripped) video-stem match.
		const strippedStem = (sub.videoFileName ?? '').toLowerCase();
		if (strippedStem) {
			const matches = candidates.filter(
				(file) => stemOf(file.relativePath).toLowerCase() === strippedStem
			);
			if (matches.length > 0) {
				const picked = this.pickEpisodeFromMatches(matches);
				if (picked) return picked;
				return {
					skipped: `stem "${sub.videoFileName}" matches multiple episode files in ${context}`
				};
			}
		}

		// (b) Explicit SxxExx / absolute episode marker.
		const marker = parseEpisodeMarker(sub.videoFileName || stemOf(sub.relativePath));
		if (marker) {
			const matches = candidates.filter(
				(file) => parseEpisodeMarker(stemOf(file.relativePath)) === marker
			);
			if (matches.length > 0) {
				const picked = this.pickEpisodeFromMatches(matches);
				if (picked) return picked;
				return {
					skipped: `episode marker ${marker} matches multiple episode files in ${context}`
				};
			}
		}

		// (c) Proximity: safe only when the directory has exactly one episode file.
		if (candidates.length === 1) {
			const ids = uniqueStrings(candidates[0].episodeIds ?? []);
			if (ids.length >= 1) {
				return { episodeIds: ids, episodeFile: candidates[0] };
			}
			return { skipped: `episode file has no episode id in ${context}` };
		}

		return {
			skipped: `${context} has ${candidates.length} episode files and no exact/marker match`
		};
	}

	/**
	 * Turn the files matched by association step (a)/(b) into the episodes they
	 * hold. A single matched file yields ALL its episode ids (a combined
	 * multi-episode file satisfies each of them). Multiple matched files only
	 * resolve when they all reference the same episode; otherwise it is ambiguous.
	 */
	private pickEpisodeFromMatches(
		matches: EpisodeFileRow[]
	): { episodeIds: string[]; episodeFile: EpisodeFileRow } | null {
		const files = [...new Map(matches.map((file) => [file.id, file])).values()];
		if (files.length === 1) {
			const ids = uniqueStrings(files[0].episodeIds ?? []);
			return ids.length >= 1 ? { episodeIds: ids, episodeFile: files[0] } : null;
		}

		const episodeIds = uniqueStrings(files.flatMap((file) => file.episodeIds ?? []));
		return episodeIds.length === 1 ? { episodeIds: episodeIds, episodeFile: files[0] } : null;
	}

	/**
	 * Reconcile discovered sidecars against stored rows for one media item.
	 * Runs in a single transaction: insert new, update changed metadata, delete
	 * rows whose file no longer exists (with a `deleted` history row).
	 */
	private reconcileItem(
		result: SubtitleScanResult,
		ownerType: 'movie' | 'episode',
		desired: DesiredSubtitle[],
		storedRows: StoredSubtitleRow[],
		storedAbsPaths: Map<string, string | null>
	): void {
		const ownerIdOf = (row: StoredSubtitleRow): string =>
			(ownerType === 'movie' ? row.movieId : row.episodeId) ?? '';
		const keyOf = (ownerId: string, relativePath: string): string => `${ownerId}::${relativePath}`;

		const desiredByKey = new Map<string, DesiredSubtitle>();
		const desiredByAbs = new Map<string, DesiredSubtitle>();
		for (const item of desired) {
			const key = keyOf(item.ownerId, item.relativePath);
			if (!desiredByKey.has(key)) desiredByKey.set(key, item);
			desiredByAbs.set(item.absPath, item);
		}

		const storedByKey = new Map<string, StoredSubtitleRow>();
		for (const row of storedRows) {
			storedByKey.set(keyOf(ownerIdOf(row), row.relativePath), row);
		}

		let added = 0;
		let updated = 0;
		let removed = 0;
		let unchanged = 0;

		db.transaction((tx) => {
			for (const item of desiredByKey.values()) {
				const existing = storedByKey.get(keyOf(item.ownerId, item.relativePath));

				if (!existing) {
					tx.insert(subtitles)
						.values({
							id: randomUUID(),
							movieId: ownerType === 'movie' ? item.ownerId : null,
							episodeId: ownerType === 'episode' ? item.ownerId : null,
							movieFileId: item.movieFileId,
							relativePath: item.relativePath,
							language: item.language,
							isForced: item.isForced,
							isHearingImpaired: item.isHearingImpaired,
							format: item.format,
							size: item.size,
							dateAdded: new Date().toISOString()
						})
						.run();

					tx.insert(subtitleHistory)
						.values({
							id: randomUUID(),
							movieId: ownerType === 'movie' ? item.ownerId : null,
							episodeId: ownerType === 'episode' ? item.ownerId : null,
							action: 'discovered',
							language: item.language,
							createdAt: new Date().toISOString()
						})
						.run();

					added++;
					continue;
				}

				if (this.metadataChanged(existing, item)) {
					tx.update(subtitles)
						.set({
							language: item.language,
							isForced: item.isForced,
							isHearingImpaired: item.isHearingImpaired,
							movieFileId: item.movieFileId,
							format: item.format,
							size: item.size
						})
						.where(eq(subtitles.id, existing.id))
						.run();
					updated++;
				} else {
					unchanged++;
				}
			}

			// Deletion pass: a stored row not represented by a desired entry is
			// removed if its file is gone, or if the same file now belongs to a
			// different owner/episode (stale association from the old scanner).
			// An unresolvable path means the owning episode/movie has no media
			// file row anymore — the subtitle cannot exist on disk, so it is
			// gone too. Rows whose file still exists without a desired entry
			// (e.g. an ambiguous sidecar) are kept.
			for (const row of storedRows) {
				if (desiredByKey.has(keyOf(ownerIdOf(row), row.relativePath))) continue;

				const absPath = storedAbsPaths.get(row.id) ?? null;
				const staleOwner = absPath !== null && desiredByAbs.has(absPath);
				const fileGone = absPath === null || !existsSync(absPath);

				if (staleOwner || fileGone) {
					tx.delete(subtitles).where(eq(subtitles.id, row.id)).run();
					tx.insert(subtitleHistory)
						.values({
							id: randomUUID(),
							movieId: row.movieId,
							episodeId: row.episodeId,
							action: 'deleted',
							language: row.language,
							errorMessage: staleOwner
								? 'reassociated during subtitle scan reconciliation'
								: absPath === null
									? 'owning media file removed during subtitle scan reconciliation'
									: 'file missing during subtitle scan reconciliation',
							createdAt: new Date().toISOString()
						})
						.run();
					removed++;
				} else {
					unchanged++;
				}
			}
		});

		result.added += added;
		result.registered = result.added;
		result.updated += updated;
		result.removed += removed;
		result.unchanged += unchanged;
	}

	/** Compare stored metadata against a desired sidecar. */
	private metadataChanged(existing: StoredSubtitleRow, desired: DesiredSubtitle): boolean {
		return (
			existing.language !== desired.language ||
			(existing.isForced ?? false) !== desired.isForced ||
			(existing.isHearingImpaired ?? false) !== desired.isHearingImpaired ||
			(existing.movieFileId ?? null) !== desired.movieFileId ||
			existing.format !== desired.format ||
			(existing.size ?? null) !== desired.size
		);
	}

	/**
	 * Scan all movies and series for subtitles
	 */
	async scanAll(): Promise<{ movies: SubtitleScanResult; series: SubtitleScanResult }> {
		const movieResults = emptyResult();
		const seriesResults = emptyResult();

		// Scan all movies
		const allMovies = await db.select({ id: movies.id }).from(movies);
		for (const movie of allMovies) {
			const result = await this.scanMovieSubtitles(movie.id);
			this.mergeResult(movieResults, result);
		}

		// Scan all series
		const allSeries = await db.select({ id: series.id }).from(series);
		for (const show of allSeries) {
			const result = await this.scanSeriesSubtitles(show.id);
			this.mergeResult(seriesResults, result);
		}

		return { movies: movieResults, series: seriesResults };
	}

	private mergeResult(target: SubtitleScanResult, source: SubtitleScanResult): void {
		target.discovered += source.discovered;
		target.added += source.added;
		target.registered += source.registered;
		target.updated += source.updated;
		target.removed += source.removed;
		target.unchanged += source.unchanged;
		target.skipped += source.skipped;
		target.ambiguous.push(...source.ambiguous);
		target.errors.push(...source.errors);
	}
}

export function getSubtitleScannerService(): SubtitleScannerService {
	return SubtitleScannerService.getInstance();
}

export { SubtitleScannerService };

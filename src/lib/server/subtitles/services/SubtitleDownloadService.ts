/**
 * Subtitle Download Service
 *
 * Handles downloading subtitles from providers, saving to disk, and
 * registering them in the database.
 *
 * Integrity guarantees:
 * - Content is sniffed for its real format (never dictated by the provider's
 *   claimed filename/format), including ZIP archives.
 * - The file is written to a temp path in the target directory and renamed
 *   into place, so a partial write never replaces a good subtitle.
 * - The old row/file, the new row and the history entry move together in one
 *   DB transaction; on failure the previous file state is restored.
 */

import { db } from '#lib/server/db/index.js';
import {
	subtitles,
	subtitleHistory,
	subtitleBlacklist,
	movies,
	episodes,
	series,
	movieFiles,
	episodeFiles,
	rootFolders
} from '#lib/server/db/schema.js';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink, rename } from 'node:fs/promises';
import { applyMediaFileMode, ensureMediaDirectory } from '#lib/server/filesystem/mkdir-helpers.js';
import { existsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { createChildLogger } from '#lib/logging/index.js';
import { getSubtitleSyncService } from './SubtitleSyncService';
import { getMediaBrowserNotifier } from '#lib/server/notifications/mediabrowser/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });

/**
 * Hostile/misbehaving providers must not be able to exhaust memory: subtitles
 * are tiny, so anything beyond these caps is rejected before extraction.
 */
const MAX_SUBTITLE_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB (multi-sub archives)
const MAX_SUBTITLE_ARCHIVE_ENTRIES = 200;
const MAX_SUBTITLE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB
import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';
import type {
	SubtitleSearchResult,
	SubtitleDownloadResult,
	SubtitleFormat,
	BlacklistReason
} from '../types';
import { getSubtitleProviderManager } from './SubtitleProviderManager';
import { isThrottleableError } from '../errors/ProviderErrors';
import { resolveDestructivePathWithinBase, resolveStoredSubtitlePath } from '../subtitle-paths';
import {
	detectSubtitleFormatFromContent,
	isZipContent,
	selectSubtitleZipEntry
} from '../subtitle-content';
import AdmZip from 'adm-zip';

/**
 * Service for downloading and managing subtitle files
 */
export class SubtitleDownloadService {
	private static instance: SubtitleDownloadService | null = null;

	private constructor() {}

	static getInstance(): SubtitleDownloadService {
		if (!SubtitleDownloadService.instance) {
			SubtitleDownloadService.instance = new SubtitleDownloadService();
		}
		return SubtitleDownloadService.instance;
	}

	/**
	 * Download a subtitle for a movie
	 */
	async downloadForMovie(
		movieId: string,
		result: SubtitleSearchResult,
		options?: { movieFileId?: string }
	): Promise<SubtitleDownloadResult> {
		// Get movie and file info
		const movie = await db.select().from(movies).where(eq(movies.id, movieId)).limit(1);
		if (!movie[0]) {
			throw new Error(`Movie not found: ${movieId}`);
		}

		// Resolve the target movie file. Explicit option wins, then the
		// movieFileId tagged on the search result (per-file search), then the
		// first file as a final fallback.
		const targetMovieFileId = options?.movieFileId ?? result.movieFileId;
		let file;
		if (targetMovieFileId) {
			const specificFile = await db
				.select()
				.from(movieFiles)
				.where(and(eq(movieFiles.id, targetMovieFileId), eq(movieFiles.movieId, movieId)))
				.limit(1);
			file = specificFile[0];
		} else {
			const files = await db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId));
			file = files[0];
		}
		if (!file) {
			throw new Error(
				targetMovieFileId
					? `No file found for movie ${movieId} with movieFileId ${targetMovieFileId}`
					: `No file found for movie: ${movieId}`
			);
		}

		// Get root folder
		const rootFolder = movie[0].rootFolderId
			? await db
					.select()
					.from(rootFolders)
					.where(eq(rootFolders.id, movie[0].rootFolderId))
					.limit(1)
			: null;

		// Check if root folder is read-only
		if (rootFolder?.[0]?.readOnly) {
			throw new Error('Cannot download subtitles to read-only folder');
		}

		const rootPath = rootFolder?.[0]?.path || '';
		const mediaPath = join(rootPath, movie[0].path);

		// Download and save
		return this.downloadAndSave(result, {
			movieId,
			movieFileId: targetMovieFileId ?? null,
			mediaPath,
			videoFileName: basename(file.relativePath),
			format: result.format,
			disableAutoSync: movie[0].scoringProfileId === 'streamer'
		});
	}

	/**
	 * Download a subtitle for an episode
	 */
	async downloadForEpisode(
		episodeId: string,
		result: SubtitleSearchResult
	): Promise<SubtitleDownloadResult> {
		// Get episode, series, and file info
		const episode = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
		if (!episode[0]) {
			throw new Error(`Episode not found: ${episodeId}`);
		}

		const seriesData = await db
			.select()
			.from(series)
			.where(eq(series.id, episode[0].seriesId))
			.limit(1);
		if (!seriesData[0]) {
			throw new Error(`Series not found for episode: ${episodeId}`);
		}

		const files = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, episode[0].seriesId));
		const file = files.find((f) => {
			const ids = f.episodeIds as string[] | null;
			return ids?.includes(episodeId);
		});
		if (!file) {
			throw new Error(`No file found for episode: ${episodeId}`);
		}

		// Get root folder
		const rootFolder = seriesData[0].rootFolderId
			? await db
					.select()
					.from(rootFolders)
					.where(eq(rootFolders.id, seriesData[0].rootFolderId))
					.limit(1)
			: null;

		// Check if root folder is read-only
		if (rootFolder?.[0]?.readOnly) {
			throw new Error('Cannot download subtitles to read-only folder');
		}

		const rootPath = rootFolder?.[0]?.path || '';
		const mediaPath = join(rootPath, seriesData[0].path, dirname(file.relativePath));

		// Download and save
		return this.downloadAndSave(result, {
			episodeId,
			mediaPath,
			videoFileName: basename(file.relativePath),
			format: result.format,
			disableAutoSync: seriesData[0].scoringProfileId === 'streamer'
		});
	}

	/**
	 * Delete a subtitle
	 */
	async delete(
		subtitleId: string,
		addToBlacklist: boolean = false,
		reason?: BlacklistReason
	): Promise<void> {
		// Get subtitle record
		const subtitle = await db.select().from(subtitles).where(eq(subtitles.id, subtitleId)).limit(1);
		if (!subtitle[0]) {
			throw new Error(`Subtitle not found: ${subtitleId}`);
		}

		// Get full path before deleting the row.
		const fullPath = await resolveStoredSubtitlePath(subtitle[0]);

		// Row delete + history + blacklist move together so a failed history
		// insert cannot leave the subtitle row gone without an audit entry.
		db.transaction((tx) => {
			if (addToBlacklist && subtitle[0].providerId && subtitle[0].providerSubtitleId) {
				tx.insert(subtitleBlacklist)
					.values({
						movieId: subtitle[0].movieId,
						episodeId: subtitle[0].episodeId,
						providerId: subtitle[0].providerId,
						providerSubtitleId: subtitle[0].providerSubtitleId,
						language: subtitle[0].language,
						reason
					})
					.run();
			}

			tx.insert(subtitleHistory)
				.values({
					movieId: subtitle[0].movieId,
					episodeId: subtitle[0].episodeId,
					action: 'deleted',
					language: subtitle[0].language,
					providerId: subtitle[0].providerId,
					providerName: undefined,
					providerSubtitleId: subtitle[0].providerSubtitleId
				})
				.run();

			tx.delete(subtitles).where(eq(subtitles.id, subtitleId)).run();
		});

		const safeFullPath = fullPath
			? await resolveDestructivePathWithinBase(dirname(fullPath), basename(fullPath))
			: null;
		if (safeFullPath && existsSync(safeFullPath)) {
			try {
				await unlink(safeFullPath);
				logger.debug({ path: safeFullPath }, 'Deleted subtitle file');
			} catch (error) {
				logger.warn(
					{ path: fullPath, error: error instanceof Error ? error.message : String(error) },
					'Failed to delete subtitle file after row removal'
				);
			}
		}

		if (fullPath) {
			getMediaBrowserNotifier().queueUpdate(fullPath, 'Deleted', 'delete');
		}

		logger.info(
			{
				subtitleId,
				blacklisted: addToBlacklist
			},
			'Subtitle deleted'
		);
	}

	/**
	 * Remove from blacklist
	 */
	async removeFromBlacklist(blacklistId: string): Promise<void> {
		await db.delete(subtitleBlacklist).where(eq(subtitleBlacklist.id, blacklistId));
	}

	/**
	 * Download and save a subtitle file
	 */
	private async downloadAndSave(
		result: SubtitleSearchResult,
		options: {
			movieId?: string;
			episodeId?: string;
			movieFileId?: string | null;
			mediaPath: string;
			videoFileName: string;
			format: SubtitleFormat;
			disableAutoSync?: boolean;
		}
	): Promise<SubtitleDownloadResult> {
		const providerManager = getSubtitleProviderManager();

		// Get provider instance
		const provider = await providerManager.getProviderInstance(result.providerId);
		if (!provider) {
			throw new Error(`Provider not available: ${result.providerId}`);
		}

		// Download subtitle content (rate-limited via the provider's shared limiter)
		let content: Buffer;
		try {
			await providerManager.acquireRateLimit(result.providerId);
			content = await provider.download(result);
		} catch (error) {
			logger.error(
				{
					provider: result.providerName,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to download subtitle'
			);

			// Record the error for throttling (like Bazarr's throttle_callback)
			// This ensures download-phase errors (e.g. DownloadLimitExceeded, TooManyRequests)
			// trigger provider throttling, not just search-phase errors
			if (isThrottleableError(error) || error instanceof Error) {
				await providerManager.recordError(result.providerId, error as Error).catch((e) => {
					logger.warn(
						{ error: e instanceof Error ? e.message : String(e) },
						'Failed to record download error for throttling'
					);
				});
			}

			throw error;
		}

		// Size cap before any parsing/extraction.
		if (content.length > MAX_SUBTITLE_DOWNLOAD_BYTES) {
			throw new Error(
				`Downloaded subtitle payload from ${result.providerName} is too large (${Math.round(
					content.length / (1024 * 1024)
				)} MB)`
			);
		}

		// Handle zip files: choose the entry that matches the requirement.
		if (isZipContent(content)) {
			content = this.extractSubtitleFromZip(content, result, options);
		}

		// The provider's claimed format is advisory only; sniff the real one.
		const detectedFormat = detectSubtitleFormatFromContent(content);
		if (detectedFormat === 'unknown') {
			throw new Error(
				`Downloaded content from ${result.providerName} is not a recognized subtitle format`
			);
		}

		// Canonicalize through the server boundary: unknown provider language
		// values become `und`, never an invented or raw non-canonical tag.
		const normalizedLanguage = normalizeLanguageTag(result.language);

		// Generate filename using the detected extension (never a hardcoded srt).
		const subtitleFileName = this.generateFileName(
			options.videoFileName,
			normalizedLanguage,
			result.isForced,
			result.isHearingImpaired,
			detectedFormat
		);

		// Ensure directory exists
		await ensureMediaDirectory(options.mediaPath);

		const finalPath = await resolveDestructivePathWithinBase(options.mediaPath, subtitleFileName);
		if (!finalPath) {
			throw new Error('Refusing destructive subtitle operation on a symlink or outside path');
		}
		const tempPath = join(dirname(finalPath), `.${subtitleFileName}.${randomUUID()}.tmp`);

		// Check for existing subtitle to upgrade/replace.
		const existingSubtitle = await this.findExistingSubtitle(
			options.movieId,
			options.episodeId,
			normalizedLanguage,
			result.isForced,
			result.isHearingImpaired,
			options.movieFileId
		);

		const oldPathCandidate = existingSubtitle
			? await resolveStoredSubtitlePath(existingSubtitle)
			: null;
		const oldPath = oldPathCandidate
			? await resolveDestructivePathWithinBase(options.mediaPath, oldPathCandidate)
			: null;
		const oldFileExists = oldPath ? existsSync(oldPath) : false;

		// An untracked sidecar already occupying the deterministic final path is
		// the only copy we know of — preserve it via backup instead of blindly
		// overwriting (and never unlink it on a DB failure).
		const untrackedFileAtFinalPath = !existingSubtitle && existsSync(finalPath);

		// Preserve the old file when the new sidecar would overwrite the same path,
		// so a DB failure can restore it.
		let backupPath: string | null = null;
		try {
			if (oldFileExists && oldPath === finalPath) {
				const candidateBackup = `${finalPath}.${randomUUID()}.bak`;
				const safeOldPath = await resolveDestructivePathWithinBase(
					dirname(oldPath),
					basename(oldPath)
				);
				const safeBackupPath = await resolveDestructivePathWithinBase(
					dirname(candidateBackup),
					basename(candidateBackup)
				);
				if (!safeOldPath || !safeBackupPath) {
					throw new Error('Refusing to move a symlinked subtitle file');
				}
				// Only record the backup once the rename actually succeeded, so a
				// failed backup never causes the original file to be removed.
				await rename(safeOldPath, safeBackupPath);
				backupPath = safeBackupPath;
			} else if (untrackedFileAtFinalPath) {
				const candidateBackup = `${finalPath}.${randomUUID()}.bak`;
				await rename(finalPath, candidateBackup);
				backupPath = candidateBackup;
			}

			// Atomic placement: write the payload to a temp file in the target
			// directory first, then rename it into its final name.
			try {
				await writeFile(tempPath, content);
				await rename(tempPath, finalPath);
				await applyMediaFileMode(finalPath);
			} catch (writeError) {
				await this.safeUnlink(tempPath);
				throw writeError;
			}
		} catch (fileError) {
			// Restore the previous file state where possible.
			if (backupPath) {
				await this.safeUnlink(finalPath);
				await this.safeRename(backupPath, finalPath);
			}
			throw new Error(
				`Failed to write subtitle file "${subtitleFileName}": ${
					fileError instanceof Error ? fileError.message : String(fileError)
				}`,
				{ cause: fileError }
			);
		}

		const subtitleId = randomUUID();
		const wasUpgrade = Boolean(existingSubtitle);
		const replacedSubtitleId = existingSubtitle?.id;

		// Row swap + history are one transaction. The file is already in place;
		// if the transaction fails we roll the file back to its previous state.
		try {
			db.transaction((tx) => {
				// Re-check the unique identity inside the transaction. A concurrent
				// trigger (import hook + scheduled task, double-click "Search now")
				// may have committed the same identity between the pre-check above
				// and this write; replace its row instead of failing the insert.
				const identityRows = tx
					.select({ id: subtitles.id })
					.from(subtitles)
					.where(
						and(
							options.movieId ? eq(subtitles.movieId, options.movieId) : isNull(subtitles.movieId),
							options.episodeId
								? eq(subtitles.episodeId, options.episodeId)
								: isNull(subtitles.episodeId),
							eq(subtitles.language, normalizedLanguage),
							eq(subtitles.isForced, result.isForced),
							eq(subtitles.isHearingImpaired, result.isHearingImpaired),
							eq(subtitles.relativePath, subtitleFileName)
						)
					)
					.all();

				if (existingSubtitle) {
					tx.delete(subtitles).where(eq(subtitles.id, existingSubtitle.id)).run();
				}
				for (const duplicate of identityRows) {
					if (duplicate.id !== existingSubtitle?.id) {
						tx.delete(subtitles).where(eq(subtitles.id, duplicate.id)).run();
					}
				}

				tx.insert(subtitles)
					.values({
						id: subtitleId,
						movieId: options.movieId,
						episodeId: options.episodeId,
						movieFileId: options.movieFileId ?? null,
						relativePath: subtitleFileName,
						language: normalizedLanguage,
						isForced: result.isForced,
						isHearingImpaired: result.isHearingImpaired,
						format: detectedFormat,
						providerId: result.providerId,
						providerSubtitleId: result.providerSubtitleId,
						matchScore: result.matchScore,
						isHashMatch: result.isHashMatch,
						size: content.length
					})
					.run();

				tx.insert(subtitleHistory)
					.values({
						movieId: options.movieId,
						episodeId: options.episodeId,
						action: wasUpgrade ? 'upgraded' : 'downloaded',
						language: normalizedLanguage,
						providerId: result.providerId,
						providerName: result.providerName,
						providerSubtitleId: result.providerSubtitleId,
						matchScore: result.matchScore,
						wasHashMatch: result.isHashMatch,
						replacedSubtitleId
					})
					.run();
			});
		} catch (dbError) {
			// Never blind-unlink a path another writer may own. Restore our backup
			// when we took one; otherwise only remove the file if no committed row
			// references this exact owner+path.
			if (backupPath) {
				await this.safeUnlink(finalPath);
				await this.safeRename(backupPath, finalPath);
			} else if (
				!(await this.hasCommittedRowForPath(options.movieId, options.episodeId, subtitleFileName))
			) {
				await this.safeUnlink(finalPath);
			}
			throw dbError;
		}

		// Commit succeeded: drop the backup and unlink a superseded old file.
		if (backupPath) {
			await this.safeUnlink(backupPath);
		}
		if (oldFileExists && oldPath && oldPath !== finalPath) {
			try {
				const safeOldPath = await resolveDestructivePathWithinBase(
					dirname(oldPath),
					basename(oldPath)
				);
				if (safeOldPath) await unlink(safeOldPath);
			} catch (error) {
				logger.warn(
					{ path: oldPath, error: error instanceof Error ? error.message : String(error) },
					'Failed to remove replaced subtitle file'
				);
			}
		}

		logger.debug(
			{
				path: finalPath,
				size: content.length,
				format: detectedFormat
			},
			'Saved subtitle file'
		);

		logger.info(
			{
				subtitleId,
				provider: result.providerName,
				language: normalizedLanguage,
				format: detectedFormat,
				wasUpgrade
			},
			'Subtitle downloaded'
		);

		// Media servers need to drop the stale sidecar and pick up the new one.
		const notifier = getMediaBrowserNotifier();
		if (wasUpgrade) {
			if (oldPath && oldPath !== finalPath) {
				notifier.queueUpdate(oldPath, 'Deleted', 'upgrade');
			}
			notifier.queueUpdate(finalPath, 'Modified', 'upgrade');
		} else {
			notifier.queueUpdate(finalPath, 'Created', 'import');
		}

		const syncResult = await this.autoSyncSubtitle(
			subtitleId,
			result.isForced,
			options.disableAutoSync ?? false
		);

		return {
			subtitleId,
			path: finalPath,
			language: normalizedLanguage,
			format: detectedFormat,
			wasSynced: syncResult.success,
			syncOffset: syncResult.success ? syncResult.offsetMs : null,
			wasUpgrade,
			replacedSubtitleId
		};
	}

	private async autoSyncSubtitle(
		subtitleId: string,
		isForced: boolean,
		disableAutoSync: boolean
	): Promise<{ success: boolean; offsetMs: number | null }> {
		if (disableAutoSync) {
			logger.debug({ subtitleId }, 'Skipping automatic subtitle sync for Streamer profile media');
			return { success: false, offsetMs: null };
		}

		if (isForced) {
			logger.debug({ subtitleId }, 'Skipping automatic subtitle sync for forced subtitle');
			return { success: false, offsetMs: null };
		}

		const syncResult = await getSubtitleSyncService().syncSubtitle(subtitleId);

		if (syncResult.success) {
			logger.debug(
				{ subtitleId, offsetMs: syncResult.offsetMs },
				'Automatically synced subtitle after download'
			);
			return { success: true, offsetMs: syncResult.offsetMs };
		}

		logger.warn(
			{ subtitleId, error: syncResult.error },
			'Automatic subtitle sync failed after download'
		);

		return { success: false, offsetMs: null };
	}

	/**
	 * Generate subtitle filename following naming convention
	 * Format: {VideoName}.{lang}.{flags}.{ext}
	 *
	 * `format` must be a content-detected concrete format.
	 */
	private generateFileName(
		videoFileName: string,
		language: string,
		isForced: boolean,
		isHi: boolean,
		format: Exclude<SubtitleFormat, 'unknown'>
	): string {
		const videoBaseName = basename(videoFileName, extname(videoFileName));
		// Detected format is authoritative; callers reject 'unknown' before this.
		const ext = format;

		let flags = '';
		if (isForced) flags += '.forced';
		if (isHi) flags += '.hi';

		return `${videoBaseName}.${language}${flags}.${ext}`;
	}

	/**
	 * Extract the matching subtitle entry from a ZIP archive.
	 *
	 * Selection order (see `selectSubtitleZipEntry`): exact language tag, then
	 * episode/release name, then forced/HI tags, ties broken deterministically by
	 * entry name. Ambiguous archives are logged with the candidates considered.
	 */
	private extractSubtitleFromZip(
		zipContent: Buffer,
		result: SubtitleSearchResult,
		options: { videoFileName: string }
	): Buffer {
		let zip: AdmZip;
		try {
			zip = new AdmZip(zipContent);
		} catch (error) {
			throw new Error(
				`Failed to read subtitle zip archive: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error }
			);
		}

		const entries = zip.getEntries();
		if (entries.length > MAX_SUBTITLE_ARCHIVE_ENTRIES) {
			throw new Error(
				`Subtitle zip archive has too many entries (${entries.length} > ${MAX_SUBTITLE_ARCHIVE_ENTRIES})`
			);
		}
		const totalUncompressed = entries.reduce((sum, entry) => sum + (entry.header?.size ?? 0), 0);
		if (totalUncompressed > MAX_SUBTITLE_UNCOMPRESSED_BYTES) {
			throw new Error(
				`Subtitle zip archive expands to ${Math.round(
					totalUncompressed / (1024 * 1024)
				)} MB, above the ${Math.round(MAX_SUBTITLE_UNCOMPRESSED_BYTES / (1024 * 1024))} MB cap`
			);
		}

		const selection = selectSubtitleZipEntry(entries, {
			language: result.language,
			isForced: result.isForced,
			isHearingImpaired: result.isHearingImpaired,
			videoFileName: options.videoFileName,
			releaseName: result.releaseName,
			fileName: result.fileName
		});

		if (selection.ambiguous) {
			logger.warn(
				{
					provider: result.providerName,
					language: result.language,
					videoFileName: options.videoFileName,
					chosen: selection.entry.entryName,
					candidates: selection.candidates
				},
				'Ambiguous subtitle zip archive; selected an entry deterministically'
			);
		} else {
			logger.debug(
				{ chosen: selection.entry.entryName, candidateCount: selection.candidates.length },
				'Selected subtitle entry from zip archive'
			);
		}

		return selection.entry.getData();
	}

	/** Best-effort unlink that never throws. */
	private async safeUnlink(path: string): Promise<void> {
		try {
			const safePath = await resolveDestructivePathWithinBase(dirname(path), basename(path));
			if (safePath) await unlink(safePath);
		} catch {
			// Already gone or never created.
		}
	}

	/** Whether a committed subtitle row references this owner + stored path. */
	private async hasCommittedRowForPath(
		movieId: string | undefined,
		episodeId: string | undefined,
		relativePath: string
	): Promise<boolean> {
		const conditions = [eq(subtitles.relativePath, relativePath)];
		if (movieId) conditions.push(eq(subtitles.movieId, movieId));
		if (episodeId) conditions.push(eq(subtitles.episodeId, episodeId));

		const rows = await db
			.select({ id: subtitles.id })
			.from(subtitles)
			.where(and(...conditions))
			.limit(1);
		return rows.length > 0;
	}

	/** Best-effort rename used for rollback; never throws. */
	private async safeRename(from: string, to: string): Promise<void> {
		try {
			const safeFrom = await resolveDestructivePathWithinBase(dirname(from), basename(from));
			const safeTo = await resolveDestructivePathWithinBase(dirname(to), basename(to));
			if (!safeFrom || !safeTo) throw new Error('Refusing to rename a symlinked subtitle file');
			await rename(safeFrom, safeTo);
		} catch (error) {
			logger.error(
				{ from, to, error: error instanceof Error ? error.message : String(error) },
				'Failed to restore subtitle file during rollback'
			);
		}
	}

	/**
	 * Find existing subtitle with same language/flags.
	 *
	 * When movieFileId is provided, the search is scoped to subtitles linked to
	 * that specific movie file so that subtitles for different quality tiers
	 * (e.g. 2160p vs 1080p) do not clobber each other.
	 *
	 * When the movie has more than one file and the request carried no
	 * movieFileId, matching is deliberately skipped: an unscoped replace could
	 * clobber the wrong quality tier, so a new row is inserted instead.
	 */
	private async findExistingSubtitle(
		movieId: string | undefined,
		episodeId: string | undefined,
		language: string,
		isForced: boolean,
		isHi: boolean,
		movieFileId?: string | null
	): Promise<typeof subtitles.$inferSelect | null> {
		if (movieId && !movieFileId) {
			const movieFilesForMovie = await db
				.select({ id: movieFiles.id })
				.from(movieFiles)
				.where(eq(movieFiles.movieId, movieId));
			if (movieFilesForMovie.length > 1) {
				logger.debug(
					{ movieId },
					'Movie has multiple files and no movieFileId was supplied; not replacing an existing subtitle'
				);
				return null;
			}
		}

		const normalizedLanguage = normalizeLanguageTag(language);
		const languageValues =
			normalizedLanguage === language ? [language] : [language, normalizedLanguage];

		const conditions = [
			inArray(subtitles.language, languageValues),
			eq(subtitles.isForced, isForced),
			eq(subtitles.isHearingImpaired, isHi)
		];

		if (movieId) {
			conditions.push(eq(subtitles.movieId, movieId));
		}
		if (episodeId) {
			conditions.push(eq(subtitles.episodeId, episodeId));
		}
		if (movieFileId) {
			conditions.push(eq(subtitles.movieFileId, movieFileId));
		}

		const existing = await db
			.select()
			.from(subtitles)
			.where(and(...conditions))
			.limit(1);

		return existing[0] || null;
	}
}

/**
 * Get the singleton SubtitleDownloadService
 */
export function getSubtitleDownloadService(): SubtitleDownloadService {
	return SubtitleDownloadService.getInstance();
}

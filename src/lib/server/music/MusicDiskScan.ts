/**
 * Library scan for music root folders.
 *
 * A video scan asks "which of these files is the movie/episode I already
 * track?" — the catalog comes first. Music is the other way round: an album
 * folder arrives with tags, gets identified against MusicBrainz, and the album
 * is created from that identity. That is why this is a separate walker and not
 * another branch inside `DiskScanService`: the unit is the album folder, the
 * source of truth is the tag block, and the outcome is a new row rather than a
 * match to an existing one.
 *
 * Adoption, not copying: the files are already under the library root, so the
 * scan records them where they are. `MusicImportService.adoptFolder` owns that
 * half; this module only decides which folder is which album.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, trackFiles, tracks } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { collectAudioFiles, groupAudioFiles, type AudioAlbumFolder } from './audio-folder.js';
import { pickReleaseGroup, type AlbumCandidate } from './release-match.js';
import { musicBrainz, pickPrimaryRelease } from './musicbrainz.js';
import { musicAlbumService } from './MusicAlbumService.js';
import { musicImportService } from './MusicImportService.js';
import { musicScanIssueService } from './MusicScanIssueService.js';

const logger = createChildLogger({ module: 'MusicDiskScan', logDomain: 'scans' });

/** How one folder fared. Kept for the log line and for tests. */
export interface MusicScanFolderResult {
	folder: string;
	album: string | null;
	artist: string | null;
	status: 'imported' | 'skipped' | 'unmatched' | 'failed';
	albumId?: string;
	reason?: string;
}

export interface MusicScanSummary {
	filesScanned: number;
	filesImported: number;
	/** Rows dropped because their file is gone (deletion reconciliation). */
	filesRemoved: number;
	/** Albums whose last file disappeared; they stay as metadata, marked missing. */
	albumsCleared: number;
	folders: number;
	imported: number;
	skipped: number;
	unmatched: number;
	failed: number;
	results: MusicScanFolderResult[];
}

export interface MusicScanProgress {
	/** Audio files found by the walk; known before the first folder is processed. */
	filesSeen: number;
	foldersSeen: number;
	currentFolder?: string;
}

export interface MusicScanOptions {
	rootFolderId: string;
	rootPath: string;
	libraryId: string;
	/** Checked between folders, so a cancel does not wait for a whole library. */
	isAborted?: () => boolean;
	onProgress?: (progress: MusicScanProgress) => void;
}

/** Files already recorded against an album in this root, by absolute path. */
function trackedPaths(rootFolderId: string): Set<string> {
	const rows = db
		.select({ albumPath: albums.path, relativePath: trackFiles.relativePath })
		.from(trackFiles)
		.innerJoin(albums, eq(trackFiles.albumId, albums.id))
		.where(eq(albums.rootFolderId, rootFolderId))
		.all();

	return new Set(
		rows.flatMap((row) => (row.albumPath ? [path.join(row.albumPath, row.relativePath)] : []))
	);
}

/** Add the album from MusicBrainz, then adopt the folder's files. */
async function adoptFolder(
	group: AudioAlbumFolder,
	options: MusicScanOptions
): Promise<{ albumId: string; filesImported: number }> {
	const candidate: AlbumCandidate = {
		album: group.album,
		artist: group.artist,
		year: group.year
	};

	const results = await musicBrainz.searchReleaseGroups({
		artist: group.artist ?? undefined,
		album: group.album ?? undefined,
		limit: 10
	});
	const releaseGroup = pickReleaseGroup(candidate, results);
	if (!releaseGroup) {
		throw new UnmatchedAlbumError('no confident MusicBrainz match');
	}

	const editions = await musicBrainz.getReleaseGroupReleases(releaseGroup.mbid);
	const primary = pickPrimaryRelease(editions);
	if (!primary) throw new UnmatchedAlbumError('release group has no editions');

	const release = await musicBrainz.getRelease(primary.mbid);
	const added = musicAlbumService.addAlbum({
		releaseGroup,
		release,
		libraryId: options.libraryId,
		rootFolderId: options.rootFolderId,
		monitored: true,
		qualityProfileId: null
	});

	const existing = db
		.select({ path: albums.path, hasFile: albums.hasFile })
		.from(albums)
		.where(eq(albums.id, added.albumId))
		.get();
	if (isDuplicateAdoption(added.created, existing, group.folder)) {
		throw new DuplicateAlbumError(`already in the library at ${existing?.path}`);
	}

	const imported = await musicImportService.adoptFolder(added.albumId, group.folder);
	return { albumId: added.albumId, filesImported: imported.filesImported };
}

class UnmatchedAlbumError extends Error {}

class DuplicateAlbumError extends Error {}

/**
 * A second folder for an album the library already holds is a duplicate, not
 * a re-adoption: adopting it would move `albums.path` and leave the first
 * copy's rows pointing at files the album no longer names.
 */
export function isDuplicateAdoption(
	created: boolean,
	existing: { path: string | null; hasFile: boolean | null } | undefined,
	folder: string
): boolean {
	if (created || !existing?.hasFile || !existing.path) return false;
	return path.resolve(existing.path) !== path.resolve(folder);
}

/**
 * Drop rows whose file no longer exists and re-derive the track and album
 * `has_file` flags from what is left.
 *
 * Only called once a walk has found audio: an unmounted root also looks like
 * "no files", and clearing a library because a mount went away is worse than
 * leaving a stale row until the next successful scan. The check is a stat per
 * tracked file, not a dependence on the walk, so a file the walker skipped
 * for its own reasons is never treated as deleted.
 */
function reconcileRemovedFiles(rootFolderId: string): { files: number; albums: number } {
	const rows = db
		.select({
			id: trackFiles.id,
			albumId: trackFiles.albumId,
			trackId: trackFiles.trackId,
			relativePath: trackFiles.relativePath,
			albumPath: albums.path
		})
		.from(trackFiles)
		.innerJoin(albums, eq(trackFiles.albumId, albums.id))
		.where(eq(albums.rootFolderId, rootFolderId))
		.all();

	const gone = rows.filter(
		(row) => row.albumPath && !existsSync(path.join(row.albumPath, row.relativePath))
	);
	if (gone.length === 0) return { files: 0, albums: 0 };

	const albumsTouched = new Set<string>();
	const tracksTouched = new Set<string>();
	for (const row of gone) {
		db.delete(trackFiles).where(eq(trackFiles.id, row.id)).run();
		albumsTouched.add(row.albumId);
		if (row.trackId) tracksTouched.add(row.trackId);
	}

	for (const trackId of tracksTouched) {
		const remaining = db
			.select({ id: trackFiles.id })
			.from(trackFiles)
			.where(eq(trackFiles.trackId, trackId))
			.get();
		db.update(tracks)
			.set({ hasFile: Boolean(remaining) })
			.where(eq(tracks.id, trackId))
			.run();
	}

	for (const albumId of albumsTouched) {
		const remaining = db
			.select({ id: trackFiles.id })
			.from(trackFiles)
			.where(eq(trackFiles.albumId, albumId))
			.get();
		db.update(albums)
			.set({ hasFile: Boolean(remaining) })
			.where(eq(albums.id, albumId))
			.run();
	}

	logger.info(
		{ files: gone.length, albums: albumsTouched.size },
		'[MusicDiskScan] removed track files missing from disk'
	);
	return { files: gone.length, albums: albumsTouched.size };
}

/**
 * Scan one music root folder: walk, group into albums, match, adopt.
 *
 * A folder whose files are all already recorded is skipped before any network
 * call, so a second scan of an unchanged library costs one walk and no
 * MusicBrainz requests.
 */
export async function scanMusicRootFolder(options: MusicScanOptions): Promise<MusicScanSummary> {
	const summary: MusicScanSummary = {
		filesScanned: 0,
		filesImported: 0,
		filesRemoved: 0,
		albumsCleared: 0,
		folders: 0,
		imported: 0,
		skipped: 0,
		unmatched: 0,
		failed: 0,
		results: []
	};

	const files = await collectAudioFiles(options.rootPath);
	summary.filesScanned = files.length;
	if (files.length === 0) return summary;

	const reconciled = reconcileRemovedFiles(options.rootFolderId);
	summary.filesRemoved = reconciled.files;
	summary.albumsCleared = reconciled.albums;

	const groups = groupAudioFiles(files);
	summary.folders = groups.length;
	const tracked = trackedPaths(options.rootFolderId);

	for (const group of groups) {
		if (options.isAborted?.()) break;

		options.onProgress?.({
			filesSeen: files.length,
			foldersSeen: summary.results.length,
			currentFolder: group.folder
		});

		const alreadyTracked = group.files.every((file) => tracked.has(file.absolutePath));
		if (alreadyTracked) {
			summary.skipped += 1;
			summary.results.push({
				folder: group.folder,
				album: group.album,
				artist: group.artist,
				status: 'skipped',
				reason: 'already in the library'
			});
			continue;
		}

		if (!group.album) {
			summary.unmatched += 1;
			summary.results.push({
				folder: group.folder,
				album: null,
				artist: group.artist,
				status: 'unmatched',
				reason: 'no album tag and the folder name has no album title'
			});
			// One audit line per unmatched folder: this is the only record of
			// what a scan could not identify, and it must be actionable.
			logger.warn(
				{ folder: group.folder, artist: group.artist },
				'[MusicDiskScan] album not identified'
			);
			continue;
		}

		try {
			const adopted = await adoptFolder(group, options);
			summary.imported += 1;
			summary.filesImported += adopted.filesImported;
			summary.results.push({
				folder: group.folder,
				album: group.album,
				artist: group.artist,
				status: 'imported',
				albumId: adopted.albumId
			});
			logger.info(
				{ folder: group.folder, albumId: adopted.albumId, files: adopted.filesImported },
				'[MusicDiskScan] album adopted'
			);
		} catch (error) {
			if (error instanceof DuplicateAlbumError) {
				summary.skipped += 1;
				summary.results.push({
					folder: group.folder,
					album: group.album,
					artist: group.artist,
					status: 'skipped',
					reason: error.message
				});
				logger.warn(
					{ folder: group.folder, reason: error.message },
					'[MusicDiskScan] duplicate album folder skipped'
				);
				continue;
			}

			if (error instanceof UnmatchedAlbumError) {
				summary.unmatched += 1;
				summary.results.push({
					folder: group.folder,
					album: group.album,
					artist: group.artist,
					status: 'unmatched',
					reason: error.message
				});
				logger.warn(
					{ folder: group.folder, album: group.album, artist: group.artist, reason: error.message },
					'[MusicDiskScan] album not identified'
				);
				continue;
			}

			summary.failed += 1;
			summary.results.push({
				folder: group.folder,
				album: group.album,
				artist: group.artist,
				status: 'failed',
				reason: error instanceof Error ? error.message : String(error)
			});
			logger.error(
				{ folder: group.folder, err: error instanceof Error ? error.message : String(error) },
				'[MusicDiskScan] album import failed'
			);
		}
	}

	musicScanIssueService.record(options.rootFolderId, summary.results);
	return summary;
}

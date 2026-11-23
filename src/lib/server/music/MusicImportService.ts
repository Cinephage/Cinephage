import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	albums,
	artists,
	downloadClients,
	downloadHistory,
	downloadQueue,
	mediaItems,
	rootFolders,
	trackFiles,
	tracks
} from '#lib/server/db/schema.js';
import { mapClientPathToLocal } from '#lib/server/downloadClients/monitoring/PathMapping.js';
import { createChildLogger } from '#lib/logging/index.js';
import { isAppError, NotFoundError, ValidationError } from '#lib/errors/index.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { matchFilesToTracks } from './track-matching.js';
import { AUDIO_EXTENSIONS, collectAudioFiles, type TaggedAudioFile } from './audio-folder.js';
import { musicStrmService } from './MusicStrmService.js';
import { sanitizeMusicSegment } from './paths.js';
import { publishImport } from '#lib/server/notifications/core/app-events.js';
import { getMediaBrowserNotifier } from '#lib/server/notifications/mediabrowser/MediaBrowserNotifier.js';
import { invalidateTrackStream } from './playback/resolver.js';
import { blocklistService } from '#lib/server/blocklist/BlocklistService.js';
import { musicScanIssueService } from './MusicScanIssueService.js';

const logger = createChildLogger({ module: 'MusicImportService', logDomain: 'imports' });

export interface MusicImportResult {
	albumId: string;
	status: 'imported' | 'failed';
	albumPath: string | null;
	filesImported: number;
	tracksMatched: number;
	unmatchedFiles: string[];
	reason?: string;
}

/**
 * Music import.
 *
 * Deliberately separate from the video `ImportService`: that one resolves a movie
 * or a series and picks files per episode, while an album folder is one item with
 * a flat file list. Sharing the machinery would mean branching on kind inside
 * both. What the two do share is the outcome shape — files recorded, the parent
 * marked as having files, the queue row closed — so the monitor can treat the
 * result the same way.
 */
export class MusicImportService {
	/**
	 * Imports currently running, by queue id. The monitor can ask for the same
	 * download from more than one path in a single cycle (a completion event and
	 * the poll loop both fire), and a second copy of a 1 GB album is real work.
	 */
	private readonly inFlight = new Set<string>();

	/** Import the completed download for an album, wherever the client put it. */
	async importFromQueue(queueId: string): Promise<MusicImportResult> {
		const queueRow = db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId)).get();
		if (!queueRow?.mediaItemId) {
			throw new NotFoundError('Queued music download', queueId);
		}
		if (queueRow.status === 'imported') {
			return {
				albumId: '',
				status: 'imported',
				albumPath: queueRow.importedPath ?? null,
				filesImported: 0,
				tracksMatched: 0,
				unmatchedFiles: [],
				reason: 'already imported'
			};
		}
		if (this.inFlight.has(queueId)) {
			throw new ValidationError('This download is already being imported');
		}
		const albumRow = db
			.select({ id: albums.id })
			.from(albums)
			.where(eq(albums.mediaItemId, queueRow.mediaItemId))
			.get();
		if (!albumRow) throw new NotFoundError('Album for queue item', queueId);

		this.inFlight.add(queueId);
		try {
			return await this.importFolder(albumRow.id, this.resolveLocalPath(queueRow), { queueId });
		} catch (error) {
			// Every real failure terminates the queue row; only content failures
			// blocklist. A precondition (no path yet) never reaches here.
			if (!isAppError(error)) this.recordImportFailure(albumRow.id, queueRow, error);
			await downloadMonitor.markFailed(
				queueRow.id,
				error instanceof Error ? error.message : String(error),
				{ terminalImport: true }
			);
			throw error;
		} finally {
			this.inFlight.delete(queueId);
		}
	}

	/**
	 * A failed album import is a release this album must not grab again. The
	 * video importer records the same way; without it a mislabelled torrent
	 * would be retried every search cycle.
	 */
	private recordImportFailure(
		albumId: string,
		queueRow: typeof downloadQueue.$inferSelect,
		error: unknown
	): void {
		try {
			blocklistService.addToBlocklist(
				{
					title: queueRow.title,
					infoHash: queueRow.infoHash ?? undefined,
					indexerId: queueRow.indexerId ?? undefined,
					size: queueRow.size ?? undefined,
					protocol: queueRow.protocol ?? undefined
				},
				{
					albumId,
					reason: 'import_failed',
					message: error instanceof Error ? error.message : String(error)
				}
			);
		} catch (blocklistError) {
			logger.warn(
				{ albumId, err: blocklistError instanceof Error ? blocklistError.message : String(blocklistError) },
				'[MusicImport] could not record the failed release in the blocklist'
			);
		}
	}

	/** Import the newest queued download for one album (how the UI asks). */
	async importFromQueueForAlbum(
		albumId: string,
		options: { dryRun?: boolean } = {}
	): Promise<MusicImportResult> {
		const albumRow = db
			.select({ mediaItemId: albums.mediaItemId })
			.from(albums)
			.where(eq(albums.id, albumId))
			.get();
		if (!albumRow?.mediaItemId) throw new NotFoundError('Album', albumId);

		const queueRow = db
			.select({ id: downloadQueue.id })
			.from(downloadQueue)
			.where(eq(downloadQueue.mediaItemId, albumRow.mediaItemId))
			.orderBy(desc(downloadQueue.addedAt))
			.get();
		if (!queueRow) throw new NotFoundError('Queued download for album', albumId);

		const row = db.select().from(downloadQueue).where(eq(downloadQueue.id, queueRow.id)).get();
		if (!row) throw new NotFoundError('Queued download for album', albumId);
		if (row.status !== 'completed' && row.status !== 'seeding' && row.status !== 'seeding-imported') {
			throw new ValidationError('The download has not finished yet');
		}

		try {
			return await this.importFolder(albumId, this.resolveLocalPath(row), {
				queueId: queueRow.id,
				dryRun: options.dryRun
			});
		} catch (error) {
			if (!isAppError(error)) this.recordImportFailure(albumId, row, error);
			await downloadMonitor.markFailed(
				row.id,
				error instanceof Error ? error.message : String(error),
				{ terminalImport: true }
			);
			throw error;
		}
	}

	/**
	 * Copy an album folder into the library and record its files.
	 *
	 * Copy rather than move: the download keeps seeding, which is what a torrent
	 * download is for. Existing destination files are skipped, so a retry does not
	 * duplicate work or overwrite an import someone already fixed up.
	 */
	async importFolder(
		albumId: string,
		sourceFolder: string,
		options: { queueId?: string; dryRun?: boolean; force?: boolean } = {}
	): Promise<MusicImportResult> {
		// The monitor can ask twice in one cycle, and a person can click import on
		// something already imported. Both are checked here as well as at the queue
		// entry point, because this is the function that does the copying.
		if (options.queueId && !options.force) {
			const existing = db
				.select({ status: downloadQueue.status, importedPath: downloadQueue.importedPath })
				.from(downloadQueue)
				.where(eq(downloadQueue.id, options.queueId))
				.get();
			if (existing?.status === 'imported') {
				return {
					albumId,
					status: 'imported',
					albumPath: existing.importedPath ?? null,
					filesImported: 0,
					tracksMatched: 0,
					unmatchedFiles: [],
					reason: 'already imported'
				};
			}
		}
		const album = db
			.select({
				id: albums.id,
				title: albums.title,
				year: albums.year,
				rootFolderId: albums.rootFolderId,
				mediaItemId: albums.mediaItemId,
				artistName: artists.name
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(albums.id, albumId))
			.get();
		if (!album) throw new NotFoundError('Album', albumId);

		if (!album.rootFolderId) {
			throw new ValidationError('The album has no root folder to import into');
		}
		const rootFolder = db
			.select({ path: rootFolders.path })
			.from(rootFolders)
			.where(eq(rootFolders.id, album.rootFolderId))
			.get();
		if (!rootFolder) throw new ValidationError('The album root folder no longer exists');

		const source = path.resolve(sourceFolder);
		const stats = await fs.stat(source).catch(() => null);
		if (!stats?.isDirectory()) throw new ValidationError(`Not a folder: ${sourceFolder}`);

		const files = await collectAudioFiles(source);
		if (files.length === 0) throw new ValidationError(`No audio files found under ${sourceFolder}`);

		const { matches, unmatched, trackIdByPath } = this.matchFiles(albumId, files);

		const destinationFolder = path.join(
			rootFolder.path,
			this.sanitize(album.artistName),
			this.sanitize(`${album.title}${album.year ? ` (${album.year})` : ''}`)
		);

		if (options.dryRun) {
			return {
				albumId,
				status: 'imported',
				albumPath: destinationFolder,
				filesImported: files.length,
				tracksMatched: matches.length,
				unmatchedFiles: unmatched.map((file) => file.fileName)
			};
		}

		await fs.mkdir(destinationFolder, { recursive: true });

		let imported = 0;
		for (const file of files) {
			const relativePath = this.sanitizeRelativePath(file.relativePath);
			const target = path.join(destinationFolder, relativePath);
			await fs.mkdir(path.dirname(target), { recursive: true });
			try {
				await fs.copyFile(file.absolutePath, target, constants.COPYFILE_EXCL);
			} catch (error) {
				// EEXIST: an earlier import already placed it. Anything else is real.
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
			imported += 1;
		}

		await this.indexFiles(
			albumId,
			destinationFolder,
			files.map((file) => ({
				file,
				relativePath: this.sanitizeRelativePath(file.relativePath)
			})),
			trackIdByPath,
			album.mediaItemId
		);
		if (options.queueId) {
			db.update(downloadQueue)
				.set({
					status: 'imported',
					importedPath: destinationFolder,
					importedAt: new Date().toISOString()
				})
				.where(eq(downloadQueue.id, options.queueId))
				.run();
			this.recordImportedHistory(options.queueId, destinationFolder);
		}

		logger.info(
			{
				albumId,
				files: imported,
				matched: matches.length,
				unmatched: unmatched.length,
				destinationFolder
			},
			'[MusicImport] album imported'
		);

		return {
			albumId,
			status: 'imported',
			albumPath: destinationFolder,
			filesImported: imported,
			tracksMatched: matches.length,
			unmatchedFiles: unmatched.map((file) => file.fileName)
		};
	}

	/**
	 * Adopt audio that is already inside a library folder.
	 *
	 * The download path copies files into place; a library scan must not, or
	 * every scanned album would exist twice under the same root. What happens
	 * after placement is shared, so an adopted album is indistinguishable from
	 * a downloaded one: same track links, same `has_file`, same folder path.
	 */
	async adoptFolder(albumId: string, folder: string): Promise<MusicImportResult> {
		const album = db
			.select({ id: albums.id, mediaItemId: albums.mediaItemId })
			.from(albums)
			.where(eq(albums.id, albumId))
			.get();
		if (!album) throw new NotFoundError('Album', albumId);

		const source = path.resolve(folder);
		const stats = await fs.stat(source).catch(() => null);
		if (!stats?.isDirectory()) throw new ValidationError(`Not a folder: ${folder}`);

		const files = await collectAudioFiles(source);
		if (files.length === 0) throw new ValidationError(`No audio files found under ${folder}`);

		const { matches, unmatched, trackIdByPath } = this.matchFiles(albumId, files);
		await this.indexFiles(
			albumId,
			source,
			files.map((file) => ({ file, relativePath: file.relativePath })),
			trackIdByPath,
			album.mediaItemId
		);

		logger.info(
			{ albumId, files: files.length, matched: matches.length, folder: source },
			'[MusicImport] album adopted from disk'
		);

		return {
			albumId,
			status: 'imported',
			albumPath: source,
			filesImported: files.length,
			tracksMatched: matches.length,
			unmatchedFiles: unmatched.map((file) => file.fileName)
		};
	}

	/** Match a folder's files to the album's tracklist, once for both entry paths. */
	private matchFiles(albumId: string, files: TaggedAudioFile[]) {
		const albumTracks = db
			.select({
				id: tracks.id,
				discNumber: tracks.discNumber,
				trackNumber: tracks.trackNumber,
				title: tracks.title
			})
			.from(tracks)
			.where(eq(tracks.albumId, albumId))
			.all();

		// `fileName` carries the relative path here: it is the unique key across
		// disc folders, and a bare name can repeat between them.
		const { matches, unmatched } = matchFilesToTracks(
			files.map((file) => ({
				discNumber: file.discNumber,
				trackNumber: file.trackNumber,
				title: file.title,
				fileName: file.relativePath
			})),
			albumTracks
		);
		const trackIdByPath = new Map(matches.map((match) => [match.file.fileName, match.trackId]));
		return { matches, unmatched, trackIdByPath };
	}

	/**
	 * Record files against an album and mark it owned. Shared by copy-import and
	 * adopt; the only difference between them is whether bytes moved first.
	 */
	private async indexFiles(
		albumId: string,
		folder: string,
		files: Array<{ file: TaggedAudioFile; relativePath: string }>,
		trackIdByPath: Map<string, string>,
		mediaItemId: string | null
	): Promise<void> {
		for (const { file, relativePath } of files) {
			const values = {
				albumId,
				trackId: trackIdByPath.get(file.relativePath) ?? null,
				relativePath,
				sizeBytes: file.sizeBytes,
				format: file.format,
				bitrateKbps: file.bitrateKbps,
				bitDepth: file.bitDepth,
				sampleRateHz: file.sampleRateHz,
				channels: file.channels,
				duration: file.durationSeconds
			};
			db.insert(trackFiles)
				.values(values)
				.onConflictDoUpdate({ target: [trackFiles.albumId, trackFiles.relativePath], set: values })
				.run();
		}

		// Only tracks a file actually matched are owned. Marking the whole
		// album made an 8-of-12 folder look complete, kept stale rows alive in
		// reconcileTracklist and stopped the missing search from retrying.
		const matchedIds = [...new Set(trackIdByPath.values())];
		if (matchedIds.length > 0) {
			db.update(tracks)
				.set({ hasFile: true })
				.where(inArray(tracks.id, matchedIds))
				.run();
		}
		db.update(albums)
			.set({ path: folder, hasFile: true, streamSource: null })
			.where(eq(albums.id, albumId))
			.run();

		musicScanIssueService.resolveFolder(folder);
		for (const id of matchedIds) invalidateTrackStream(id);
		getMediaBrowserNotifier().queueUpdate(folder, 'Created', 'import');

		// The album is owned now: stream shortcuts left beside the real files
		// would make the media server show every track twice.
		await musicStrmService.removeShortcutsInFolder(folder);
		if (mediaItemId) {
			db.update(mediaItems)
				.set({ path: folder })
				.where(eq(mediaItems.id, mediaItemId))
				.run();
		}
	}

	/**
	 * A finished album import is a history event like any movie import. The
	 * queue row is the source (title, client, protocol, size); `media_item_id`
	 * is what lets Activity name the album after the queue row is gone.
	 */
	private recordImportedHistory(queueId: string, importedPath: string): void {
		const row = db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId)).get();
		if (!row?.mediaItemId) return;

		const existing = db
			.select({ id: downloadHistory.id })
			.from(downloadHistory)
			.where(
				and(
					eq(downloadHistory.mediaItemId, row.mediaItemId),
					eq(downloadHistory.title, row.title),
					eq(downloadHistory.status, 'imported')
				)
			)
			.get();
		if (existing) return;

		let downloadTimeSeconds: number | undefined;
		if (row.startedAt && row.completedAt) {
			const start = new Date(row.startedAt).getTime();
			const end = new Date(row.completedAt).getTime();
			downloadTimeSeconds = Math.max(0, Math.floor((end - start) / 1000));
		}

		const album = db
			.select({ id: albums.id })
			.from(albums)
			.where(eq(albums.mediaItemId, row.mediaItemId))
			.get();
		if (album) {
			publishImport({
				mediaType: 'album',
				mediaId: album.id,
				releaseName: row.title,
				quality: null
			});
		}

		db.insert(downloadHistory)
			.values({
				downloadClientId: row.downloadClientId,
				downloadClientName: null,
				downloadId: row.downloadId,
				infoHash: row.infoHash,
				title: row.title,
				indexerId: row.indexerId,
				indexerName: row.indexerName,
				protocol: row.protocol,
				mediaItemId: row.mediaItemId,
				status: 'imported',
				size: row.size,
				downloadTimeSeconds,
				finalRatio: row.ratio,
				quality: row.quality,
				releaseGroup: row.releaseGroup,
				importedPath,
				transferMode: row.transferMode,
				grabbedAt: row.addedAt,
				completedAt: row.completedAt,
				importedAt: new Date().toISOString()
			})
			.run();
	}

	/**
	 * Where the files actually are on this host.
	 *
	 * A queue row carries two paths: `outputPath`, already resolved by the monitor,
	 * and `clientDownloadPath`, which is the *client's* view and means nothing here.
	 * Falling back to the client's mapping covers a row the monitor has not touched
	 * yet — the first live import failed precisely because it read the raw client
	 * path.
	 */
	private resolveLocalPath(row: typeof downloadQueue.$inferSelect): string {
		if (row.outputPath) return row.outputPath;
		if (!row.clientDownloadPath)
			throw new ValidationError('The queue item has no path to import from');

		const client = row.downloadClientId
			? db.select().from(downloadClients).where(eq(downloadClients.id, row.downloadClientId)).get()
			: null;
		if (!client) return row.clientDownloadPath;

		return mapClientPathToLocal(
			row.clientDownloadPath,
			client.downloadPathLocal,
			client.downloadPathRemote,
			client.tempPathLocal,
			client.tempPathRemote
		);
	}

	/** Path-safe segment: no separators, no leading dots, no trailing spaces. */
	private sanitize(value: string): string {
		return sanitizeMusicSegment(value);
	}

	/** The same, segment by segment, so a disc subfolder survives. */
	private sanitizeRelativePath(relativePath: string): string {
		return relativePath
			.split(path.sep)
			.map((segment) => {
				const extension = path.extname(segment);
				// A folder can contain a dot ("Mr. Robot"); only a real audio
				// extension is treated as one.
				if (!AUDIO_EXTENSIONS.has(extension.toLowerCase())) return this.sanitize(segment);
				const base = this.sanitize(path.basename(segment, extension));
				return `${base}${extension.toLowerCase()}`;
			})
			.join(path.sep);
	}
}

export const musicImportService = new MusicImportService();

/**
 * Item kinds the music importer owns. The `kind` column on `media_items` names
 * the *shape* of the item (an album, later a book), not the media kind, so this
 * is a set and not a single literal — and it is the only place that mapping
 * lives.
 */
const MUSIC_ITEM_KINDS: ReadonlySet<string> = new Set(['album']);

/** Whether a spine item belongs to the music importer. */
export function isMusicMediaItem(mediaItemId: string): boolean {
	const row = db
		.select({ kind: mediaItems.kind })
		.from(mediaItems)
		.where(eq(mediaItems.id, mediaItemId))
		.get();
	return row ? MUSIC_ITEM_KINDS.has(row.kind) : false;
}

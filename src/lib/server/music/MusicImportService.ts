import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	albums,
	artists,
	downloadClients,
	downloadQueue,
	mediaItems,
	rootFolders,
	trackFiles,
	tracks
} from '#lib/server/db/schema.js';
import { mapClientPathToLocal } from '#lib/server/downloadClients/monitoring/PathMapping.js';
import { createChildLogger } from '#lib/logging/index.js';
import { NotFoundError, ValidationError } from '#lib/errors/index.js';
import { matchFilesToTracks, type AudioFileRef } from './track-matching.js';
import { musicStrmService } from './MusicStrmService.js';
import { sanitizeMusicSegment } from './paths.js';

const logger = createChildLogger({ module: 'MusicImportService', logDomain: 'imports' });

const AUDIO_EXTENSIONS = new Set([
	'.flac',
	'.mp3',
	'.m4a',
	'.aac',
	'.ogg',
	'.opus',
	'.wav',
	'.wv',
	'.ape'
]);
/** Directories and files that are never album content. */
const SKIP_NAMES = /^(sample|samples|scans|covers?|artwork|\.)/i;
/** A file this small is a cue stub or a failed download, not audio. */
const MIN_AUDIO_BYTES = 64 * 1024;

export interface MusicImportResult {
	albumId: string;
	status: 'imported' | 'failed';
	albumPath: string | null;
	filesImported: number;
	tracksMatched: number;
	unmatchedFiles: string[];
	reason?: string;
}

interface TaggedFile extends AudioFileRef {
	absolutePath: string;
	/** Path relative to the folder being imported; unique, and kept on copy. */
	relativePath: string;
	fileName: string;
	sizeBytes: number;
	format: string | null;
	bitrateKbps: number | null;
	bitDepth: number | null;
	sampleRateHz: number | null;
	channels: number | null;
	durationSeconds: number | null;
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
		} finally {
			this.inFlight.delete(queueId);
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

		return this.importFolder(albumId, this.resolveLocalPath(row), {
			queueId: queueRow.id,
			dryRun: options.dryRun
		});
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

		const files = await this.collectAudioFiles(source, source);
		if (files.length === 0) throw new ValidationError(`No audio files found under ${sourceFolder}`);

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

		db.update(tracks)
			.set({ hasFile: true })
			.where(and(eq(tracks.albumId, albumId), eq(tracks.hasFile, false)))
			.run();
		db.update(albums)
			.set({ path: destinationFolder, hasFile: true, streamSource: null })
			.where(eq(albums.id, albumId))
			.run();

		// The album is owned now: stream shortcuts left beside the real files
		// would make the media server show every track twice.
		await musicStrmService.removeShortcutsInFolder(destinationFolder);
		if (album.mediaItemId) {
			db.update(mediaItems)
				.set({ path: destinationFolder })
				.where(eq(mediaItems.id, album.mediaItemId))
				.run();
		}
		if (options.queueId) {
			db.update(downloadQueue)
				.set({
					status: 'imported',
					importedPath: destinationFolder,
					importedAt: new Date().toISOString()
				})
				.where(eq(downloadQueue.id, options.queueId))
				.run();
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

	/** Every audio file under a folder, tagged. Hidden and scan folders skipped. */
	private async collectAudioFiles(root: string, current: string, depth = 0): Promise<TaggedFile[]> {
		if (depth > 4) return [];

		const entries = await fs.readdir(current, { withFileTypes: true });
		const files: TaggedFile[] = [];

		for (const entry of entries) {
			if (SKIP_NAMES.test(entry.name)) continue;
			const full = path.join(current, entry.name);

			if (entry.isDirectory()) {
				files.push(...(await this.collectAudioFiles(root, full, depth + 1)));
				continue;
			}
			if (!AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

			const stats = await fs.stat(full).catch(() => null);
			if (!stats || stats.size < MIN_AUDIO_BYTES) continue;

			files.push(await this.readTags(full, path.relative(root, full), entry.name, stats.size));
		}

		return files;
	}

	private async readTags(
		absolutePath: string,
		relativePath: string,
		fileName: string,
		sizeBytes: number
	): Promise<TaggedFile> {
		const base: TaggedFile = {
			absolutePath,
			relativePath,
			fileName,
			discNumber: null,
			trackNumber: null,
			title: null,
			sizeBytes,
			format: null,
			bitrateKbps: null,
			bitDepth: null,
			sampleRateHz: null,
			channels: null,
			durationSeconds: null
		};

		try {
			const metadata = await parseFile(absolutePath, { duration: true, skipCovers: true });
			const { common, format } = metadata;
			return {
				...base,
				discNumber: common.disk?.no ?? null,
				trackNumber: common.track?.no ?? null,
				title: common.title ?? null,
				format: format.container ?? format.codec ?? null,
				bitrateKbps: format.bitrate ? Math.round(format.bitrate / 1000) : null,
				bitDepth: format.bitsPerSample ?? null,
				sampleRateHz: format.sampleRate ?? null,
				channels: format.numberOfChannels ?? null,
				durationSeconds: format.duration ? Math.round(format.duration) : null
			};
		} catch (error) {
			// An unreadable tag block must not lose the file: the matcher falls back
			// to the file name, which is what it does when tags are absent anyway.
			logger.warn(
				{ file: fileName, err: error instanceof Error ? error.message : String(error) },
				'[MusicImport] could not read tags'
			);
			return base;
		}
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

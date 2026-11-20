import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists, downloadQueue } from '#lib/server/db/schema.js';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { NotFoundError, ValidationError } from '#lib/errors/index.js';
import { getDownloadResolutionService } from '#lib/server/downloads/DownloadResolutionService.js';
import { musicSearchService, type MusicReleaseCandidate } from './MusicSearchService.js';
import { musicStreamGrabService } from './MusicStreamGrabService.js';
import { parseMusicStreamUrl } from './stream-url.js';

const logger = createChildLogger({ module: 'MusicGrabService', logDomain: 'system' });

export interface MusicGrabResult {
	/** Null for a stream grab: only a download client hands back a queue id. */
	queueId: string | null;
	/** Null for a stream grab, for the same reason. */
	downloadId: string | null;
	title: string;
	indexerName: string | null;
	size: number | null;
	/** Ladder rung of the release that was taken. */
	tierLabel: string | null;
}

/**
 * Grabbing a music release.
 *
 * Deliberately its own module rather than a branch inside the video grab
 * pipeline: that pipeline resolves a movie/series context and a video scoring
 * profile, and threading an album through it would make both paths worse. What
 * it *does* reuse is the two pieces that are already kind-neutral — the download
 * client abstraction and `downloadMonitor.addToQueue`, which now accepts a
 * spine `mediaItemId`.
 *
 * Selection is the profile's job: the search already ranks by the quality ladder,
 * so this takes the best **accepted** candidate and never re-ranks on seeders.
 */
export class MusicGrabService {
	/** A queue row already in flight for this album, if any. */
	private activeQueueForMediaItem(mediaItemId: string): string | null {
		const row = db
			.select({ id: downloadQueue.id })
			.from(downloadQueue)
			.where(
				and(
					eq(downloadQueue.mediaItemId, mediaItemId),
					notInArray(downloadQueue.status, ['removed', 'failed', 'imported'])
				)
			)
			.get();
		return row?.id ?? null;
	}

	async grabAlbum(
		albumId: string,
		options: { releaseGuid?: string } = {}
	): Promise<MusicGrabResult> {
		const album = db
			.select({
				id: albums.id,
				title: albums.title,
				mediaItemId: albums.mediaItemId,
				artist: artists.name
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(albums.id, albumId))
			.get();
		if (!album) throw new NotFoundError('Album', albumId);

		const active = this.activeQueueForMediaItem(album.mediaItemId);
		if (active) {
			throw new ValidationError('This album already has a download in flight', {
				queueId: active
			});
		}

		const { candidates } = await musicSearchService.searchForAlbum(albumId);
		const chosen = this.choose(candidates, options.releaseGuid);
		if (!chosen) {
			throw new ValidationError('No release passed the quality profile for this album');
		}

		// The Streamer releases the album to a source instead of a download
		// client. It is the same decision the movie streamer profile makes, and
		// the reason no torrent client is required for this branch.
		if (chosen.protocol === 'streaming') {
			const parsed = parseMusicStreamUrl(chosen.downloadUrl ?? '');
			if (!parsed || parsed.albumId !== album.id) {
				throw new ValidationError('The streaming release does not point at this album');
			}

			const result = await musicStreamGrabService.grabAlbumStream(album, chosen);
			return { queueId: null, downloadId: null, ...result };
		}

		if (!chosen.magnetUrl && !chosen.downloadUrl && !chosen.infoHash) {
			throw new ValidationError('The chosen release has no magnet, torrent URL or info hash');
		}

		const clientResult = await getDownloadClientManager().getClientForProtocol('torrent');
		if (!clientResult) throw new ValidationError('No enabled torrent download client configured');
		const { client: clientConfig, instance } = clientResult;

		const categoryMap = (clientConfig.categoryMap ?? {}) as Record<string, string>;
		const category = categoryMap.music;
		if (!category) {
			throw new ValidationError(
				`Download client "${clientConfig.name}" has no music category configured`
			);
		}

		// Resolve the release before adding it. A tracker result often carries only
		// a .torrent URL, and the client returns no hash for a URL add — which would
		// leave a queue row nothing can track. Resolution fetches the torrent and
		// extracts the info hash, so the queue row is identifiable from the start.
		const resolved = await getDownloadResolutionService().resolve({
			downloadUrl: chosen.downloadUrl,
			magnetUrl: chosen.magnetUrl,
			infoHash: chosen.infoHash,
			indexerId: chosen.indexerId,
			title: chosen.title
		});
		if (!resolved.success) {
			throw new ValidationError(
				`Could not resolve the release: ${resolved.error ?? 'unknown error'}`
			);
		}

		// Save inside the client's mapped download root. A category can carry its
		// own save path on the client, and when that path sits outside the mapping
		// the files land where the importer cannot see them — the first live grab
		// did exactly that. One subdirectory per kind keeps them together.
		const remoteRoot = clientConfig.downloadPathRemote?.replace(/\/+$/, '');
		const savePath = remoteRoot ? `${remoteRoot}/${category}` : undefined;

		const downloadId = await instance.addDownload({
			magnetUri: resolved.magnetUrl,
			torrentFile: resolved.torrentFile,
			infoHash: resolved.infoHash,
			downloadUrl:
				resolved.magnetUrl || resolved.torrentFile ? undefined : (chosen.downloadUrl ?? undefined),
			category,
			savePath,
			title: chosen.title,
			paused: false
		});
		if (!downloadId) {
			throw new ValidationError(
				'The download client did not return a download id; the release cannot be tracked'
			);
		}

		const queueItem = await downloadMonitor.addToQueue({
			downloadClientId: clientConfig.id,
			downloadId,
			infoHash: resolved.infoHash ?? chosen.infoHash ?? undefined,
			title: chosen.title,
			indexerId: chosen.indexerId ?? undefined,
			indexerName: chosen.indexerName ?? undefined,
			downloadUrl: chosen.downloadUrl ?? undefined,
			magnetUrl: chosen.magnetUrl ?? undefined,
			protocol: chosen.protocol ?? 'torrent',
			size: chosen.size ?? undefined,
			mediaItemId: album.mediaItemId
		});

		// A download supersedes a stream marker: the album's source is whatever
		// the newest grab chose.
		db.update(albums).set({ streamSource: null }).where(eq(albums.id, album.id)).run();

		logger.info(
			{
				albumId,
				queueId: queueItem.id,
				title: chosen.title,
				tier: chosen.tierLabel,
				category
			},
			'[MusicGrab] album grabbed'
		);

		return {
			queueId: queueItem.id,
			downloadId,
			title: chosen.title,
			indexerName: chosen.indexerName,
			size: chosen.size,
			tierLabel: chosen.tierLabel ?? null
		};
	}

	/**
	 * The best accepted candidate: the search already sorted by ladder rung, so
	 * the first accepted entry wins. An explicit guid lets a person pick one from
	 * the list without the profile overriding the choice.
	 */
	private choose(
		candidates: MusicReleaseCandidate[],
		releaseGuid?: string
	): MusicReleaseCandidate | null {
		if (releaseGuid) {
			return candidates.find((candidate) => candidate.guid === releaseGuid) ?? null;
		}
		return candidates.find((candidate) => candidate.accepted) ?? null;
	}
}

export const musicGrabService = new MusicGrabService();

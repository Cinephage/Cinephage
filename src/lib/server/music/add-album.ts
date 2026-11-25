import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists } from '#lib/server/db/schema.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { validateRootFolder } from '#lib/server/library/LibraryAddService.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { searchAddedAlbums } from '#lib/server/music/MusicAutoSearch.js';
import { musicBrainz, pickPrimaryRelease } from '#lib/server/music/musicbrainz.js';

export interface AddAlbumInput {
	/** MusicBrainz release-group id. */
	mbid: string;
	/** Writable music root folder the album is stored under. */
	rootFolderId: string;
	monitored?: boolean;
	qualityProfileId?: string | null;
	/** Run the indexer search after the album is stored. */
	search?: boolean;
	/**
	 * When the album already exists, switch monitoring on. Lists deliberately
	 * leave an owned album's monitoring alone; a request is a statement about
	 * the album, so it does.
	 */
	monitorExisting?: boolean;
}

export interface AddAlbumResult {
	albumId: string;
	/** False when the album was already stored and only linked. */
	created: boolean;
}

/**
 * Turn one MusicBrainz release group into a library album, idempotently.
 *
 * This is the single owner of "add an album by release-group id": smart lists
 * and user requests both come through here, so the root-folder contract, the
 * edition pick and the optional search cannot drift between them.
 */
export async function addAlbumFromReleaseGroup(input: AddAlbumInput): Promise<AddAlbumResult> {
	await validateRootFolder(input.rootFolderId, 'music', { requireWritable: true });
	const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
		input.rootFolderId,
		'music'
	);
	const monitored = input.monitored ?? true;
	const qualityProfileId = input.qualityProfileId ?? null;

	const existing = await db
		.select({ id: albums.id, title: albums.title, artistName: artists.name })
		.from(albums)
		.innerJoin(artists, eq(albums.artistId, artists.id))
		.where(eq(albums.mbid, input.mbid))
		.limit(1)
		.get();

	let albumId: string;
	let title: string;
	let artistName: string;
	let created = false;

	if (existing) {
		albumId = existing.id;
		title = existing.title;
		artistName = existing.artistName ?? '';
		if (input.monitorExisting && !monitored) {
			await db.update(albums).set({ monitored: false }).where(eq(albums.id, albumId));
		} else if (input.monitorExisting) {
			await db.update(albums).set({ monitored: true }).where(eq(albums.id, albumId));
		}
	} else {
		const { group, releases } = await musicBrainz.getReleaseGroupWithReleases(input.mbid);
		const chosen = pickPrimaryRelease(releases);
		if (!chosen) {
			throw new Error('That release group has no editions');
		}
		const release = await musicBrainz.getRelease(chosen.mbid);
		const result = musicAlbumService.addAlbum({
			releaseGroup: group,
			release,
			libraryId: owningLibrary.id,
			rootFolderId: input.rootFolderId,
			monitored,
			qualityProfileId
		});
		albumId = result.albumId;
		title = group.title;
		artistName = group.artist?.name ?? '';
		created = true;
	}

	if (input.search) {
		await searchAddedAlbums([{ id: albumId, title, artistName }]);
	}

	return { albumId, created };
}

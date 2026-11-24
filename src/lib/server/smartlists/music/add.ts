import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	albums,
	smartListItems,
	type SmartListItemRecord,
	type SmartListRecord
} from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { validateRootFolder } from '#lib/server/library/LibraryAddService.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';
import { autoSearchAlbum } from '#lib/server/music/MusicAutoSearch.js';
import { musicBrainz, pickPrimaryRelease } from '#lib/server/music/musicbrainz.js';

const logger = createChildLogger({ module: 'MusicSmartListAdd', logDomain: 'monitoring' as const });

export interface AddMusicItemOptions {
	/** Set the provenance flags: this row was added by the list's auto-add. */
	auto?: boolean;
	/** Run the indexer search after the album is stored. */
	search?: boolean;
}

/**
 * Turn one list item (a MusicBrainz release group) into a library album.
 *
 * Idempotent: an album already stored by its release-group id is linked, not
 * re-fetched. The list's quality profile is applied to a new album; an existing
 * album keeps the profile and monitoring it already had, because a list is not
 * a statement about an album the user already owns.
 */
export async function addMusicItem(
	list: SmartListRecord,
	item: SmartListItemRecord,
	options: AddMusicItemOptions = {}
): Promise<{ success: boolean; error?: string }> {
	if (item.mediaType !== 'music') return { success: false, error: 'Not a music item' };
	if (item.inLibrary) return { success: false, error: 'Item already in library' };
	if (!item.mbid) return { success: false, error: 'Item has no release-group id' };
	if (!list.rootFolderId) {
		return { success: false, error: 'Smart list root folder is not configured' };
	}

	try {
		await validateRootFolder(list.rootFolderId, 'music', { requireWritable: true });
		const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
			list.rootFolderId,
			'music'
		);
		const monitored = list.autoAddMonitored ?? true;
		const qualityProfileId =
			list.scoringProfileId && musicProfileService.get(list.scoringProfileId)
				? list.scoringProfileId
				: null;

		const existing = await db
			.select({ id: albums.id })
			.from(albums)
			.where(eq(albums.mbid, item.mbid))
			.limit(1)
			.get();

		let albumId = existing?.id ?? null;
		if (!albumId) {
			const { group, releases } = await musicBrainz.getReleaseGroupWithReleases(item.mbid);
			const chosen = pickPrimaryRelease(releases);
			if (!chosen) {
				return { success: false, error: 'That release group has no editions' };
			}
			const release = await musicBrainz.getRelease(chosen.mbid);
			const result = musicAlbumService.addAlbum({
				releaseGroup: group,
				release,
				libraryId: owningLibrary.id,
				rootFolderId: list.rootFolderId,
				monitored,
				qualityProfileId
			});
			albumId = result.albumId;
		}

		const now = new Date().toISOString();
		await db
			.update(smartListItems)
			.set({
				inLibrary: true,
				albumId,
				wasAutoAdded: options.auto ?? false,
				autoAddedAt: options.auto ? now : null,
				updatedAt: now
			})
			.where(eq(smartListItems.id, item.id))
			.run();

		if (options.search) {
			const search = await autoSearchAlbum({
				id: albumId,
				title: item.title,
				artistName: item.artistName ?? ''
			});
			if (!search.grabbed) {
				logger.info(
					{ listId: list.id, albumId, error: search.error },
					'[MusicSmartList] album added but no release grabbed'
				);
			}
		}

		return { success: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ listId: list.id, itemId: item.id, err: message }, '[MusicSmartList] add failed');
		return { success: false, error: message };
	}
}

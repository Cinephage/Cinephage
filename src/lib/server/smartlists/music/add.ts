import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { smartListItems, type SmartListRecord, type SmartListItemRecord } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';
import { addAlbumFromReleaseGroup } from '#lib/server/music/add-album.js';

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
		const monitored = list.autoAddMonitored ?? true;
		const qualityProfileId =
			list.scoringProfileId && musicProfileService.get(list.scoringProfileId)
				? list.scoringProfileId
				: null;
		const { albumId } = await addAlbumFromReleaseGroup({
			mbid: item.mbid,
			rootFolderId: list.rootFolderId,
			monitored,
			qualityProfileId,
			search: options.search ?? false
		});

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

		return { success: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ listId: list.id, itemId: item.id, err: message }, '[MusicSmartList] add failed');
		return { success: false, error: message };
	}
}

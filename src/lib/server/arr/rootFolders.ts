/**
 * Radarr/Sonarr-compatible `rootfolder` response.
 *
 * Root folders split cleanly by media type - `root_folders.mediaType` is
 * already 'movie' | 'tv' in the schema, so Radarr only ever sees movie
 * folders and Sonarr only ever sees tv folders, regardless of
 * `mediaSubType` (anime is a sub-type under either, not a separate list).
 *
 * Field set confirmed against RootFolderResource in Radarr/Sonarr's actual
 * openapi.json - no `totalSpace` field exists there, so it isn't sent here
 * even though Cinephage tracks it.
 */

import { getRootFolderService } from '#lib/server/downloadClients/RootFolderService.js';
import { getOrAssignArrIds } from './ArrIdMappingService.js';
import type { RootFolderMediaType } from '#lib/types/downloadClient.js';

export async function buildRootFolders(mediaType: RootFolderMediaType) {
	const folders = await getRootFolderService().getFoldersByType(mediaType);
	const arrIds = await getOrAssignArrIds(
		'rootFolder',
		folders.map((f) => f.id)
	);

	return folders.map((folder) => ({
		id: arrIds.get(folder.id),
		path: folder.path,
		accessible: true,
		freeSpace: folder.freeSpaceBytes ?? 0,
		unmappedFolders: []
	}));
}

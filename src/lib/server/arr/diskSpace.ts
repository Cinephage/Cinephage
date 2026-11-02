/**
 * Radarr/Sonarr-compatible `diskspace` response.
 *
 * Field set confirmed against DiskSpaceResource in Radarr/Sonarr's actual
 * openapi.json. Scoped by media type like rootfolder - each persona only
 * ever reports the disk space for the folders it manages, matching how a
 * real standalone Radarr only knows about its own movie root folders.
 */

import { getRootFolderService } from '#lib/server/downloadClients/RootFolderService.js';
import { getOrAssignArrIds } from './ArrIdMappingService.js';
import type { RootFolderMediaType } from '#lib/types/downloadClient.js';

export async function buildDiskSpace(mediaType: RootFolderMediaType) {
	const folders = await getRootFolderService().getFoldersByType(mediaType);
	const arrIds = await getOrAssignArrIds(
		'rootFolder',
		folders.map((f) => f.id)
	);

	return folders.map((folder) => ({
		id: arrIds.get(folder.id),
		path: folder.path,
		label: folder.name,
		freeSpace: folder.freeSpaceBytes ?? 0,
		totalSpace: folder.totalSpaceBytes ?? 0
	}));
}

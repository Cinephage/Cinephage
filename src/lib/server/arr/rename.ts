/**
 * Radarr/Sonarr-compatible `rename` (pending rename preview) response.
 *
 * Reuses Cinephage's real RenamePreviewService.previewMovie()/previewSeries()
 * - the same rename-preview logic behind Cinephage's own UI
 * Only items that would actually change are returned (`willChange`),
 * matching Radarr/Sonarr's semantics: this endpoint lists pending renames,
 * not every file's current status.
 *
 * Field set confirmed against RenameMovieResource / RenameEpisodeResource
 * in Radarr/Sonarr's actual openapi.json - both are the same four fields.
 */

import { RenamePreviewService } from '#lib/server/library/naming/RenamePreviewService.js';
import { getEntityIdForArrId, getOrAssignArrId } from './ArrIdMappingService.js';

export async function buildMovieRename(movieArrId: number): Promise<Record<string, unknown>[]> {
	const movieId = await getEntityIdForArrId('movie', movieArrId);
	if (!movieId) return [];

	const service = new RenamePreviewService();
	const result = await service.previewMovie(movieId);

	return Promise.all(
		result.willChange.map(async (item) => ({
			id: await getOrAssignArrId('rename', item.fileId),
			movieId: movieArrId,
			movieFileId: await getOrAssignArrId('movieFile', item.fileId),
			existingPath: item.currentFullPath,
			newPath: item.newFullPath
		}))
	);
}

export async function buildSeriesRename(seriesArrId: number): Promise<Record<string, unknown>[]> {
	const seriesId = await getEntityIdForArrId('series', seriesArrId);
	if (!seriesId) return [];

	const service = new RenamePreviewService();
	const result = await service.previewSeries(seriesId);

	return Promise.all(
		result.willChange.map(async (item) => ({
			id: await getOrAssignArrId('rename', item.fileId),
			seriesId: seriesArrId,
			episodeFileId: await getOrAssignArrId('episodeFile', item.fileId),
			existingPath: item.currentFullPath,
			newPath: item.newFullPath
		}))
	);
}

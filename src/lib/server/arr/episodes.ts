/**
 * Sonarr-compatible `episode` (and EpisodeResource used by `/calendar`)
 * responses. Field set confirmed against EpisodeResource / EpisodeFileResource
 * in Sonarr's actual openapi.json, backed by Cinephage's `episodes` /
 * `episode_files` tables.
 *
 * Omits the nested `series` resource by default (real API only includes it
 * when `includeSeries=true`, same convention as movie/queue/history).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { episodes, episodeFiles } from '#lib/server/db/schema.js';
import { getOrAssignArrId, getOrAssignArrIds } from './ArrIdMappingService.js';

type EpisodeRow = typeof episodes.$inferSelect;
type EpisodeFileRow = typeof episodeFiles.$inferSelect;

function buildEpisodeFileResource(
	file: EpisodeFileRow,
	fileArrId: number,
	seriesArrId: number
): Record<string, unknown> {
	const resolution = file.quality?.resolution
		? Number.parseInt(file.quality.resolution, 10) || 0
		: 0;
	return {
		id: fileArrId,
		seriesId: seriesArrId,
		seasonNumber: file.seasonNumber,
		relativePath: file.relativePath,
		path: file.relativePath,
		size: file.size ?? 0,
		dateAdded: file.dateAdded,
		sceneName: file.sceneName,
		releaseGroup: file.releaseGroup,
		languages: (file.languages ?? []).map((name, i) => ({ id: i + 1, name })),
		quality: {
			quality: { id: 1, name: file.quality?.resolution ?? 'Unknown', resolution },
			revision: { version: 1, real: 0, isRepack: false }
		},
		customFormats: [],
		customFormatScore: 0,
		indexerFlags: 0,
		releaseType: file.releaseType ?? 'singleEpisode',
		mediaInfo: file.mediaInfo
			? {
					audioBitrate: file.mediaInfo.audioBitrate ?? 0,
					audioChannels: file.mediaInfo.audioChannels ?? 0,
					audioCodec: file.mediaInfo.audioCodec ?? null,
					audioLanguages: file.mediaInfo.audioLanguages ?? [],
					videoBitDepth: file.mediaInfo.videoBitDepth ?? 0,
					videoBitrate: file.mediaInfo.videoBitrate ?? 0,
					videoCodec: file.mediaInfo.videoCodec ?? null,
					videoFps: file.mediaInfo.fps ?? 0,
					videoDynamicRange: file.mediaInfo.videoHdrFormat ? 'HDR' : 'SDR',
					resolution:
						file.mediaInfo.width && file.mediaInfo.height
							? `${file.mediaInfo.width}x${file.mediaInfo.height}`
							: null,
					runTime: file.mediaInfo.runtime ?? null,
					subtitles: (file.mediaInfo.subtitleLanguages ?? []).join(', ')
				}
			: null,
		qualityCutoffNotMet: false
	};
}

/**
 * Episode files can cover multiple episodes (double episodes, season
 * packs) via `episodeIds` - build a lookup from each covered episode ID to
 * its file row rather than assuming a 1:1 relationship.
 */
async function loadEpisodeFileByEpisodeId(seriesId: string): Promise<Map<string, EpisodeFileRow>> {
	const files = await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));
	const map = new Map<string, EpisodeFileRow>();
	for (const file of files) {
		for (const episodeId of file.episodeIds ?? []) {
			map.set(episodeId, file);
		}
	}
	return map;
}

async function episodeToResource(
	row: EpisodeRow,
	file: EpisodeFileRow | undefined,
	episodeArrId: number,
	seriesArrId: number
): Promise<Record<string, unknown>> {
	const fileArrId = file ? await getOrAssignArrId('episodeFile', file.id) : null;

	return {
		id: episodeArrId,
		seriesId: seriesArrId,
		tvdbId: 0,
		episodeFileId: fileArrId ?? 0,
		seasonNumber: row.seasonNumber,
		episodeNumber: row.episodeNumber,
		title: row.title,
		airDate: row.airDate,
		airDateUtc: row.airDate,
		lastSearchTime: row.lastSearchTime,
		runtime: row.runtime ?? 0,
		overview: row.overview ?? '',
		...(file ? { episodeFile: buildEpisodeFileResource(file, fileArrId!, seriesArrId) } : {}),
		hasFile: !!row.hasFile,
		monitored: !!row.monitored,
		absoluteEpisodeNumber: row.absoluteEpisodeNumber ?? undefined,
		images: []
	};
}

interface EpisodeFilter {
	seriesArrId?: number;
	seriesId: string;
	seasonNumber?: number;
	episodeIds?: number[];
}

export async function buildEpisodesForSeries(
	filter: EpisodeFilter
): Promise<Record<string, unknown>[]> {
	const conditions = [eq(episodes.seriesId, filter.seriesId)];
	if (filter.seasonNumber !== undefined) {
		conditions.push(eq(episodes.seasonNumber, filter.seasonNumber));
	}
	const rows = await db
		.select()
		.from(episodes)
		.where(and(...conditions));

	const fileMap = await loadEpisodeFileByEpisodeId(filter.seriesId);
	const episodeArrIds = await getOrAssignArrIds(
		'episode',
		rows.map((r) => r.id)
	);
	const seriesArrId = filter.seriesArrId ?? (await getOrAssignArrId('series', filter.seriesId));

	const records = await Promise.all(
		rows.map((row) =>
			episodeToResource(row, fileMap.get(row.id), episodeArrIds.get(row.id)!, seriesArrId)
		)
	);

	if (filter.episodeIds?.length) {
		return records.filter((r) => filter.episodeIds!.includes(r.id as number));
	}
	return records;
}

/** GET /episode?episodeIds=... - lookup a batch of episodes by their surrogate IDs directly. */
export async function buildEpisodesByArrIds(arrIds: number[]): Promise<Record<string, unknown>[]> {
	if (arrIds.length === 0) return [];

	// Episode IDs don't carry which series they belong to until resolved -
	// resolve each surrogate ID back to its Cinephage UUID first.
	const { getEntityIdForArrId } = await import('./ArrIdMappingService.js');
	const episodeUuids = (
		await Promise.all(arrIds.map((id) => getEntityIdForArrId('episode', id)))
	).filter((id): id is string => !!id);
	if (episodeUuids.length === 0) return [];

	const rows = await db.select().from(episodes).where(inArray(episodes.id, episodeUuids));
	const seriesIds = [...new Set(rows.map((r) => r.seriesId))];
	const fileMapsBySeries = new Map(
		await Promise.all(
			seriesIds.map(async (id) => [id, await loadEpisodeFileByEpisodeId(id)] as const)
		)
	);
	const episodeArrIds = await getOrAssignArrIds(
		'episode',
		rows.map((r) => r.id)
	);
	const seriesArrIds = await getOrAssignArrIds('series', seriesIds);

	return Promise.all(
		rows.map((row) =>
			episodeToResource(
				row,
				fileMapsBySeries.get(row.seriesId)?.get(row.id),
				episodeArrIds.get(row.id)!,
				seriesArrIds.get(row.seriesId)!
			)
		)
	);
}

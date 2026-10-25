/**
 * Radarr/Sonarr-compatible `command` (POST) response.
 *
 * Real Radarr/Sonarr commands are queued/async and cover ~30 different
 * command names, each hitting a different subsystem. Rather than build a
 * full command dispatcher, this maps every command name with a clear,
 * confident Cinephage equivalent to a real trigger (fired without blocking
 * the HTTP response - real commands are async too, clients poll for
 * completion via GET /command): missing-item search, cutoff-unmet search,
 * root-folder rescan, metadata refresh, rename execution, and blocklist
 * clearing. Anything else (including Backup - see the note by its case)
 * is accepted and reported as completed, so a client sending an unmapped
 * command name still gets a valid response rather than an error.
 *
 * Field set confirmed against CommandResource in Radarr/Sonarr's actual
 * openapi.json.
 */

import { createChildLogger } from '#lib/logging/index.js';
import { monitoringSearchService } from '#lib/server/monitoring/search/MonitoringSearchService.js';
import { diskScanService } from '#lib/server/library/disk-scan.js';
import {
	refreshMovieMetadata,
	refreshSeriesMetadata
} from '#lib/server/metadata/metadata-refresh.js';
import { RenamePreviewService } from '#lib/server/library/naming/RenamePreviewService.js';
import { db } from '#lib/server/db/index.js';
import { movies, series, blocklist } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getEntityIdForArrId } from './ArrIdMappingService.js';
import { searchOnAdd } from '#lib/server/library/searchOnAdd/index.js';
import type { ArrAppName } from './systemStatus.js';

const logger = createChildLogger({ module: 'ArrCompatCommand', logDomain: 'system' });

let nextCommandId = 1;

interface CommandRecord {
	id: number;
	name: string;
	commandName: string;
	message: string;
	priority: string;
	status: 'started' | 'completed' | 'failed';
	queued: string;
	started: string;
	ended?: string;
	trigger: string;
	sendUpdatesToClient: boolean;
	updateScheduledTask: boolean;
	exception?: string;
}

/**
 * Real command history, keyed by id. Without this, GET /command (list) and
 * GET /command/{id} (poll-for-completion) had nothing to return but an empty
 * list; a client polling to confirm the command it just submitted actually
 * ran would see it "doesn't exist" and, per typical arr-client retry policy,
 * resubmit it. That's a real hammering vector: repeated resubmission of a
 * search command with no cooldown between attempts.
 */
const commandHistory = new Map<number, CommandRecord>();
const MAX_COMMAND_HISTORY = 200;

function recordCommand(record: CommandRecord): void {
	commandHistory.set(record.id, record);
	if (commandHistory.size > MAX_COMMAND_HISTORY) {
		const oldestId = commandHistory.keys().next().value;
		if (oldestId !== undefined) commandHistory.delete(oldestId);
	}
}

/** Fire a real trigger without blocking the HTTP response - matches how real command execution is async too. */
function fireAndForget(name: string, fn: () => Promise<unknown>, record: CommandRecord): void {
	record.status = 'started';
	fn()
		.then(() => {
			record.status = 'completed';
			record.ended = new Date().toISOString();
		})
		.catch((err) => {
			logger.warn({ err, command: name }, '[ArrCompatCommand] Background command failed');
			record.status = 'failed';
			record.ended = new Date().toISOString();
			record.exception = err instanceof Error ? err.message : String(err);
		});
}

async function resolveRootFolderScan(appName: ArrAppName, arrId: number): Promise<void> {
	const entityId = await getEntityIdForArrId(appName === 'Radarr' ? 'movie' : 'series', arrId);
	if (!entityId) return;

	const row =
		appName === 'Radarr'
			? await db
					.select({ rootFolderId: movies.rootFolderId })
					.from(movies)
					.where(eq(movies.id, entityId))
					.get()
			: await db
					.select({ rootFolderId: series.rootFolderId })
					.from(series)
					.where(eq(series.id, entityId))
					.get();

	if (row?.rootFolderId) {
		await diskScanService.scanRootFolder(row.rootFolderId);
	}
}

async function renameEntity(appName: ArrAppName, arrId: number): Promise<void> {
	const entityId = await getEntityIdForArrId(appName === 'Radarr' ? 'movie' : 'series', arrId);
	if (!entityId) return;

	const service = new RenamePreviewService();
	const preview =
		appName === 'Radarr'
			? await service.previewMovie(entityId)
			: await service.previewSeries(entityId);
	const fileIds = preview.willChange.map((item) => item.fileId);
	if (fileIds.length === 0) return;

	await service.executeRenames(fileIds, appName === 'Radarr' ? 'movie' : 'episode');
}

/** Coerce a value to a finite integer arr id, accepting both a real number
 * and a numeric string; some arr clients serialize ids as strings, and a
 * strict `typeof === 'number'` check would silently drop them, falling
 * through to an unscoped library-wide search instead of the one entity the
 * client actually asked for. */
function toArrId(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function collectIds(body: Record<string, unknown>, single: string, plural: string): number[] {
	const ids: number[] = [];
	const singleId = toArrId(body[single]);
	if (singleId !== null) ids.push(singleId);
	if (Array.isArray(body[plural])) {
		for (const id of body[plural]) {
			const parsed = toArrId(id);
			if (parsed !== null) ids.push(parsed);
		}
	}
	return ids;
}

/**
 * Targeted per-entity searches. Arr clients send command bodies with explicit
 * movieId/seriesId/episodeId(s); honoring them prevents a requested
 * single-entity search from launching a global library sweep.
 */
async function searchTargetedMovies(movieArrIds: number[]): Promise<void> {
	for (const arrId of movieArrIds) {
		const entityId = await getEntityIdForArrId('movie', arrId);
		if (!entityId) continue;
		const movie = await db.select().from(movies).where(eq(movies.id, entityId)).get();
		if (!movie) continue;
		await searchOnAdd.searchForMovie({
			movieId: movie.id,
			tmdbId: movie.tmdbId,
			imdbId: movie.imdbId,
			title: movie.title,
			year: movie.year ?? undefined,
			scoringProfileId: movie.scoringProfileId ?? undefined,
			bypassMonitoring: true
		});
	}
}

async function searchTargetedSeries(seriesArrIds: number[]): Promise<void> {
	for (const arrId of seriesArrIds) {
		const entityId = await getEntityIdForArrId('series', arrId);
		if (!entityId) continue;
		const show = await db.select().from(series).where(eq(series.id, entityId)).get();
		if (!show) continue;
		await searchOnAdd.searchForSeries({
			seriesId: show.id,
			tmdbId: show.tmdbId,
			tvdbId: show.tvdbId ?? null,
			imdbId: show.imdbId ?? null,
			title: show.title,
			year: show.year ?? undefined,
			scoringProfileId: show.scoringProfileId ?? undefined,
			bypassMonitoring: true
		});
	}
}

async function searchTargetedEpisodes(episodeArrIds: number[]): Promise<void> {
	for (const arrId of episodeArrIds) {
		const entityId = await getEntityIdForArrId('episode', arrId);
		if (!entityId) continue;
		await searchOnAdd.searchForEpisode({ episodeId: entityId, bypassMonitoring: true });
	}
}

export function handleCommand(
	appName: ArrAppName,
	body: Record<string, unknown>
): Record<string, unknown> {
	const name = (body.name as string) ?? '';
	const id = nextCommandId++;
	const now = new Date().toISOString();

	// Default: nothing dispatched below flips this; matches real commands
	// that have nothing to do (unmapped names, a rename with no changes to
	// make) reporting completed immediately. Any branch that does dispatch
	// work hands this same object to fireAndForget, which flips it to
	// 'started' synchronously and to 'completed'/'failed' once settled.
	const record: CommandRecord = {
		id,
		name,
		commandName: name,
		message: `Command ${name} accepted`,
		priority: 'normal',
		status: 'completed',
		queued: now,
		started: now,
		ended: now,
		trigger: 'manual',
		sendUpdatesToClient: false,
		updateScheduledTask: false
	};

	switch (name) {
		case 'MissingMoviesSearch':
		case 'MoviesSearch': {
			const movieIds = collectIds(body, 'movieId', 'movieIds');
			if (movieIds.length > 0) {
				fireAndForget(name, () => searchTargetedMovies(movieIds), record);
			} else {
				fireAndForget(name, () => monitoringSearchService.searchMissingMovies(), record);
			}
			break;
		}
		case 'MissingEpisodeSearch':
		case 'SeriesSearch':
		case 'EpisodeSearch': {
			const episodeIds = collectIds(body, 'episodeId', 'episodeIds');
			const seriesIds = collectIds(body, 'seriesId', 'seriesIds');
			if (episodeIds.length > 0) {
				fireAndForget(name, () => searchTargetedEpisodes(episodeIds), record);
			} else if (seriesIds.length > 0) {
				fireAndForget(name, () => searchTargetedSeries(seriesIds), record);
			} else {
				fireAndForget(name, () => monitoringSearchService.searchMissingEpisodes(), record);
			}
			break;
		}
		case 'RescanMovie': {
			const movieId = toArrId(body.movieId);
			if (movieId !== null) {
				fireAndForget(name, () => resolveRootFolderScan('Radarr', movieId), record);
			}
			break;
		}
		case 'RescanSeries': {
			const seriesId = toArrId(body.seriesId);
			if (seriesId !== null) {
				fireAndForget(name, () => resolveRootFolderScan('Sonarr', seriesId), record);
			}
			break;
		}
		case 'RefreshMovie': {
			const movieId = toArrId(body.movieId);
			if (movieId !== null) {
				fireAndForget(
					name,
					async () => {
						const entityId = await getEntityIdForArrId('movie', movieId);
						if (entityId) await refreshMovieMetadata(entityId);
					},
					record
				);
			}
			break;
		}
		case 'RefreshSeries': {
			const seriesId = toArrId(body.seriesId);
			if (seriesId !== null) {
				fireAndForget(
					name,
					async () => {
						const entityId = await getEntityIdForArrId('series', seriesId);
						if (entityId) await refreshSeriesMetadata(entityId);
					},
					record
				);
			}
			break;
		}
		case 'CutOffUnmetMoviesSearch':
			fireAndForget(
				name,
				() => monitoringSearchService.searchForUpgrades({ cutoffUnmetOnly: true }),
				record
			);
			break;
		case 'CutOffUnmetEpisodeSearch':
			fireAndForget(
				name,
				() => monitoringSearchService.searchForUpgrades({ cutoffUnmetOnly: true }),
				record
			);
			break;
		case 'ClearBlocklist':
			fireAndForget(
				name,
				async () => {
					await db.delete(blocklist);
				},
				record
			);
			break;
		case 'RenameMovie': {
			const movieIds = collectIds(body, 'movieId', 'movieIds');
			for (const movieId of movieIds) {
				fireAndForget(name, () => renameEntity('Radarr', movieId), record);
			}
			break;
		}
		case 'RenameSeries': {
			const seriesIds = collectIds(body, 'seriesId', 'seriesIds');
			for (const seriesId of seriesIds) {
				fireAndForget(name, () => renameEntity('Sonarr', seriesId), record);
			}
			break;
		}
		// Backup is intentionally not mapped: Cinephage's backup mechanism
		// requires a user-supplied encryption passphrase (ConfigurationBackupService),
		// which isn't available to an automated command trigger - there's no
		// safe value to supply on the caller's behalf.
		default:
			// Unmapped command name - accept it, but there's nothing real to
			// trigger. Reported as completed rather than erroring the caller.
			break;
	}

	recordCommand(record);
	return record as unknown as Record<string, unknown>;
}

/** GET /command - real command history, so a polling client sees actual
 * status instead of an empty list (which some arr clients treat as "the
 * command was lost" and resubmit, hammering whatever it triggers). */
export function listCommands(): Record<string, unknown>[] {
	return Array.from(commandHistory.values()) as unknown as Record<string, unknown>[];
}

/** GET /command/{id} */
export function getCommand(id: number): Record<string, unknown> | undefined {
	return commandHistory.get(id) as unknown as Record<string, unknown> | undefined;
}

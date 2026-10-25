/**
 * GET /api/queue
 * List all items in the download queue
 */

import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { downloadQueue, movies, series, downloadClients } from '#lib/server/db/schema.js';
import { eq, not, inArray, and, isNull, isNotNull } from 'drizzle-orm';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import type { QueueItem, QueueItemWithMedia, QueueStatus } from '#lib/types/queue.js';
import { redactUrl } from '#lib/server/utils/urlSecurity.js';

/**
 * Terminal statuses (items that are done processing)
 */
const TERMINAL_STATUSES: QueueStatus[] = ['imported', 'removed'];

export const GET: RequestHandler = async ({ url }) => {
	// Parse query params for filtering
	const statusParam = url.searchParams.get('status') as QueueStatus | 'all' | null;
	const mediaType = url.searchParams.get('mediaType') as 'movie' | 'tv' | 'all' | null;
	const clientId = url.searchParams.get('clientId');
	const includeTerminal = url.searchParams.get('includeTerminal') === 'true';

	// Build where conditions
	const conditions = [];

	// Status filter
	if (statusParam && statusParam !== 'all') {
		conditions.push(eq(downloadQueue.status, statusParam));
	} else if (!includeTerminal) {
		// By default, exclude terminal statuses
		conditions.push(not(inArray(downloadQueue.status, TERMINAL_STATUSES)));
	}

	// Media type filter
	if (mediaType === 'movie') {
		conditions.push(and(isNotNull(downloadQueue.movieId), isNull(downloadQueue.seriesId)));
	} else if (mediaType === 'tv') {
		conditions.push(and(isNotNull(downloadQueue.seriesId), isNull(downloadQueue.movieId)));
	}

	// Client filter
	if (clientId) {
		conditions.push(eq(downloadQueue.downloadClientId, clientId));
	}

	// Query with conditions
	const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

	const rows = whereClause
		? await db.select().from(downloadQueue).where(whereClause)
		: await db
				.select()
				.from(downloadQueue)
				.where(not(inArray(downloadQueue.status, TERMINAL_STATUSES)));

	// Collect unique IDs for batch queries
	const movieIds = [...new Set(rows.filter((r) => r.movieId).map((r) => r.movieId!))];
	const seriesIds = [...new Set(rows.filter((r) => r.seriesId).map((r) => r.seriesId!))];
	const clientIds = [...new Set(rows.map((r) => r.downloadClientId))];

	// Batch fetch all related data in parallel
	const [moviesData, seriesData, clientsData] = await Promise.all([
		movieIds.length
			? db
					.select({
						id: movies.id,
						tmdbId: movies.tmdbId,
						title: movies.title,
						year: movies.year,
						posterPath: movies.posterPath
					})
					.from(movies)
					.where(inArray(movies.id, movieIds))
			: [],
		seriesIds.length
			? db
					.select({
						id: series.id,
						tmdbId: series.tmdbId,
						title: series.title,
						year: series.year,
						posterPath: series.posterPath
					})
					.from(series)
					.where(inArray(series.id, seriesIds))
			: [],
		clientIds.length
			? db
					.select({
						id: downloadClients.id,
						name: downloadClients.name,
						implementation: downloadClients.implementation
					})
					.from(downloadClients)
					.where(inArray(downloadClients.id, clientIds))
			: []
	]);

	// Build lookup maps for O(1) access
	const movieMap = new Map(moviesData.map((m) => [m.id, m]));
	const seriesMap = new Map(seriesData.map((s) => [s.id, s]));
	const clientMap = new Map(clientsData.map((c) => [c.id, c]));

	// Enrich queue items with media info using maps
	// Note: downloadUrl is redacted to prevent API key exposure in responses
	const items: QueueItemWithMedia[] = rows.map((row) => ({
		id: row.id,
		downloadClientId: row.downloadClientId,
		downloadId: row.downloadId,
		title: row.title,
		indexerId: row.indexerId,
		indexerName: row.indexerName,
		downloadUrl: row.downloadUrl ? redactUrl(row.downloadUrl) : null,
		magnetUrl: row.magnetUrl,
		protocol: row.protocol,
		movieId: row.movieId,
		seriesId: row.seriesId,
		episodeIds: row.episodeIds as string[] | null,
		seasonNumber: row.seasonNumber,
		status: row.status as QueueStatus,
		progress: parseFloat(row.progress || '0'),
		size: row.size,
		downloadSpeed: row.downloadSpeed || 0,
		uploadSpeed: row.uploadSpeed || 0,
		eta: row.eta,
		ratio: parseFloat(row.ratio || '0'),
		clientDownloadPath: row.clientDownloadPath,
		outputPath: row.outputPath,
		importedPath: row.importedPath,
		quality: row.quality as QueueItem['quality'],
		addedAt: row.addedAt || new Date().toISOString(),
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		importedAt: row.importedAt,
		errorMessage: row.errorMessage,
		importAttempts: row.importAttempts || 0,
		lastAttemptAt: row.lastAttemptAt,
		isAutomatic: !!row.isAutomatic,
		isUpgrade: !!row.isUpgrade,
		movie: row.movieId ? movieMap.get(row.movieId) || null : null,
		series: row.seriesId ? seriesMap.get(row.seriesId) || null : null,
		downloadClient: clientMap.get(row.downloadClientId) || null
	}));

	// Get stats
	const stats = await downloadMonitor.getStats();

	return Response.json({
		success: true,
		data: {
			items,
			stats
		}
	});
};

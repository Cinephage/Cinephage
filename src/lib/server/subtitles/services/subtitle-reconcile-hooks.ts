/**
 * Subtitle reconciliation hooks.
 *
 * The subtitle scanner is disk-aware but must run after the library scanner has
 * settled so it sees the current media items and their files. Two integration
 * points invoke these hooks:
 *
 *  (a) `LibrarySchedulerService.runFullScan` / `runFolderScan` after the disk
 *      scan completes — covers scheduled/startup scans and manual/hosted scans
 *      (LibraryJobWorker delegates to these).
 *  (b) `LibraryWatcherService.processPendingChanges` after its incremental scan
 *      — covers filesystem add/change/delete events.
 *
 * Both call `scheduleReconcileRootFolder(rootFolderId)`, which enumerates the
 * media items in that root folder and schedules a per-item reconciliation.
 * Debouncing per media item coalesces watcher/scanner bursts for the same show
 * or movie while keeping the work scoped to the root folder that was scanned.
 * Note that sidecar-only changes are not visible to the filesystem watcher
 * (it ignores non-video files), so the scan-completion hook is what catches a
 * newly dropped `.srt` next to an existing video.
 *
 * The hook is best-effort: every failure is logged and swallowed so a subtitle
 * problem can never fail a library scan or watcher cycle.
 */

import { db } from '#lib/server/db/index.js';
import { movies, series, episodeFiles } from '#lib/server/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { getSubtitleScannerService } from './SubtitleScannerService';

const logger = createChildLogger({ logDomain: 'subtitles' as const });

/** Trailing debounce applied per media item. */
export const SUBTITLE_RECONCILE_DEBOUNCE_MS = 1500;

const pending = new Map<string, NodeJS.Timeout>();

function scheduleItem(key: string, run: () => Promise<unknown>): void {
	const existing = pending.get(key);
	if (existing) clearTimeout(existing);

	const timer = setTimeout(() => {
		pending.delete(key);
		void run().catch((error) => {
			logger.warn({ error, key }, '[SubtitleScanner] reconcile hook failed (non-fatal)');
		});
	}, SUBTITLE_RECONCILE_DEBOUNCE_MS);

	// Never hold the process open just for a debounced reconcile.
	timer.unref?.();
	pending.set(key, timer);
}

/** Schedule a debounced reconciliation for one movie. */
export function scheduleReconcileMovie(movieId: string): void {
	scheduleItem(`movie:${movieId}`, () => getSubtitleScannerService().scanMovieSubtitles(movieId));
}

/** Schedule a debounced reconciliation for one series. */
export function scheduleReconcileSeries(seriesId: string): void {
	scheduleItem(`series:${seriesId}`, () =>
		getSubtitleScannerService().scanSeriesSubtitles(seriesId)
	);
}

/**
 * Enumerate the movies/series in a root folder and schedule a debounced
 * reconciliation for each. Never throws.
 *
 * File-row-driven (Sonarr parity: subtitle scans ride on existing media
 * files, not on library rows). Items with no files — wanted-but-missing
 * entries whose folders don't exist yet, or rows whose files were removed —
 * have nothing to discover and no folder to read, so they are not scheduled.
 */
export async function scheduleReconcileRootFolder(rootFolderId: string): Promise<void> {
	try {
		const [movieRows, seriesRows] = await Promise.all([
			db
				.select({ id: movies.id })
				.from(movies)
				// hasFile=false movies have no folder on disk by design.
				.where(and(eq(movies.rootFolderId, rootFolderId), eq(movies.hasFile, true))),
			db
				.selectDistinct({ id: series.id })
				.from(series)
				.innerJoin(episodeFiles, eq(episodeFiles.seriesId, series.id))
				.where(eq(series.rootFolderId, rootFolderId))
		]);

		for (const movie of movieRows) scheduleReconcileMovie(movie.id);
		for (const show of seriesRows) scheduleReconcileSeries(show.id);

		if (movieRows.length > 0 || seriesRows.length > 0) {
			logger.debug(
				{ rootFolderId, movies: movieRows.length, series: seriesRows.length },
				'[SubtitleScanner] scheduled subtitle reconciliation'
			);
		}
	} catch (error) {
		logger.warn(
			{ error, rootFolderId },
			'[SubtitleScanner] could not enumerate media for reconciliation (non-fatal)'
		);
	}
}

/** Clear all pending debounce timers (used by tests / shutdown). */
export function resetSubtitleReconcileHooks(): void {
	for (const timer of pending.values()) clearTimeout(timer);
	pending.clear();
}

/**
 * Scheduled search for monitored albums that have no files.
 *
 * Movies and episodes are walked by `MonitoringSearchService`; music has its
 * own acquisition unit (the album) and its own guard (`autoSearchAlbum`), so it
 * gets one small loop rather than a branch inside the video search. The album's
 * `last_searched_at` is the cooldown clock, and an album already sitting in the
 * queue is skipped: the grab service would refuse it anyway, and a second search
 * only burns indexer requests.
 */

import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists, downloadQueue } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { autoSearchAlbum } from './MusicAutoSearch.js';

const logger = createChildLogger({ module: 'MusicMonitoringSearch', logDomain: 'monitoring' });

export interface MusicSearchItem {
	albumId: string;
	title: string;
	artistName: string;
	searched: boolean;
	grabbed: boolean;
	release?: string;
	error?: string;
	skipped?: string;
}

export interface MusicSearchSummary {
	searched: number;
	grabbed: number;
	errors: number;
	skipped: number;
}

export interface MissingMusicOptions {
	ignoreCooldown?: boolean;
	cooldownHours?: number;
	/** Hard cap for one run; 0 or omitted means every eligible album. */
	limit?: number;
}

const ACTIVE_QUEUE_STATUSES = ['removed', 'failed', 'imported'];

export async function searchMissingMusic(
	signal?: AbortSignal,
	options: MissingMusicOptions = {}
): Promise<{ summary: MusicSearchSummary; items: MusicSearchItem[] }> {
	const rows = db
		.select({
			albumId: albums.id,
			mediaItemId: albums.mediaItemId,
			title: albums.title,
			artistName: artists.name,
			lastSearchedAt: albums.lastSearchedAt
		})
		.from(albums)
		.innerJoin(artists, eq(albums.artistId, artists.id))
		.where(and(eq(albums.monitored, true), eq(albums.hasFile, false), eq(artists.monitored, true)))
		.all();

	const cutoff =
		options.ignoreCooldown || !options.cooldownHours
			? null
			: Date.now() - options.cooldownHours * 60 * 60 * 1000;
	const limit = options.limit && options.limit > 0 ? options.limit : rows.length;

	const items: MusicSearchItem[] = [];
	const summary: MusicSearchSummary = { searched: 0, grabbed: 0, errors: 0, skipped: 0 };
	let searchedCount = 0;

	for (const row of rows) {
		if (signal?.aborted) break;
		if (searchedCount >= limit) break;

		if (cutoff && row.lastSearchedAt) {
			const last = new Date(row.lastSearchedAt).getTime();
			if (Number.isFinite(last) && last > cutoff) {
				summary.skipped++;
				continue;
			}
		}

		const active = db
			.select({ id: downloadQueue.id })
			.from(downloadQueue)
			.where(
				and(
					eq(downloadQueue.mediaItemId, row.mediaItemId),
					notInArray(downloadQueue.status, ACTIVE_QUEUE_STATUSES)
				)
			)
			.get();
		if (active) {
			summary.skipped++;
			items.push({
				albumId: row.albumId,
				title: row.title,
				artistName: row.artistName,
				searched: false,
				grabbed: false,
				skipped: 'already queued'
			});
			continue;
		}

		summary.searched++;
		searchedCount++;
		const result = await autoSearchAlbum({ id: row.albumId, title: row.title });
		db.update(albums)
			.set({ lastSearchedAt: new Date().toISOString() })
			.where(eq(albums.id, row.albumId))
			.run();

		if (result.grabbed) summary.grabbed++;
		if (result.error) summary.errors++;

		items.push({
			albumId: row.albumId,
			title: row.title,
			artistName: row.artistName,
			searched: true,
			grabbed: result.grabbed,
			release: result.release,
			error: result.error
		});
	}

	logger.info(
		{ ...summary, albums: rows.length },
		'[MusicMonitoringSearch] monitored album search completed'
	);
	return { summary, items };
}

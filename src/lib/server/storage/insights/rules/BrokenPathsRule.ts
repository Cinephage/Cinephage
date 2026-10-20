import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import {
	episodeFiles,
	movieFiles,
	movies,
	rootFolders,
	series,
	storageItems
} from '#lib/server/db/schema.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from '../types.js';

const YIELD_INTERVAL = 500;

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Verifies that file paths referenced by storage_items still exist on disk.
 * Builds full paths by joining storage_items -> movie_files/episode_files ->
 * movies/series -> root_folders. Uses synchronous existsSync (~microseconds).
 */
export class BrokenPathsRule implements StorageInsightRule {
	readonly type = 'broken-paths' as const;

	async evaluate(ctx: RuleContext): Promise<InsightFinding[]> {
		// Build a root folder path lookup
		const folders = ctx.db.select().from(rootFolders).all();
		const folderPathById = new Map(folders.map((f) => [f.id, f.path]));

		// Load movie-file-backed storage items with full path resolution
		const movieBacked = ctx.db
			.select({
				storageId: storageItems.id,
				title: storageItems.title,
				tmdbId: storageItems.tmdbId,
				rootFolderId: storageItems.rootFolderId,
				relativePath: movieFiles.relativePath,
				moviePath: movies.path
			})
			.from(storageItems)
			.innerJoin(movieFiles, sql`${storageItems.movieFileId} = ${movieFiles.id}`)
			.innerJoin(movies, sql`${movieFiles.movieId} = ${movies.id}`)
			.all();

		// Load episode-file-backed storage items
		const episodeBacked = ctx.db
			.select({
				storageId: storageItems.id,
				title: storageItems.title,
				tmdbId: storageItems.tmdbId,
				rootFolderId: storageItems.rootFolderId,
				relativePath: episodeFiles.relativePath,
				seriesPath: series.path
			})
			.from(storageItems)
			.innerJoin(episodeFiles, sql`${storageItems.episodeFileId} = ${episodeFiles.id}`)
			.innerJoin(series, sql`${episodeFiles.seriesId} = ${series.id}`)
			.all();

		const broken: Array<{
			storageId: string;
			title: string;
			tmdbId: number | null;
			itemType: 'movie' | 'episode';
			fullPath: string;
		}> = [];

		// existsSync() is a blocking syscall per file - yielding periodically
		// keeps this rule from freezing the event loop for its full duration
		// on a large library.
		let processed = 0;
		for (const row of movieBacked) {
			const rootPath = row.rootFolderId ? folderPathById.get(row.rootFolderId) : null;
			if (rootPath) {
				const fullPath = join(rootPath, row.moviePath ?? '', row.relativePath ?? '');
				if (!existsSync(fullPath)) {
					broken.push({
						storageId: row.storageId,
						title: row.title,
						tmdbId: row.tmdbId,
						itemType: 'movie',
						fullPath
					});
				}
			}
			if (++processed % YIELD_INTERVAL === 0) await yieldToEventLoop();
		}

		for (const row of episodeBacked) {
			const rootPath = row.rootFolderId ? folderPathById.get(row.rootFolderId) : null;
			if (rootPath) {
				const fullPath = join(rootPath, row.seriesPath ?? '', row.relativePath ?? '');
				if (!existsSync(fullPath)) {
					broken.push({
						storageId: row.storageId,
						title: row.title,
						tmdbId: row.tmdbId,
						itemType: 'episode',
						fullPath
					});
				}
			}
			if (++processed % YIELD_INTERVAL === 0) await yieldToEventLoop();
		}

		if (broken.length === 0) return [];

		return [
			{
				type: this.type,
				severity: 'critical',
				scope: 'global',
				title: `Broken file paths`,
				summary: `${broken.length} item${broken.length === 1 ? "'s" : 's'} file${broken.length === 1 ? '' : 's'} no longer exist${broken.length === 1 ? 's' : ''} on disk. The DB record is stale — run a scan to clean up.`,
				details: {
					items: broken.map((b) => ({
						storageId: b.storageId,
						title: b.title,
						tmdbId: b.tmdbId,
						itemType: b.itemType
					}))
				},
				itemCount: broken.length
			}
		];
	}
}

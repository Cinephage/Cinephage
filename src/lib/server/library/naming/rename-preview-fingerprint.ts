import { createHash } from 'node:crypto';
import { count } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	episodes,
	episodeFiles,
	movieFiles,
	movies,
	rootFolders,
	series
} from '#lib/server/db/schema.js';
import { namingSettingsService } from './NamingSettingsService.js';

/**
 * Fingerprint everything that must invalidate the ENTIRE bulk rename preview:
 * the effective naming config, the root folder layout, and the row counts of
 * every table the preview iterates. Structural changes flip the fingerprint
 * even when no fine-grained library event fires (config restore, bulk adds,
 * unmatched matches, manual imports, root folder edits), so the cache can
 * self-validate on read instead of trusting event coverage alone.
 */
export async function computeRenamePreviewFingerprint(): Promise<string> {
	const config = namingSettingsService.getConfigSync();

	const [roots, movieCount, movieFileCount, seriesCount, episodeCount, episodeFileCount] =
		await Promise.all([
			db.select({ id: rootFolders.id, path: rootFolders.path }).from(rootFolders),
			db
				.select({ c: count() })
				.from(movies)
				.then((r) => r[0]?.c ?? 0),
			db
				.select({ c: count() })
				.from(movieFiles)
				.then((r) => r[0]?.c ?? 0),
			db
				.select({ c: count() })
				.from(series)
				.then((r) => r[0]?.c ?? 0),
			db
				.select({ c: count() })
				.from(episodes)
				.then((r) => r[0]?.c ?? 0),
			db
				.select({ c: count() })
				.from(episodeFiles)
				.then((r) => r[0]?.c ?? 0)
		]);

	const payload = JSON.stringify({
		config,
		roots: roots
			.map((root) => ({ id: root.id, path: root.path }))
			.sort((a, b) => a.id.localeCompare(b.id)),
		counts: {
			movies: movieCount,
			movieFiles: movieFileCount,
			series: seriesCount,
			episodes: episodeCount,
			episodeFiles: episodeFileCount
		}
	});

	return createHash('sha256').update(payload).digest('hex');
}

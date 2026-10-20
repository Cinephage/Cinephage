import { sql } from 'drizzle-orm';
import { movieFiles, movies } from '#lib/server/db/schema.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from '../types.js';

/**
 * Detects movies with multiple movie_files rows pointing to the same tmdbId AND
 * the same resolution. A movie with files at DIFFERENT resolutions (multi-quality
 * mode) is intentional and is NOT a duplicate. A genuine duplicate is two or more
 * files at the SAME resolution (e.g. two 1080p encodes) that the user may want to
 * clean up.
 *
 * Episode duplicate detection is deferred — it requires comparing
 * episodeIds JSON arrays across episode_files to find overlapping
 * episode coverage, which is non-trivial in SQLite.
 */
export class DuplicateItemsRule implements StorageInsightRule {
	readonly type = 'duplicate-items' as const;

	async evaluate(ctx: RuleContext): Promise<InsightFinding[]> {
		type DupeGroupRow = {
			movieId: string;
			tmdbId: number | null;
			title: string | null;
			resolution: string;
			fileCount: number;
		};

		// GROUP BY movie+resolution HAVING COUNT(*) > 1 returns only the
		// duplicate groups directly.
		const resolutionExpr = sql`coalesce(json_extract(${movieFiles.quality}, '$.resolution'), 'unknown')`;
		const dupeGroups = ctx.db
			.select({
				movieId: movies.id,
				tmdbId: movies.tmdbId,
				title: movies.title,
				resolution: resolutionExpr.as('resolution'),
				fileCount: sql<number>`count(*)`
			})
			.from(movies)
			.innerJoin(movieFiles, sql`${movieFiles.movieId} = ${movies.id}`)
			.where(sql`${movies.tmdbId} IS NOT NULL`)
			.groupBy(movies.id, resolutionExpr)
			.having(sql`count(*) > 1`)
			.all() as DupeGroupRow[];

		// A movie can have more than one dupe-resolution group; fileCount is
		// the max across them.
		const movieMap = new Map<
			string,
			{ tmdbId: number | null; title: string | null; fileCount: number }
		>();
		for (const row of dupeGroups) {
			const entry = movieMap.get(row.movieId);
			if (!entry || row.fileCount > entry.fileCount) {
				movieMap.set(row.movieId, {
					tmdbId: row.tmdbId,
					title: row.title,
					fileCount: row.fileCount
				});
			}
		}

		const duplicates = [...movieMap.values()];

		if (duplicates.length === 0) return [];

		const totalDupes = duplicates.length;
		return [
			{
				type: this.type,
				severity: 'warning',
				scope: 'global',
				title: `Duplicate items`,
				summary: `${totalDupes} Movie${totalDupes === 1 ? ' has' : 's have'} multiple files. You may want to remove duplicates to reclaim space.`,
				details: {
					items: duplicates.map((d) => ({
						tmdbId: d.tmdbId,
						title: d.title,
						fileCount: d.fileCount
					}))
				},
				itemCount: totalDupes
			}
		];
	}
}

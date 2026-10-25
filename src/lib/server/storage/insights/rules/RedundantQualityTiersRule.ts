import { sql } from 'drizzle-orm';
import { movieFiles, movies, scoringProfiles } from '#lib/server/db/schema.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from '../types.js';
import {
	effectiveBuckets,
	redundantFileIds,
	type BucketFile
} from '#lib/server/quality/buckets.js';

/**
 * Surfaces movie files that no longer fit the movie's desired-quality tiers.
 *
 * When `desiredQualities` shrinks or is removed, files outside the (now
 * smaller) set of effective tiers become silent orphans — e.g. a 720p file
 * next to a multi-quality [2160p, 1080p] config, or any non-best file when the
 * movie is single-quality. This rule ONLY surfaces them (severity: info, with a
 * deep-link via the insight type); Cinephage never auto-deletes files.
 *
 * Movie-only: multi-quality is not an episode concept. Unknown-resolution
 * files are never flagged (we don't auto-classify what we can't identify).
 */
export class RedundantQualityTiersRule implements StorageInsightRule {
	readonly type = 'redundant-quality-tiers' as const;

	async evaluate(ctx: RuleContext): Promise<InsightFinding[]> {
		type Row = {
			movieId: string;
			tmdbId: number | null;
			title: string | null;
			desiredQualities: unknown;
			minResolution: string | null;
			maxResolution: string | null;
			fileId: string;
			relativePath: string;
			quality: unknown;
			size: number | null;
		};

		const rows = ctx.db
			.select({
				movieId: movies.id,
				tmdbId: movies.tmdbId,
				title: movies.title,
				desiredQualities: movies.desiredQualities,
				minResolution: scoringProfiles.minResolution,
				maxResolution: scoringProfiles.maxResolution,
				fileId: movieFiles.id,
				relativePath: movieFiles.relativePath,
				quality: movieFiles.quality,
				size: movieFiles.size
			})
			.from(movies)
			.innerJoin(movieFiles, sql`${movieFiles.movieId} = ${movies.id}`)
			.leftJoin(scoringProfiles, sql`${scoringProfiles.id} = ${movies.scoringProfileId}`)
			.where(sql`${movies.tmdbId} IS NOT NULL`)
			.all() as Row[];

		const movieMap = new Map<
			string,
			{
				tmdbId: number | null;
				title: string | null;
				desiredQualities: unknown;
				minResolution: string | null;
				maxResolution: string | null;
				files: BucketFile[];
			}
		>();

		for (const row of rows) {
			let entry = movieMap.get(row.movieId);
			if (!entry) {
				entry = {
					tmdbId: row.tmdbId,
					title: row.title,
					desiredQualities: row.desiredQualities,
					minResolution: row.minResolution,
					maxResolution: row.maxResolution,
					files: []
				};
				movieMap.set(row.movieId, entry);
			}
			entry.files.push({
				id: row.fileId,
				relativePath: row.relativePath,
				quality: row.quality as { resolution?: string } | null,
				size: row.size
			});
		}

		const redundant = [...movieMap.values()]
			.map((entry) => {
				const desired = (entry.desiredQualities as Resolution[] | null) ?? null;
				const effective = effectiveBuckets(desired, entry.minResolution, entry.maxResolution);
				const fileIds = redundantFileIds(entry.files, effective);
				return {
					tmdbId: entry.tmdbId,
					title: entry.title,
					redundantCount: fileIds.length
				};
			})
			.filter((d) => d.redundantCount > 0);

		if (redundant.length === 0) return [];

		const total = redundant.length;
		return [
			{
				type: this.type,
				severity: 'info',
				scope: 'global',
				title: 'Redundant quality files',
				summary: `${total} movie${total === 1 ? ' has' : 's have'} files that no longer fit the desired quality tiers. Review them to reclaim space.`,
				details: {
					items: redundant.map((d) => ({
						tmdbId: d.tmdbId,
						title: d.title,
						redundantCount: d.redundantCount
					}))
				},
				itemCount: total
			}
		];
	}
}

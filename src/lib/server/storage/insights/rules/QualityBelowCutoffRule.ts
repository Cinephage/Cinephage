import { sql } from 'drizzle-orm';
import {
	episodeFiles,
	movieFiles,
	movies,
	scoringProfiles,
	series
} from '#lib/server/db/schema.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from '../types.js';

/**
 * Resolution ordinal scale (higher = better). Matches RESOLUTION_ORDER
 * from src/lib/server/indexers/parser/types.ts but inlined here to avoid
 * a cross-domain import dependency.
 */
const RESOLUTION_ORDER: Record<string, number> = {
	'2160p': 4,
	'1080p': 3,
	'720p': 2,
	'480p': 1,
	unknown: 0
};

/**
 * Finds media whose stored quality.resolution is below their scoring profile's
 * minResolution. Covers both movies and episodes. These are candidates for
 * upgrade searches.
 *
 * NOTE: The monitoring system's CutoffUnmetSpecification was softened to always
 * accept (hard cutoffs removed). This rule is the NEW logic that surfaces
 * below-cutoff items for display purposes — it does NOT trigger automatic
 * upgrades.
 */
export class QualityBelowCutoffRule implements StorageInsightRule {
	readonly type = 'quality-below-cutoff' as const;

	async evaluate(ctx: RuleContext): Promise<InsightFinding[]> {
		type MovieRow = {
			movieId: string;
			title: string | null;
			tmdbId: number | null;
			quality: unknown;
			minResolution: string | null;
			profileName: string | null;
		};

		const resolutionOf = (quality: unknown): string =>
			(quality as { resolution?: string } | null)?.resolution ?? 'unknown';

		// Movies: join movies → movie_files → scoring_profiles
		const movieRows = ctx.db
			.select({
				movieId: movies.id,
				title: movies.title,
				tmdbId: movies.tmdbId,
				quality: movieFiles.quality,
				minResolution: scoringProfiles.minResolution,
				profileName: scoringProfiles.name
			})
			.from(movies)
			.innerJoin(movieFiles, sql`${movieFiles.movieId} = ${movies.id}`)
			.leftJoin(scoringProfiles, sql`${scoringProfiles.id} = ${movies.scoringProfileId}`)
			.where(sql`${movies.tmdbId} IS NOT NULL`)
			.all() as MovieRow[];

		// Multi-quality mode: a movie may have several movie_files at DIFFERENT
		// resolutions. Only the BEST file per movie should be evaluated against the
		// cutoff — an intentional lower-resolution tier is not a below-cutoff
		// candidate when a higher tier already satisfies the profile.
		const bestPerMovie = new Map<string, MovieRow>();
		for (const row of movieRows) {
			const res = resolutionOf(row.quality);
			const ordinal = RESOLUTION_ORDER[res] ?? 0;
			const current = bestPerMovie.get(row.movieId);
			if (!current) {
				bestPerMovie.set(row.movieId, row);
				continue;
			}
			const currentRes = resolutionOf(current.quality);
			const currentOrdinal = RESOLUTION_ORDER[currentRes] ?? 0;
			if (ordinal > currentOrdinal) {
				bestPerMovie.set(row.movieId, row);
			}
		}
		const dedupedMovieRows = [...bestPerMovie.values()];

		// Episodes: join series → episode_files → scoring_profiles
		// (multi-quality is a movie-only feature; episodes are left unchanged)
		const episodeRows = ctx.db
			.select({
				title: series.title,
				tmdbId: series.tmdbId,
				quality: episodeFiles.quality,
				minResolution: scoringProfiles.minResolution,
				profileName: scoringProfiles.name
			})
			.from(series)
			.innerJoin(episodeFiles, sql`${episodeFiles.seriesId} = ${series.id}`)
			.leftJoin(scoringProfiles, sql`${scoringProfiles.id} = ${series.scoringProfileId}`)
			.where(sql`${series.tmdbId} IS NOT NULL`)
			.all();

		// Movie and series tmdbIds are independent namespaces, so every row
		// carries its own itemType rather than letting downstream consumers
		// guess which table a tmdbId belongs to (a movie and an unrelated
		// show can share the same numeric id).
		const allRows = [
			...dedupedMovieRows.map((r) => ({ ...r, itemType: 'movie' as const })),
			...episodeRows.map((r) => ({ ...r, itemType: 'episode' as const }))
		];

		const belowCutoff = allRows.filter((row) => {
			if (!row.minResolution) return false;
			const fileRes = resolutionOf(row.quality);
			const fileOrdinal = RESOLUTION_ORDER[fileRes] ?? 0;
			const cutoffOrdinal = RESOLUTION_ORDER[row.minResolution] ?? 0;
			return fileOrdinal < cutoffOrdinal;
		});

		if (belowCutoff.length === 0) return [];

		return [
			{
				type: this.type,
				severity: 'info',
				scope: 'global',
				title: `Items below quality cutoff`,
				summary: `${belowCutoff.length} item${belowCutoff.length === 1 ? '' : 's'} ${belowCutoff.length === 1 ? 'has' : 'have'} a resolution below ${belowCutoff.length === 1 ? 'its' : 'their'} profile's minimum. These are candidates for upgrade searches.`,
				details: {
					items: belowCutoff.map((r) => ({
						tmdbId: r.tmdbId,
						title: r.title,
						itemType: r.itemType,
						currentResolution: resolutionOf(r.quality),
						minResolution: r.minResolution
					}))
				},
				itemCount: belowCutoff.length
			}
		];
	}
}

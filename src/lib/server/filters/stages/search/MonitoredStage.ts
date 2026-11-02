import type { DecisionStage, StageResult } from '../../types.js';
import type { SearchEligibilityContext } from './types.js';
import { db } from '#lib/server/db/index.js';
import { seasons } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

export class MonitoredStage implements DecisionStage<SearchEligibilityContext> {
	name = 'monitored';

	isEnabled(ctx: SearchEligibilityContext): boolean {
		return !ctx.options.forceSearch;
	}

	async evaluate(ctx: SearchEligibilityContext): Promise<StageResult> {
		if (ctx.episode) {
			return this.evaluateEpisode(ctx);
		}
		return this.evaluateMovie(ctx);
	}

	private evaluateMovie(ctx: SearchEligibilityContext): StageResult {
		if (!ctx.media.monitored) {
			return { accepted: false, reason: 'Movie is not monitored' };
		}
		return { accepted: true };
	}

	private async evaluateEpisode(ctx: SearchEligibilityContext): Promise<StageResult> {
		if (!ctx.series?.monitored) {
			return { accepted: false, reason: 'Series is not monitored' };
		}

		if (!ctx.episode!.monitored) {
			return { accepted: false, reason: 'Episode is not monitored' };
		}

		if (!ctx.episode!.seasonId) {
			return { accepted: true };
		}

		const season = await db.query.seasons.findFirst({
			where: eq(seasons.id, ctx.episode!.seasonId)
		});

		if (season && !season.monitored) {
			return { accepted: false, reason: 'Season is not monitored' };
		}

		return { accepted: true };
	}
}

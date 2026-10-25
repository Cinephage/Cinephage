import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';
import { delayProfileService } from '#lib/server/monitoring/specifications/DelaySpecification.js';

export class DelayStage implements DecisionStage<GrabDecisionContext> {
	name = 'delay';

	isEnabled(ctx: GrabDecisionContext): boolean {
		return !ctx.options.skipDelay && !ctx.options.force;
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const { release, target, computed } = ctx;

		const movieId = target.type === 'movie' ? target.movieId : undefined;
		const seriesId = 'seriesId' in target ? target.seriesId : undefined;

		const quality = computed.scoringResult
			? {
					resolution: computed.scoringResult.resolution ?? undefined,
					source: undefined as string | undefined,
					codec: undefined as string | undefined,
					hdr: undefined as string | undefined
				}
			: undefined;

		const delayResult = await delayProfileService.calculateDelay(
			{
				title: release.title,
				score: computed.candidateScore ?? 0,
				size: release.size,
				infoHash: release.infoHash,
				protocol: release.protocol ?? 'torrent',
				publishDate: release.publishDate,
				quality
			},
			{ movieId, seriesId }
		);

		if (!delayResult.shouldDelay) {
			return {
				accepted: true,
				details: delayResult.bypassReason ? { bypassReason: delayResult.bypassReason } : undefined
			};
		}

		// Add to pending queue and reject this immediate grab
		const episodeIds =
			target.type === 'episode'
				? [target.episodeId]
				: target.type === 'season' || target.type === 'series'
					? target.episodeIds
					: undefined;

		await delayProfileService.addToPending(
			{
				title: release.title,
				score: computed.candidateScore ?? 0,
				size: release.size,
				infoHash: release.infoHash,
				downloadUrl: release.downloadUrl,
				magnetUrl: release.magnetUrl,
				indexerId: release.indexerId,
				protocol: release.protocol ?? 'torrent',
				publishDate: release.publishDate,
				quality
			},
			{
				movieId,
				seriesId,
				episodeIds,
				processAt: delayResult.processAt!
			}
		);

		return {
			accepted: false,
			reason: delayResult.reason ?? 'Release held in delay queue',
			details: { processAt: delayResult.processAt?.toISOString() }
		};
	}
}

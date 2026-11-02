import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext, ExistingFile, UpgradeStatus } from './types.js';
import { isUpgrade } from '#lib/server/scoring/scorer.js';
import { buildExistingAttrs } from '#lib/server/scoring/utils.js';
import {
	effectiveBuckets,
	isMultiQualityMode,
	selectBestExistingFileInBucket
} from '#lib/server/quality/buckets.js';

export class UpgradeStage implements DecisionStage<GrabDecisionContext> {
	name = 'upgrade';

	isEnabled(_ctx: GrabDecisionContext): boolean {
		return true;
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const { existingFiles, profile, options, target, desiredQualities } = ctx;

		if (existingFiles.length === 0) {
			ctx.computed.upgradeStatus = 'new';
			return { accepted: true, details: { upgradeStatus: 'new' } };
		}

		if (options.force) {
			ctx.computed.upgradeStatus = 'upgrade';
			return { accepted: true, details: { upgradeStatus: 'upgrade' } };
		}

		if (!profile.upgradesAllowed) {
			ctx.computed.upgradeStatus = 'blocked';
			return {
				accepted: false,
				reason: 'Upgrades are disabled for this profile',
				details: { rejectionType: 'upgrades_disabled', upgradeStatus: 'blocked' }
			};
		}

		// Multi-quality: scope the movie comparison to the candidate's resolution
		// bucket. An empty bucket is treated as a fresh fill (upgradeStatus 'new').
		if (target.type === 'movie') {
			const candidateResolution = ctx.computed.scoringResult?.resolution;
			const effective = effectiveBuckets(
				desiredQualities,
				profile.minResolution,
				profile.maxResolution
			);
			if (
				candidateResolution &&
				isMultiQualityMode(effective) &&
				effective.includes(candidateResolution)
			) {
				const inBucket = selectBestExistingFileInBucket(existingFiles, candidateResolution);
				if (!inBucket) {
					ctx.computed.upgradeStatus = 'new';
					return { accepted: true, details: { upgradeStatus: 'new' } };
				}
				return this.evaluateSingleFile(ctx, inBucket);
			}
		}

		if (target.type === 'movie' || target.type === 'episode') {
			return this.evaluateSingleFile(ctx, existingFiles[0]);
		}

		return this.evaluateMultiFile(ctx);
	}

	private evaluateSingleFile(ctx: GrabDecisionContext, existing: ExistingFile): StageResult {
		const { release, profile, options } = ctx;

		const isStreamingExisting = existing.relativePath.endsWith('.strm');
		const isStreamingCandidate = release.protocol === 'streaming';

		if (isStreamingExisting && isStreamingCandidate) {
			ctx.computed.upgradeStatus = 'rejected';
			return {
				accepted: false,
				reason: 'Cannot upgrade streaming with streaming',
				details: { rejectionType: 'not_upgrade', upgradeStatus: 'rejected' }
			};
		}

		if (!isStreamingExisting && isStreamingCandidate && profile.id === 'streamer') {
			ctx.computed.upgradeStatus = 'upgrade';
			return { accepted: true, details: { upgradeStatus: 'upgrade' } };
		}

		const existingAttrs = buildExistingAttrs(existing);
		const existingTitle = existing.sceneName ?? existing.relativePath;

		const result = isUpgrade(existingTitle, release.title, profile, {
			minimumImprovement: profile.minScoreIncrement,
			allowSidegrade: options.allowSidegrade,
			existingAttrs,
			candidateSizeBytes: release.size,
			existingSizeBytes: existing.size ?? undefined,
			candidateProtocol: release.protocol
		});

		ctx.computed.existingScore = result.existing.totalScore;

		let upgradeStatus: UpgradeStatus;
		if (result.isUpgrade) {
			upgradeStatus = result.improvement === 0 ? 'sidegrade' : 'upgrade';
		} else {
			upgradeStatus = result.improvement < 0 ? 'downgrade' : 'rejected';
		}
		ctx.computed.upgradeStatus = upgradeStatus;

		if (!result.isUpgrade) {
			return {
				accepted: false,
				reason: `Not an upgrade (candidate: ${result.candidate.totalScore}, existing: ${result.existing.totalScore}, improvement: ${result.improvement})`,
				details: { rejectionType: 'not_upgrade', upgradeStatus }
			};
		}

		return { accepted: true, details: { upgradeStatus } };
	}

	private evaluateMultiFile(ctx: GrabDecisionContext): StageResult {
		const { release, existingFiles, profile, options, target } = ctx;

		const targetEpisodeIds =
			target.type === 'season' || target.type === 'series' ? target.episodeIds : [];
		const episodeIdSet = new Set(targetEpisodeIds);

		const fileByEpisode = new Map<string, ExistingFile>();
		for (const f of existingFiles) {
			for (const eid of f.episodeIds ?? []) {
				if (episodeIdSet.has(eid)) {
					fileByEpisode.set(eid, f);
				}
			}
		}

		let improved = 0;
		let unchanged = 0;
		let downgraded = 0;
		let newEpisodes = 0;

		for (const episodeId of episodeIdSet) {
			const existing = fileByEpisode.get(episodeId);

			if (!existing || !existing.relativePath) {
				newEpisodes++;
				continue;
			}

			const existingAttrs = buildExistingAttrs(existing);
			const existingTitle = existing.sceneName ?? existing.relativePath;

			const result = isUpgrade(existingTitle, release.title, profile, {
				minimumImprovement: profile.minScoreIncrement,
				allowSidegrade: options.allowSidegrade,
				existingAttrs,
				candidateSizeBytes: release.size,
				existingSizeBytes: existing.size ?? undefined,
				candidateProtocol: release.protocol
			});

			if (result.isUpgrade) {
				improved++;
			} else if (result.improvement < 0) {
				downgraded++;
			} else {
				unchanged++;
			}
		}

		const total = improved + unchanged + downgraded + newEpisodes;
		const benefitCount = improved + newEpisodes;
		const isMajorityBenefit = benefitCount > total / 2;

		const upgradeStatus: UpgradeStatus = isMajorityBenefit ? 'upgrade' : 'rejected';
		ctx.computed.upgradeStatus = upgradeStatus;

		if (!isMajorityBenefit) {
			return {
				accepted: false,
				reason: `Not enough episodes benefit (${benefitCount}/${total} improved)`,
				details: {
					rejectionType: 'not_upgrade',
					upgradeStatus,
					upgradeStats: { improved, unchanged, downgraded, newEpisodes }
				}
			};
		}

		return {
			accepted: true,
			details: {
				upgradeStatus,
				upgradeStats: { improved, unchanged, downgraded, newEpisodes }
			}
		};
	}
}

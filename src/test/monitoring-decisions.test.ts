/**
 * Monitoring Decisions Integration Tests
 *
 * End-to-end scenario tests that validate the complete decision flow:
 * - Should we grab this release?
 * - Is it an upgrade?
 * - Does it pass size limits?
 * - Is it blocked by cutoff?
 *
 * These tests simulate real-world scenarios without database dependencies.
 */

import { describe, it, expect, vi } from 'vitest';
import { ALL_FORMATS } from '#lib/server/scoring/formats/index.js';

vi.mock('#lib/server/scoring/formats/registry.js', () => ({
	getActiveFormats: () => ALL_FORMATS,
	invalidateFormatCache: () => {}
}));

import { scoreRelease, isUpgrade, rankReleases } from '#lib/server/scoring/scorer.js';
import {
	QUALITY_PROFILE,
	BALANCED_PROFILE,
	COMPACT_PROFILE
} from '#lib/server/scoring/profiles.js';
import type { ScoringProfile, ScoringResult } from '#lib/server/scoring/types.js';

/**
 * Simulates the full decision pipeline for grabbing a release
 */
interface GrabDecision {
	shouldGrab: boolean;
	reason: string;
	releaseScore: ScoringResult;
	existingScore?: ScoringResult;
	improvement?: number;
}

/**
 * Simulate the complete grab decision for a movie
 */
function simulateMovieGrabDecision(
	candidateRelease: string,
	candidateSizeBytes: number,
	profile: ScoringProfile,
	existingFile?: string,
	existingSizeBytes?: number
): GrabDecision {
	// Score the candidate
	const releaseScore = scoreRelease(candidateRelease, profile, undefined, candidateSizeBytes, {
		mediaType: 'movie'
	});

	// Check if candidate is banned
	if (releaseScore.isBanned) {
		return {
			shouldGrab: false,
			reason: `Banned: ${releaseScore.bannedReasons.join(', ')}`,
			releaseScore
		};
	}

	// Check if candidate is size-rejected
	if (releaseScore.sizeRejected) {
		return {
			shouldGrab: false,
			reason: releaseScore.sizeRejectionReason || 'Size rejected',
			releaseScore
		};
	}

	// Check if candidate meets minimum score
	if (!releaseScore.meetsMinimum) {
		return {
			shouldGrab: false,
			reason: `Below minimum score (${releaseScore.totalScore} < ${profile.minScore})`,
			releaseScore
		};
	}

	// If no existing file, this is a new grab (missing content)
	if (!existingFile) {
		return {
			shouldGrab: true,
			reason: 'Missing content - grabbing first acceptable release',
			releaseScore
		};
	}

	// Score existing file
	const existingScore = scoreRelease(existingFile, profile, undefined, existingSizeBytes, {
		mediaType: 'movie'
	});

	// Check if upgrades are allowed
	if (!profile.upgradesAllowed) {
		return {
			shouldGrab: false,
			reason: 'Upgrades not allowed in profile',
			releaseScore,
			existingScore
		};
	}

	// Check upgradeUntilScore cutoff
	const cutoff = profile.upgradeUntilScore ?? -1;
	if (cutoff > 0 && existingScore.totalScore >= cutoff) {
		return {
			shouldGrab: false,
			reason: `Already at cutoff (${existingScore.totalScore} >= ${cutoff})`,
			releaseScore,
			existingScore
		};
	}

	// Check if it's actually an upgrade
	const upgradeResult = isUpgrade(existingFile, candidateRelease, profile, {
		minimumImprovement: profile.minScoreIncrement ?? 0,
		candidateSizeBytes
	});

	if (!upgradeResult.isUpgrade) {
		const improvement = upgradeResult.candidate.totalScore - upgradeResult.existing.totalScore;
		if (improvement <= 0) {
			return {
				shouldGrab: false,
				reason: `Not an upgrade (candidate: ${upgradeResult.candidate.totalScore}, existing: ${upgradeResult.existing.totalScore})`,
				releaseScore,
				existingScore,
				improvement
			};
		} else {
			return {
				shouldGrab: false,
				reason: `Improvement too small (${improvement} < ${profile.minScoreIncrement})`,
				releaseScore,
				existingScore,
				improvement
			};
		}
	}

	return {
		shouldGrab: true,
		reason: `Upgrade found (+${upgradeResult.improvement} points)`,
		releaseScore,
		existingScore,
		improvement: upgradeResult.improvement
	};
}

describe('Monitoring Decisions - Real-World Scenarios', () => {
	describe('Scenario: Missing Content', () => {
		it('should grab first acceptable release for missing movie', () => {
			const decision = simulateMovieGrabDecision(
				'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				4 * 1024 * 1024 * 1024, // 4GB
				QUALITY_PROFILE
			);

			expect(decision.shouldGrab).toBe(true);
			expect(decision.reason).toContain('Missing content');
		});

		it('should NOT grab truly banned release (CAM, screener) even for missing movie', () => {
			// CAM releases are truly banned in all profiles
			const decision = simulateMovieGrabDecision(
				'Movie.2024.1080p.CAM-GROUP',
				1.5 * 1024 * 1024 * 1024, // 1.5GB
				QUALITY_PROFILE
			);

			expect(decision.shouldGrab).toBe(false);
			expect(decision.reason).toContain('Banned');
		});

		it('should grab YTS release for missing movie in COMPACT_PROFILE', () => {
			// YTS is highly valued in Micro profile
			const decision = simulateMovieGrabDecision(
				'Movie.2024.1080p.BluRay.x265-YTS',
				2 * 1024 * 1024 * 1024, // 2GB
				COMPACT_PROFILE
			);

			expect(decision.shouldGrab).toBe(true);
			expect(decision.releaseScore.isBanned).toBe(false);
		});

		it('should NOT grab oversized release for missing movie', () => {
			const profile: ScoringProfile = {
				...QUALITY_PROFILE,
				id: 'test-size',
				name: 'Test Size',
				movieMaxSizeGb: 20
			};

			const decision = simulateMovieGrabDecision(
				'Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos-GROUP',
				60 * 1024 * 1024 * 1024, // 60GB
				profile
			);

			expect(decision.shouldGrab).toBe(false);
			expect(decision.reason).toContain('exceeds maximum');
		});
	});

	describe('Scenario: Upgrade Decision', () => {
		it('should grab 2160p Remux as upgrade over 1080p WebDL', () => {
			const decision = simulateMovieGrabDecision(
				'Movie.2024.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.Atmos-GROUP',
				45 * 1024 * 1024 * 1024, // 45GB
				QUALITY_PROFILE,
				'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				4 * 1024 * 1024 * 1024 // 4GB
			);

			expect(decision.shouldGrab).toBe(true);
			expect(decision.reason).toContain('Upgrade found');
			expect(decision.improvement).toBeGreaterThan(0);
		});

		it('should NOT grab 1080p WebDL as "upgrade" over 2160p Remux (downgrade)', () => {
			const decision = simulateMovieGrabDecision(
				'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				4 * 1024 * 1024 * 1024, // 4GB
				QUALITY_PROFILE,
				'Movie.2024.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.Atmos-GROUP',
				45 * 1024 * 1024 * 1024 // 45GB
			);

			expect(decision.shouldGrab).toBe(false);
			expect(decision.reason).toContain('Not an upgrade');
		});

		it('should NOT upgrade when already at cutoff', () => {
			const lowCutoffProfile: ScoringProfile = {
				...QUALITY_PROFILE,
				id: 'low-cutoff',
				name: 'Low Cutoff',
				upgradeUntilScore: 500 // Stop at 500
			};

			// Existing 1080p REMUX DTS-HD MA scores ~590, candidate 2160p REMUX scores ~550
			// Since 590 >= 500 (cutoff), should return "Already at cutoff"
			const decision = simulateMovieGrabDecision(
				'Movie.2024.2160p.UHD.BluRay.REMUX-GROUP',
				45 * 1024 * 1024 * 1024,
				lowCutoffProfile,
				'Movie.2024.1080p.BluRay.REMUX.DTS-HD.MA-GROUP',
				30 * 1024 * 1024 * 1024
			);

			expect(decision.shouldGrab).toBe(false);
			expect(decision.reason).toContain('Already at cutoff');
		});

		it('should reject upgrade with insufficient improvement', () => {
			const highIncrementProfile: ScoringProfile = {
				...QUALITY_PROFILE,
				id: 'high-increment',
				name: 'High Increment',
				minScoreIncrement: 10000 // Require huge improvement
			};

			// 1080p BluRay to 1080p BluRay with slightly better audio
			// Score difference would be small
			const decision = simulateMovieGrabDecision(
				'Movie.2024.1080p.BluRay.DTS-HD.MA-GROUP',
				12 * 1024 * 1024 * 1024,
				highIncrementProfile,
				'Movie.2024.1080p.BluRay.DTS-GROUP',
				10 * 1024 * 1024 * 1024
			);

			expect(decision.shouldGrab).toBe(false);
			expect(decision.reason).toMatch(/Improvement too small|Not an upgrade/);
		});
	});

	describe('Scenario: Profile Comparison', () => {
		const releases = [
			{
				name: 'Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos-GROUP',
				size: 60 * 1024 * 1024 * 1024
			},
			{ name: 'Movie.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP', size: 8 * 1024 * 1024 * 1024 },
			{ name: 'Movie.2024.1080p.BluRay.x265.DTS-HD.MA-GROUP', size: 8 * 1024 * 1024 * 1024 },
			{ name: 'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP', size: 4 * 1024 * 1024 * 1024 },
			{ name: 'Movie.2024.720p.WEB-DL-GROUP', size: 2 * 1024 * 1024 * 1024 }
		];

		it('QUALITY_PROFILE should rank Remux first', () => {
			const ranked = rankReleases(
				releases.map((r) => ({ name: r.name, sizeBytes: r.size })),
				QUALITY_PROFILE
			);

			expect(ranked[0].releaseName).toContain('REMUX');
			expect(ranked[0].rank).toBe(1);
		});

		it('BALANCED_PROFILE should rank x265 encodes highly', () => {
			const ranked = rankReleases(
				releases.map((r) => ({ name: r.name, sizeBytes: r.size })),
				BALANCED_PROFILE
			);

			// x265 should be competitive
			const x265Release = ranked.find((r) => r.releaseName.includes('x265'));
			expect(x265Release).toBeDefined();
			expect(x265Release!.rank).toBeLessThanOrEqual(3);
		});

		it('COMPACT_PROFILE should accept smaller files', () => {
			const microWithSizeLimit: ScoringProfile = {
				...COMPACT_PROFILE,
				id: 'micro-limited',
				name: 'Micro Limited',
				movieMaxSizeGb: 10
			};

			// 60GB Remux should be rejected
			const remuxDecision = simulateMovieGrabDecision(
				'Movie.2024.2160p.UHD.BluRay.REMUX-GROUP',
				60 * 1024 * 1024 * 1024,
				microWithSizeLimit
			);
			expect(remuxDecision.shouldGrab).toBe(false);

			// 4GB WebDL should be accepted
			const webdlDecision = simulateMovieGrabDecision(
				'Movie.2024.1080p.WEB-DL-GROUP',
				4 * 1024 * 1024 * 1024,
				microWithSizeLimit
			);
			expect(webdlDecision.shouldGrab).toBe(true);
		});
	});

	describe('Scenario: TV Episode Size Validation', () => {
		it('should validate single episode size', () => {
			const profile: ScoringProfile = {
				...BALANCED_PROFILE,
				id: 'tv-profile',
				name: 'TV Profile',
				episodeMinSizeMb: 200,
				episodeMaxSizeMb: 1500
			};

			// 800MB single episode - OK
			const okScore = scoreRelease(
				'Show.S01E01.1080p.WEB-DL.DDP5.1-GROUP',
				profile,
				undefined,
				800 * 1024 * 1024,
				{ mediaType: 'tv', isSeasonPack: false }
			);
			expect(okScore.sizeRejected).toBe(false);

			// 50MB single episode - too small
			const tooSmallScore = scoreRelease(
				'Show.S01E01.1080p.WEB-DL-GROUP',
				profile,
				undefined,
				50 * 1024 * 1024,
				{ mediaType: 'tv', isSeasonPack: false }
			);
			expect(tooSmallScore.sizeRejected).toBe(true);

			// 5GB single episode - too large
			const tooLargeScore = scoreRelease(
				'Show.S01E01.2160p.REMUX-GROUP',
				profile,
				undefined,
				5 * 1024 * 1024 * 1024,
				{ mediaType: 'tv', isSeasonPack: false }
			);
			expect(tooLargeScore.sizeRejected).toBe(true);
		});

		it('should validate season pack per-episode average', () => {
			const profile: ScoringProfile = {
				...BALANCED_PROFILE,
				id: 'tv-pack-profile',
				name: 'TV Pack Profile',
				episodeMinSizeMb: 200,
				episodeMaxSizeMb: 1500
			};

			// 10 episode season, 10GB total = 1GB per episode - OK
			const okScore = scoreRelease(
				'Show.S01.1080p.WEB-DL-GROUP',
				profile,
				undefined,
				10 * 1024 * 1024 * 1024,
				{ mediaType: 'tv', isSeasonPack: true, episodeCount: 10 }
			);
			expect(okScore.sizeRejected).toBe(false);

			// 10 episode season, 500MB total = 50MB per episode - too small
			const tooSmallScore = scoreRelease(
				'Show.S01.1080p.WEB-DL-GROUP',
				profile,
				undefined,
				500 * 1024 * 1024,
				{ mediaType: 'tv', isSeasonPack: true, episodeCount: 10 }
			);
			expect(tooSmallScore.sizeRejected).toBe(true);
		});
	});

	describe('Scenario: Release Ranking for Auto-Grab', () => {
		it('should rank releases correctly for auto-grab selection', () => {
			const candidates = [
				{ name: 'Movie.2024.720p.HDTV-GROUP', sizeBytes: 1 * 1024 * 1024 * 1024 },
				{
					name: 'Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos-FraMeSToR',
					sizeBytes: 50 * 1024 * 1024 * 1024
				},
				{
					name: 'Movie.2024.1080p.BluRay.x264.DTS-HD.MA-GROUP',
					sizeBytes: 12 * 1024 * 1024 * 1024
				},
				{ name: 'Movie.2024.1080p.WEB-DL.DDP5.1-NTb', sizeBytes: 4 * 1024 * 1024 * 1024 }
			];

			const ranked = rankReleases(candidates, QUALITY_PROFILE);

			// Top release should be the 2160p Remux with top tier group
			expect(ranked[0].releaseName).toContain('2160p');
			expect(ranked[0].releaseName).toContain('REMUX');

			// 720p HDTV should be last
			expect(ranked[ranked.length - 1].releaseName).toContain('720p');
			expect(ranked[ranked.length - 1].releaseName).toContain('HDTV');

			// All should meet minimum
			expect(ranked.every((r) => r.meetsMinimum)).toBe(true);
		});

		it('should filter out truly banned releases (CAM) from candidates', () => {
			const candidates = [
				{ name: 'Movie.2024.1080p.CAM-GROUP', sizeBytes: 2 * 1024 * 1024 * 1024 }, // CAM is banned
				{ name: 'Movie.2024.1080p.WEB-DL-GROUP', sizeBytes: 4 * 1024 * 1024 * 1024 }
			];

			const ranked = rankReleases(candidates, QUALITY_PROFILE);

			// CAM release should be ranked last due to ban
			expect(ranked[0].releaseName).not.toContain('CAM');
			expect(ranked[ranked.length - 1].isBanned).toBe(true);
		});

		it('should rank YTS differently based on profile', () => {
			const candidates = [
				{ name: 'Movie.2024.1080p.BluRay.x265-YTS', sizeBytes: 2 * 1024 * 1024 * 1024 },
				{ name: 'Movie.2024.1080p.WEB-DL-GROUP', sizeBytes: 4 * 1024 * 1024 * 1024 }
			];

			// QUALITY_PROFILE penalizes YTS
			const rankedBest = rankReleases(candidates, QUALITY_PROFILE);
			expect(rankedBest[0].releaseName).not.toContain('YTS');
			expect(rankedBest[0].isBanned).toBe(false); // NOT banned, just lower score

			// COMPACT_PROFILE values YTS
			const rankedMicro = rankReleases(candidates, COMPACT_PROFILE);
			expect(rankedMicro[0].releaseName).toContain('YTS');
			expect(rankedMicro[0].isBanned).toBe(false);
		});
	});

	describe('Scenario: Complex Upgrade Chain', () => {
		it('should show correct upgrade path: 720p → 1080p WebDL → 1080p BluRay → 2160p', () => {
			const releases = [
				'Movie.2024.720p.WEB-DL-GROUP',
				'Movie.2024.1080p.WEB-DL.DDP5.1-GROUP',
				'Movie.2024.1080p.BluRay.x264.DTS-HD.MA-GROUP',
				'Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos-GROUP'
			];

			// Score all releases
			const scores = releases.map((r) => ({
				release: r,
				score: scoreRelease(r, QUALITY_PROFILE).totalScore
			}));

			// Verify each step is an improvement
			for (let i = 1; i < scores.length; i++) {
				expect(scores[i].score).toBeGreaterThan(scores[i - 1].score);
			}

			// Verify upgrade detection at each step
			for (let i = 1; i < releases.length; i++) {
				const result = isUpgrade(releases[i - 1], releases[i], QUALITY_PROFILE);
				expect(result.isUpgrade).toBe(true);
				expect(result.improvement).toBeGreaterThan(0);
			}
		});
	});
});

describe('Edge Cases', () => {
	it('should handle release with no recognizable quality markers', () => {
		const result = scoreRelease('some.random.file.name.mkv', QUALITY_PROFILE);

		// Should still return a result, just with low/zero score
		expect(result).toBeDefined();
		expect(result.meetsMinimum).toBeDefined();
	});

	it('should handle empty release name', () => {
		const result = scoreRelease('', QUALITY_PROFILE);

		expect(result).toBeDefined();
		expect(result.totalScore).toBeDefined();
	});

	it('should handle very long release names', () => {
		const longName =
			'Movie.With.A.Very.Long.Title.That.Goes.On.And.On.2024.2160p.UHD.BluRay.REMUX.HDR10.Plus.Dolby.Vision.TrueHD.7.1.Atmos.HEVC-SuperLongGroupName';
		const result = scoreRelease(longName, QUALITY_PROFILE);

		expect(result).toBeDefined();
		expect(result.meetsMinimum).toBe(true);
	});

	it('should handle unicode in release names', () => {
		const result = scoreRelease('Movie.日本語.2024.1080p.WEB-DL-GROUP', QUALITY_PROFILE);

		expect(result).toBeDefined();
	});
});

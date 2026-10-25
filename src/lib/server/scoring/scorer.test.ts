import { describe, it, expect, vi } from 'vitest';
import { ALL_FORMATS } from './formats/index.js';
import { createScoringProfile } from '../../../test/fixtures/releases.js';

vi.mock('./formats/registry.js', () => ({
	getActiveFormats: () => ALL_FORMATS,
	invalidateFormatCache: () => {}
}));

import { scoreRelease, isUpgrade } from './scorer';
import { DEFAULT_PROFILES, BALANCED_PROFILE } from './profiles';
import type { ScoringProfile } from './types';

// Profiles that support torrent-based release scoring (excludes streaming-only)
const TORRENT_PROFILES = DEFAULT_PROFILES.filter((p) => p.id !== 'streamer');

/**
 * Comprehensive tests for the scoring/upgrade system.
 * Tests run against ALL profiles to ensure correct behavior regardless of user's profile choice.
 */

// Test releases with varying quality/attributes
const TEST_RELEASES = {
	// High quality releases
	'4k-remux': 'Movie.2024.2160p.UHD.BluRay.REMUX.DTS-HD.MA-GROUP',
	'4k-webdl': 'Movie.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP',
	'1080p-bluray': 'Movie.2024.1080p.BluRay.x264.DTS-GROUP',
	'1080p-webdl': 'Movie.2024.1080p.WEB-DL.DD5.1.H.264-GROUP',
	'720p-webdl': 'Movie.2024.720p.WEB-DL.x264-GROUP',
	'720p-hdtv': 'Movie.2024.720p.HDTV.x264-GROUP',

	// Size-optimized releases (YTS/YIFY) - valued in MICRO, penalized in BEST
	'yts-1080p': 'Movie.2024.1080p.BluRay.x264-YTS.MX',
	'yify-720p': 'Movie.2024.720p.BluRay.x264-YIFY',

	// Banned content (CAM, TS, Screeners) - banned in ALL profiles
	cam: 'Movie.2024.CAM.x264-GROUP',
	ts: 'Movie.2024.TS.x264-GROUP',
	hdts: 'Movie.2024.HDTS.x264-GROUP',
	screener: 'Movie.2024.DVDScr.x264-GROUP',
	telecine: 'Movie.2024.TC.x264-GROUP',
	telesync: 'Movie.2024.TELESYNC.x264-GROUP',

	// Subtitle formats
	hardsub: 'Movie.2024.1080p.WEB-DL.x264.HardSub-GROUP',

	// HDR variants
	'dolby-vision': 'Movie.2024.2160p.WEB-DL.DV.HDR.DDP5.1-GROUP',
	hdr10: 'Movie.2024.2160p.WEB-DL.HDR10.DDP5.1-GROUP',
	hdr10plus: 'Movie.2024.2160p.WEB-DL.HDR10Plus.DDP5.1-GROUP',

	// Audio formats
	atmos: 'Movie.2024.2160p.WEB-DL.DDP5.1.Atmos-GROUP',
	truehd: 'Movie.2024.2160p.BluRay.TrueHD.7.1-GROUP',
	'dts-x': 'Movie.2024.2160p.BluRay.DTS-X.MA-GROUP'
};

// Content that is universally banned (actual banned content via BANNED_SCORE)
const UNIVERSALLY_BANNED = ['cam', 'screener'] as const;

// Releases that are NEVER banned (may have different scores per profile)
const NEVER_BANNED = [
	'4k-remux',
	'4k-webdl',
	'1080p-bluray',
	'1080p-webdl',
	'720p-webdl',
	'yts-1080p',
	'yify-720p'
] as const;

describe('Scoring System - All Profiles', () => {
	// Run ALL tests against EVERY profile
	describe.each(DEFAULT_PROFILES)('Profile: $name', (profile: ScoringProfile) => {
		describe('Universal Bans', () => {
			it.each(UNIVERSALLY_BANNED)('should ban %s content', (releaseKey) => {
				const result = scoreRelease(TEST_RELEASES[releaseKey], profile);
				expect(result.isBanned).toBe(true);
			});
		});

		describe('Never Banned Releases', () => {
			it.each(NEVER_BANNED)('should NOT ban %s', (releaseKey) => {
				const result = scoreRelease(TEST_RELEASES[releaseKey], profile);
				expect(result.isBanned).toBe(false);
			});
		});

		describe('YTS/YIFY Scoring', () => {
			it('should NOT ban YTS releases (they are scored, not banned)', () => {
				const ytsResult = scoreRelease(TEST_RELEASES['yts-1080p'], profile);

				// YTS is NEVER banned in ANY profile
				expect(ytsResult.isBanned).toBe(false);
			});

			it('should NOT ban YIFY releases', () => {
				const yifyResult = scoreRelease(TEST_RELEASES['yify-720p'], profile);

				// YIFY is NEVER banned in ANY profile
				expect(yifyResult.isBanned).toBe(false);
			});
		});

		describe('Scoring Returns Valid Results', () => {
			it('should return valid totalScore for all test releases', () => {
				for (const [_key, release] of Object.entries(TEST_RELEASES)) {
					const result = scoreRelease(release, profile);

					expect(result).toBeDefined();
					expect(typeof result.totalScore).toBe('number');
					expect(result.profile).toBe(profile.name);
					expect(result.releaseName).toBe(release);

					// If banned, totalScore should be -Infinity
					if (result.isBanned) {
						expect(result.totalScore).toBe(-Infinity);
					}
				}
			});

			it('should include breakdown categories', () => {
				const result = scoreRelease(TEST_RELEASES['1080p-bluray'], profile);

				expect(result.breakdown).toBeDefined();
				expect(result.breakdown.resolution).toBeDefined();
				expect(result.breakdown.source).toBeDefined();
				expect(result.breakdown.codec).toBeDefined();
				expect(result.breakdown.audio).toBeDefined();
			});
		});

		describe('Quality Ordering (Profile-Aware)', () => {
			it('should score resolution based on profile preference', () => {
				const score4k = scoreRelease(TEST_RELEASES['4k-webdl'], profile);
				const score1080p = scoreRelease(TEST_RELEASES['1080p-webdl'], profile);

				// Most profiles prefer 4K over 1080p
				// But Compact prefers smaller files, so 1080p > 4K
				if (profile.name === 'Compact') {
					// Compact profile: 1080p scores higher than 4K
					expect(score1080p.breakdown.resolution.score).toBeGreaterThan(
						score4k.breakdown.resolution.score
					);
				} else {
					// Other profiles: 4K >= 1080p
					expect(score4k.breakdown.resolution.score).toBeGreaterThanOrEqual(
						score1080p.breakdown.resolution.score
					);
				}
			});

			it('should score 1080p releases higher than 720p', () => {
				const score1080p = scoreRelease(TEST_RELEASES['1080p-webdl'], profile);
				const score720p = scoreRelease(TEST_RELEASES['720p-webdl'], profile);

				expect(score1080p.breakdown.resolution.score).toBeGreaterThanOrEqual(
					score720p.breakdown.resolution.score
				);
			});
		});

		describe('Banned Content Has Negative Total', () => {
			it('should return -Infinity for banned content', () => {
				const result = scoreRelease(TEST_RELEASES['cam'], profile);

				expect(result.isBanned).toBe(true);
				expect(result.totalScore).toBe(-Infinity);
			});
		});
	});
});

describe('Upgrade Detection - Torrent Profiles', () => {
	// Uses TORRENT_PROFILES because streaming profile doesn't have torrent format scores
	describe.each(TORRENT_PROFILES)('Profile: $name', (profile: ScoringProfile) => {
		describe('Resolution Upgrades', () => {
			it('should identify 720p → 1080p as upgrade', () => {
				const result = isUpgrade(
					TEST_RELEASES['720p-webdl'],
					TEST_RELEASES['1080p-webdl'],
					profile
				);
				expect(result.isUpgrade).toBe(true);
				expect(result.improvement).toBeGreaterThan(0);
			});

			it('should handle 1080p → 4K based on profile preference', () => {
				const result = isUpgrade(TEST_RELEASES['1080p-webdl'], TEST_RELEASES['4k-webdl'], profile);
				// Whether this is an upgrade depends on the profile
				// ALL profiles now consider 4K HEVC WEB-DL as good or better than 1080p
				// Even Compact: 4K HEVC WEB-DL is efficient and acceptable
				expect(result.isUpgrade).toBe(true);
				expect(result.improvement).toBeGreaterThan(0);
			});

			it('should NOT identify 1080p → 720p as upgrade (downgrade)', () => {
				const result = isUpgrade(
					TEST_RELEASES['1080p-webdl'],
					TEST_RELEASES['720p-webdl'],
					profile
				);
				expect(result.isUpgrade).toBe(false);
				expect(result.improvement).toBeLessThan(0);
			});

			it('should NOT identify same quality as upgrade', () => {
				const result = isUpgrade(
					TEST_RELEASES['1080p-webdl'],
					TEST_RELEASES['1080p-webdl'],
					profile
				);
				expect(result.isUpgrade).toBe(false);
				expect(result.improvement).toBe(0);
			});
		});

		describe('Banned Content Cannot Be Upgrade', () => {
			it('should NOT identify CAM as upgrade from any quality', () => {
				const result = isUpgrade(TEST_RELEASES['720p-webdl'], TEST_RELEASES['cam'], profile);
				// Banned content cannot be an upgrade regardless of score
				expect(result.isUpgrade).toBe(false);
				expect(result.candidate.isBanned).toBe(true);
			});

			it('should NOT identify screener as upgrade from any quality', () => {
				const result = isUpgrade(TEST_RELEASES['720p-webdl'], TEST_RELEASES['screener'], profile);
				expect(result.isUpgrade).toBe(false);
				expect(result.candidate.isBanned).toBe(true);
			});
		});

		describe('Upgrade Options', () => {
			it('should respect minimumImprovement option', () => {
				// 720p → 1080p should be a small enough upgrade
				const withNoMin = isUpgrade(
					TEST_RELEASES['720p-webdl'],
					TEST_RELEASES['1080p-webdl'],
					profile,
					{ minimumImprovement: 0 }
				);

				// But not if we require huge improvement
				const withHugeMin = isUpgrade(
					TEST_RELEASES['720p-webdl'],
					TEST_RELEASES['1080p-webdl'],
					profile,
					{ minimumImprovement: 999999 }
				);

				expect(withNoMin.isUpgrade).toBe(true);
				expect(withHugeMin.isUpgrade).toBe(false);
			});

			it('should respect allowSidegrade option', () => {
				// Same release - no improvement
				const withoutSidegrade = isUpgrade(
					TEST_RELEASES['1080p-webdl'],
					TEST_RELEASES['1080p-webdl'],
					profile,
					{ allowSidegrade: false }
				);

				const withSidegrade = isUpgrade(
					TEST_RELEASES['1080p-webdl'],
					TEST_RELEASES['1080p-webdl'],
					profile,
					{ allowSidegrade: true }
				);

				expect(withoutSidegrade.isUpgrade).toBe(false);
				// With sidegrade allowed, 0 improvement should pass
				expect(withSidegrade.isUpgrade).toBe(true);
			});
		});
	});
});

describe('Edge Cases - All Profiles', () => {
	describe.each(DEFAULT_PROFILES)('Profile: $name', (profile: ScoringProfile) => {
		it('should handle empty release name gracefully', () => {
			const result = scoreRelease('', profile);
			expect(result).toBeDefined();
			expect(typeof result.totalScore).toBe('number');
		});

		it('should handle release with minimal info', () => {
			const result = scoreRelease('Movie.2024-GROUP', profile);
			expect(result).toBeDefined();
			expect(result.isBanned).toBe(false); // Unknown quality shouldn't be banned
		});

		it('should parse complex release names correctly', () => {
			const complexRelease =
				'Movie.2024.PROPER.REPACK.2160p.UHD.BluRay.REMUX.HDR.DV.TrueHD.7.1.Atmos-GROUP';
			const result = scoreRelease(complexRelease, profile);

			expect(result).toBeDefined();
			expect(result.isBanned).toBe(false);
		});
	});
});

describe('Profile-Specific Behavior', () => {
	it('should have different scoring strategies across profiles', () => {
		const qualityProfile = DEFAULT_PROFILES.find((p) => p.name === 'Quality');
		const compactProfile = DEFAULT_PROFILES.find((p) => p.name === 'Compact');

		expect(qualityProfile).toBeDefined();
		expect(compactProfile).toBeDefined();

		if (qualityProfile && compactProfile) {
			// YTS is valued more in Compact profile than Quality profile
			// This tests the formatScores differ between profiles
			const ytsInQuality = scoreRelease(TEST_RELEASES['yts-1080p'], qualityProfile);
			const ytsInCompact = scoreRelease(TEST_RELEASES['yts-1080p'], compactProfile);

			// Both NOT banned
			expect(ytsInQuality.isBanned).toBe(false);
			expect(ytsInCompact.isBanned).toBe(false);

			// But different total scores
			expect(ytsInCompact.totalScore).toBeGreaterThan(ytsInQuality.totalScore);
		}
	});

	it('should have consistent ban rules for CAM across all profiles', () => {
		const camScores = DEFAULT_PROFILES.map((profile) => ({
			profile: profile.name,
			result: scoreRelease(TEST_RELEASES['cam'], profile)
		}));

		// CAM should be banned in ALL profiles
		camScores.forEach(({ result }) => {
			expect(result.isBanned).toBe(true);
		});
	});

	it('all 4 default profiles should exist', () => {
		expect(DEFAULT_PROFILES.length).toBeGreaterThanOrEqual(4);

		const profileNames = DEFAULT_PROFILES.map((p) => p.name);
		expect(profileNames).toContain('Quality');
		expect(profileNames).toContain('Balanced');
		expect(profileNames).toContain('Compact');
		expect(profileNames).toContain('Streamer');
	});

	it('should score canonical parsed audio fields from parser output', () => {
		const compactProfile = DEFAULT_PROFILES.find((p) => p.name === 'Compact');
		expect(compactProfile).toBeDefined();

		if (compactProfile) {
			const release =
				'Avatar.Fire.and.Ash.2025.Hybrid.1080p.MA.WEBRIP.DDP7.1.DoVi.HDR10P.x265.HuN-TRiNiTY';
			const result = scoreRelease(release, compactProfile);

			expect(result.matchedFormats.some((f) => f.format.id === 'audio-ddplus')).toBe(true);
			expect(result.matchedFormats.some((f) => f.format.id === 'codec-x265')).toBe(true);
			expect(result.matchedFormats.some((f) => f.format.id === 'source-webrip')).toBe(true);
		}
	});

	it('should not award YTS group score from indexer/title heuristics alone', () => {
		const compactProfile = DEFAULT_PROFILES.find((p) => p.name === 'Compact');
		expect(compactProfile).toBeDefined();

		if (compactProfile) {
			const result = scoreRelease('Avatar: Fire and Ash (2025) 720p web x264', compactProfile);

			expect(result.matchedFormats.some((f) => f.format.id === 'group-yts')).toBe(false);
		}
	});
});

describe('Size Validation - All Profiles', () => {
	describe.each(DEFAULT_PROFILES)('Profile: $name', (profile: ScoringProfile) => {
		it('should validate movie size when context provided', () => {
			// Test with a 50GB file (likely too big for most profiles)
			const result = scoreRelease(
				TEST_RELEASES['1080p-bluray'],
				profile,
				undefined,
				50 * 1024 * 1024 * 1024, // 50GB in bytes
				{ mediaType: 'movie' }
			);

			expect(result).toBeDefined();
			// Size rejection depends on profile settings
			if (profile.movieMaxSizeGb && Number(profile.movieMaxSizeGb) < 50) {
				expect(result.sizeRejected).toBe(true);
			}
		});

		it('should validate episode size when context provided', () => {
			// Test with a 5GB episode (likely too big)
			const result = scoreRelease(
				TEST_RELEASES['1080p-webdl'],
				profile,
				undefined,
				5 * 1024 * 1024 * 1024, // 5GB in bytes
				{ mediaType: 'tv', isSeasonPack: false }
			);

			expect(result).toBeDefined();
			// Just ensure it returns valid result - rejection depends on profile
			expect(typeof result.sizeRejected).toBe('boolean');
		});

		it('should handle season packs with episode count', () => {
			// 10GB season pack with 10 episodes = 1GB per episode
			const result = scoreRelease(
				TEST_RELEASES['1080p-webdl'],
				profile,
				undefined,
				10 * 1024 * 1024 * 1024,
				{ mediaType: 'tv', isSeasonPack: true, episodeCount: 10 }
			);

			expect(result).toBeDefined();
			expect(typeof result.sizeRejected).toBe('boolean');
		});

		it('should skip size validation for season pack without episode count', () => {
			const result = scoreRelease(
				TEST_RELEASES['1080p-webdl'],
				profile,
				undefined,
				10 * 1024 * 1024 * 1024,
				{ mediaType: 'tv', isSeasonPack: true, episodeCount: 0 }
			);

			// Implementation skips size validation when episode count is unknown
			// This allows the release through - user can evaluate size manually
			expect(result.sizeRejected).toBe(false);
		});
	});
});

describe('Protocol Restrictions', () => {
	// Const adapter (VariableDeclaration, not FunctionDeclaration - not subject to the create* ban)
	const buildProtocolProfile = (
		allowedProtocols: ('torrent' | 'usenet' | 'streaming')[]
	): ScoringProfile => createScoringProfile({ allowedProtocols }) as unknown as ScoringProfile;

	it('should reject torrent when profile only allows usenet', () => {
		const usenetOnlyProfile = buildProtocolProfile(['usenet']);

		// Note: protocol is the 6th parameter: (releaseName, profile, attributes, fileSizeBytes, sizeContext, protocol)
		const result = scoreRelease(
			TEST_RELEASES['1080p-bluray'],
			usenetOnlyProfile,
			undefined, // attributes
			undefined, // fileSizeBytes
			undefined, // sizeContext
			'torrent' // protocol
		);

		expect(result.protocolRejected).toBe(true);
		expect(result.protocolRejectionReason).toContain('torrent');
		expect(result.protocolRejectionReason).toContain('usenet');
	});

	it('should accept usenet when profile allows usenet', () => {
		const usenetOnlyProfile = buildProtocolProfile(['usenet']);

		const result = scoreRelease(
			TEST_RELEASES['1080p-bluray'],
			usenetOnlyProfile,
			undefined,
			undefined,
			undefined,
			'usenet'
		);

		expect(result.protocolRejected).toBe(false);
		expect(result.protocolRejectionReason).toBeUndefined();
	});

	it('should accept any protocol when no restriction is set', () => {
		// Default profiles don't have allowedProtocols set
		const noRestrictionProfile = DEFAULT_PROFILES.find((p) => p.name === 'Balanced')!;

		const torrentResult = scoreRelease(
			TEST_RELEASES['1080p-bluray'],
			noRestrictionProfile,
			undefined,
			undefined,
			undefined,
			'torrent'
		);
		const usenetResult = scoreRelease(
			TEST_RELEASES['1080p-bluray'],
			noRestrictionProfile,
			undefined,
			undefined,
			undefined,
			'usenet'
		);

		expect(torrentResult.protocolRejected).toBe(false);
		expect(usenetResult.protocolRejected).toBe(false);
	});

	it('should accept streaming protocol when profile allows streaming', () => {
		const streamingProfile = buildProtocolProfile(['streaming']);

		const result = scoreRelease(
			TEST_RELEASES['1080p-webdl'],
			streamingProfile,
			undefined,
			undefined,
			undefined,
			'streaming'
		);

		expect(result.protocolRejected).toBe(false);
	});

	it('should reject streaming when profile only allows torrent and usenet', () => {
		const downloadOnlyProfile = buildProtocolProfile(['torrent', 'usenet']);

		const result = scoreRelease(
			TEST_RELEASES['1080p-webdl'],
			downloadOnlyProfile,
			undefined,
			undefined,
			undefined,
			'streaming'
		);

		expect(result.protocolRejected).toBe(true);
	});

	it('protocol-rejected releases should not meet minimum requirements', () => {
		const usenetOnlyProfile = buildProtocolProfile(['usenet']);

		const result = scoreRelease(
			TEST_RELEASES['1080p-bluray'],
			usenetOnlyProfile,
			undefined,
			undefined,
			undefined,
			'torrent'
		);

		expect(result.protocolRejected).toBe(true);
		expect(result.meetsMinimum).toBe(false);
	});
});

describe('Season Pack and Episode Scoring', () => {
	// Note: Pack preference bonuses (complete series, multi-season, single season)
	// are defined in types.ts but not currently applied in scorer.ts.
	// These tests verify the current scoring behavior.

	describe.each(TORRENT_PROFILES)('Profile: $name', (profile: ScoringProfile) => {
		it('should score TV releases consistently', () => {
			const regularEpisode = scoreRelease(
				'Show.S01E01.1080p.WEB-DL.x264-GROUP',
				profile,
				undefined,
				undefined,
				{ mediaType: 'tv', isSeasonPack: false }
			);

			const seasonPack = scoreRelease(
				'Show.S01.1080p.WEB-DL.x264-GROUP',
				profile,
				undefined,
				undefined,
				{ mediaType: 'tv', isSeasonPack: true }
			);

			// Both should be valid scored releases
			expect(regularEpisode.isBanned).toBe(false);
			expect(seasonPack.isBanned).toBe(false);
			expect(regularEpisode.totalScore).toBeGreaterThan(0);
			expect(seasonPack.totalScore).toBeGreaterThan(0);
		});

		it('should score individual episodes consistently', () => {
			const episode1 = scoreRelease(
				'Show.S01E01.1080p.WEB-DL.x264-GROUP',
				profile,
				undefined,
				undefined,
				{ mediaType: 'tv', isSeasonPack: false }
			);

			const episode2 = scoreRelease(
				'Show.S01E02.1080p.WEB-DL.x264-GROUP',
				profile,
				undefined,
				undefined,
				{ mediaType: 'tv', isSeasonPack: false }
			);

			// Individual episodes with same quality should have identical scores
			expect(episode1.totalScore).toBe(episode2.totalScore);
		});

		it('should handle season pack size context for validation', () => {
			// Season pack with valid size should not be rejected for size
			const result = scoreRelease(
				'Show.S01.1080p.WEB-DL.x264-GROUP',
				profile,
				undefined,
				5 * 1024 * 1024 * 1024, // 5GB total
				{ mediaType: 'tv', isSeasonPack: true, episodeCount: 10 } // 500MB per episode
			);

			expect(result).toBeDefined();
			// Size validation uses per-episode calculation for season packs
			expect(typeof result.sizeRejected).toBe('boolean');
		});
	});

	it('should score same quality releases equally regardless of pack type', () => {
		const profile = DEFAULT_PROFILES.find((p) => p.name === 'Balanced')!;

		const singleEpisode = scoreRelease(
			'Show.S01E01.1080p.WEB-DL.x264-GROUP',
			profile,
			undefined,
			undefined,
			{ mediaType: 'tv', isSeasonPack: false }
		);

		const seasonPack = scoreRelease(
			'Show.S01.1080p.WEB-DL.x264-GROUP',
			profile,
			undefined,
			undefined,
			{ mediaType: 'tv', isSeasonPack: true }
		);

		// Current implementation: same quality = same score
		// (Pack bonuses are not applied in current scorer implementation)
		expect(singleEpisode.totalScore).toBe(seasonPack.totalScore);
	});
});

describe('Glued channel-digit audio parsing (#585)', () => {
	it('detects FLAC1.0 and lets the Bluray encode outrank the REMUX under Balanced', () => {
		const remux = scoreRelease(
			'And.Justice.for.All.1979.1080p.BluRay.REMUX.AVC.FLAC.1.0-ZnP',
			BALANCED_PROFILE
		);
		const encode = scoreRelease(
			'And.Justice.for.All.1979.1080p.BluRay.FLAC1.0.x264-ZoroSenpai',
			BALANCED_PROFILE
		);

		// Both detect FLAC now, so the encode's +50 Bluray-vs-Remux source
		// edge decides: 200+200+10+80 = 490 beats 200+150+10+80 = 440.
		// Before the parser fix the encode lost FLAC's 80 points (410 < 440).
		expect(encode.totalScore).toBe(490);
		expect(remux.totalScore).toBe(440);
	});
});

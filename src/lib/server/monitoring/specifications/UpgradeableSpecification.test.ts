/**
 * UpgradeableSpecification Unit Tests
 *
 * Tests for the specification that determines if a release qualifies
 * as an upgrade over an existing file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	MovieUpgradeableSpecification,
	EpisodeUpgradeableSpecification,
	isMovieUpgrade,
	isEpisodeUpgrade
} from './UpgradeableSpecification.js';
import type { MovieContext, EpisodeContext, ReleaseCandidate } from './types.js';
import { RejectionReason } from './types.js';
import {
	createMovie,
	createMovieFile,
	createSeries,
	createEpisode,
	createEpisodeFile
} from '../../../../test/fixtures/media.js';
import { createScoringProfile } from '../../../../test/fixtures/releases.js';

// Typed adapter consts (arrow functions, not FunctionDeclarations - not subject to the create* ban)
const testMovie = (overrides?: Parameters<typeof createMovie>[0]): MovieContext['movie'] =>
	createMovie(overrides) as unknown as MovieContext['movie'];
const testMovieFile = (
	overrides?: Parameters<typeof createMovieFile>[0]
): MovieContext['existingFile'] =>
	createMovieFile(overrides) as unknown as MovieContext['existingFile'];
const testSeries = (overrides?: Parameters<typeof createSeries>[0]): EpisodeContext['series'] =>
	createSeries(overrides) as unknown as EpisodeContext['series'];
const testEpisode = (overrides?: Parameters<typeof createEpisode>[0]): EpisodeContext['episode'] =>
	createEpisode(overrides) as unknown as EpisodeContext['episode'];
const testEpisodeFile = (
	overrides?: Parameters<typeof createEpisodeFile>[0]
): EpisodeContext['existingFile'] =>
	createEpisodeFile(overrides) as unknown as EpisodeContext['existingFile'];
const testProfile = (
	overrides?: Parameters<typeof createScoringProfile>[0]
): MovieContext['profile'] => createScoringProfile(overrides) as unknown as MovieContext['profile'];

const TEST_PROFILES: Record<string, Record<string, unknown>> = {
	best: {
		id: 'best',
		name: 'Best',
		upgradesAllowed: true,
		minScore: 0,
		upgradeUntilScore: 50000,
		minScoreIncrement: 100,
		formatScores: {
			'resolution-2160p': 500,
			'resolution-1080p': 300,
			'source-remux': 400,
			'source-bluray': 300,
			'source-webdl': 200,
			'codec-x264': 50
		}
	},
	'no-upgrades': {
		id: 'no-upgrades',
		name: 'No Upgrades',
		upgradesAllowed: false,
		minScore: 0,
		upgradeUntilScore: -1,
		minScoreIncrement: 0,
		formatScores: {}
	},
	'high-increment': {
		id: 'high-increment',
		name: 'High Increment',
		upgradesAllowed: true,
		minScore: 0,
		upgradeUntilScore: 50000,
		minScoreIncrement: 5000,
		formatScores: {
			'resolution-2160p': 500,
			'source-bluray': 300,
			'source-webdl': 200
		}
	},
	'low-cutoff': {
		id: 'low-cutoff',
		name: 'Low Cutoff',
		upgradesAllowed: true,
		minScore: 0,
		upgradeUntilScore: 5000,
		minScoreIncrement: 0,
		formatScores: {
			'resolution-2160p': 500,
			'resolution-1080p': 300,
			'source-bluray': 300,
			'source-remux': 400,
			'codec-x264': 50
		}
	},
	'custom-profile': {
		id: 'custom-profile',
		name: 'Custom Profile',
		upgradesAllowed: true,
		minScore: 0,
		upgradeUntilScore: 30000,
		minScoreIncrement: 100,
		formatScores: {
			'resolution-2160p': 500,
			'source-remux': 400,
			'source-bluray': 300
		}
	}
};

vi.mock('#lib/server/quality/index.js', () => ({
	qualityFilter: {
		getProfile: vi.fn(async (id: string) => TEST_PROFILES[id] ?? null)
	}
}));

describe('MovieUpgradeableSpecification', () => {
	let spec: MovieUpgradeableSpecification;

	beforeEach(() => {
		spec = new MovieUpgradeableSpecification();
	});

	describe('Basic Validation', () => {
		it('should reject when no existing file', async () => {
			const context: MovieContext = {
				movie: testMovie(),
				existingFile: null,
				profile: testProfile()
			};
			const release: ReleaseCandidate = {
				title: 'Test.Movie.2024.2160p.REMUX',
				score: 20000
			};

			const result = await spec.isSatisfied(context, release);

			expect(result.accepted).toBe(false);
			expect(result.reason).toBe('no_existing_file');
		});

		it('should reject when no release candidate', async () => {
			const context: MovieContext = {
				movie: testMovie(),
				existingFile: testMovieFile({ sceneName: 'Test.Movie.2024.1080p.WEB-DL' }),
				profile: testProfile()
			};

			const result = await spec.isSatisfied(context);

			expect(result.accepted).toBe(false);
			expect(result.reason).toBe('no_release_candidate');
		});

		it('should reject when no profile', async () => {
			const context: MovieContext = {
				movie: testMovie(),
				existingFile: testMovieFile({ sceneName: 'Test.Movie.2024.1080p.WEB-DL' }),
				profile: null
			};
			const release: ReleaseCandidate = {
				title: 'Test.Movie.2024.2160p.REMUX',
				score: 20000
			};

			const result = await spec.isSatisfied(context, release);

			expect(result.accepted).toBe(false);
			expect(result.reason).toBe(RejectionReason.NO_PROFILE);
		});
	});

	describe('Upgrade Decisions', () => {
		it('should accept upgrade from 1080p WebDL to 2160p Remux', async () => {
			const context: MovieContext = {
				movie: testMovie(),
				existingFile: testMovieFile({
					sceneName: 'Test.Movie.2024.1080p.WEB-DL.DDP5.1-GROUP'
				}),
				profile: testProfile({ id: 'best', upgradesAllowed: true, minScoreIncrement: 100 })
			};
			const release: ReleaseCandidate = {
				title: 'Test.Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos-GROUP',
				score: 23000
			};

			const result = await spec.isSatisfied(context, release);

			expect(result.accepted).toBe(true);
		});

		it('should reject downgrade from 2160p Remux to 1080p WebDL', async () => {
			const context: MovieContext = {
				movie: testMovie(),
				existingFile: testMovieFile({
					sceneName: 'Test.Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos-GROUP'
				}),
				profile: testProfile({ id: 'best', upgradesAllowed: true, minScoreIncrement: 100 })
			};
			const release: ReleaseCandidate = {
				title: 'Test.Movie.2024.1080p.WEB-DL.DDP5.1-GROUP',
				score: 4500
			};

			const result = await spec.isSatisfied(context, release);

			expect(result.accepted).toBe(false);
			expect(result.reason).toBe(RejectionReason.QUALITY_NOT_BETTER);
		});

		it('should reject when upgrades not allowed', async () => {
			const context: MovieContext = {
				movie: testMovie(),
				existingFile: testMovieFile({ sceneName: 'Test.Movie.2024.1080p.WEB-DL-GROUP' }),
				profile: testProfile({ id: 'no-upgrades', upgradesAllowed: false })
			};
			const release: ReleaseCandidate = {
				title: 'Test.Movie.2024.2160p.UHD.BluRay.REMUX-GROUP',
				score: 20000
			};

			const result = await spec.isSatisfied(context, release);

			expect(result.accepted).toBe(false);
			expect(result.reason).toBe(RejectionReason.UPGRADES_NOT_ALLOWED);
		});

		it('should reject when improvement below minScoreIncrement', async () => {
			const context: MovieContext = {
				movie: testMovie(),
				existingFile: testMovieFile({ sceneName: 'Test.Movie.2024.1080p.WEB-DL-GROUP' }),
				profile: testProfile({
					id: 'high-increment',
					upgradesAllowed: true,
					minScoreIncrement: 5000
				})
			};
			const release: ReleaseCandidate = {
				title: 'Test.Movie.2024.1080p.BluRay.x264-GROUP',
				score: 8000
			};

			const result = await spec.isSatisfied(context, release);

			expect(result.accepted).toBe(false);
		});

		it('should accept upgrade even when candidate exceeds cutoff (cutoff only limits search initiation)', async () => {
			const context: MovieContext = {
				movie: testMovie(),
				existingFile: testMovieFile({
					sceneName: 'Test.Movie.2024.1080p.BluRay.x264-GROUP'
				}),
				profile: testProfile({
					id: 'low-cutoff',
					upgradesAllowed: true,
					upgradeUntilScore: 5000,
					minScoreIncrement: 0
				})
			};
			const release: ReleaseCandidate = {
				title: 'Test.Movie.2024.2160p.UHD.BluRay.REMUX-GROUP',
				score: 20000
			};

			const result = await spec.isSatisfied(context, release);

			expect(result.accepted).toBe(true);
		});
	});

	describe('Convenience Functions', () => {
		it('isMovieUpgrade should return boolean', async () => {
			const context: MovieContext = {
				movie: testMovie(),
				existingFile: testMovieFile({
					sceneName: 'Test.Movie.2024.1080p.WEB-DL-GROUP'
				}),
				profile: testProfile({ id: 'best', upgradesAllowed: true, minScoreIncrement: 100 })
			};
			const release: ReleaseCandidate = {
				title: 'Test.Movie.2024.2160p.UHD.BluRay.REMUX-GROUP',
				score: 20000
			};

			const result = await isMovieUpgrade(context, release);

			expect(typeof result).toBe('boolean');
			expect(result).toBe(true);
		});
	});
});

describe('EpisodeUpgradeableSpecification', () => {
	let spec: EpisodeUpgradeableSpecification;

	beforeEach(() => {
		spec = new EpisodeUpgradeableSpecification();
	});

	it('should accept upgrade for episode', async () => {
		const context: EpisodeContext = {
			series: testSeries(),
			episode: testEpisode(),
			existingFile: testEpisodeFile({
				sceneName: 'Test.Show.S01E01.1080p.WEB-DL-GROUP'
			}),
			profile: testProfile({ id: 'best', upgradesAllowed: true, minScoreIncrement: 100 })
		};
		const release: ReleaseCandidate = {
			title: 'Test.Show.S01E01.2160p.UHD.BluRay.REMUX-GROUP',
			score: 20000
		};

		const result = await spec.isSatisfied(context, release);

		expect(result.accepted).toBe(true);
	});

	it('should reject downgrade for episode', async () => {
		const context: EpisodeContext = {
			series: testSeries(),
			episode: testEpisode(),
			existingFile: testEpisodeFile({
				sceneName: 'Test.Show.S01E01.2160p.UHD.BluRay.REMUX-GROUP'
			}),
			profile: testProfile({ id: 'best', upgradesAllowed: true, minScoreIncrement: 100 })
		};
		const release: ReleaseCandidate = {
			title: 'Test.Show.S01E01.1080p.WEB-DL-GROUP',
			score: 4000
		};

		const result = await spec.isSatisfied(context, release);

		expect(result.accepted).toBe(false);
		expect(result.reason).toBe(RejectionReason.QUALITY_NOT_BETTER);
	});

	it('isEpisodeUpgrade should return boolean', async () => {
		const context: EpisodeContext = {
			series: testSeries(),
			episode: testEpisode(),
			existingFile: testEpisodeFile({
				sceneName: 'Test.Show.S01E01.1080p.WEB-DL-GROUP'
			}),
			profile: testProfile({ id: 'best', upgradesAllowed: true, minScoreIncrement: 100 })
		};
		const release: ReleaseCandidate = {
			title: 'Test.Show.S01E01.2160p.UHD.BluRay.REMUX-GROUP',
			score: 20000
		};

		const result = await isEpisodeUpgrade(context, release);

		expect(typeof result).toBe('boolean');
		expect(result).toBe(true);
	});
});

describe('Custom Profile Support', () => {
	let spec: MovieUpgradeableSpecification;

	beforeEach(() => {
		spec = new MovieUpgradeableSpecification();
	});

	it('should work with custom profiles (non-built-in)', async () => {
		const context: MovieContext = {
			movie: testMovie(),
			existingFile: testMovieFile({
				sceneName: 'Test.Movie.2024.1080p.WEB-DL.DDP5.1-GROUP'
			}),
			profile: testProfile({
				id: 'custom-profile',
				upgradesAllowed: true,
				minScoreIncrement: 100
			})
		};
		const release: ReleaseCandidate = {
			title: 'Test.Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos-GROUP',
			score: 25000
		};

		const result = await spec.isSatisfied(context, release);

		expect(result.accepted).toBe(true);
	});

	it('should reject unknown custom profile IDs', async () => {
		const context: MovieContext = {
			movie: testMovie(),
			existingFile: testMovieFile({
				sceneName: 'Test.Movie.2024.1080p.WEB-DL-GROUP'
			}),
			profile: testProfile({
				id: 'nonexistent-profile',
				upgradesAllowed: true,
				minScoreIncrement: 100
			})
		};
		const release: ReleaseCandidate = {
			title: 'Test.Movie.2024.2160p.UHD.BluRay.REMUX-GROUP',
			score: 20000
		};

		const result = await spec.isSatisfied(context, release);

		expect(result.accepted).toBe(false);
		expect(result.reason).toBe(RejectionReason.NO_PROFILE);
	});
});

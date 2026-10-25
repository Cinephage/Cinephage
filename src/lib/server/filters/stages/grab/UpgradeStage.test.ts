import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpgradeStage } from './UpgradeStage.js';
import { makeGrabDecisionContext } from '../../../../../test/fixtures/filters.js';
import type { ExistingFile } from './types.js';

const mockIsUpgrade = vi.hoisted(() => vi.fn());
const mockBuildExistingAttrs = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/scoring/scorer.js', () => ({
	isUpgrade: mockIsUpgrade
}));

vi.mock('#lib/server/scoring/utils.js', () => ({
	buildExistingAttrs: mockBuildExistingAttrs
}));

function makeProfile(overrides = {}) {
	return {
		id: 'balanced',
		upgradesAllowed: true,
		minScoreIncrement: 10,
		formatScores: {},
		...overrides
	} as any;
}

const stage = new UpgradeStage();

describe('UpgradeStage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockBuildExistingAttrs.mockReturnValue(undefined);
	});

	describe('isEnabled', () => {
		it('always returns true', () => {
			expect(stage.isEnabled(makeGrabDecisionContext())).toBe(true);
			expect(stage.isEnabled(makeGrabDecisionContext({ existingFiles: [] }))).toBe(true);
		});
	});

	describe('evaluate - new content', () => {
		it('accepts with upgradeStatus new when no existing files', async () => {
			const ctx = makeGrabDecisionContext({ existingFiles: [] });
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
			expect(ctx.computed.upgradeStatus).toBe('new');
		});
	});

	describe('evaluate - force mode', () => {
		it('accepts with upgradeStatus upgrade when force is true', async () => {
			const existing: ExistingFile = { id: 'f1', relativePath: '/movies/movie.mkv' };
			const ctx = makeGrabDecisionContext({
				existingFiles: [existing],
				options: { force: true, skipBlocklist: false, allowSidegrade: false, isAutomatic: false }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
			expect(ctx.computed.upgradeStatus).toBe('upgrade');
		});
	});

	describe('evaluate - upgrades disabled', () => {
		it('rejects when profile disallows upgrades', async () => {
			const existing: ExistingFile = { id: 'f1', relativePath: '/movies/movie.mkv' };
			const ctx = makeGrabDecisionContext({
				existingFiles: [existing],
				profile: makeProfile({ upgradesAllowed: false })
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(false);
			expect(result.reason).toContain('Upgrades are disabled');
			expect(ctx.computed.upgradeStatus).toBe('blocked');
		});
	});

	describe('evaluate - single file upgrade', () => {
		it('accepts when isUpgrade returns true', async () => {
			const existing: ExistingFile = {
				id: 'f1',
				relativePath: '/movies/movie.1080p.mkv',
				sceneName: 'Movie.2024.1080p.WEB-DL'
			};
			mockIsUpgrade.mockReturnValue({
				isUpgrade: true,
				improvement: 50,
				existing: { totalScore: 100 },
				candidate: { totalScore: 150 }
			});

			const ctx = makeGrabDecisionContext({ existingFiles: [existing] });
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
			expect(ctx.computed.upgradeStatus).toBe('upgrade');
			expect(ctx.computed.existingScore).toBe(100);
		});

		it('rejects when isUpgrade returns false', async () => {
			const existing: ExistingFile = {
				id: 'f1',
				relativePath: '/movies/movie.2160p.mkv',
				sceneName: 'Movie.2024.2160p.Remux'
			};
			mockIsUpgrade.mockReturnValue({
				isUpgrade: false,
				improvement: -50,
				existing: { totalScore: 300 },
				candidate: { totalScore: 250 }
			});

			const ctx = makeGrabDecisionContext({ existingFiles: [existing] });
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(false);
			expect(ctx.computed.upgradeStatus).toBe('downgrade');
		});

		it('sets sidegrade when improvement is 0', async () => {
			const existing: ExistingFile = { id: 'f1', relativePath: '/movies/movie.mkv' };
			mockIsUpgrade.mockReturnValue({
				isUpgrade: true,
				improvement: 0,
				existing: { totalScore: 100 },
				candidate: { totalScore: 100 }
			});

			const ctx = makeGrabDecisionContext({ existingFiles: [existing] });
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
			expect(ctx.computed.upgradeStatus).toBe('sidegrade');
		});
	});

	describe('evaluate - streaming rules', () => {
		it('rejects streaming-to-streaming upgrade', async () => {
			const existing: ExistingFile = { id: 'f1', relativePath: '/movies/movie.strm' };
			const ctx = makeGrabDecisionContext({
				release: { title: 'Movie.2024.1080p', protocol: 'streaming' },
				existingFiles: [existing]
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(false);
			expect(result.reason).toContain('Cannot upgrade streaming with streaming');
		});

		it('accepts streamer profile replacing local with streaming', async () => {
			const existing: ExistingFile = { id: 'f1', relativePath: '/movies/movie.mkv' };
			const ctx = makeGrabDecisionContext({
				release: { title: 'Movie.2024.1080p', protocol: 'streaming' },
				existingFiles: [existing],
				profile: makeProfile({ id: 'streamer' })
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
			expect(ctx.computed.upgradeStatus).toBe('upgrade');
		});
	});

	describe('evaluate - multi-quality (movie)', () => {
		it('accepts as new when candidate targets an empty resolution bucket', async () => {
			const existing: ExistingFile = {
				id: 'f4k',
				relativePath: '/movies/movie.2160p.mkv',
				quality: { resolution: '2160p' }
			};
			const ctx = makeGrabDecisionContext({
				existingFiles: [existing],
				desiredQualities: ['2160p', '1080p'],
				computed: { scoringResult: { resolution: '1080p' } as any }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
			expect(ctx.computed.upgradeStatus).toBe('new');
			expect(mockIsUpgrade).not.toHaveBeenCalled();
		});

		it('compares against the same-bucket file when the bucket is filled', async () => {
			const existing: ExistingFile[] = [
				{
					id: 'f4k',
					relativePath: '/movies/movie.2160p.mkv',
					sceneName: 'Movie.2024.2160p.Remux',
					quality: { resolution: '2160p' }
				},
				{
					id: 'f1080',
					relativePath: '/movies/movie.1080p.mkv',
					sceneName: 'Movie.2024.1080p.WEB-DL',
					quality: { resolution: '1080p' }
				}
			];
			mockIsUpgrade.mockReturnValue({
				isUpgrade: true,
				improvement: 40,
				existing: { totalScore: 100 },
				candidate: { totalScore: 140 }
			});

			const ctx = makeGrabDecisionContext({
				existingFiles: existing,
				desiredQualities: ['2160p', '1080p'],
				computed: { scoringResult: { resolution: '1080p' } as any }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
			expect(ctx.computed.upgradeStatus).toBe('upgrade');
			// The baseline passed to isUpgrade should be the 1080p file
			expect(mockBuildExistingAttrs).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1080' }));
		});

		it('falls back to best-file comparison when candidate resolution is outside desired buckets', async () => {
			const existing: ExistingFile[] = [
				{ id: 'f4k', relativePath: '/movies/movie.2160p.mkv', quality: { resolution: '2160p' } }
			];
			mockIsUpgrade.mockReturnValue({
				isUpgrade: false,
				improvement: -100,
				existing: { totalScore: 300 },
				candidate: { totalScore: 200 }
			});

			const ctx = makeGrabDecisionContext({
				existingFiles: existing,
				desiredQualities: ['2160p', '1080p'],
				computed: { scoringResult: { resolution: '720p' } as any }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(false);
		});
	});

	describe('evaluate - multi-file (season/series)', () => {
		it('accepts when majority benefits', async () => {
			const files: ExistingFile[] = [
				{ id: 'f1', relativePath: '/show/s01e01.mkv', episodeIds: ['e1'] },
				{ id: 'f2', relativePath: '/show/s01e02.mkv', episodeIds: ['e2'] },
				{ id: 'f3', relativePath: '/show/s01e03.mkv', episodeIds: ['e3'] }
			];
			mockIsUpgrade
				.mockReturnValueOnce({
					isUpgrade: true,
					improvement: 50,
					existing: { totalScore: 100 },
					candidate: { totalScore: 150 }
				})
				.mockReturnValueOnce({
					isUpgrade: true,
					improvement: 30,
					existing: { totalScore: 100 },
					candidate: { totalScore: 130 }
				})
				.mockReturnValueOnce({
					isUpgrade: false,
					improvement: -10,
					existing: { totalScore: 100 },
					candidate: { totalScore: 90 }
				});

			const ctx = makeGrabDecisionContext({
				target: { type: 'season', seriesId: 's1', seasonNumber: 1, episodeIds: ['e1', 'e2', 'e3'] },
				existingFiles: files
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
			expect(ctx.computed.upgradeStatus).toBe('upgrade');
		});

		it('rejects when majority does not benefit', async () => {
			const files: ExistingFile[] = [
				{ id: 'f1', relativePath: '/show/s01e01.mkv', episodeIds: ['e1'] },
				{ id: 'f2', relativePath: '/show/s01e02.mkv', episodeIds: ['e2'] },
				{ id: 'f3', relativePath: '/show/s01e03.mkv', episodeIds: ['e3'] }
			];
			mockIsUpgrade
				.mockReturnValueOnce({
					isUpgrade: false,
					improvement: 0,
					existing: { totalScore: 100 },
					candidate: { totalScore: 100 }
				})
				.mockReturnValueOnce({
					isUpgrade: false,
					improvement: -10,
					existing: { totalScore: 100 },
					candidate: { totalScore: 90 }
				})
				.mockReturnValueOnce({
					isUpgrade: true,
					improvement: 5,
					existing: { totalScore: 100 },
					candidate: { totalScore: 105 }
				});

			const ctx = makeGrabDecisionContext({
				target: { type: 'season', seriesId: 's1', seasonNumber: 1, episodeIds: ['e1', 'e2', 'e3'] },
				existingFiles: files
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(false);
			expect(ctx.computed.upgradeStatus).toBe('rejected');
		});
	});
});

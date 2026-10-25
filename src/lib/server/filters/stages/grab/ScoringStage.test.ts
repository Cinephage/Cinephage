import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoringStage } from './ScoringStage.js';
import { makeGrabDecisionContext } from '../../../../../test/fixtures/filters.js';

const mockParse = vi.hoisted(() => vi.fn());
const mockCalculateEnhancedScore = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/indexers/parser/ReleaseParser.js', () => ({
	ReleaseParser: class {
		parse = mockParse;
	}
}));

vi.mock('#lib/server/quality/QualityFilter.js', () => ({
	qualityFilter: { calculateEnhancedScore: mockCalculateEnhancedScore }
}));

const stage = new ScoringStage();

describe('ScoringStage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('isEnabled', () => {
		it('always returns true', () => {
			expect(stage.isEnabled(makeGrabDecisionContext())).toBe(true);
			expect(
				stage.isEnabled(
					makeGrabDecisionContext({
						options: { force: true, skipBlocklist: true, allowSidegrade: true, isAutomatic: false }
					})
				)
			).toBe(true);
		});
	});

	describe('evaluate', () => {
		it('enriches ctx.computed with scoring result', async () => {
			const parsed = { originalTitle: 'Movie.2024.1080p.WEB-DL.x264' };
			mockParse.mockReturnValue(parsed);

			const scoringResult = {
				totalScore: 150,
				isBanned: false,
				bannedReasons: [],
				sizeRejected: false,
				sizeRejectionReason: undefined,
				protocolRejected: false,
				protocolRejectionReason: undefined,
				meetsMinimum: true
			};
			mockCalculateEnhancedScore.mockReturnValue({ scoringResult, score: 150 });

			const ctx = makeGrabDecisionContext();
			const result = await stage.evaluate(ctx);

			expect(result.accepted).toBe(true);
			expect(ctx.computed.candidateScore).toBe(150);
			expect(ctx.computed.isBanned).toBe(false);
			expect(ctx.computed.meetsMinimum).toBe(true);
			expect(ctx.computed.scoringResult).toBe(scoringResult);
		});

		it('enriches banned state correctly', async () => {
			mockParse.mockReturnValue({ originalTitle: 'Bad.Release' });
			const scoringResult = {
				totalScore: -999999,
				isBanned: true,
				bannedReasons: ['YIFY', 'CAM'],
				sizeRejected: false,
				sizeRejectionReason: undefined,
				protocolRejected: false,
				protocolRejectionReason: undefined,
				meetsMinimum: false
			};
			mockCalculateEnhancedScore.mockReturnValue({ scoringResult, score: -999999 });

			const ctx = makeGrabDecisionContext();
			await stage.evaluate(ctx);

			expect(ctx.computed.isBanned).toBe(true);
			expect(ctx.computed.bannedReasons).toEqual(['YIFY', 'CAM']);
		});

		it('passes correct sizeContext for season targets', async () => {
			mockParse.mockReturnValue({ originalTitle: 'Show.S01' });
			const scoringResult = {
				totalScore: 100,
				isBanned: false,
				bannedReasons: [],
				sizeRejected: false,
				protocolRejected: false,
				meetsMinimum: true
			};
			mockCalculateEnhancedScore.mockReturnValue({ scoringResult, score: 100 });

			const ctx = makeGrabDecisionContext({
				target: { type: 'season', seriesId: 's1', seasonNumber: 1, episodeIds: ['e1', 'e2', 'e3'] }
			});
			await stage.evaluate(ctx);

			expect(mockCalculateEnhancedScore).toHaveBeenCalledWith(
				expect.anything(),
				ctx.profile,
				ctx.release.size,
				{ mediaType: 'tv', isSeasonPack: true, episodeCount: 3 },
				'nzbgeek',
				ctx.release.protocol
			);
		});

		it('always returns accepted true (enrichment only)', async () => {
			mockParse.mockReturnValue({});
			const scoringResult = {
				totalScore: -100,
				isBanned: true,
				bannedReasons: ['bad'],
				sizeRejected: true,
				sizeRejectionReason: 'too big',
				protocolRejected: true,
				protocolRejectionReason: 'not allowed',
				meetsMinimum: false
			};
			mockCalculateEnhancedScore.mockReturnValue({ scoringResult, score: -100 });

			const result = await stage.evaluate(makeGrabDecisionContext());
			expect(result.accepted).toBe(true);
		});
	});
});

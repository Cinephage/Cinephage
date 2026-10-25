import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlocklistStage } from './BlocklistStage.js';
import { makeGrabDecisionContext } from '../../../../../test/fixtures/filters.js';

const mockIsBlocklisted = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/blocklist/BlocklistService.js', () => ({
	blocklistService: { isBlocklisted: mockIsBlocklisted }
}));

const stage = new BlocklistStage();

describe('BlocklistStage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('isEnabled', () => {
		it('returns true by default', () => {
			expect(stage.isEnabled(makeGrabDecisionContext())).toBe(true);
		});

		it('stays enabled for manual force grabs (hard stage)', () => {
			const ctx = makeGrabDecisionContext({
				options: { force: true, skipBlocklist: false, allowSidegrade: false, isAutomatic: false }
			});
			expect(stage.isEnabled(ctx)).toBe(true);
		});

		it('returns false only for an explicit hard override', () => {
			const ctx = makeGrabDecisionContext({
				options: {
					force: true,
					skipBlocklist: false,
					allowSidegrade: false,
					isAutomatic: false,
					overrideHardStages: true
				}
			});
			expect(stage.isEnabled(ctx)).toBe(false);
		});

		it('returns false when skipBlocklist is true', () => {
			const ctx = makeGrabDecisionContext({
				options: { force: false, skipBlocklist: true, allowSidegrade: false, isAutomatic: true }
			});
			expect(stage.isEnabled(ctx)).toBe(false);
		});
	});

	describe('evaluate', () => {
		it('accepts when release is not blocklisted', async () => {
			mockIsBlocklisted.mockResolvedValue({ blocked: false });
			const ctx = makeGrabDecisionContext();
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
			expect(mockIsBlocklisted).toHaveBeenCalledWith(ctx.release, {
				movieId: 'movie-1',
				seriesId: undefined
			});
		});

		it('rejects when release is blocklisted', async () => {
			mockIsBlocklisted.mockResolvedValue({
				blocked: true,
				reason: 'Blocklisted: download_failed'
			});
			const result = await stage.evaluate(makeGrabDecisionContext());
			expect(result.accepted).toBe(false);
			expect(result.reason).toBe('Blocklisted: download_failed');
		});

		it('extracts seriesId for episode targets', async () => {
			mockIsBlocklisted.mockResolvedValue({ blocked: false });
			const ctx = makeGrabDecisionContext({
				target: { type: 'episode', episodeId: 'ep-1', seriesId: 'series-1' }
			});
			await stage.evaluate(ctx);
			expect(mockIsBlocklisted).toHaveBeenCalledWith(ctx.release, {
				movieId: undefined,
				seriesId: 'series-1'
			});
		});

		it('extracts seriesId for season targets', async () => {
			mockIsBlocklisted.mockResolvedValue({ blocked: false });
			const ctx = makeGrabDecisionContext({
				target: { type: 'season', seriesId: 'series-2', seasonNumber: 1, episodeIds: ['e1'] }
			});
			await stage.evaluate(ctx);
			expect(mockIsBlocklisted).toHaveBeenCalledWith(ctx.release, {
				movieId: undefined,
				seriesId: 'series-2'
			});
		});
	});
});

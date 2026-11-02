import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaOccupancyStage } from './MediaOccupancyStage.js';
import { makeGrabDecisionContext } from '../../../../../test/fixtures/filters.js';

const mockCheck = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/acquisition/MediaOccupancyService.js', () => ({
	mediaOccupancyService: { check: mockCheck }
}));

describe('MediaOccupancyStage', () => {
	const stage = new MediaOccupancyStage();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('stays enabled for manual force grabs (hard stage)', () => {
		const ctx = makeGrabDecisionContext({
			options: { force: true, skipBlocklist: false, allowSidegrade: false, isAutomatic: false }
		});

		expect(stage.isEnabled(ctx)).toBe(true);
	});

	it('is disabled only for an explicit hard override', () => {
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

	it('runs for manual grabs (slot exclusivity applies to everyone)', () => {
		const ctx = makeGrabDecisionContext({
			options: { force: false, skipBlocklist: false, allowSidegrade: false, isAutomatic: false }
		});

		expect(stage.isEnabled(ctx)).toBe(true);
	});

	it('accepts when target is not occupied', async () => {
		mockCheck.mockResolvedValue({ occupied: false });

		const ctx = makeGrabDecisionContext();
		const result = await stage.evaluate(ctx);

		expect(result.accepted).toBe(true);
		expect(mockCheck).toHaveBeenCalledWith(ctx.target, { isUpgrade: undefined });
	});

	it('rejects automatic duplicate episode grabs when target is occupied', async () => {
		mockCheck.mockResolvedValue({
			occupied: true,
			reason: 'episode_already_downloading',
			details: { queueItemId: 'queue-1' }
		});

		const result = await stage.evaluate(makeGrabDecisionContext());

		expect(result.accepted).toBe(false);
		expect(result.reason).toBe('Media target is already occupied: episode_already_downloading');
		expect(result.details).toEqual({
			rejectionType: 'media_occupied',
			reason: 'episode_already_downloading',
			queueItemId: 'queue-1'
		});
	});

	it('passes upgrade intent to occupancy service', async () => {
		mockCheck.mockResolvedValue({ occupied: false });
		const ctx = makeGrabDecisionContext({
			options: {
				force: false,
				skipBlocklist: false,
				allowSidegrade: false,
				isAutomatic: true,
				isUpgrade: true
			}
		});

		await stage.evaluate(ctx);

		expect(mockCheck).toHaveBeenCalledWith(ctx.target, { isUpgrade: true });
	});
});

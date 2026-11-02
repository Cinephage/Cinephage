import { describe, expect, it, vi } from 'vitest';
import { MonitoredStage } from './MonitoredStage.js';
import { makeSearchEligibilityContext } from '../../../../../test/fixtures/filters.js';

const mockFindFirst = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			seasons: { findFirst: mockFindFirst }
		}
	}
}));

vi.mock('#lib/server/db/schema.js', () => ({
	seasons: { id: 'id' }
}));

vi.mock('drizzle-orm', () => ({
	eq: (col: string, val: string) => ({ col, val })
}));

const stage = new MonitoredStage();

describe('MonitoredStage', () => {
	describe('isEnabled', () => {
		it('returns true by default', () => {
			expect(stage.isEnabled(makeSearchEligibilityContext())).toBe(true);
		});

		it('returns false when forceSearch is true', () => {
			const ctx = makeSearchEligibilityContext({ options: { forceSearch: true } });
			expect(stage.isEnabled(ctx)).toBe(false);
		});
	});

	describe('evaluate (movie)', () => {
		it('accepts when movie is monitored', async () => {
			const result = await stage.evaluate(makeSearchEligibilityContext());
			expect(result.accepted).toBe(true);
		});

		it('rejects when movie is not monitored', async () => {
			const ctx = makeSearchEligibilityContext({
				media: { id: 'movie-1', monitored: false, tmdbId: 12345 }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(false);
			expect(result.reason).toBe('Movie is not monitored');
		});
	});

	describe('evaluate (episode)', () => {
		it('rejects when series is not monitored', async () => {
			const ctx = makeSearchEligibilityContext({
				episode: { id: 'ep-1', monitored: true, seasonId: 's1' },
				series: { id: 'series-1', monitored: false }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(false);
			expect(result.reason).toBe('Series is not monitored');
		});

		it('rejects when episode is not monitored', async () => {
			const ctx = makeSearchEligibilityContext({
				episode: { id: 'ep-1', monitored: false, seasonId: 's1' },
				series: { id: 'series-1', monitored: true }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(false);
			expect(result.reason).toBe('Episode is not monitored');
		});

		it('rejects when season is not monitored', async () => {
			mockFindFirst.mockResolvedValue({ id: 's1', monitored: false });
			const ctx = makeSearchEligibilityContext({
				episode: { id: 'ep-1', monitored: true, seasonId: 's1' },
				series: { id: 'series-1', monitored: true }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(false);
			expect(result.reason).toBe('Season is not monitored');
		});

		it('accepts when all levels are monitored', async () => {
			mockFindFirst.mockResolvedValue({ id: 's1', monitored: true });
			const ctx = makeSearchEligibilityContext({
				episode: { id: 'ep-1', monitored: true, seasonId: 's1' },
				series: { id: 'series-1', monitored: true }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
		});

		it('accepts when no seasonId is present', async () => {
			const ctx = makeSearchEligibilityContext({
				episode: { id: 'ep-1', monitored: true },
				series: { id: 'series-1', monitored: true }
			});
			const result = await stage.evaluate(ctx);
			expect(result.accepted).toBe(true);
		});
	});
});

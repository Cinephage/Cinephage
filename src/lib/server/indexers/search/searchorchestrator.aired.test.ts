import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getSeason: vi.fn()
}));

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: { getSeason: mocks.getSeason }
}));

import { SearchOrchestrator } from './SearchOrchestrator';

type AiredCountApi = {
	getAiredSeasonEpisodeCount(tmdbId: number, seasonNumber: number): Promise<number | undefined>;
};

function airedCount(orchestrator: SearchOrchestrator) {
	return (orchestrator as unknown as AiredCountApi).getAiredSeasonEpisodeCount.bind(orchestrator);
}

describe('SearchOrchestrator aired episode count', () => {
	beforeEach(() => {
		mocks.getSeason.mockReset();
	});

	it('counts episodes whose air date has passed and ignores specials', async () => {
		mocks.getSeason.mockResolvedValue({
			episode_count: 4,
			episodes: [
				{ episode_number: 0, air_date: '2025-12-01' },
				{ episode_number: 1, air_date: '2026-01-01' },
				{ episode_number: 2, air_date: '2026-01-02' },
				{ episode_number: 3, air_date: '2099-01-01' }
			]
		});
		const orchestrator = new SearchOrchestrator();

		await expect(airedCount(orchestrator)(1, 1)).resolves.toBe(2);
	});

	it('returns undefined when TMDB has no episode list', async () => {
		mocks.getSeason.mockResolvedValue({ episode_count: 8, episodes: [] });
		const orchestrator = new SearchOrchestrator();

		await expect(airedCount(orchestrator)(2, 1)).resolves.toBeUndefined();
	});

	it('caches the result per season', async () => {
		mocks.getSeason.mockResolvedValue({
			episodes: [{ episode_number: 1, air_date: '2026-01-01' }]
		});
		const orchestrator = new SearchOrchestrator();
		const count = airedCount(orchestrator);

		await count(3, 1);
		await count(3, 1);

		expect(mocks.getSeason).toHaveBeenCalledTimes(1);
	});

	it('returns undefined instead of throwing when TMDB fails', async () => {
		mocks.getSeason.mockRejectedValue(new Error('tmdb down'));
		const orchestrator = new SearchOrchestrator();

		await expect(airedCount(orchestrator)(4, 1)).resolves.toBeUndefined();
	});
});

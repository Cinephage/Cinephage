import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	searchEnhanced: vi.fn(),
	grab: vi.fn(),
	moviesFindFirst: vi.fn(),
	movieFilesFindMany: vi.fn(),
	profilesFindFirst: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			movies: { findFirst: mocks.moviesFindFirst },
			movieFiles: { findMany: mocks.movieFilesFindMany },
			scoringProfiles: { findFirst: mocks.profilesFindFirst }
		}
	}
}));

vi.mock('#lib/server/indexers/IndexerManager.js', () => ({
	getIndexerManager: vi.fn(async () => ({
		searchEnhanced: mocks.searchEnhanced,
		getIndexers: vi.fn(async () => []),
		getDefinitionCapabilities: vi.fn()
	}))
}));

vi.mock('#lib/server/indexers/search/availability.js', () => ({
	evaluateIndexerSearchAvailability: vi.fn(() => ({ ok: true }))
}));

vi.mock('#lib/server/indexers/search/profile-indexer-filter.js', () => ({
	resolveAllowedIndexerIds: vi.fn(async () => [])
}));

vi.mock('#lib/server/downloads/GrabService.js', () => ({
	grabService: { grab: mocks.grab }
}));

const { searchForMovie } = await import('./search-movie.js');

const altTitles = {
	getMovieSearchTitlesWithRefresh: vi.fn(async () => ['Harry Potter and the Prisoner of Azkaban'])
};

function release(title: string, resolution: string, totalScore: number) {
	return {
		title,
		guid: title,
		downloadUrl: 'https://tracker.example/dl/1',
		indexerId: 'idx-1',
		indexerName: 'Prowlarr',
		protocol: 'torrent',
		size: 4_000_000_000,
		categories: [2000],
		publishDate: new Date('2026-01-01T00:00:00Z'),
		parsed: { resolution },
		totalScore,
		rejected: false
	};
}

describe('searchForMovie (single-quality)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.movieFilesFindMany.mockResolvedValue([]);
		mocks.moviesFindFirst.mockResolvedValue({
			desiredQualities: ['1080p'],
			scoringProfileId: 'balanced'
		});
		mocks.profilesFindFirst.mockResolvedValue({ minResolution: null, maxResolution: null });
	});

	it('keeps trying lower-ranked releases after a rejection', async () => {
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				release(
					'Harry Potter and the Prisoner of Azkaban 2004 2160p BluRay x265-GRP',
					'2160p',
					740
				),
				release('Harry Potter and the Prisoner of Azkaban 2004 1080p BluRay x265-GRP', '1080p', 500)
			],
			rejectedCount: 0
		});
		// The 4K candidate is refused by the desired-quality rule; the 1080p one is fine.
		mocks.grab.mockImplementation(async ({ release: candidate }: { release: { title: string } }) =>
			candidate.title.includes('2160p')
				? {
						success: false,
						error: "Resolution 2160p is outside the movie's desired qualities [1080p]",
						decision: { rejectionType: 'desired_quality' }
					}
				: { success: true, download: { queueId: 'queue-1' } }
		);

		const result = await searchForMovie(
			{
				movieId: 'movie-1',
				tmdbId: 673,
				title: 'Harry Potter and the Prisoner of Azkaban',
				year: 2004
			},
			altTitles as never
		);

		expect(mocks.grab).toHaveBeenCalledTimes(2);
		expect(result.success).toBe(true);
		expect(result.releaseName).toContain('1080p');
	});

	it('reports an aggregate reason when every candidate is refused', async () => {
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				release(
					'Harry Potter and the Prisoner of Azkaban 2004 2160p BluRay x265-GRP',
					'2160p',
					740
				),
				release('Harry Potter and the Prisoner of Azkaban 2004 1080p BluRay x265-GRP', '1080p', 500)
			],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue({
			success: false,
			error: 'refused',
			decision: { rejectionType: 'desired_quality' }
		});

		const result = await searchForMovie(
			{
				movieId: 'movie-1',
				tmdbId: 673,
				title: 'Harry Potter and the Prisoner of Azkaban',
				year: 2004
			},
			altTitles as never
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('2 rejected');
		expect(result.error).toContain('desired_quality');
	});
});

import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { movies } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

vi.mock('#lib/server/quality/QualityFilter.js', () => ({
	qualityFilter: {
		getProfile: vi.fn().mockResolvedValue(null),
		getDefaultScoringProfile: vi.fn().mockResolvedValue({ id: 'balanced', upgradesAllowed: true })
	}
}));

const { GrabService } = await import('./GrabService.js');

type Testable = {
	resolveTarget: (request: {
		target: { type: 'movie'; movieId: string };
	}) => Promise<{ desiredQualities?: string[] }>;
};

describe('GrabService.resolveTarget - desiredQualities threading', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});
	beforeEach(() => {
		testDb.sqlite.exec(
			'DELETE FROM acquisition_reservations; DELETE FROM acquisition_intents; DELETE FROM movies;'
		);
	});

	it('threads movie desiredQualities into the resolved context', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'm1',
				tmdbId: 1,
				title: 'Test',
				path: 'Test',
				desiredQualities: ['2160p', '1080p']
			})
			.run();

		const service = new GrabService() as unknown as Testable;
		const resolved = await service.resolveTarget({ target: { type: 'movie', movieId: 'm1' } });

		expect(resolved.desiredQualities).toEqual(['2160p', '1080p']);
	});

	it('leaves desiredQualities undefined for a single-quality movie', async () => {
		testDb.db.insert(movies).values({ id: 'm2', tmdbId: 2, title: 'Test 2', path: 'Test 2' }).run();

		const service = new GrabService() as unknown as Testable;
		const resolved = await service.resolveTarget({ target: { type: 'movie', movieId: 'm2' } });

		expect(resolved.desiredQualities).toBeUndefined();
	});
});

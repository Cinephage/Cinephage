import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { downloadHistory, movies } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

vi.mock('#lib/server/filters/GrabDecisionPipeline.js', () => ({
	grabDecisionPipeline: {
		evaluate: vi.fn(async () => ({
			accepted: true,
			reason: 'Accepted',
			upgradeStatus: 'new',
			scores: { candidate: 0 },
			audit: { stages: [], finalResult: { accepted: true }, totalDurationMs: 0 }
		}))
	}
}));

vi.mock('#lib/server/quality/QualityFilter.js', () => ({
	qualityFilter: {
		getDefaultScoringProfile: vi.fn(async () => ({ id: 'profile-1', name: 'Default' }))
	}
}));

vi.mock('#lib/server/acquisition/MediaOccupancyService.js', () => ({
	mediaOccupancyService: {
		runExclusive: vi.fn(async (_target, operation: () => Promise<unknown>) => operation())
	}
}));

vi.mock('#lib/server/settings/acquisition.js', () => ({
	getDefaultAcquisitionProtocol: vi.fn(() => 'torrent')
}));

// The real failure this reproduces: no enabled torrent client configured.
vi.mock('./handlers/TorrentHandler.js', () => ({
	TorrentHandler: class {
		handle = vi.fn(async () => ({
			success: false,
			error: 'No enabled torrent download client configured'
		}));
	}
}));
vi.mock('./handlers/UsenetHandler.js', () => ({
	UsenetHandler: class {
		handle = vi.fn();
	}
}));
vi.mock('./handlers/StreamingHandler.js', () => ({
	StreamingHandler: class {
		handle = vi.fn();
	}
}));
vi.mock('./handlers/NzbStreamingHandler.js', () => ({
	NzbStreamingHandler: class {
		handle = vi.fn();
	}
}));

const { GrabService } = await import('./GrabService.js');

/**
 * Regression test for a real report: a grab that fails after a release is
 * matched (e.g. no enabled download client for the release's protocol) was
 * only ever logged - never recorded anywhere queryable.
 */
describe('GrabService - failed grab persists a real download_history record', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		testDb.sqlite.exec('DELETE FROM acquisition_reservations; DELETE FROM acquisition_intents;');
		testDb.sqlite.exec('DELETE FROM download_history;');
		testDb.sqlite.exec('DELETE FROM movies;');
	});

	it('writes a failed history row with the real error message when routeByProtocol fails', async () => {
		testDb.db
			.insert(movies)
			.values({ id: 'movie-1', tmdbId: 1, title: 'The Wild Robot', path: 'The Wild Robot' })
			.run();

		const result = await new GrabService().grab({
			release: {
				title: 'The.Wild.Robot.2024.2160p.WEB',
				protocol: 'torrent',
				downloadUrl: 'https://indexer.example/download/1',
				indexerId: 'indexer-1',
				indexerName: 'DigitalCore',
				size: 5_000_000_000
			},
			target: { type: 'movie', movieId: 'movie-1' },
			options: { force: false, skipBlocklist: false, allowSidegrade: false, isAutomatic: true }
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe('No enabled torrent download client configured');

		// persistFailedGrab is fire-and-forget - give its microtask a tick.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const rows = await testDb.db
			.select()
			.from(downloadHistory)
			.where(eq(downloadHistory.movieId, 'movie-1'));

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			title: 'The.Wild.Robot.2024.2160p.WEB',
			status: 'failed',
			statusReason: 'No enabled torrent download client configured',
			indexerName: 'DigitalCore',
			protocol: 'torrent'
		});
		expect(rows[0].downloadId).toBeNull();
	});
});

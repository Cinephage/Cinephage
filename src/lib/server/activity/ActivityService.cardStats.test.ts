import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper';
import {
	downloadClients,
	downloadHistory,
	downloadQueue,
	movies,
	taskHistory
} from '#lib/server/db/schema.js';
import type { ActivityFilters, ActivityScope } from '#lib/types/activity.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const { ActivityService } = await import('./ActivityService');

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	testDb.db.delete(downloadQueue).run();
	testDb.db.delete(downloadHistory).run();
	testDb.db.delete(taskHistory).run();
	testDb.db.delete(downloadClients).run();
	testDb.db.delete(movies).run();
});

let tmdbId = 1000;

async function insertMovie(title: string): Promise<string> {
	const id = randomUUID();
	tmdbId += 1;
	await testDb.db.insert(movies).values({ id, tmdbId, title, path: `/movies/${title}` });
	return id;
}

async function insertQueueRow(status: string, index: number): Promise<string> {
	const title = `Movie ${status} ${index}`;
	const movieId = await insertMovie(title);
	await testDb.db.insert(downloadQueue).values({
		id: randomUUID(),
		downloadClientId: 'client-1',
		downloadId: `download-${status}`,
		movieId,
		title: `Movie.${status}.${index}.2025.1080p.WEB-DL-GRP`,
		protocol: 'torrent',
		status: status as typeof downloadQueue.$inferInsert.status,
		progress: '0.5',
		addedAt: `2026-11-20T00:00:0${index}.000Z`
	});
	return movieId;
}

async function insertFailedHistory(overrides: {
	movieId: string;
	title: string;
	downloadId: string;
	createdAt: string;
}): Promise<void> {
	await testDb.db.insert(downloadHistory).values({
		id: randomUUID(),
		downloadClientId: 'client-1',
		downloadId: overrides.downloadId,
		title: overrides.title,
		protocol: 'torrent',
		movieId: overrides.movieId,
		status: 'failed',
		statusReason: 'Download failed',
		grabbedAt: overrides.createdAt,
		createdAt: overrides.createdAt
	});
}

/**
 * A queue with every status the Activity page meets, two media-move tasks
 * and failed history rows (two of them duplicates of one release, one for a
 * release that is downloading again).
 */
async function seedActivity(): Promise<void> {
	await testDb.db.insert(downloadClients).values({
		id: 'client-1',
		name: 'Test client',
		implementation: 'qbittorrent',
		host: 'localhost',
		port: 8080
	});

	const statuses = [
		'downloading',
		'queued',
		'awaiting',
		'importing',
		'completed',
		'seeding',
		'paused',
		'failed',
		'imported'
	];
	const movieIds = new Map<string, string>();
	for (const [index, status] of statuses.entries()) {
		movieIds.set(status, await insertQueueRow(status, index));
	}

	await testDb.db.insert(taskHistory).values([
		{
			taskId: 'media-move:movie:moving-movie',
			status: 'running',
			results: { mediaTitle: 'Movie being moved' },
			startedAt: '2026-11-20T01:00:00.000Z'
		},
		{
			taskId: 'media-move:movie:moved-movie',
			status: 'completed',
			results: { mediaTitle: 'Movie already moved' },
			startedAt: '2026-11-19T01:00:00.000Z',
			completedAt: '2026-11-19T01:05:00.000Z'
		},
		{
			taskId: 'media-move:movie:unmoved-movie',
			status: 'failed',
			results: { mediaTitle: 'Movie that failed to move' },
			errors: ['Disk full'],
			startedAt: '2026-11-18T01:00:00.000Z',
			completedAt: '2026-11-18T01:05:00.000Z'
		}
	]);

	// The release that is downloading again failed once before.
	await insertFailedHistory({
		movieId: movieIds.get('downloading')!,
		title: 'Movie.downloading.0.2025.1080p.WEB-DL-GRP',
		downloadId: 'download-downloading',
		createdAt: '2026-11-10T00:00:00.000Z'
	});
	// The same release failed three times: the History list shows it once.
	const thriceFailed = await insertMovie('Movie failed three times');
	for (const createdAt of [
		'2026-11-11T00:00:00.000Z',
		'2026-11-12T00:00:00.000Z',
		'2026-11-13T00:00:00.000Z'
	]) {
		await insertFailedHistory({
			movieId: thriceFailed,
			title: 'Movie.failed.thrice.2025.1080p.WEB-DL-GRP',
			downloadId: 'download-failed-thrice',
			createdAt
		});
	}
}

async function listTotal(filters: ActivityFilters, scope: ActivityScope): Promise<number> {
	const result = await ActivityService.getInstance().getActivities(
		filters,
		{ field: 'time', direction: 'desc' },
		{ limit: 50, offset: 0 },
		scope
	);
	return result.total;
}

describe('ActivityService card counts', () => {
	it('counts the same active rows the Active list shows', async () => {
		await seedActivity();
		const service = ActivityService.getInstance();

		const stats = await service.getQueueCardStats();

		// downloading, queued, awaiting, importing, completed and the running move.
		expect(stats.downloadingCount).toBe(6);
		expect(stats.seedingCount).toBe(1);
		expect(stats.pausedCount).toBe(1);
		expect(stats.totalCount).toBe(8);
		expect(stats.totalCount).toBe(stats.downloadingCount + stats.seedingCount + stats.pausedCount);
		expect(await listTotal({ status: 'all' }, 'active')).toBe(stats.totalCount);
		expect(await service.getActiveCount()).toBe(stats.totalCount);
	});

	it('gives each tile the number of rows its filter lists', async () => {
		await seedActivity();
		const stats = await ActivityService.getInstance().getQueueCardStats();

		expect(await listTotal({ status: 'downloading' }, 'active')).toBe(stats.downloadingCount);
		expect(await listTotal({ status: 'seeding' }, 'active')).toBe(stats.seedingCount);
		expect(await listTotal({ status: 'paused' }, 'active')).toBe(stats.pausedCount);
		expect(await listTotal({ status: 'failed' }, 'history')).toBe(stats.failedCount);
	});

	it('lists a download that is being recovered (awaiting) as downloading', async () => {
		await seedActivity();

		const result = await ActivityService.getInstance().getActivities(
			{ status: 'downloading' },
			{ field: 'time', direction: 'desc' },
			{ limit: 50, offset: 0 },
			'active'
		);

		const awaiting = result.activities.find(
			(activity) => activity.releaseTitle === 'Movie.awaiting.2.2025.1080p.WEB-DL-GRP'
		);
		expect(awaiting?.status).toBe('downloading');
		expect(result.activities.map((activity) => activity.status)).toContain('importing');
	});

	it('builds an Active tab summary that adds up to the card counts', async () => {
		await seedActivity();
		const service = ActivityService.getInstance();

		const [stats, result] = await Promise.all([
			service.getQueueCardStats(),
			service.getActivities(
				{ status: 'all' },
				{ field: 'time', direction: 'desc' },
				{ limit: 50, offset: 0 },
				'active'
			)
		]);

		expect(result.summary).not.toBeNull();
		expect(result.summary!.totalCount).toBe(stats.totalCount);
		expect(result.summary!.downloadingCount + result.summary!.importingCount).toBe(
			stats.downloadingCount
		);
		expect(result.summary!.failedCount).toBe(stats.failedCount);
	});

	it('counts failed rows the way the History list shows them', async () => {
		await seedActivity();

		const stats = await ActivityService.getInstance().getQueueCardStats();

		// Four failed download_history rows, three of them one release, plus
		// the failed move. The failed queue row is not a History row.
		expect(stats.failedCount).toBe(3);
	});

	it('leaves failed and imported queue rows out of the active counts', async () => {
		await seedActivity();
		const result = await ActivityService.getInstance().getActivities(
			{ status: 'all' },
			{ field: 'time', direction: 'desc' },
			{ limit: 50, offset: 0 },
			'active'
		);

		const titles = result.activities.map((activity) => activity.releaseTitle);
		expect(titles).not.toContain('Movie.failed.7.2025.1080p.WEB-DL-GRP');
		expect(titles).not.toContain('Movie.imported.8.2025.1080p.WEB-DL-GRP');
	});
});

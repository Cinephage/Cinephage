import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper';
import { albums, artists, downloadClients, downloadQueue, mediaItems } from '#lib/server/db/schema.js';

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
	testDb.db.delete(downloadClients).run();
	testDb.db.delete(albums).run();
	testDb.db.delete(artists).run();
	testDb.db.delete(mediaItems).run();
});

async function seedMusicQueue(): Promise<void> {
	const artistId = randomUUID();
	const albumId = randomUUID();
	const mediaItemId = randomUUID();

	await testDb.db.insert(artists).values({ id: artistId, name: 'Chris Webby', mbid: 'artist-mbid' });
	await testDb.db.insert(mediaItems).values({
		id: mediaItemId,
		kind: 'album',
		title: 'The White Noise LP',
		year: 2009
	});
	await testDb.db.insert(albums).values({
		id: albumId,
		mediaItemId,
		artistId,
		title: 'The White Noise LP',
		year: 2009
	});
	await testDb.db.insert(downloadClients).values({
		id: 'client-1',
		name: 'Test client',
		implementation: 'qbittorrent',
		host: 'localhost',
		port: 8080
	});
	await testDb.db.insert(downloadQueue).values({
		id: randomUUID(),
		downloadClientId: 'client-1',
		downloadId: 'music-download',
		mediaItemId,
		title: 'Chris.Webby.The.White.Noise.LP.2009.FLAC',
		protocol: 'torrent',
		status: 'downloading',
		progress: '0.4',
		addedAt: '2026-11-20T00:00:00.000Z'
	});
}

describe('ActivityService music rows', () => {
	it('resolves a queue row through media_items to the album and artist', async () => {
		await seedMusicQueue();

		const result = await ActivityService.getInstance().getActivities(
			{ mediaType: 'music' },
			{ field: 'time', direction: 'desc' },
			{ limit: 50, offset: 0 },
			'all'
		);

		expect(result.total).toBe(1);
		expect(result.activities).toHaveLength(1);
		expect(result.activities[0]).toMatchObject({
			mediaType: 'album',
			mediaTitle: 'The White Noise LP',
			mediaYear: 2009,
			artistName: 'Chris Webby',
			releaseTitle: 'Chris.Webby.The.White.Noise.LP.2009.FLAC'
		});
	});

	it('keeps music out of the movie and TV filters', async () => {
		await seedMusicQueue();
		const service = ActivityService.getInstance();

		const movies = await service.getActivities(
			{ mediaType: 'movie' },
			{ field: 'time', direction: 'desc' },
			{ limit: 50, offset: 0 },
			'all'
		);
		const tv = await service.getActivities(
			{ mediaType: 'tv' },
			{ field: 'time', direction: 'desc' },
			{ limit: 50, offset: 0 },
			'all'
		);

		expect(movies.total).toBe(0);
		expect(tv.total).toBe(0);
	});
});

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as schema from '#lib/server/db/schema.js';
import { createTestDb, destroyTestDb, clearTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { getCalendarData } from './queries.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

function seedAlbum(releaseDate: string | null, monitored = true) {
	const mediaItemId = randomUUID();
	testDb.db
		.insert(schema.mediaItems)
		.values({ id: mediaItemId, kind: 'music', title: 'Discovery' })
		.run();
	const artistId = randomUUID();
	testDb.db.insert(schema.artists).values({ id: artistId, name: 'Daft Punk' }).run();
	testDb.db
		.insert(schema.albums)
		.values({
			id: randomUUID(),
			mediaItemId,
			artistId,
			title: 'Discovery',
			year: 2001,
			releaseDate,
			monitored
		})
		.run();
}

beforeEach(() => {
	clearTestDb(testDb);
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('getCalendarData music', () => {
	it('places a monitored album on its release day', async () => {
		seedAlbum('2001-02-26');

		const days = await getCalendarData('2001-02', 'music');

		const day = days.find((entry) => entry.date === '2001-02-26');
		expect(day?.albums).toHaveLength(1);
		expect(day?.albums[0]).toMatchObject({
			title: 'Discovery',
			artistName: 'Daft Punk',
			releaseDate: '2001-02-26'
		});
		expect(days.every((entry) => entry.movies.length === 0 && entry.episodes.length === 0)).toBe(true);
	});

	it('skips unmonitored albums and partial dates', async () => {
		seedAlbum('2001-02-26', false);
		seedAlbum('2001-02');

		const days = await getCalendarData('2001-02', 'music');

		expect(days.every((entry) => entry.albums.length === 0)).toBe(true);
	});

	it('leaves albums out of a video-only view', async () => {
		seedAlbum('2001-02-26');

		const days = await getCalendarData('2001-02', 'episodes');

		expect(days.every((entry) => entry.albums.length === 0)).toBe(true);
	});
});

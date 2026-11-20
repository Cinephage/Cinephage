import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper.js';

const testDb: TestDatabase = createTestDb();
const published: Array<{ event: string; payload: Record<string, unknown> }> = [];

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

vi.mock('./delivery.js', () => ({
	getNotificationDeliveryService: () => ({
		publish: async (event: string, payload: Record<string, unknown>) => {
			published.push({ event, payload });
		}
	})
}));

const { publishImport } = await import('./app-events.js');

beforeEach(() => {
	clearTestDb(testDb);
	published.length = 0;
});

afterAll(() => destroyTestDb(testDb));

describe('music notifications', () => {
	it('names the album and artist and links to the music library', async () => {
		testDb.db
			.insert(schema.mediaItems)
			.values({ id: 'mi-album', kind: 'album', title: 'Discovery' })
			.run();
		testDb.db.insert(schema.artists).values({ id: 'ar-dp', name: 'Daft Punk' }).run();
		testDb.db
			.insert(schema.albums)
			.values({
				id: 'al-discovery',
				mediaItemId: 'mi-album',
				artistId: 'ar-dp',
				title: 'Discovery',
				year: 2001,
				mbid: 'rg-discovery'
			})
			.run();

		publishImport({
			mediaType: 'album',
			mediaId: 'al-discovery',
			releaseName: 'Daft Punk - Discovery (2001) [FLAC]'
		});

		await vi.waitFor(() => expect(published).toHaveLength(1));
		expect(published[0].event).toBe('import');
		expect(published[0].payload.media).toMatchObject({
			type: 'album',
			title: 'Daft Punk — Discovery',
			year: 2001,
			mbid: 'rg-discovery'
		});
		expect(String(published[0].payload.summary)).toContain('Album imported');
	});
});

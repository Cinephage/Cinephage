import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper.js';
import { api } from '../../../../test/api-helper.js';

/**
 * The Songs window is the one list that was already paged. This pins the
 * contract the page depends on: `quality=all` means unfiltered (not "a profile
 * named all"), and a real profile still narrows the rows.
 */
const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

const { GET } = await import('./+server.js');

function seedTrack(albumId: string, id: string, title: string, position: number): void {
	testDb.db.insert(schema.tracks).values({ id, albumId, title, position }).run();
}

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(schema.libraries).run();
	testDb.db.delete(schema.settings).run();

	testDb.db
		.insert(schema.scoringProfiles)
		.values([
			{
				id: 'music-a',
				name: 'A',
				mediaKind: 'music',
				musicTiers: [{ kind: 'lossless', label: 'Lossless' }],
				isBuiltIn: true
			},
			{
				id: 'music-b',
				name: 'B',
				mediaKind: 'music',
				musicTiers: [{ kind: 'lossy', label: 'Lossy' }],
				isBuiltIn: true
			}
		])
		.run();
	testDb.db
		.insert(schema.settings)
		.values({ key: 'music_quality', value: JSON.stringify({ defaultProfileId: 'music-a' }) })
		.run();
	testDb.db
		.insert(schema.libraries)
		.values({
			id: 'lib-music',
			name: 'Music',
			slug: 'music',
			mediaType: 'music',
			mediaSubType: 'standard'
		})
		.run();
	testDb.db
		.insert(schema.artists)
		.values({ id: 'artist-1', name: 'Artist', mbid: 'mbid-artist-1', libraryId: 'lib-music' })
		.run();

	for (const [index, profile] of ['music-a', 'music-b'].entries()) {
		const albumId = `album-${profile}`;
		testDb.db
			.insert(schema.mediaItems)
			.values({ id: `mi-${profile}`, kind: 'album', title: profile })
			.run();
		testDb.db
			.insert(schema.albums)
			.values({
				id: albumId,
				mediaItemId: `mi-${profile}`,
				artistId: 'artist-1',
				title: profile,
				libraryId: 'lib-music',
				qualityProfileId: profile
			})
			.run();
		seedTrack(albumId, `track-${index}`, `${profile} song`, index + 1);
	}
});

afterAll(() => destroyTestDb(testDb));

describe('GET /api/music/tracks', () => {
	it('treats quality=all as the unfiltered list', async () => {
		const { status, data } = await api.get<any>(GET, {
			auth: 'admin',
			url: 'http://localhost/api/music/tracks?quality=all'
		});

		expect(status).toBe(200);
		expect(data.total).toBe(2);
		expect(data.tracks).toHaveLength(2);
	});

	it('narrows to the albums behind a real profile', async () => {
		const { status, data } = await api.get<any>(GET, {
			auth: 'admin',
			url: 'http://localhost/api/music/tracks?quality=music-a'
		});

		expect(status).toBe(200);
		expect(data.total).toBe(1);
		expect(data.tracks[0].title).toBe('music-a song');
	});
});

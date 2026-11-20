import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';
import { musicArtistService } from './MusicArtistService.js';
import { musicBrainz } from './musicbrainz.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

beforeEach(() => clearTestDb(testDb));
afterEach(() => vi.restoreAllMocks());
afterAll(() => destroyTestDb(testDb));

function seedArtist(id: string, mbid: string | null, name: string): void {
	testDb.db.insert(schema.artists).values({ id, mbid, name }).run();
}

describe('MusicArtistService.refreshArtist', () => {
	it('replaces the artist fields from MusicBrainz', async () => {
		seedArtist('artist-1', 'mbid-old', 'Old Name');
		vi.spyOn(musicBrainz, 'getArtist').mockResolvedValue({
			mbid: 'mbid-old',
			name: 'New Name',
			sortName: 'New Name',
			disambiguation: 'UK band',
			type: 'Group',
			country: 'GB',
			genres: ['rock', 'pop']
		});

		const artist = await musicArtistService.refreshArtist('artist-1');

		expect(artist).toMatchObject({
			name: 'New Name',
			sortName: 'New Name',
			disambiguation: 'UK band',
			artistType: 'Group',
			country: 'GB',
			genres: ['rock', 'pop']
		});
	});
});

describe('MusicArtistService.rematchArtist', () => {
	it('refuses an mbid another artist already holds', async () => {
		seedArtist('artist-1', 'mbid-old', 'One');
		seedArtist('artist-2', 'mbid-taken', 'Two');

		await expect(musicArtistService.rematchArtist('artist-1', 'mbid-taken')).rejects.toThrow(
			/Another artist/
		);
	});

	it('changes the identity and reports the albums left attached', async () => {
		seedArtist('artist-1', 'mbid-old', 'Old Name');
		vi.spyOn(musicBrainz, 'getArtist').mockResolvedValue({
			mbid: 'mbid-new',
			name: 'Right Artist',
			sortName: 'Right Artist',
			disambiguation: null,
			type: 'Person',
			country: 'US',
			genres: []
		});

		const result = await musicArtistService.rematchArtist('artist-1', 'mbid-new');

		expect(result.artist).toMatchObject({ mbid: 'mbid-new', name: 'Right Artist' });
		expect(result.albums).toBe(0);
		expect(
			testDb.db.select().from(schema.artists).where(eq(schema.artists.id, 'artist-1')).get()
		).toMatchObject({ mbid: 'mbid-new', artistType: 'Person' });
	});
});

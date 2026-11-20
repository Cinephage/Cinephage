import { describe, it, expect, vi } from 'vitest';
import * as schema from '#lib/server/db/schema.js';
import { createTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { musicProfileService } from './MusicProfileService.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

function seedMusicProfile(id: string, name: string) {
	testDb.db
		.insert(schema.scoringProfiles)
		.values({
			id,
			name,
			mediaKind: 'music',
			musicTiers: [{ kind: 'lossless', label: 'Lossless' }],
			isBuiltIn: true
		})
		.run();
}

function seedArtistAndAlbum(artistProfile: string | null, albumProfile: string | null) {
	testDb.db
		.insert(schema.mediaItems)
		.values({ id: 'mi-1', kind: 'album', title: 'Discovery' })
		.run();
	testDb.db
		.insert(schema.artists)
		.values({ id: 'artist-1', name: 'Daft Punk', qualityProfileId: artistProfile })
		.run();
	testDb.db
		.insert(schema.albums)
		.values({
			id: 'album-1',
			mediaItemId: 'mi-1',
			artistId: 'artist-1',
			title: 'Discovery',
			qualityProfileId: albumProfile
		})
		.run();
}

describe('MusicProfileService', () => {
	it('lists only music profiles and reads the default from settings', () => {
		seedMusicProfile('music-a', 'A');
		testDb.db
			.insert(schema.scoringProfiles)
			.values({ id: 'video-a', name: 'Video', mediaKind: 'video' })
			.run();

		expect(musicProfileService.list().map((p) => p.id)).toContain('music-a');
		expect(musicProfileService.list().every((p) => p.tiers.length > 0)).toBe(true);

		musicProfileService.setDefault('music-a');
		expect(musicProfileService.getDefault()?.id).toBe('music-a');
	});

	it('resolves album then artist then default', () => {
		seedMusicProfile('music-artist', 'Artist profile');
		seedMusicProfile('music-album', 'Album profile');
		seedArtistAndAlbum('music-artist', 'music-album');

		expect(musicProfileService.resolveForAlbum('album-1').id).toBe('music-album');

		testDb.db.update(schema.albums).set({ qualityProfileId: null }).run();
		expect(musicProfileService.resolveForAlbum('album-1').id).toBe('music-artist');

		testDb.db.update(schema.artists).set({ qualityProfileId: null }).run();
		expect(musicProfileService.resolveForAlbum('album-1').id).toBe(
			musicProfileService.getDefault()?.id
		);
	});

	it('validates tiers and refuses to delete a built-in profile', () => {
		seedMusicProfile('music-builtin', 'Built in');
		expect(() =>
			musicProfileService.create({ name: 'Broken', tiers: [] })
		).toThrow(/at least one tier/i);
		expect(() => musicProfileService.remove('music-builtin')).toThrow(/built-in/i);
	});
});

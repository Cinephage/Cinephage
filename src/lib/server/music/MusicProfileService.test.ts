import { describe, it, expect, vi } from 'vitest';
import * as schema from '#lib/server/db/schema.js';
import { createTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { musicProfileService } from './MusicProfileService.js';
import { gradeMusicRelease } from './parse-release.js';

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

function seedMusicLibrary(qualityProfileId: string | null) {
	testDb.db
		.insert(schema.libraries)
		.values({
			id: 'lib-music',
			name: 'Music',
			slug: 'music',
			mediaType: 'music',
			mediaSubType: 'standard',
			qualityProfileId
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
		.values({
			id: 'artist-1',
			name: 'Daft Punk',
			libraryId: 'lib-music',
			qualityProfileId: artistProfile
		})
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

	it('resolves album then artist then library then default', () => {
		seedMusicProfile('music-artist', 'Artist profile');
		seedMusicProfile('music-album', 'Album profile');
		seedMusicProfile('music-library', 'Library profile');
		seedMusicLibrary('music-library');
		seedArtistAndAlbum('music-artist', 'music-album');

		expect(musicProfileService.resolveForAlbum('album-1').id).toBe('music-album');

		testDb.db.update(schema.albums).set({ qualityProfileId: null }).run();
		expect(musicProfileService.resolveForAlbum('album-1').id).toBe('music-artist');

		testDb.db.update(schema.artists).set({ qualityProfileId: null }).run();
		expect(musicProfileService.resolveForAlbum('album-1').id).toBe('music-library');

		testDb.db.update(schema.libraries).set({ qualityProfileId: null }).run();
		expect(musicProfileService.resolveForAlbum('album-1').id).toBe(
			musicProfileService.getDefault()?.id
		);
	});

	it('stores fallback and size bounds in the music columns, not upgradesAllowed', () => {
		const created = musicProfileService.create({
			name: 'Custom',
			tiers: [{ kind: 'lossless', label: 'Lossless' }],
			allowFallback: false,
			minSizeMb: 100,
			maxSizeMb: 2000
		});

		const row = testDb.sqlite
			.prepare(
				'SELECT music_allow_fallback, upgrades_allowed, music_min_size_mb, music_max_size_mb FROM scoring_profiles WHERE id = ?'
			)
			.get(created.id) as {
			music_allow_fallback: number;
			upgrades_allowed: number;
			music_min_size_mb: number;
			music_max_size_mb: number;
		};

		expect(row.music_allow_fallback).toBe(0);
		expect(row.music_min_size_mb).toBe(100);
		expect(row.music_max_size_mb).toBe(2000);
		expect(created.allowFallback).toBe(false);
	});

	it('grades through the stored profile, so a lossless rung rejects an MP3', () => {
		testDb.db
			.insert(schema.mediaItems)
			.values({ id: 'mi-grade', kind: 'album', title: 'Grade Me' })
			.run();
		testDb.db.insert(schema.artists).values({ id: 'artist-grade', name: 'Grade Artist' }).run();
		testDb.db
			.insert(schema.albums)
			.values({
				id: 'album-grade',
				mediaItemId: 'mi-grade',
				artistId: 'artist-grade',
				title: 'Grade Me',
				qualityProfileId: 'music-default'
			})
			.run();
		const profile = musicProfileService.resolveForAlbum('album-grade');

		const flac = gradeMusicRelease(profile, {
			title: 'Daft Punk - Discovery (2001) [FLAC 24-96]',
			protocol: 'torrent'
		});
		const mp3 = gradeMusicRelease(profile, {
			title: 'Daft Punk - Discovery (2001) [MP3 128]',
			protocol: 'torrent'
		});

		expect(flac.tierIndex).toBe(0);
		expect(flac.tierLabel).toBe('Lossless');
		expect(mp3.tierIndex).toBeGreaterThan(0);
		expect(mp3.tierLabel).not.toBe('Lossless');
	});

	it('validates tiers and size bounds, and refuses to delete a built-in profile', () => {
		seedMusicProfile('music-builtin', 'Built in');
		expect(() => musicProfileService.create({ name: 'Broken', tiers: [] })).toThrow(
			/at least one tier/i
		);
		expect(() =>
			musicProfileService.create({
				name: 'Inverted',
				tiers: [{ kind: 'lossless', label: 'Lossless' }],
				minSizeMb: 900,
				maxSizeMb: 100
			})
		).toThrow(/floor cannot be above the ceiling/i);
		expect(() => musicProfileService.remove('music-builtin')).toThrow(/built-in/i);
	});
});

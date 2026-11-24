import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';

/**
 * The artist list is a rollup of the albums table: it appears when the artist
 * owns at least one album, and library/profile filters scope through those
 * albums. These tests pin the rollup, the file-state HAVING and the sorts the
 * browser used to perform.
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

const { musicArtistService } = await import('./MusicArtistService.js');

let albumCounter = 0;

function seedProfile(id: string): void {
	testDb.db
		.insert(schema.scoringProfiles)
		.values({
			id,
			name: id,
			mediaKind: 'music',
			musicTiers: [{ kind: 'lossless', label: 'Lossless' }],
			isBuiltIn: true
		})
		.run();
}

function seedLibrary(id: string, profile: string | null): void {
	testDb.db
		.insert(schema.libraries)
		.values({
			id,
			name: id,
			slug: id,
			mediaType: 'music',
			mediaSubType: 'standard',
			qualityProfileId: profile
		})
		.run();
}

function seedArtist(
	id: string,
	name: string,
	options: { profile?: string | null; monitored?: boolean; libraryId?: string } = {}
): void {
	testDb.db
		.insert(schema.artists)
		.values({
			id,
			name,
			mbid: `mbid-${id}`,
			monitored: options.monitored ?? true,
			libraryId: options.libraryId ?? 'lib-music',
			qualityProfileId: options.profile ?? null
		})
		.run();
}

function seedAlbum(options: {
	artistId: string;
	title: string;
	libraryId?: string;
	hasFile?: boolean;
	streamSource?: string | null;
	coverPath?: string | null;
}): string {
	albumCounter += 1;
	const albumId = `album-${albumCounter}`;
	const mediaItemId = `mi-${albumCounter}`;

	testDb.db
		.insert(schema.mediaItems)
		.values({ id: mediaItemId, kind: 'album', title: options.title })
		.run();
	testDb.db
		.insert(schema.albums)
		.values({
			id: albumId,
			mediaItemId,
			artistId: options.artistId,
			title: options.title,
			hasFile: options.hasFile ?? false,
			streamSource: options.streamSource ?? null,
			libraryId: options.libraryId ?? 'lib-music',
			coverPath: options.coverPath ?? null
		})
		.run();
	return albumId;
}

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(schema.libraries).run();
	testDb.db.delete(schema.settings).run();

	seedProfile('music-a');
	seedProfile('music-b');
	testDb.db
		.insert(schema.settings)
		.values({ key: 'music_quality', value: JSON.stringify({ defaultProfileId: 'music-a' }) })
		.run();
	seedLibrary('lib-music', null);
	seedLibrary('lib-music-b', 'music-b');
});

afterAll(() => destroyTestDb(testDb));

describe('MusicArtistService.listArtistsPage', () => {
	it('rolls albums up into the card shape', () => {
		seedArtist('artist-alpha', 'Alpha', { profile: 'music-b' });
		const cover = seedAlbum({
			artistId: 'artist-alpha',
			title: 'First',
			hasFile: true,
			coverPath: '/media/cover.jpg'
		});
		seedAlbum({ artistId: 'artist-alpha', title: 'Second' });

		const page = musicArtistService.listArtistsPage();
		expect(page.total).toBe(1);
		expect(page.rows[0]).toMatchObject({
			id: 'artist-alpha',
			name: 'Alpha',
			albumCount: 2,
			inLibraryCount: 1,
			coverAlbumId: cover,
			monitored: true
		});
	});

	it('searches the artist name and skips artists with no albums', () => {
		seedArtist('artist-alpha', 'Alpha');
		seedArtist('artist-beta', 'Beta');
		seedArtist('artist-empty', 'Delta');
		seedAlbum({ artistId: 'artist-alpha', title: 'A' });
		seedAlbum({ artistId: 'artist-beta', title: 'B' });

		expect(
			musicArtistService.listArtistsPage({ q: 'alp' }).rows.map((row) => row.name)
		).toEqual(['Alpha']);
		expect(musicArtistService.listArtistsPage({ q: 'delta' }).total).toBe(0);
	});

	it('filters by monitoring', () => {
		seedArtist('artist-alpha', 'Alpha', { monitored: true });
		seedArtist('artist-beta', 'Beta', { monitored: false });
		seedAlbum({ artistId: 'artist-alpha', title: 'A' });
		seedAlbum({ artistId: 'artist-beta', title: 'B' });

		expect(
			musicArtistService.listArtistsPage({ monitor: 'unmonitored' }).rows.map((row) => row.name)
		).toEqual(['Beta']);
	});

	it('scopes library and profile through the artist albums', () => {
		seedArtist('artist-alpha', 'Alpha', { profile: 'music-b' });
		seedArtist('artist-beta', 'Beta');
		seedArtist('artist-gamma', 'Gamma');
		seedAlbum({ artistId: 'artist-alpha', title: 'A' });
		seedAlbum({ artistId: 'artist-beta', title: 'B', libraryId: 'lib-music-b' });
		seedAlbum({ artistId: 'artist-gamma', title: 'G', libraryId: 'lib-music' });

		expect(
			musicArtistService
				.listArtistsPage({ libraryId: 'lib-music-b' })
				.rows.map((row) => row.name)
		).toEqual(['Beta']);

		// Alpha inherits music-b from the artist, Beta from the library;
		// Gamma resolves to the default music-a.
		expect(
			musicArtistService.listArtistsPage({ quality: 'music-b' }).rows.map((row) => row.name)
		).toEqual(['Alpha', 'Beta']);
	});

	it('treats "missing" as no file and no stream', () => {
		seedArtist('artist-alpha', 'Alpha');
		seedArtist('artist-beta', 'Beta');
		seedArtist('artist-gamma', 'Gamma');
		seedAlbum({ artistId: 'artist-alpha', title: 'A', hasFile: true });
		seedAlbum({ artistId: 'artist-beta', title: 'B', streamSource: 'cinephage-stream' });
		seedAlbum({ artistId: 'artist-gamma', title: 'G' });

		expect(
			musicArtistService.listArtistsPage({ file: 'missing' }).rows.map((row) => row.name)
		).toEqual(['Gamma']);
		expect(
			musicArtistService.listArtistsPage({ file: 'downloaded' }).rows.map((row) => row.name)
		).toEqual(['Alpha']);
	});

	it('sorts by album count and by missing albums', () => {
		seedArtist('artist-alpha', 'Alpha');
		seedArtist('artist-beta', 'Beta');
		seedAlbum({ artistId: 'artist-alpha', title: 'A1', hasFile: true });
		seedAlbum({ artistId: 'artist-alpha', title: 'A2', hasFile: true });
		seedAlbum({ artistId: 'artist-beta', title: 'B1' });

		expect(
			musicArtistService.listArtistsPage({ sort: 'albums-desc' }).rows.map((row) => row.name)
		).toEqual(['Alpha', 'Beta']);
		expect(
			musicArtistService.listArtistsPage({ sort: 'missing-desc' }).rows.map((row) => row.name)
		).toEqual(['Beta', 'Alpha']);
	});

	it('pages the list and keeps the filtered total', () => {
		for (const name of ['Alpha', 'Beta', 'Gamma']) {
			seedArtist(`artist-${name.toLowerCase()}`, name);
			seedAlbum({ artistId: `artist-${name.toLowerCase()}`, title: name });
		}

		const page = musicArtistService.listArtistsPage({ limit: 2, offset: 1, sort: 'name-asc' });
		expect(page.total).toBe(3);
		expect(page.rows.map((row) => row.name)).toEqual(['Beta', 'Gamma']);
	});

	it('lists the ids behind the same filters', () => {
		seedArtist('artist-alpha', 'Alpha');
		seedArtist('artist-beta', 'Beta');
		seedAlbum({ artistId: 'artist-alpha', title: 'A', hasFile: true });
		seedAlbum({ artistId: 'artist-beta', title: 'B' });

		expect(musicArtistService.listArtistIds({ file: 'downloaded' })).toEqual(['artist-alpha']);
	});

	it('counts distinct artists that own albums', () => {
		seedArtist('artist-alpha', 'Alpha');
		seedArtist('artist-beta', 'Beta');
		seedArtist('artist-empty', 'Delta');
		seedAlbum({ artistId: 'artist-alpha', title: 'A' });
		seedAlbum({ artistId: 'artist-alpha', title: 'A2' });
		seedAlbum({ artistId: 'artist-beta', title: 'B' });

		expect(musicArtistService.countArtists()).toBe(2);
	});
});

describe('MusicArtistService.listArtistsPage with streaming albums', () => {
	it('counts a stream-backed album as playable, not as an empty slot', () => {
		seedArtist('artist-stream', 'Streamer');
		seedAlbum({
			artistId: 'artist-stream',
			title: 'Streamed',
			streamSource: 'Cinephage Library'
		});
		seedAlbum({ artistId: 'artist-stream', title: 'Wanted' });

		const page = musicArtistService.listArtistsPage();

		expect(page.rows[0]).toMatchObject({ albumCount: 2, inLibraryCount: 1 });
	});
});

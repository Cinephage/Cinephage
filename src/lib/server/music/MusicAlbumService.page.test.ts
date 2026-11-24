import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';

/**
 * The album list moved from "load every row and filter in the browser" to one
 * SQL window. These tests pin the filters that used to live in the page —
 * search, file state, monitoring, library and the effective profile — plus the
 * sort and the total the window reports.
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

const { musicAlbumService } = await import('./MusicAlbumService.js');

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

function seedLibrary(id: string, mediaType: 'music' | 'movie', profile: string | null): void {
	testDb.db
		.insert(schema.libraries)
		.values({
			id,
			name: id,
			slug: id,
			mediaType,
			mediaSubType: 'standard',
			qualityProfileId: profile
		})
		.run();
}

function seedArtist(
	id: string,
	name: string,
	options: { profile?: string | null; libraryId?: string } = {}
): void {
	testDb.db
		.insert(schema.artists)
		.values({
			id,
			name,
			mbid: `mbid-${id}`,
			libraryId: options.libraryId ?? 'lib-music',
			qualityProfileId: options.profile ?? null
		})
		.run();
}

function seedAlbum(options: {
	artistId: string;
	title: string;
	libraryId?: string;
	albumProfile?: string | null;
	hasFile?: boolean;
	streamSource?: string | null;
	monitored?: boolean;
	year?: number | null;
	files?: number[];
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
			year: options.year ?? 2000,
			hasFile: options.hasFile ?? false,
			streamSource: options.streamSource ?? null,
			monitored: options.monitored ?? true,
			qualityProfileId: options.albumProfile ?? null,
			libraryId: options.libraryId ?? 'lib-music',
			coverPath: options.coverPath ?? null
		})
		.run();

	for (const [index, size] of (options.files ?? []).entries()) {
		testDb.db
			.insert(schema.trackFiles)
			.values({
				id: `tf-${albumCounter}-${index}`,
				albumId,
				relativePath: `${index}.flac`,
				sizeBytes: size
			})
			.run();
	}

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
	seedLibrary('lib-music', 'music', null);
	seedLibrary('lib-music-b', 'music', 'music-b');
	seedLibrary('lib-movies', 'movie', null);
});

afterAll(() => destroyTestDb(testDb));

describe('MusicAlbumService.listAlbumsPage', () => {
	it('searches title and artist with every word required', () => {
		seedArtist('artist-daft', 'Daft Punk');
		seedArtist('artist-other', 'Other');
		seedAlbum({ artistId: 'artist-daft', title: 'Discovery' });
		seedAlbum({ artistId: 'artist-other', title: 'Homework' });

		expect(musicAlbumService.listAlbumsPage({ q: 'daft discovery' }).rows.map((r) => r.title)).toEqual([
			'Discovery'
		]);
		expect(musicAlbumService.listAlbumsPage({ q: 'homework' }).total).toBe(1);
		expect(musicAlbumService.listAlbumsPage({ q: 'nothing here' }).total).toBe(0);
	});

	it('filters by the profile a grab would inherit', () => {
		seedArtist('artist-a', 'A', { profile: 'music-b' });
		seedArtist('artist-b', 'B');
		seedArtist('artist-c', 'C');
		seedArtist('artist-d', 'D');

		// artist -> album -> library -> default
		seedAlbum({ artistId: 'artist-a', title: 'From artist' });
		seedAlbum({ artistId: 'artist-b', title: 'From album', albumProfile: 'music-b' });
		seedAlbum({ artistId: 'artist-c', title: 'From library', libraryId: 'lib-music-b' });
		seedAlbum({ artistId: 'artist-d', title: 'From default' });

		const scoped = musicAlbumService.listAlbumsPage({ quality: 'music-b' });
		expect(scoped.rows.map((row) => row.title).sort()).toEqual([
			'From album',
			'From artist',
			'From library'
		]);
		expect(scoped.total).toBe(3);
		expect(scoped.rows.every((row) => row.effectiveProfileId === 'music-b')).toBe(true);

		expect(
			musicAlbumService.listAlbumsPage({ quality: 'music-a' }).rows.map((row) => row.title)
		).toEqual(['From default']);
	});

	it('treats "missing" as no file and no stream', () => {
		seedArtist('artist-1', 'One');
		seedAlbum({ artistId: 'artist-1', title: 'Missing' });
		seedAlbum({ artistId: 'artist-1', title: 'Streaming', streamSource: 'cinephage-stream' });
		seedAlbum({ artistId: 'artist-1', title: 'Downloaded', hasFile: true });

		const page = musicAlbumService.listAlbumsPage({ file: 'missing' });
		expect(page.rows.map((row) => row.title)).toEqual(['Missing']);
		expect(page.total).toBe(1);

		expect(
			musicAlbumService.listAlbumsPage({ file: 'downloaded' }).rows.map((row) => row.title)
		).toEqual(['Downloaded']);
	});

	it('filters by monitoring and library', () => {
		seedArtist('artist-1', 'One');
		seedAlbum({ artistId: 'artist-1', title: 'Wanted', monitored: true });
		seedAlbum({ artistId: 'artist-1', title: 'Ignored', monitored: false });
		seedAlbum({ artistId: 'artist-1', title: 'Elsewhere', libraryId: 'lib-music-b' });

		expect(
			musicAlbumService.listAlbumsPage({ monitor: 'unmonitored' }).rows.map((row) => row.title)
		).toEqual(['Ignored']);
		expect(
			musicAlbumService
				.listAlbumsPage({ libraryId: 'lib-music-b' })
				.rows.map((row) => row.title)
		).toEqual(['Elsewhere']);
	});

	it('sorts by the summed file size', () => {
		seedArtist('artist-1', 'One');
		seedAlbum({ artistId: 'artist-1', title: 'Small', files: [100, 100] });
		seedAlbum({ artistId: 'artist-1', title: 'Big', files: [500] });
		seedAlbum({ artistId: 'artist-1', title: 'Nothing' });

		expect(
			musicAlbumService.listAlbumsPage({ sort: 'size-desc' }).rows.map((row) => row.title)
		).toEqual(['Big', 'Small', 'Nothing']);
		expect(
			musicAlbumService.listAlbumsPage({ sort: 'size-asc' }).rows.map((row) => row.title)
		).toEqual(['Nothing', 'Small', 'Big']);
	});

	it('returns one window and the filtered total', () => {
		seedArtist('artist-1', 'One');
		for (let index = 0; index < 5; index += 1) {
			seedAlbum({ artistId: 'artist-1', title: `Album ${index}` });
		}

		const page = musicAlbumService.listAlbumsPage({ limit: 2, offset: 2, sort: 'title-asc' });
		expect(page.rows).toHaveLength(2);
		expect(page.total).toBe(5);
		expect(page.rows.map((row) => row.title)).toEqual(['Album 2', 'Album 3']);
	});

	it('lists the ids behind the same filters', () => {
		seedArtist('artist-1', 'One');
		const first = seedAlbum({ artistId: 'artist-1', title: 'Wanted', hasFile: true });
		seedAlbum({ artistId: 'artist-1', title: 'Not wanted' });

		expect(musicAlbumService.listAlbumIds({ file: 'downloaded' })).toEqual([first]);
	});
});

describe('MusicAlbumService.countLibrary', () => {
	it('counts albums, missing files and monitored flags', () => {
		seedArtist('artist-1', 'One');
		seedAlbum({ artistId: 'artist-1', title: 'Missing', monitored: true });
		seedAlbum({ artistId: 'artist-1', title: 'Streaming', streamSource: 'cinephage-stream' });
		seedAlbum({
			artistId: 'artist-1',
			title: 'Downloaded',
			hasFile: true,
			monitored: false
		});

		expect(musicAlbumService.countLibrary()).toEqual({
			albums: 3,
			missing: 1,
			monitored: 2
		});
	});
});

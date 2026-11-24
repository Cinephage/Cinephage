import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTestDb, createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper.js';
import { musicBrainz } from '../musicbrainz.js';
import type { MusicRecordingHit, MusicReleaseGroup } from '../types.js';
import { expandArtists, previewExpansion, type PlaylistJobRow } from './jobs.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

function group(overrides: Partial<MusicReleaseGroup> & { mbid: string }): MusicReleaseGroup {
	return {
		title: 'Discovery',
		primaryType: 'Album',
		secondaryTypes: [],
		firstReleaseDate: '2001-02-26',
		year: 2001,
		artist: { mbid: 'artist-daft-punk', name: 'Daft Punk' },
		...overrides
	};
}

function row(overrides: Partial<PlaylistJobRow> = {}): PlaylistJobRow {
	return {
		releaseGroupMbid: 'rg-seed',
		artistMbid: 'artist-daft-punk',
		title: 'Discovery',
		artistName: 'Daft Punk',
		year: 2001,
		primaryType: 'Album',
		matchedBy: 'album',
		confidence: 'high',
		tracks: [],
		inLibrary: false,
		albumId: null,
		status: 'pending',
		error: null,
		...overrides
	};
}

function hit(overrides: Partial<MusicRecordingHit> = {}): MusicRecordingHit {
	return {
		mbid: 'rec-1',
		title: 'Get Lucky',
		artistCredit: 'Daft Punk feat. Pharrell Williams',
		artists: [{ mbid: 'artist-daft-punk', name: 'Daft Punk' }],
		releaseGroup: null,
		releaseGroups: [],
		releaseMbid: null,
		releaseOwned: true,
		score: 100,
		...overrides
	};
}

beforeEach(() => {
	clearTestDb(testDb);
	vi.restoreAllMocks();
});

afterAll(() => destroyTestDb(testDb));

describe('artist expansion', () => {
	it('takes the artist albums and EPs, and leaves compilations out', async () => {
		vi.spyOn(musicBrainz, 'getArtistReleaseGroups').mockResolvedValue({
			releaseGroups: [
				group({ mbid: 'rg-discovery' }),
				group({ mbid: 'rg-ep', primaryType: 'EP', title: 'Alive' }),
				group({ mbid: 'rg-hits', secondaryTypes: ['Compilation'], title: 'Greatest Hits' }),
				group({ mbid: 'rg-single', primaryType: 'Single', title: 'One More Time' })
			],
			total: 4
		} as never);

		const rows = await expandArtists([row()], 'artist');

		expect(rows.map((entry) => entry.releaseGroupMbid).sort()).toEqual(['rg-discovery', 'rg-ep']);
	});

	it('adds the albums the artist guests on when the scope asks for features', async () => {
		vi.spyOn(musicBrainz, 'getArtistReleaseGroups').mockResolvedValue({
			releaseGroups: [group({ mbid: 'rg-discovery' })],
			total: 1
		} as never);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([
			hit({ mbid: 'rec-own', releaseGroup: group({ mbid: 'rg-discovery' }) }),
			hit({
				mbid: 'rec-guest',
				releaseGroup: group({
					mbid: 'rg-random-access',
					title: 'Random Access Memories',
					artist: { mbid: 'artist-other', name: 'Someone Else' }
				})
			}),
			hit({
				mbid: 'rec-va',
				releaseGroup: group({
					mbid: 'rg-now',
					title: 'Now That Is Music',
					secondaryTypes: ['Compilation'],
					artist: { mbid: 'artist-va', name: 'Various Artists' }
				})
			})
		]);

		const rows = await expandArtists([row()], 'features');

		expect(rows.map((entry) => entry.releaseGroupMbid).sort()).toEqual([
			'rg-discovery',
			'rg-random-access'
		]);
	});

	it('previews what the expansion adds without writing anything', async () => {
		vi.spyOn(musicBrainz, 'getArtistReleaseGroups').mockResolvedValue({
			releaseGroups: [group({ mbid: 'rg-a' }), group({ mbid: 'rg-b', title: 'Homework' })],
			total: 2
		} as never);

		const preview = await previewExpansion([row()], 'artist');

		expect(preview.total).toBe(2);
		expect(preview.byArtist).toHaveLength(1);
		expect(preview.byArtist[0]).toMatchObject({ artistName: 'Daft Punk', count: 2 });
		expect(preview.byArtist[0].albums.map((album) => album.title)).toEqual(['Discovery', 'Homework']);
	});
});

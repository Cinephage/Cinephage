import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../../../../test/db-helper.js';
import { musicBrainz } from '../musicbrainz.js';
import type { MusicReleaseGroup } from '../types.js';
import { resolvePlaylistTracks, titlesMatch } from './resolve.js';
import type { PlaylistTrack } from './types.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

function track(overrides: Partial<PlaylistTrack>): PlaylistTrack {
	return {
		title: 'One More Time',
		artists: ['Daft Punk'],
		album: null,
		year: null,
		durationMs: null,
		isrc: null,
		...overrides
	};
}

const DISCOVERY: MusicReleaseGroup = {
	mbid: 'rg-discovery',
	title: 'Discovery',
	primaryType: 'Album',
	secondaryTypes: [],
	firstReleaseDate: '2001-02-26',
	year: 2001,
	artist: { mbid: 'artist-daft-punk', name: 'Daft Punk' }
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('titlesMatch', () => {
	it('treats an edition decoration as the same work', () => {
		expect(titlesMatch('Hey Jude (Remastered 2015)', 'Hey Jude')).toBe(true);
		expect(titlesMatch('Random Access Memories (Deluxe Edition)', 'Random Access Memories')).toBe(
			true
		);
	});

	it('ignores a bracketed version tag', () => {
		expect(titlesMatch("California Dreamin' (Single Version)", "California Dreamin'")).toBe(true);
		expect(titlesMatch('Do You Love Me (Mono Single)', 'Do You Love Me')).toBe(true);
	});

	it('refuses a different work with a similar name', () => {
		expect(titlesMatch('Discovery', 'Discovery Remixed')).toBe(false);
		expect(titlesMatch('Discovery', 'Re-Discovery')).toBe(false);
	});
});

describe('resolvePlaylistTracks', () => {
	it('resolves a whole album with one search and keeps every song on it', async () => {
		const search = vi
			.spyOn(musicBrainz, 'searchReleaseGroups')
			.mockResolvedValue([DISCOVERY]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([]);

		const result = await resolvePlaylistTracks([
			track({ title: 'One More Time', album: 'Discovery' }),
			track({ title: 'Digital Love', album: 'Discovery' })
		]);

		expect(search).toHaveBeenCalledTimes(1);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			releaseGroupMbid: 'rg-discovery',
			matchedBy: 'album',
			confidence: 'high',
			inLibrary: false
		});
		expect(result.candidates[0].tracks.map((entry) => entry.title)).toEqual([
			'One More Time',
			'Digital Love'
		]);
		expect(result.resolvedTracks).toBe(2);
	});

	it('falls back to a recording search when the album name does not resolve', async () => {
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([
			{ ...DISCOVERY, mbid: 'rg-wrong', title: 'Discovery Remixed' }
		]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([
			{
				mbid: 'rec-1',
				title: 'One More Time',
				artistCredit: 'Daft Punk',
				artists: [{ mbid: 'artist-daft-punk', name: 'Daft Punk' }],
				releaseGroup: { mbid: 'rg-discovery', title: 'Discovery' },
				releaseMbid: 'rel-1',
				score: 100
			}
		]);
		const lookup = vi.spyOn(musicBrainz, 'getReleaseGroup').mockResolvedValue(DISCOVERY);

		const result = await resolvePlaylistTracks([
			track({ title: 'One More Time', album: 'Discovery (Deluxe)' })
		]);

		expect(lookup).toHaveBeenCalledWith('rg-discovery');
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].matchedBy).toBe('track');
		expect(result.candidates[0].confidence).toBe('low');
	});

	it('prefers the recording whose release belongs to the artist over a compilation', async () => {
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([
			{
				mbid: 'rec-va',
				title: 'One More Time',
				artistCredit: 'Daft Punk',
				artists: [{ mbid: 'artist-daft-punk', name: 'Daft Punk' }],
				releaseGroup: { mbid: 'rg-compilation', title: 'Hits of the 2000s' },
				releaseMbid: 'rel-va',
				releaseOwned: false,
				score: 100
			},
			{
				mbid: 'rec-own',
				title: 'One More Time',
				artistCredit: 'Daft Punk',
				artists: [{ mbid: 'artist-daft-punk', name: 'Daft Punk' }],
				releaseGroup: { mbid: 'rg-discovery', title: 'Discovery' },
				releaseMbid: 'rel-own',
				releaseOwned: true,
				score: 95
			}
		]);
		vi.spyOn(musicBrainz, 'getReleaseGroup').mockResolvedValue(DISCOVERY);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].releaseGroupMbid).toBe('rg-discovery');
		expect(result.candidates[0].artistName).toBe('Daft Punk');
	});

	it('reports a song whose recording does not match instead of adding a similar one', async () => {
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([
			{
				mbid: 'rec-cover',
				title: 'One More Time (Cover)',
				artistCredit: 'Some Tribute Band',
				artists: [{ mbid: 'artist-cover', name: 'Some Tribute Band' }],
				releaseGroup: { mbid: 'rg-cover', title: 'Tribute to Daft Punk' },
				releaseMbid: 'rel-cover',
				score: 90
			}
		]);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.candidates).toHaveLength(0);
		expect(result.unmatched).toEqual([
			{ title: 'One More Time', artist: 'Daft Punk', reason: 'no-match' }
		]);
	});

	it('marks a song with no artist as unmatched without asking MusicBrainz', async () => {
		const search = vi.spyOn(musicBrainz, 'searchRecordings');
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([]);

		const result = await resolvePlaylistTracks([track({ artists: [] })]);

		expect(search).not.toHaveBeenCalled();
		expect(result.unmatched[0]).toMatchObject({ reason: 'no-artist' });
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../../../../test/db-helper.js';
import { musicLookupCache } from '#lib/server/db/schema.js';
import { musicBrainz } from '../musicbrainz.js';
import type { MusicRecordingHit, MusicReleaseGroup } from '../types.js';
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

function recordingHit(overrides: Partial<MusicRecordingHit> = {}): MusicRecordingHit {
	return {
		mbid: 'rec-1',
		title: 'One More Time',
		artistCredit: 'Daft Punk',
		artists: [{ mbid: 'artist-daft-punk', name: 'Daft Punk' }],
		releaseGroup: DISCOVERY,
		// What the search itself returned, ranked: the resolver picks the album
		// from here instead of browsing the recording again.
		releaseGroups: [DISCOVERY],
		releaseMbid: 'rel-discovery',
		releaseOwned: true,
		score: 100,
		...overrides
	};
}

beforeEach(() => {
	// The cache is real here; a hit from the previous test would hide a lookup.
	testDb.db.delete(musicLookupCache).run();
});

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
	beforeEach(() => {
		// These cases drive the recording path; an artist id would send them
		// through the discography index instead.
		vi.spyOn(musicBrainz, 'resolveArtistMbid').mockResolvedValue(null);
	});

	it('retries a song whose lookup was refused and keeps it when the retry answers', async () => {
		vi.spyOn(musicBrainz, 'searchRecordings')
			.mockRejectedValueOnce(new Error('MusicBrainz throttled the request (503)'))
			.mockResolvedValue([recordingHit()]);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.unmatched).toHaveLength(0);
		expect(result.candidates[0].releaseGroupMbid).toBe('rg-discovery');
		expect(result.resolvedTracks).toBe(1);
	});

	it('reports an unreachable song as unreachable, not as a missing match', async () => {
		vi.spyOn(musicBrainz, 'searchRecordings').mockRejectedValue(
			new Error('MusicBrainz throttled the request (503)')
		);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.unmatched).toEqual([
			expect.objectContaining({ title: 'One More Time', reason: 'lookup-failed' })
		]);
	});

	it('calls a song with no match a miss once MusicBrainz has answered', async () => {
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([]);
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([]);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.unmatched).toEqual([
			expect.objectContaining({ title: 'One More Time', reason: 'no-match' })
		]);
	});

	it("takes a song's album from the artist's own discography", async () => {
		vi.spyOn(musicBrainz, 'resolveArtistMbid').mockResolvedValue('artist-daft-punk');
		vi.spyOn(musicBrainz, 'getArtistAlbumTrackIndex').mockResolvedValue([
			{ title: 'One More Time', groups: [DISCOVERY] }
		]);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].releaseGroupMbid).toBe('rg-discovery');
		expect(result.candidates[0].title).toBe('Discovery');
	});

	it('resolves a whole album with one search and keeps every song on it', async () => {
		const search = vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([DISCOVERY]);
		const recordings = vi.spyOn(musicBrainz, 'searchRecordings');

		const result = await resolvePlaylistTracks([
			track({ title: 'One More Time', album: 'Discovery' }),
			track({ title: 'Digital Love', album: 'Discovery' })
		]);

		expect(search).toHaveBeenCalledTimes(1);
		expect(recordings).not.toHaveBeenCalled();
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

	it('asks for each album once, and falls back song by song for the one it missed', async () => {
		const search = vi
			.spyOn(musicBrainz, 'searchReleaseGroups')
			.mockResolvedValue([DISCOVERY]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([]);

		const result = await resolvePlaylistTracks([
			track({ title: 'One More Time', album: 'Discovery' }),
			track({ title: 'Something Else', album: 'An Album Nobody Has' })
		]);

		// Discovery, the album nobody has, then the song's same-named guess.
		expect(search).toHaveBeenCalledTimes(3);
		expect(search.mock.calls[1][0]).toMatchObject({ album: 'an album nobody has' });
		expect(result.candidates).toHaveLength(1);
		expect(result.unmatched).toHaveLength(1);
	});

	it('falls back to a recording search when the album name does not resolve', async () => {
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([
			{ ...DISCOVERY, mbid: 'rg-wrong', title: 'Discovery Remixed' }
		]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([recordingHit()]);
		const lookup = vi.spyOn(musicBrainz, 'getReleaseGroup');

		const result = await resolvePlaylistTracks([
			track({ title: 'One More Time', album: 'Discovery (Deluxe)' })
		]);

		// The hit carries its group, so no second request is needed for it.
		expect(lookup).not.toHaveBeenCalled();
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].matchedBy).toBe('track');
		expect(result.candidates[0].confidence).toBe('low');
	});

	it('prefers the album the artist owns over a Various Artists compilation', async () => {
		const compilation: MusicReleaseGroup = {
			mbid: 'rg-compilation',
			title: 'Hits of the 2000s',
			primaryType: 'Album',
			secondaryTypes: ['Compilation'],
			firstReleaseDate: '2008-01-01',
			year: 2008,
			artist: { mbid: 'artist-va', name: 'Various Artists' }
		};
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([]);
		const appearances = vi.spyOn(musicBrainz, 'getRecordingReleaseGroups');
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([
			recordingHit({
				mbid: 'rec-va',
				releaseOwned: false,
				releaseGroup: compilation,
				releaseGroups: [compilation, DISCOVERY]
			})
		]);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].releaseGroupMbid).toBe('rg-discovery');
		expect(result.candidates[0].artistName).toBe('Daft Punk');
		// The compilation was already in the search response; asking again for
		// what we had just been told is the request this change removes.
		expect(appearances).not.toHaveBeenCalled();
	});

	it('takes the studio album over a live album the song also appears on', async () => {
		const live: MusicReleaseGroup = {
			mbid: 'rg-live',
			title: 'Alive 2007',
			primaryType: 'Album',
			secondaryTypes: ['Live'],
			firstReleaseDate: '2007-11-19',
			year: 2007,
			artist: { mbid: 'artist-daft-punk', name: 'Daft Punk' }
		};
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([
			recordingHit({ releaseGroup: live, releaseGroups: [live, DISCOVERY] })
		]);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].releaseGroupMbid).toBe('rg-discovery');
	});

	it('keeps the single when the only album is a hits compilation', async () => {
		const single: MusicReleaseGroup = {
			mbid: 'rg-single',
			title: 'One More Time',
			primaryType: 'Single',
			secondaryTypes: [],
			firstReleaseDate: '2000-11-13',
			year: 2000,
			artist: { mbid: 'artist-daft-punk', name: 'Daft Punk' }
		};
		const hits: MusicReleaseGroup = {
			mbid: 'rg-hits',
			title: 'Greatest Hits',
			primaryType: 'Album',
			secondaryTypes: ['Compilation'],
			firstReleaseDate: '2008-01-01',
			year: 2008,
			artist: { mbid: 'artist-daft-punk', name: 'Daft Punk' }
		};
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([
			recordingHit({ releaseGroup: single, releaseGroups: [hits, single] })
		]);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.candidates[0].releaseGroupMbid).toBe('rg-single');
	});

	it('resolves a recording the search returned without any release attached', async () => {
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([
			recordingHit({ releaseGroup: null, releaseGroups: [], releaseMbid: null })
		]);
		vi.spyOn(musicBrainz, 'getRecordingReleaseGroups').mockResolvedValue([DISCOVERY]);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].releaseGroupMbid).toBe('rg-discovery');
		expect(result.candidates[0].matchedBy).toBe('track');
	});

	it('reports a song whose recording does not match instead of adding a similar one', async () => {
		vi.spyOn(musicBrainz, 'searchReleaseGroups').mockResolvedValue([]);
		vi.spyOn(musicBrainz, 'searchRecordings').mockResolvedValue([
			recordingHit({
				title: 'One More Time (Cover)',
				artistCredit: 'Some Tribute Band',
				artists: [{ mbid: 'artist-cover', name: 'Some Tribute Band' }],
				releaseGroup: {
					mbid: 'rg-cover',
					title: 'Tribute to Daft Punk',
					primaryType: 'Album',
					secondaryTypes: [],
					artist: { mbid: 'artist-cover', name: 'Some Tribute Band' }
				}
			})
		]);

		const result = await resolvePlaylistTracks([track({ title: 'One More Time' })]);

		expect(result.candidates).toHaveLength(0);
		expect(result.unmatched).toEqual([
			{ title: 'One More Time', artist: 'Daft Punk', reason: 'no-match' }
		]);
	});

	it('marks a song with no artist as unmatched without asking MusicBrainz', async () => {
		const recordings = vi.spyOn(musicBrainz, 'searchRecordings');
		const search = vi.spyOn(musicBrainz, 'searchReleaseGroups');

		const result = await resolvePlaylistTracks([track({ artists: [] })]);

		expect(recordings).not.toHaveBeenCalled();
		expect(search).not.toHaveBeenCalled();
		expect(result.unmatched[0]).toMatchObject({ reason: 'no-artist' });
	});
});

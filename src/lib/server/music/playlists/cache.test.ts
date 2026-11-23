import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDatabase } from '../../../../test/db-helper.js';
import { musicLookupCache } from '#lib/server/db/schema.js';
import type { MusicReleaseGroup } from '../types.js';
import {
	getAlbumMatch,
	getSongMatch,
	setAlbumMatch,
	setSongMatch,
	songCacheKey
} from './cache.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

const DISCOVERY: MusicReleaseGroup = {
	mbid: 'rg-discovery',
	title: 'Discovery',
	primaryType: 'Album',
	secondaryTypes: [],
	firstReleaseDate: '2001-02-26',
	year: 2001,
	artist: { mbid: 'artist-daft-punk', name: 'Daft Punk' }
};

beforeEach(() => {
	testDb.db.delete(musicLookupCache).run();
});

describe('playlist lookup cache', () => {
	it('returns a stored album match without asking MusicBrainz again', () => {
		setAlbumMatch('Daft Punk', 'Discovery', DISCOVERY);

		expect(getAlbumMatch('daft punk', 'DISCOVERY')).toEqual({ value: DISCOVERY });
	});

	it('folds the key, so a decorated album name hits the same entry', () => {
		setAlbumMatch('Daft Punk', 'discovery', DISCOVERY);

		expect(getAlbumMatch('Daft  Punk', 'Discovery')).toEqual({ value: DISCOVERY });
	});

	it('remembers a miss, and says so instead of "never asked"', () => {
		setAlbumMatch('Daft Punk', 'No Such Album', null);

		expect(getAlbumMatch('Daft Punk', 'No Such Album')).toEqual({ value: null });
	});

	it('expires a miss sooner than a hit', () => {
		const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
		testDb.db
			.insert(musicLookupCache)
			.values({ key: 'album:daft punk|no such album', payload: 'null', fetchedAt: old })
			.run();
		testDb.db
			.insert(musicLookupCache)
			.values({
				key: songCacheKey('Daft Punk', 'One More Time'),
				payload: JSON.stringify(DISCOVERY),
				fetchedAt: old
			})
			.run();

		// Ten days is past the miss TTL (7) but well inside the hit TTL (30).
		expect(getAlbumMatch('Daft Punk', 'No Such Album')).toBeNull();
		expect(getSongMatch('Daft Punk', 'One More Time')).toEqual({ value: DISCOVERY });
		// A stale row is dropped rather than left to accumulate.
		expect(
			testDb.db
				.select()
				.from(musicLookupCache)
				.where(eq(musicLookupCache.key, 'album:daft punk|no such album'))
				.all()
		).toHaveLength(0);
	});

	it('stores song matches under their own key', () => {
		setSongMatch('Daft Punk', 'One More Time', DISCOVERY);

		expect(getSongMatch('Daft Punk', 'One More Time')).toEqual({ value: DISCOVERY });
		expect(getAlbumMatch('Daft Punk', 'One More Time')).toBeNull();
	});
});

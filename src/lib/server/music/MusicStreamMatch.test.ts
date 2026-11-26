/**
 * The match pass over the streamed library.
 *
 * What matters here is that it is cheap and it stays cheap: a track that
 * already has an upload costs no provider call, only the unmatched ones are
 * resolved, and nothing about audio is written anywhere.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	clearTestDb,
	destroyTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

const resolver = vi.hoisted(() => ({
	resolveTrackStream: vi.fn(),
	isTrackStreamCached: vi.fn(() => true)
}));

vi.mock('./playback/resolver.js', () => resolver);

import { matchStreamedMusic } from './MusicStreamMatch.js';

function seedAlbum(id: string, added: string, streamSource: string | null, videoIds: (string | null)[]): void {
	testDb.db.insert(schema.mediaItems).values({ id: `mi-${id}`, kind: 'album', title: id }).run();
	testDb.db.insert(schema.artists).values({ id: `ar-${id}`, name: 'Artist' }).run();
	testDb.db
		.insert(schema.albums)
		.values({
			id,
			mediaItemId: `mi-${id}`,
			artistId: `ar-${id}`,
			title: `Album ${id}`,
			streamSource,
			added
		})
		.run();
	testDb.db
		.insert(schema.tracks)
		.values(
			videoIds.map((videoId, index) => ({
				id: `${id}-t${index + 1}`,
				albumId: id,
				title: `Track ${index + 1}`,
				trackNumber: index + 1,
				position: index + 1,
				streamVideoId: videoId
			}))
		)
		.run();
}

beforeEach(() => {
	clearTestDb(testDb);
	resolver.resolveTrackStream.mockReset();
	// The real resolver remembers the upload it picked; the mock must too, or the
	// "second run is free" behaviour would be untestable.
	resolver.resolveTrackStream.mockImplementation(async (trackId: string) => {
		testDb.db
			.update(schema.tracks)
			.set({ streamVideoId: `picked-${trackId}` })
			.where(eq(schema.tracks.id, trackId))
			.run();
		return {
			status: 'ok' as const,
			stream: {
				source: 'youtube' as const,
				url: 'https://example/audio',
				contentType: 'audio/mp4',
				expiresAt: null
			},
			albumId: 'al-1'
		};
	});
});

afterAll(() => destroyTestDb(testDb));

describe('matchStreamedMusic', () => {
	it('matches only the tracks that have no upload yet', async () => {
		seedAlbum('al-1', '2026-11-01T00:00:00.000Z', 'cinephage-stream', ['known-video', null]);

		const { summary, items } = await matchStreamedMusic(null);

		expect(summary).toMatchObject({
			albums: 1,
			albumsTouched: 1,
			tracks: 2,
			matched: 1,
			alreadyMatched: 1,
			unresolved: 0,
			stoppedReason: 'complete'
		});
		expect(resolver.resolveTrackStream).toHaveBeenCalledTimes(1);
		expect(resolver.resolveTrackStream).toHaveBeenCalledWith('al-1-t2');
		expect(items[0].matched).toBe(1);
	});

	it('costs no provider calls once the library is matched', async () => {
		seedAlbum('al-1', '2026-11-01T00:00:00.000Z', 'cinephage-stream', [null, null]);
		await matchStreamedMusic(null);
		resolver.resolveTrackStream.mockClear();

		const { summary } = await matchStreamedMusic(null);

		expect(summary).toMatchObject({ matched: 0, alreadyMatched: 2, unresolved: 0 });
		expect(resolver.resolveTrackStream).not.toHaveBeenCalled();
	});

	it('leaves albums that are not stream-backed alone', async () => {
		seedAlbum('owned', '2026-11-01T00:00:00.000Z', null, [null, null]);

		const { summary } = await matchStreamedMusic(null);

		expect(summary.albums).toBe(0);
		expect(resolver.resolveTrackStream).not.toHaveBeenCalled();
	});

	it('reports a track the provider cannot match', async () => {
		seedAlbum('al-1', '2026-11-01T00:00:00.000Z', 'cinephage-stream', [null]);
		resolver.resolveTrackStream.mockResolvedValueOnce({
			status: 'provider-unavailable',
			detail: 'No matching upload found'
		});

		const { summary } = await matchStreamedMusic(null);

		expect(summary).toMatchObject({ matched: 0, unresolved: 1 });
	});

	it('honours a per-run album limit, newest first', async () => {
		seedAlbum('older', '2026-11-01T00:00:00.000Z', 'cinephage-stream', [null]);
		seedAlbum('newer', '2026-11-20T00:00:00.000Z', 'cinephage-stream', [null]);

		const { summary, items } = await matchStreamedMusic(null, { limitAlbums: 1 });

		expect(summary.stoppedReason).toBe('album-limit');
		expect(summary.albums).toBe(1);
		expect(items.map((item) => item.albumId)).toEqual(['newer']);
	});
});

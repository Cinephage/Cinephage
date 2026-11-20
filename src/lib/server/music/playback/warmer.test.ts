import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	clearTestDb,
	destroyTestDb,
	type TestDatabase
} from '../../../../test/db-helper.js';
import { warmAlbum } from './warmer.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

const resolver = vi.hoisted(() => {
	const resolved = new Set<string>();
	return {
		resolved,
		resolveTrackStream: vi.fn(async (trackId: string) => {
			resolved.add(trackId);
			return {
				status: 'ok' as const,
				stream: { source: 'youtube' as const, url: 'https://example/x', contentType: 'audio/mp4', expiresAt: null },
				albumId: 'al-1'
			};
		}),
		isTrackStreamCached: vi.fn((trackId: string) => resolved.has(trackId)),
		invalidateTrackStream: vi.fn()
	};
});

vi.mock('./resolver.js', () => resolver);

function seed(streamSource: string | null): void {
	testDb.db.insert(schema.mediaItems).values({ id: 'mi-1', kind: 'album', title: 'Asylum' }).run();
	testDb.db.insert(schema.artists).values({ id: 'ar-1', name: 'Chris Webby' }).run();
	testDb.db
		.insert(schema.albums)
		.values({
			id: 'al-1',
			mediaItemId: 'mi-1',
			artistId: 'ar-1',
			title: 'Asylum',
			streamSource
		})
		.run();
	testDb.db
		.insert(schema.tracks)
		.values([
			{ id: 't-1', albumId: 'al-1', title: 'One', trackNumber: 1 },
			{ id: 't-2', albumId: 'al-1', title: 'Two', trackNumber: 2 },
			{ id: 't-3', albumId: 'al-1', title: 'Three', trackNumber: 3 }
		])
		.run();
}

function resolvedTrackIds(): string[] {
	return resolver.resolveTrackStream.mock.calls.map(([id]) => id).sort();
}

beforeEach(() => {
	clearTestDb(testDb);
	resolver.resolved.clear();
	resolver.resolveTrackStream.mockClear();
	resolver.isTrackStreamCached.mockClear();
});

afterAll(() => destroyTestDb(testDb));

describe('warmAlbum', () => {
	it('resolves every provider track and skips one with a file', async () => {
		seed('cinephage-stream');
		testDb.db
			.insert(schema.trackFiles)
			.values({ id: 'tf-3', albumId: 'al-1', trackId: 't-3', relativePath: '03 Three.flac' })
			.run();

		warmAlbum('al-1');

		await vi.waitFor(() => expect(resolvedTrackIds()).toEqual(['t-1', 't-2']));
	});

	it('does not resolve the same track twice when called again while warming', async () => {
		seed('cinephage-stream');

		warmAlbum('al-1');
		warmAlbum('al-1');

		await vi.waitFor(() => expect(resolver.resolved.size).toBe(3));
		expect(resolvedTrackIds()).toEqual(['t-1', 't-2', 't-3']);
	});

	it('does nothing for an album that is not stream-backed', async () => {
		seed(null);

		warmAlbum('al-1');

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(resolver.resolveTrackStream).not.toHaveBeenCalled();
	});

	it('costs no provider calls once the album is warm', async () => {
		seed('cinephage-stream');
		for (const id of ['t-1', 't-2', 't-3']) resolver.resolved.add(id);

		warmAlbum('al-1');

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(resolver.resolveTrackStream).not.toHaveBeenCalled();
	});
});

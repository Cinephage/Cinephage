import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	clearTestDb,
	destroyTestDb,
	type TestDatabase
} from '../../../../test/db-helper.js';
import { invalidateTrackStream, resolveTrackStream } from './resolver.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

vi.mock('#lib/server/filesystem/path-guard.js', () => ({
	isPathInsideManagedRoot: async () => true
}));

const ytdlp = vi.hoisted(() => ({
	isYtDlpAvailable: vi.fn(async () => true),
	searchYoutube: vi.fn(),
	resolveAudio: vi.fn()
}));

vi.mock('./ytdlp.js', () => ytdlp);

const AUDIO = {
	url: 'https://rr1---sn-test.googlevideo.com/videoplayback?expire=1795165657&x=1',
	contentType: 'audio/mp4',
	expiresAt: Date.now() + 2 * 60 * 60 * 1000
};

/**
 * Fresh ids per test: the resolver's hot cache lives for the whole module, so a
 * reused track id would answer from a previous test instead of the database.
 */
let seq = 0;

interface Seed {
	albumId: string;
	tracks: [string, string];
}

function seedAlbum(): Seed {
	seq += 1;
	const mediaItemId = `mi-${seq}`;
	const artistId = `ar-${seq}`;
	const albumId = `al-${seq}`;
	const tracks: [string, string] = [`t-${seq}-1`, `t-${seq}-2`];

	testDb.db
		.insert(schema.mediaItems)
		.values({ id: mediaItemId, kind: 'album', title: 'The White Noise LP' })
		.run();
	testDb.db.insert(schema.artists).values({ id: artistId, name: 'Chris Webby' }).run();
	testDb.db
		.insert(schema.albums)
		.values({
			id: albumId,
			mediaItemId,
			artistId,
			title: 'The White Noise LP',
			path: '/media/music/Chris Webby/The White Noise LP (2009)',
			streamSource: 'cinephage-stream'
		})
		.run();
	testDb.db
		.insert(schema.tracks)
		.values([
			{ id: tracks[0], albumId, title: 'La La La', duration: 230, trackNumber: 1 },
			{ id: tracks[1], albumId, title: 'Get Down', duration: 196, trackNumber: 2 }
		])
		.run();

	return { albumId, tracks };
}

function storedVideoId(trackId: string): string | null {
	const row = testDb.db
		.select({ streamVideoId: schema.tracks.streamVideoId })
		.from(schema.tracks)
		.where(eq(schema.tracks.id, trackId))
		.get();
	return row?.streamVideoId ?? null;
}

function storedLink(trackId: string): { url: string; expiresAt: number } | null {
	const row = testDb.db
		.select({ url: schema.trackStreamCache.url, expiresAt: schema.trackStreamCache.expiresAt })
		.from(schema.trackStreamCache)
		.where(eq(schema.trackStreamCache.trackId, trackId))
		.get();
	return row ?? null;
}

beforeEach(() => {
	clearTestDb(testDb);
	ytdlp.searchYoutube.mockReset();
	ytdlp.resolveAudio.mockReset();
	ytdlp.isYtDlpAvailable.mockResolvedValue(true);
});

afterAll(() => destroyTestDb(testDb));

describe('resolveTrackStream (provider)', () => {
	it('picks from a search, remembers the upload and keeps the link', async () => {
		const { albumId, tracks } = seedAlbum();
		ytdlp.searchYoutube.mockResolvedValue([
			{ id: 'vid-1', title: 'Chris Webby - La La La', duration: 231, channel: 'Chris Webby' }
		]);
		ytdlp.resolveAudio.mockResolvedValue(AUDIO);

		const outcome = await resolveTrackStream(tracks[0]);

		expect(outcome).toMatchObject({ status: 'ok', albumId });
		expect(outcome.status === 'ok' && outcome.stream.source).toBe('youtube');
		expect(ytdlp.searchYoutube).toHaveBeenCalledWith('Chris Webby La La La', 5);
		expect(ytdlp.resolveAudio).toHaveBeenCalledWith('vid-1');
		expect(storedVideoId(tracks[0])).toBe('vid-1');
		expect(storedLink(tracks[0])).toEqual({ url: AUDIO.url, expiresAt: AUDIO.expiresAt });
	});

	it('replays a remembered upload without searching again', async () => {
		const { tracks } = seedAlbum();
		testDb.db
			.update(schema.tracks)
			.set({ streamVideoId: 'vid-known' })
			.where(eq(schema.tracks.id, tracks[1]))
			.run();
		ytdlp.resolveAudio.mockResolvedValue(AUDIO);

		const outcome = await resolveTrackStream(tracks[1]);

		expect(outcome.status).toBe('ok');
		expect(ytdlp.searchYoutube).not.toHaveBeenCalled();
		expect(ytdlp.resolveAudio).toHaveBeenCalledWith('vid-known');
	});

	it('searches again and replaces the id when the remembered upload is gone', async () => {
		const { tracks } = seedAlbum();
		testDb.db
			.update(schema.tracks)
			.set({ streamVideoId: 'vid-dead' })
			.where(eq(schema.tracks.id, tracks[0]))
			.run();
		ytdlp.resolveAudio.mockImplementation(async (videoId: string) => {
			if (videoId === 'vid-dead') throw new Error('Video unavailable');
			return AUDIO;
		});
		ytdlp.searchYoutube.mockResolvedValue([
			{ id: 'vid-fresh', title: 'Chris Webby - La La La', duration: 230, channel: null }
		]);

		const outcome = await resolveTrackStream(tracks[0]);

		expect(outcome.status).toBe('ok');
		expect(ytdlp.searchYoutube).toHaveBeenCalledTimes(1);
		expect(storedVideoId(tracks[0])).toBe('vid-fresh');
	});

	it('reports a track on an album with no stream marker as not playable', async () => {
		const { albumId, tracks } = seedAlbum();
		testDb.db
			.update(schema.albums)
			.set({ streamSource: null })
			.where(eq(schema.albums.id, albumId))
			.run();

		await expect(resolveTrackStream(tracks[0])).resolves.toEqual({ status: 'not-stream-backed' });
	});

	it('resolves once when playback and the warmer ask at the same time', async () => {
		const { tracks } = seedAlbum();
		ytdlp.searchYoutube.mockResolvedValue([
			{ id: 'vid-1', title: 'Chris Webby - La La La', duration: 231, channel: null }
		]);
		ytdlp.resolveAudio.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return AUDIO;
		});

		const [first, second] = await Promise.all([
			resolveTrackStream(tracks[0]),
			resolveTrackStream(tracks[0])
		]);

		expect(first.status).toBe('ok');
		expect(second.status).toBe('ok');
		expect(ytdlp.searchYoutube).toHaveBeenCalledTimes(1);
		expect(ytdlp.resolveAudio).toHaveBeenCalledTimes(1);
	});
});

describe('resolveTrackStream (kept links)', () => {
	it('serves a stored link after a restart without calling the provider', async () => {
		const { albumId, tracks } = seedAlbum();
		testDb.db
			.insert(schema.trackStreamCache)
			.values({
				trackId: tracks[0],
				url: 'https://rr2---sn-kept.googlevideo.com/videoplayback?expire=1795169999',
				contentType: 'audio/mp4',
				expiresAt: Date.now() + 60_000
			})
			.run();

		const outcome = await resolveTrackStream(tracks[0]);

		expect(outcome).toMatchObject({ status: 'ok', albumId });
		expect(outcome.status === 'ok' && outcome.stream.url).toContain('sn-kept');
		expect(ytdlp.searchYoutube).not.toHaveBeenCalled();
		expect(ytdlp.resolveAudio).not.toHaveBeenCalled();
	});

	it('ignores an expired link and resolves a fresh one', async () => {
		const { tracks } = seedAlbum();
		testDb.db
			.insert(schema.trackStreamCache)
			.values({
				trackId: tracks[0],
				url: 'https://rr2---sn-expired.googlevideo.com/videoplayback?expire=1',
				contentType: 'audio/mp4',
				expiresAt: Date.now() - 1
			})
			.run();
		ytdlp.searchYoutube.mockResolvedValue([
			{ id: 'vid-1', title: 'Chris Webby - La La La', duration: 231, channel: null }
		]);
		ytdlp.resolveAudio.mockResolvedValue(AUDIO);

		const outcome = await resolveTrackStream(tracks[0]);

		expect(outcome.status === 'ok' && outcome.stream.url).toBe(AUDIO.url);
		expect(ytdlp.resolveAudio).toHaveBeenCalledWith('vid-1');
		expect(storedLink(tracks[0])).toEqual({ url: AUDIO.url, expiresAt: AUDIO.expiresAt });
	});

	it('drops the stored link when the provider rejects it', async () => {
		const { tracks } = seedAlbum();
		testDb.db
			.insert(schema.trackStreamCache)
			.values({
				trackId: tracks[0],
				url: 'https://rr2---sn-dead.googlevideo.com/videoplayback?expire=1',
				contentType: 'audio/mp4',
				expiresAt: Date.now() + 60_000
			})
			.run();

		invalidateTrackStream(tracks[0]);

		expect(storedLink(tracks[0])).toBeNull();
	});
});

describe('resolveTrackStream (local file)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'cp-resolver-'));

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('serves the file on disk even when the album is stream-backed and a link is kept', async () => {
		const { albumId, tracks } = seedAlbum();
		writeFileSync(join(dir, '01 La La La.m4a'), 'audio');
		testDb.db.update(schema.albums).set({ path: dir }).where(eq(schema.albums.id, albumId)).run();
		testDb.db
			.insert(schema.trackFiles)
			.values({ id: 'tf-1', albumId, trackId: tracks[0], relativePath: '01 La La La.m4a' })
			.run();
		testDb.db
			.insert(schema.trackStreamCache)
			.values({
				trackId: tracks[0],
				url: 'https://rr2---sn-kept.googlevideo.com/videoplayback?expire=1',
				contentType: 'audio/mp4',
				expiresAt: Date.now() + 60_000
			})
			.run();

		const outcome = await resolveTrackStream(tracks[0]);

		expect(outcome.status).toBe('ok');
		expect(outcome.status === 'ok' && outcome.stream).toMatchObject({
			source: 'local',
			url: join(dir, '01 La La La.m4a')
		});
		expect(ytdlp.searchYoutube).not.toHaveBeenCalled();
	});
});

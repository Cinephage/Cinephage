import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
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

// Nothing in this suite should reach the network: a folder it cannot identify
// is a legitimate scan result, and the reconciliation under test runs first.
vi.mock('./musicbrainz.js', () => ({
	musicBrainz: {
		searchReleaseGroups: vi.fn(async () => []),
		getReleaseGroupReleases: vi.fn(async () => []),
		getRelease: vi.fn(async () => {
			throw new Error('offline');
		})
	},
	pickPrimaryRelease: vi.fn(() => null)
}));

const { scanMusicRootFolder, isDuplicateAdoption } = await import('./MusicDiskScan.js');

const ROOT_ID = 'rf-music-reconcile';

/** One second of silence with a valid WAV header: enough for the audio walk. */
function wavBytes(): Buffer {
	const sampleRate = 44100;
	const channels = 1;
	const bitsPerSample = 16;
	const dataSize = sampleRate * channels * (bitsPerSample / 8);
	const buffer = Buffer.alloc(44 + dataSize);
	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write('WAVE', 8);
	buffer.write('fmt ', 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(channels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
	buffer.writeUInt16LE((channels * bitsPerSample) / 8, 32);
	buffer.writeUInt16LE(bitsPerSample, 34);
	buffer.write('data', 36);
	buffer.writeUInt32LE(dataSize, 40);
	return buffer;
}

describe('MusicDiskScan reconciliation', () => {
	let root: string;

	beforeEach(async () => {
		clearTestDb(testDb);
		testDb.db
			.insert(schema.rootFolders)
			.values({ id: ROOT_ID, name: 'Music', path: '/music', mediaType: 'music' })
			.onConflictDoNothing()
			.run();
		testDb.db
			.insert(schema.libraries)
			.values({
				id: 'lib-music-reconcile',
				name: 'Music',
				slug: 'music-reconcile',
				mediaType: 'music'
			})
			.onConflictDoNothing()
			.run();
		testDb.db
			.insert(schema.mediaItems)
			.values({ id: 'mi-reconcile', kind: 'album', title: 'Gone Album', year: 2020 })
			.onConflictDoNothing()
			.run();
		testDb.db
			.insert(schema.artists)
			.values({ id: 'ar-reconcile', name: 'Test Artist', monitored: true })
			.onConflictDoNothing()
			.run();

		root = await fs.mkdtemp(path.join(os.tmpdir(), 'cine-scan-'));
		// The walk must find audio, otherwise reconciliation is skipped by design.
		await fs.mkdir(path.join(root, 'Other'), { recursive: true });
		await fs.writeFile(path.join(root, 'Other', '01 - Unknown.wav'), wavBytes());
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	afterAll(() => destroyTestDb(testDb));

	it('drops a row whose file is gone and clears both has_file flags', async () => {
		const albumPath = path.join(root, 'Gone Album');
		await fs.mkdir(albumPath, { recursive: true });
		// The row points at a file that is not there: a deletion outside Cinephage.
		testDb.db
			.insert(schema.albums)
			.values({
				id: 'al-reconcile',
				mediaItemId: 'mi-reconcile',
				artistId: 'ar-reconcile',
				title: 'Gone Album',
				year: 2020,
				path: albumPath,
				rootFolderId: ROOT_ID,
				libraryId: 'lib-music-reconcile',
				hasFile: true
			})
			.run();
		testDb.db
			.insert(schema.tracks)
			.values({
				id: 'tr-reconcile',
				albumId: 'al-reconcile',
				title: 'Gone',
				discNumber: 1,
				trackNumber: 1,
				position: 1,
				hasFile: true
			})
			.run();
		testDb.db
			.insert(schema.trackFiles)
			.values({
				id: 'tf-reconcile',
				albumId: 'al-reconcile',
				trackId: 'tr-reconcile',
				relativePath: '01 - Gone.wav',
				format: 'WAV',
				sizeBytes: 1024
			})
			.run();

		const summary = await scanMusicRootFolder({
			rootFolderId: ROOT_ID,
			rootPath: root,
			libraryId: 'lib-music-reconcile'
		});

		expect(summary.filesRemoved).toBe(1);
		expect(summary.albumsCleared).toBe(1);
		expect(
			testDb.db
				.select()
				.from(schema.trackFiles)
				.where(eq(schema.trackFiles.id, 'tf-reconcile'))
				.all()
		).toHaveLength(0);
		expect(
			testDb.db.select().from(schema.albums).where(eq(schema.albums.id, 'al-reconcile')).get()
				?.hasFile
		).toBe(false);
		expect(
			testDb.db.select().from(schema.tracks).where(eq(schema.tracks.id, 'tr-reconcile')).get()
				?.hasFile
		).toBe(false);
	});

	it('leaves a row alone while its file is still on disk', async () => {
		const albumPath = path.join(root, 'Here Album');
		await fs.mkdir(albumPath, { recursive: true });
		await fs.writeFile(path.join(albumPath, '01 - Here.wav'), wavBytes());
		testDb.db
			.insert(schema.albums)
			.values({
				id: 'al-here',
				mediaItemId: 'mi-reconcile',
				artistId: 'ar-reconcile',
				title: 'Here Album',
				year: 2020,
				path: albumPath,
				rootFolderId: ROOT_ID,
				libraryId: 'lib-music-reconcile',
				hasFile: true
			})
			.run();
		testDb.db
			.insert(schema.trackFiles)
			.values({
				id: 'tf-here',
				albumId: 'al-here',
				relativePath: '01 - Here.wav',
				format: 'WAV',
				sizeBytes: 1024
			})
			.run();

		const summary = await scanMusicRootFolder({
			rootFolderId: ROOT_ID,
			rootPath: root,
			libraryId: 'lib-music-reconcile'
		});

		expect(summary.filesRemoved).toBe(0);
		expect(
			testDb.db.select().from(schema.trackFiles).where(eq(schema.trackFiles.id, 'tf-here')).all()
		).toHaveLength(1);
	});

	it('skips reconciliation when the walk found no audio at all', async () => {
		const albumPath = path.join(root, 'Empty Album');
		await fs.mkdir(albumPath, { recursive: true });
		testDb.db
			.insert(schema.albums)
			.values({
				id: 'al-empty',
				mediaItemId: 'mi-reconcile',
				artistId: 'ar-reconcile',
				title: 'Empty Album',
				year: 2020,
				path: albumPath,
				rootFolderId: ROOT_ID,
				libraryId: 'lib-music-reconcile',
				hasFile: true
			})
			.run();
		testDb.db
			.insert(schema.trackFiles)
			.values({
				id: 'tf-empty',
				albumId: 'al-empty',
				relativePath: '01 - Gone.wav',
				format: 'WAV',
				sizeBytes: 1024
			})
			.run();
		// Remove the only audio the walk could find.
		await fs.rm(path.join(root, 'Other'), { recursive: true, force: true });

		const summary = await scanMusicRootFolder({
			rootFolderId: ROOT_ID,
			rootPath: root,
			libraryId: 'lib-music-reconcile'
		});

		expect(summary.filesRemoved).toBe(0);
		expect(
			testDb.db.select().from(schema.trackFiles).where(eq(schema.trackFiles.id, 'tf-empty')).all()
		).toHaveLength(1);
	});
});

describe('isDuplicateAdoption', () => {
	it('never flags the album it just created', () => {
		expect(isDuplicateAdoption(true, { path: '/music/A', hasFile: true }, '/music/B')).toBe(false);
	});

	it('flags a second folder for an album the library already holds', () => {
		expect(isDuplicateAdoption(false, { path: '/music/A', hasFile: true }, '/music/B')).toBe(true);
	});

	it('allows re-adoption when the album points at the same folder', () => {
		expect(isDuplicateAdoption(false, { path: '/music/A', hasFile: true }, '/music/A')).toBe(false);
	});

	it('allows adoption when the album has no files left', () => {
		expect(isDuplicateAdoption(false, { path: '/music/A', hasFile: false }, '/music/B')).toBe(
			false
		);
	});

	it('allows the first adoption when the album has no path yet', () => {
		expect(isDuplicateAdoption(false, { path: null, hasFile: false }, '/music/B')).toBe(false);
	});
});

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

import { musicImportService } from './MusicImportService.js';

/** One second of silence with a valid WAV header: big enough to count as audio. */
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

describe('MusicImportService.adoptFolder', () => {
	let folder: string;

	beforeEach(async () => {
		clearTestDb(testDb);
		testDb.db
			.insert(schema.mediaItems)
			.values({ id: 'mi-adopt', kind: 'album', title: 'Adopt Me', year: 2020 })
			.run();
		testDb.db.insert(schema.artists).values({ id: 'ar-adopt', name: 'Test Artist' }).run();
		testDb.db
			.insert(schema.albums)
			.values({
				id: 'al-adopt',
				mediaItemId: 'mi-adopt',
				artistId: 'ar-adopt',
				title: 'Adopt Me',
				year: 2020,
				hasFile: false
			})
			.run();
		testDb.db
			.insert(schema.tracks)
			.values([
				{ id: 'tr-1', albumId: 'al-adopt', title: 'One', discNumber: 1, trackNumber: 1, position: 1 },
				{ id: 'tr-2', albumId: 'al-adopt', title: 'Two', discNumber: 1, trackNumber: 2, position: 2 }
			])
			.run();

		folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cine-adopt-'));
		await fs.writeFile(path.join(folder, '01 - One.wav'), wavBytes());
		await fs.writeFile(path.join(folder, '02 - Two.wav'), wavBytes());
	});

	afterEach(async () => {
		await fs.rm(folder, { recursive: true, force: true });
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('records the files where they are and links them to the tracklist', async () => {
		const result = await musicImportService.adoptFolder('al-adopt', folder);

		expect(result.status).toBe('imported');
		expect(result.filesImported).toBe(2);
		expect(result.tracksMatched).toBe(2);
		expect(result.albumPath).toBe(folder);

		const files = testDb.db
			.select()
			.from(schema.trackFiles)
			.where(eq(schema.trackFiles.albumId, 'al-adopt'))
			.all();
		expect(files).toHaveLength(2);
		expect(files.map((file) => file.trackId).sort()).toEqual(['tr-1', 'tr-2']);
		expect(files.every((file) => file.format === 'WAVE' || file.format === 'WAV')).toBe(true);

		const album = testDb.db.select().from(schema.albums).where(eq(schema.albums.id, 'al-adopt')).get();
		expect(album?.path).toBe(folder);
		expect(album?.hasFile).toBe(true);

		const tracks = testDb.db
			.select()
			.from(schema.tracks)
			.where(eq(schema.tracks.albumId, 'al-adopt'))
			.all();
		expect(tracks.every((track) => track.hasFile)).toBe(true);

		const item = testDb.db
			.select()
			.from(schema.mediaItems)
			.where(eq(schema.mediaItems.id, 'mi-adopt'))
			.get();
		expect(item?.path).toBe(folder);
	});

	it('does not mark a track owned when no file matched it', async () => {
		testDb.db
			.insert(schema.tracks)
			.values({
				id: 'tr-3',
				albumId: 'al-adopt',
				title: 'Three',
				discNumber: 1,
				trackNumber: 3,
				position: 3
			})
			.run();

		await musicImportService.adoptFolder('al-adopt', folder);

		const tracks = testDb.db
			.select()
			.from(schema.tracks)
			.where(eq(schema.tracks.albumId, 'al-adopt'))
			.all();
		expect(tracks.find((track) => track.id === 'tr-1')?.hasFile).toBe(true);
		expect(tracks.find((track) => track.id === 'tr-2')?.hasFile).toBe(true);
		expect(tracks.find((track) => track.id === 'tr-3')?.hasFile).toBe(false);
	});

	it('is idempotent: adopting the same folder twice keeps one row per file', async () => {
		await musicImportService.adoptFolder('al-adopt', folder);
		await musicImportService.adoptFolder('al-adopt', folder);

		const files = testDb.db
			.select()
			.from(schema.trackFiles)
			.where(eq(schema.trackFiles.albumId, 'al-adopt'))
			.all();
		expect(files).toHaveLength(2);
	});

	it('refuses a folder with no audio instead of marking the album owned', async () => {
		const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'cine-adopt-empty-'));
		try {
			await expect(musicImportService.adoptFolder('al-adopt', empty)).rejects.toThrow(
				/No audio files found/
			);
			const album = testDb.db
				.select()
				.from(schema.albums)
				.where(eq(schema.albums.id, 'al-adopt'))
				.get();
			expect(album?.hasFile).toBe(false);
		} finally {
			await fs.rm(empty, { recursive: true, force: true });
		}
	});
});

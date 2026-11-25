import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';
import { musicRenameService, musicTrackFileName } from './MusicRenameService.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

let albumDir: string;
let albumId: string;

function seed(options: { path?: string | null; files: Array<{ path: string; trackId?: string }> }) {
	const mediaItemId = randomUUID();
	testDb.db
		.insert(schema.mediaItems)
		.values({ id: mediaItemId, kind: 'music', title: 'Discovery' })
		.run();
	const artistId = randomUUID();
	testDb.db.insert(schema.artists).values({ id: artistId, name: 'Daft Punk' }).run();
	albumId = randomUUID();
	testDb.db
		.insert(schema.albums)
		.values({
			id: albumId,
			mediaItemId,
			artistId,
			title: 'Discovery',
			year: 2001,
			path: options.path === undefined ? albumDir : options.path
		})
		.run();

	const trackId = randomUUID();
	testDb.db
		.insert(schema.tracks)
		.values({ id: trackId, albumId, title: 'Crescendolls', discNumber: 1, trackNumber: 5 })
		.run();

	for (const file of options.files) {
		testDb.db
			.insert(schema.trackFiles)
			.values({
				id: randomUUID(),
				albumId,
				trackId: file.trackId === 'none' ? null : (file.trackId ?? trackId),
				relativePath: file.path
			})
			.run();
	}

	return { trackId };
}

beforeEach(() => {
	clearTestDb(testDb);
	albumDir = mkdtempSync(join(tmpdir(), 'music-rename-'));
});

afterEach(async () => {
	await rm(albumDir, { recursive: true, force: true });
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('musicTrackFileName', () => {
	it('pads the position and keeps the extension', () => {
		expect(
			musicTrackFileName({ discNumber: 1, trackNumber: 5, title: 'Crescendolls' }, '.flac')
		).toBe('05 - Crescendolls.flac');
	});

	it('prefixes later discs so two disc ones cannot collide', () => {
		expect(musicTrackFileName({ discNumber: 2, trackNumber: 1, title: 'Something' }, '.mp3')).toBe(
			'2-01 - Something.mp3'
		);
	});
});

describe('MusicRenameService.previewAlbum', () => {
	it('targets the canonical name without moving the file', () => {
		writeFileSync(join(albumDir, '05 Crescendolls.flac'), 'audio');
		seed({ files: [{ path: '05 Crescendolls.flac' }] });

		const preview = musicRenameService.previewAlbum(albumId);

		expect(preview.totalFiles).toBe(1);
		expect(preview.totalWillChange).toBe(1);
		expect(preview.willChange[0].newRelativePath).toBe('05 - Crescendolls.flac');
		expect(existsSync(join(albumDir, '05 - Crescendolls.flac'))).toBe(false);
	});

	it('reports an already-correct name as correct', () => {
		writeFileSync(join(albumDir, '05 - Crescendolls.flac'), 'audio');
		seed({ files: [{ path: '05 - Crescendolls.flac' }] });

		const preview = musicRenameService.previewAlbum(albumId);

		expect(preview.totalAlreadyCorrect).toBe(1);
		expect(preview.totalWillChange).toBe(0);
	});

	it('marks two files that resolve to one name as a collision', () => {
		writeFileSync(join(albumDir, '05 Crescendolls.flac'), 'audio');
		writeFileSync(join(albumDir, '05-Crescendolls.flac'), 'audio');
		const { trackId } = seed({ files: [] });
		for (const path of ['05 Crescendolls.flac', '05-Crescendolls.flac']) {
			testDb.db
				.insert(schema.trackFiles)
				.values({ id: randomUUID(), albumId, trackId, relativePath: path })
				.run();
		}

		const preview = musicRenameService.previewAlbum(albumId);

		expect(preview.totalCollisions).toBe(2);
		expect(preview.totalWillChange).toBe(0);
		expect(preview.collisions[0].collisionsWith).toHaveLength(1);
	});

	it('errors instead of guessing when the file has no track', () => {
		writeFileSync(join(albumDir, 'unknown.flac'), 'audio');
		seed({ files: [{ path: 'unknown.flac', trackId: 'none' }] });

		const preview = musicRenameService.previewAlbum(albumId);

		expect(preview.totalErrors).toBe(1);
		expect(preview.errors[0].error).toMatch(/not linked/);
	});
});

describe('MusicRenameService.executeRenames', () => {
	it('moves the file and rewrites the stored relative path', async () => {
		writeFileSync(join(albumDir, '05 Crescendolls.flac'), 'audio');
		seed({ files: [{ path: '05 Crescendolls.flac' }] });
		const file = testDb.db.select().from(schema.trackFiles).all()[0];

		const result = await musicRenameService.executeRenames([file.id]);

		expect(result.succeeded).toBe(1);
		expect(result.failed).toBe(0);
		expect(existsSync(join(albumDir, '05 - Crescendolls.flac'))).toBe(true);
		expect(existsSync(join(albumDir, '05 Crescendolls.flac'))).toBe(false);
		expect(testDb.db.select().from(schema.trackFiles).all()[0].relativePath).toBe(
			'05 - Crescendolls.flac'
		);
		expect(musicRenameService.previewAlbum(albumId).totalAlreadyCorrect).toBe(1);
	});

	it('refuses a missing source instead of creating a row that points nowhere', async () => {
		seed({ files: [{ path: 'gone.flac' }] });
		const file = testDb.db.select().from(schema.trackFiles).all()[0];

		const result = await musicRenameService.executeRenames([file.id]);

		expect(result.failed).toBe(1);
		expect(result.results[0].error).toMatch(/missing/);
		expect(testDb.db.select().from(schema.trackFiles).all()[0].relativePath).toBe('gone.flac');
	});
});

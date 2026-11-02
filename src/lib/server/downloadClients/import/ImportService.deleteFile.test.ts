/**
 * deleteMovieFile/deleteEpisodeFile should also remove the .nfo sidecar,
 * not just the video file - otherwise retiring a file during an upgrade
 * (or a manual delete) leaves a stale .nfo behind under the old name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, clearTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	movies,
	movieFiles,
	series,
	seasons,
	episodes,
	episodeFiles,
	rootFolders
} from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const { ImportService } = await import('./ImportService');

describe('ImportService.deleteMovieFile / deleteEpisodeFile remove the .nfo sidecar too', () => {
	let rootDir: string;
	let service: ReturnType<typeof ImportService.getInstance>;

	beforeEach(async () => {
		clearTestDb(testDb);
		rootDir = await mkdtemp(join(tmpdir(), 'cinephage-delete-nfo-'));
		ImportService.resetInstance();
		service = ImportService.getInstance();
	});

	afterEach(async () => {
		await rm(rootDir, { recursive: true, force: true });
	});

	it('deletes the movie .nfo alongside the video file', async () => {
		const rootFolderId = randomUUID();
		await testDb.db.insert(rootFolders).values({
			id: rootFolderId,
			name: 'Movies',
			path: rootDir,
			mediaType: 'movie'
		});
		const movieId = randomUUID();
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 1,
			title: 'Test Movie',
			path: 'Test Movie (2024)',
			rootFolderId,
			hasFile: true
		});
		const fileId = randomUUID();
		const relativePath = 'Test Movie (2024) [1080p].mkv';
		await testDb.db.insert(movieFiles).values({ id: fileId, movieId, relativePath });

		const movieDir = join(rootDir, 'Test Movie (2024)');
		mkdirSync(movieDir, { recursive: true });
		const videoPath = join(movieDir, relativePath);
		const nfoPath = join(movieDir, 'Test Movie (2024) [1080p].nfo');
		writeFileSync(videoPath, 'video bytes');
		writeFileSync(nfoPath, '<movie></movie>');

		const result = await service.deleteMovieFile(fileId, movieId, false);

		expect(result.success).toBe(true);
		await expect(access(videoPath)).rejects.toThrow();
		await expect(access(nfoPath)).rejects.toThrow();
	});

	it('deletes the episode .nfo alongside the video file', async () => {
		const rootFolderId = randomUUID();
		await testDb.db.insert(rootFolders).values({
			id: rootFolderId,
			name: 'TV',
			path: rootDir,
			mediaType: 'tv'
		});
		const seriesId = randomUUID();
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 2,
			title: 'Test Show',
			path: 'Test Show (2024)',
			rootFolderId
		});
		await testDb.db.insert(seasons).values({ seriesId, seasonNumber: 1 });
		const [ep] = await testDb.db
			.insert(episodes)
			.values({ seriesId, seasonNumber: 1, episodeNumber: 1, hasFile: true })
			.returning();
		const fileId = randomUUID();
		const relativePath = 'Season 01/Test Show - S01E01 - Pilot [1080p].mkv';
		await testDb.db.insert(episodeFiles).values({
			id: fileId,
			seriesId,
			seasonNumber: 1,
			episodeIds: [ep.id],
			relativePath
		});

		const seasonDir = join(rootDir, 'Test Show (2024)', 'Season 01');
		mkdirSync(seasonDir, { recursive: true });
		const videoPath = join(rootDir, 'Test Show (2024)', relativePath);
		const nfoPath = join(
			rootDir,
			'Test Show (2024)',
			'Season 01/Test Show - S01E01 - Pilot [1080p].nfo'
		);
		writeFileSync(videoPath, 'video bytes');
		writeFileSync(nfoPath, '<episodedetails></episodedetails>');

		const result = await service.deleteEpisodeFile(fileId, seriesId, false);

		expect(result.success).toBe(true);
		await expect(access(videoPath)).rejects.toThrow();
		await expect(access(nfoPath)).rejects.toThrow();
	});
});

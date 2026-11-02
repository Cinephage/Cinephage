import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../../test/db-helper';
import { callHandler } from '../../../../../../test/api-helper';
import { randomUUID } from 'node:crypto';
import {
	renamingFailures,
	movieFiles,
	episodeFiles,
	movies,
	series
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

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

const mockAccess = vi.fn();
const mockRename = vi.fn();
const mockMkdir = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
	access: mockAccess,
	rename: mockRename,
	mkdir: mockMkdir
}));

const { POST } = await import('./+server');

// Wrap callHandler to catch SvelteKit HttpErrors
async function call(id: string) {
	try {
		return await callHandler(POST, 'POST', undefined, {
			url: `http://localhost/api/reports/renaming-failures/${id}/retry`,
			params: { id },
			auth: 'admin' as const
		});
	} catch (err: any) {
		if (err && typeof err.status === 'number') {
			return {
				status: err.status,
				data: { success: false, message: err.body?.message ?? String(err.body) }
			};
		}
		throw err;
	}
}

describe('Renaming Failures Retry API', () => {
	let movieId: string;
	let seriesId: string;

	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		clearTestDb(testDb);
		testDb.db.delete(renamingFailures).run();
		mockAccess.mockReset();
		mockRename.mockReset();
		mockMkdir.mockResolvedValue(undefined);

		// Seed parent records for FK references
		movieId = randomUUID();
		testDb.db
			.insert(movies)
			.values({ id: movieId, tmdbId: 1001, title: 'Test Movie', path: '/movies/test' })
			.run();

		seriesId = randomUUID();
		testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 2001, title: 'Test Series', path: '/tv/test' })
			.run();
	});

	it('returns 404 when record not found', async () => {
		const { status } = await call(randomUUID());
		expect(status).toBe(404);
	});

	it('returns 400 when record is already resolved', async () => {
		const id = randomUUID();
		testDb.db
			.insert(renamingFailures)
			.values({
				id,
				fileId: 'f1',
				fileType: 'movie',
				sourcePath: '/src/a.mkv',
				intendedPath: '/dst/a.mkv',
				reason: 'permission_denied',
				failedAt: new Date().toISOString(),
				status: 'resolved'
			})
			.run();

		const { status, data } = await call(id);
		expect(status).toBe(400);
		expect((data as any).success).toBe(false);
	});

	it.each(['source_not_found', 'path_too_long', 'invalid_chars'])(
		'returns 422 for non-retryable reason: %s',
		async (reason) => {
			const id = randomUUID();
			testDb.db
				.insert(renamingFailures)
				.values({
					id,
					fileId: 'f1',
					fileType: 'movie',
					sourcePath: '/src/a.mkv',
					intendedPath: '/dst/a.mkv',
					reason,
					failedAt: new Date().toISOString(),
					status: 'failed'
				})
				.run();

			const { status, data } = await call(id);
			expect(status).toBe(422);
			expect((data as any).success).toBe(false);
		}
	);

	it('returns 422 when source file does not exist', async () => {
		const id = randomUUID();
		testDb.db
			.insert(renamingFailures)
			.values({
				id,
				fileId: 'f1',
				fileType: 'movie',
				sourcePath: '/nonexistent/file.mkv',
				intendedPath: '/dst/file.mkv',
				reason: 'permission_denied',
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		// access throws = file doesn't exist
		mockAccess.mockRejectedValueOnce(new Error('ENOENT'));

		const { status, data } = await call(id);
		expect(status).toBe(422);
		expect((data as any).success).toBe(false);
		expect((data as any).error).toMatch(/no longer exists/i);
	});

	it('returns 409 for collision reason when target path still exists', async () => {
		const id = randomUUID();
		testDb.db
			.insert(renamingFailures)
			.values({
				id,
				fileId: 'f1',
				fileType: 'movie',
				sourcePath: '/src/collision.mkv',
				intendedPath: '/dst/collision.mkv',
				reason: 'collision',
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		// access resolves for source (exists), also resolves for intendedPath (still occupied)
		mockAccess.mockResolvedValue(undefined);

		const { status, data } = await call(id);
		expect(status).toBe(409);
		expect((data as any).success).toBe(false);
	});

	it('happy path movie file: renames and updates movieFiles.relativePath', async () => {
		const fileId = randomUUID();
		const id = randomUUID();

		testDb.db
			.insert(movieFiles)
			.values({ id: fileId, movieId, relativePath: 'old-name.mkv' })
			.run();

		testDb.db
			.insert(renamingFailures)
			.values({
				id,
				fileId,
				fileType: 'movie',
				sourcePath: '/movies/test/old-name.mkv',
				intendedPath: '/movies/test/new-name.mkv',
				reason: 'permission_denied',
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		// source exists, rename succeeds
		mockAccess.mockResolvedValue(undefined);
		mockRename.mockResolvedValue(undefined);

		const { status, data } = await call(id);
		expect(status).toBe(200);
		expect((data as any).success).toBe(true);
		expect(mockRename).toHaveBeenCalledWith(
			'/movies/test/old-name.mkv',
			'/movies/test/new-name.mkv'
		);

		// movieFiles.relativePath updated to basename of intendedPath
		const mf = testDb.db.select().from(movieFiles).all()[0];
		expect(mf.relativePath).toBe('new-name.mkv');

		// renamingFailures record marked resolved
		const rf = testDb.db.select().from(renamingFailures).all()[0];
		expect(rf.status).toBe('resolved');
		expect(rf.resolvedAt).not.toBeNull();
	});

	it('happy path episode file: renames and updates episodeFiles.relativePath', async () => {
		const fileId = randomUUID();
		const id = randomUUID();

		testDb.db
			.insert(episodeFiles)
			.values({ id: fileId, seriesId, seasonNumber: 1, relativePath: 'S01E01.old.mkv' })
			.run();

		testDb.db
			.insert(renamingFailures)
			.values({
				id,
				fileId,
				fileType: 'episode',
				sourcePath: '/tv/test/S01E01.old.mkv',
				intendedPath: '/tv/test/S01E01.new.mkv',
				reason: 'permission_denied',
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		mockAccess.mockResolvedValue(undefined);
		mockRename.mockResolvedValue(undefined);

		const { status, data } = await call(id);
		expect(status).toBe(200);
		expect((data as any).success).toBe(true);

		const ef = testDb.db.select().from(episodeFiles).all()[0];
		expect(ef.relativePath).toBe('S01E01.new.mkv');
	});

	it('still returns success when collision reason but target is now free', async () => {
		const fileId = randomUUID();
		const id = randomUUID();

		testDb.db
			.insert(movieFiles)
			.values({ id: fileId, movieId, relativePath: 'old-collision.mkv' })
			.run();

		testDb.db
			.insert(renamingFailures)
			.values({
				id,
				fileId,
				fileType: 'movie',
				sourcePath: '/movies/test/old-collision.mkv',
				intendedPath: '/movies/test/new-collision.mkv',
				reason: 'collision',
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		// access: source exists (resolves), intendedPath does NOT exist (throws) = target is free
		mockAccess
			.mockResolvedValueOnce(undefined) // source check passes
			.mockRejectedValueOnce(new Error('ENOENT')); // intendedPath check: not accessible = free
		mockRename.mockResolvedValue(undefined);

		const { status, data } = await call(id);
		expect(status).toBe(200);
		expect((data as any).success).toBe(true);
	});

	it('returns success even when db update for library record throws', async () => {
		const id = randomUUID();

		testDb.db
			.insert(renamingFailures)
			.values({
				id,
				fileId: randomUUID(), // non-existent fileId — update will be a no-op, not a throw
				fileType: 'movie',
				sourcePath: '/movies/test/orphan.mkv',
				intendedPath: '/movies/test/orphan-new.mkv',
				reason: 'permission_denied',
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		mockAccess.mockResolvedValue(undefined);
		mockRename.mockResolvedValue(undefined);

		// No movieFile seeded for the fileId — the update runs but affects 0 rows (no throw)
		const { status, data } = await call(id);
		expect(status).toBe(200);
		expect((data as any).success).toBe(true);
	});
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../../test/db-helper';
import { createRequestEvent } from '../../../../../../test/api-helper';
import { rootFolders, movies, movieFiles } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

const { isPathInsideManagedRootMock } = vi.hoisted(() => ({
	isPathInsideManagedRootMock: vi.fn().mockResolvedValue(true)
}));

vi.mock('#lib/server/filesystem/path-guard.js', () => ({
	isPathInsideManagedRoot: isPathInsideManagedRootMock
}));

const { GET, HEAD } = await import('./+server');

const TEST_DIR = join(tmpdir(), `cinephage-stream-movie-test-${process.pid}`);
const TEST_FILE = 'movie.mkv';
const TEST_FILE_CONTENT = Buffer.from('fake mkv video bytes for testing 1234567890');
const ROOT_FOLDER_ID = 'rf-test-1';
const MOVIE_ID = 'movie-test-1';
const FILE_ID = 'mf-test-1';
const MISSING_FILE_ID = 'mf-does-not-exist';

function makeRequest(method: string, headers: Record<string, string> = {}): Request {
	return new Request('http://localhost/api/streaming/library/movie/' + FILE_ID, {
		method,
		headers
	});
}

async function callGet(fileId: string, headers: Record<string, string> = {}): Promise<Response> {
	const request = makeRequest('GET', headers);
	return GET(createRequestEvent(request, { fileId }, { auth: 'admin' }) as any);
}

async function callHead(fileId: string): Promise<Response> {
	const request = makeRequest('HEAD');
	return HEAD(createRequestEvent(request, { fileId }, { auth: 'admin' }) as any);
}

beforeAll(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	writeFileSync(join(TEST_DIR, TEST_FILE), TEST_FILE_CONTENT);
});

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	destroyTestDb(testDb);
});

beforeEach(async () => {
	clearTestDb(testDb);
	isPathInsideManagedRootMock.mockResolvedValue(true);

	// Seed: rootFolder -> movie -> movieFile
	await testDb.db.insert(rootFolders).values({
		id: ROOT_FOLDER_ID,
		name: 'Movies',
		path: TEST_DIR,
		mediaType: 'movie'
	});

	await testDb.db.insert(movies).values({
		id: MOVIE_ID,
		tmdbId: 12345,
		title: 'Test Movie',
		path: '',
		rootFolderId: ROOT_FOLDER_ID
	});

	await testDb.db.insert(movieFiles).values({
		id: FILE_ID,
		movieId: MOVIE_ID,
		relativePath: TEST_FILE,
		size: TEST_FILE_CONTENT.length
	});
});

describe('GET /api/streaming/library/movie/[fileId]', () => {
	it('returns 404 for unknown fileId', async () => {
		const res = await callGet(MISSING_FILE_ID);
		expect(res.status).toBe(404);
	});

	it('returns 404 when resolved path is outside managed root', async () => {
		isPathInsideManagedRootMock.mockResolvedValue(false);
		const res = await callGet(FILE_ID);
		expect(res.status).toBe(404);
	});

	it('returns 200 with full content and correct headers', async () => {
		const res = await callGet(FILE_ID);

		expect(res.status).toBe(200);
		expect(res.headers.get('Accept-Ranges')).toBe('bytes');
		expect(res.headers.get('Content-Length')).toBe(String(TEST_FILE_CONTENT.length));
		expect(res.headers.get('Content-Type')).toMatch(/video/);

		const body = Buffer.from(await res.arrayBuffer());
		expect(body).toEqual(TEST_FILE_CONTENT);
	});

	it('returns 206 for a valid Range request', async () => {
		const start = 5;
		const end = 14;
		const res = await callGet(FILE_ID, { Range: `bytes=${start}-${end}` });

		expect(res.status).toBe(206);
		expect(res.headers.get('Content-Range')).toBe(
			`bytes ${start}-${end}/${TEST_FILE_CONTENT.length}`
		);
		expect(res.headers.get('Content-Length')).toBe(String(end - start + 1));
		expect(res.headers.get('Accept-Ranges')).toBe('bytes');

		const body = Buffer.from(await res.arrayBuffer());
		expect(body).toEqual(TEST_FILE_CONTENT.subarray(start, end + 1));
	});

	it('returns 206 for an open-ended Range request (bytes=N-)', async () => {
		const start = 10;
		const end = TEST_FILE_CONTENT.length - 1;
		const res = await callGet(FILE_ID, { Range: `bytes=${start}-` });

		expect(res.status).toBe(206);
		expect(res.headers.get('Content-Range')).toBe(
			`bytes ${start}-${end}/${TEST_FILE_CONTENT.length}`
		);

		const body = Buffer.from(await res.arrayBuffer());
		expect(body).toEqual(TEST_FILE_CONTENT.subarray(start));
	});

	it('returns 206 for a suffix Range request (bytes=-N)', async () => {
		const suffixLength = 8;
		const start = TEST_FILE_CONTENT.length - suffixLength;
		const end = TEST_FILE_CONTENT.length - 1;
		const res = await callGet(FILE_ID, { Range: `bytes=-${suffixLength}` });

		expect(res.status).toBe(206);
		expect(res.headers.get('Content-Range')).toBe(
			`bytes ${start}-${end}/${TEST_FILE_CONTENT.length}`
		);

		const body = Buffer.from(await res.arrayBuffer());
		expect(body).toEqual(TEST_FILE_CONTENT.subarray(start));
	});

	it('returns 416 for an unsatisfiable Range request', async () => {
		const res = await callGet(FILE_ID, { Range: `bytes=9999-99999` });
		expect(res.status).toBe(416);
		expect(res.headers.get('Content-Range')).toBe(`bytes */${TEST_FILE_CONTENT.length}`);
	});

	it('uses Content-Type video/x-matroska for .mkv files', async () => {
		const res = await callGet(FILE_ID);
		expect(res.headers.get('Content-Type')).toBe('video/x-matroska');
	});
});

describe('HEAD /api/streaming/library/movie/[fileId]', () => {
	it('returns 404 for unknown fileId', async () => {
		const res = await callHead(MISSING_FILE_ID);
		expect(res.status).toBe(404);
	});

	it('returns 200 with correct headers and no body', async () => {
		const res = await callHead(FILE_ID);

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe(String(TEST_FILE_CONTENT.length));
		expect(res.headers.get('Accept-Ranges')).toBe('bytes');
		expect(res.headers.get('Content-Type')).toBe('video/x-matroska');

		// HEAD must have no body
		const body = await res.text();
		expect(body).toBe('');
	});
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { api, type ErrorResponse } from '../../../../test/api-helper';

const syncSubtitleMock = vi.hoisted(() => vi.fn());
const isAvailableMock = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

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

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

vi.mock('#lib/server/subtitles/services/SubtitleSyncService.js', () => ({
	getSubtitleSyncService: () => ({
		syncSubtitle: syncSubtitleMock,
		isAvailable: isAvailableMock
	})
}));

const { GET, POST } = await import('./+server');

describe('Subtitle Sync API', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		clearTestDb(testDb);
		syncSubtitleMock.mockReset();
		isAvailableMock.mockReset();
	});

	it('passes subtitle IDs directly to the sync service', async () => {
		syncSubtitleMock.mockResolvedValue({
			success: true,
			offsetMs: 1500
		});

		const { status, data } = await api.post<{
			success: boolean;
			offsetMs: number;
			error?: string;
		}>(POST, {
			subtitleId: '9a3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49',
			referenceType: 'subtitle',
			referencePath: '/tmp/reference.srt',
			splitPenalty: 10,
			noSplits: false
		});

		expect(status).toBe(200);
		expect(syncSubtitleMock).toHaveBeenCalledWith('9a3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49', {
			referenceType: 'subtitle',
			referencePath: '/tmp/reference.srt',
			splitPenalty: 10,
			noSplits: false
		});
		expect(data.success).toBe(true);
		expect(data.offsetMs).toBe(1500);
	});

	it('returns not found when the sync service cannot find the subtitle', async () => {
		syncSubtitleMock.mockResolvedValue({
			success: false,
			offsetMs: 0,
			error: 'Subtitle not found: missing-id'
		});

		const { status, data } = await api.post<ErrorResponse>(POST, {
			subtitleId: '9a3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49'
		});

		expect(status).toBe(404);
		expect(data.error).toBe('Subtitle not found');
	});

	it('reports alass availability', async () => {
		isAvailableMock.mockResolvedValue(true);

		const { status, data } = await api.get<{ available: boolean; message: string }>(GET);

		expect(status).toBe(200);
		expect(data.available).toBe(true);
	});
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { api } from '../../../../test/api-helper';

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

const { GET, PUT } = await import('./+server');

describe('Language Settings API', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		testDb.sqlite.prepare('DELETE FROM language_settings').run();
	});

	it('GET returns the singleton defaults', async () => {
		const { status, data } = await api.get<Record<string, unknown>>(GET);

		expect(status).toBe(200);
		expect(data).toMatchObject({
			defaultProfileId: null,
			metadataLocale: 'en-US',
			region: 'US',
			unknownSubtitlePolicy: 'und',
			autoSyncSubtitles: true
		});
	});

	it('PUT updates and canonicalizes settings', async () => {
		const { status, data } = await api.put<Record<string, unknown>>(PUT, {
			metadataLocale: 'pt-br',
			region: 'de',
			unknownSubtitlePolicy: 'assume-language'
		});

		expect(status).toBe(200);
		expect(data).toMatchObject({
			metadataLocale: 'pt-BR',
			region: 'DE',
			unknownSubtitlePolicy: 'assume-language'
		});
	});

	it('PUT rejects an invalid metadata locale', async () => {
		const { status } = await api.put(PUT, { metadataLocale: 'not a locale!!' });

		expect(status).toBe(400);
	});

	it('PUT is admin-gated', async () => {
		const { status } = await api.put(PUT, { region: 'US' }, { auth: 'user' });

		expect(status).toBe(403);
	});

	it('PUT rejects unauthenticated requests', async () => {
		const { status } = await api.put(PUT, { region: 'US' }, { auth: false });

		expect(status).toBe(401);
	});
});

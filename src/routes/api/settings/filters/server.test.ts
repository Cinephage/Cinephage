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

interface FiltersResponse {
	success: boolean;
	filters: Record<string, unknown>;
}

describe('Global filters API', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		testDb.sqlite.prepare('DELETE FROM settings').run();
		testDb.sqlite.prepare('DELETE FROM language_settings').run();
	});

	function getStoredFilters(): string | undefined {
		const row = testDb.sqlite
			.prepare(`SELECT value FROM settings WHERE key = 'global_filters'`)
			.get() as { value: string } | undefined;
		return row?.value;
	}

	function getLanguageSettingsRow(): Record<string, unknown> | undefined {
		return testDb.sqlite.prepare(`SELECT * FROM language_settings WHERE id = 'singleton'`).get() as
			Record<string, unknown> | undefined;
	}

	it('GET returns stored global_filters and never reads language_settings', async () => {
		testDb.sqlite
			.prepare(
				`INSERT INTO settings (key, value) VALUES ('global_filters', '{"language":"fr-FR","region":"FR"}')`
			)
			.run();
		testDb.sqlite
			.prepare(
				`INSERT INTO language_settings (id, metadata_locale, region) VALUES ('singleton', 'de-DE', 'DE')`
			)
			.run();

		const { status, data } = await api.get<FiltersResponse>(GET, { auth: 'admin' });

		expect(status).toBe(200);
		expect(data.filters).toMatchObject({ language: 'fr-FR', region: 'FR' });
	});

	it('PUT stores global_filters and mirrors canonical language/region into language_settings', async () => {
		const { status, data } = await api.put<FiltersResponse>(PUT, {
			language: 'pt-br',
			region: 'de'
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
		// Response shape unchanged: the parsed body comes back verbatim.
		expect(data.filters).toMatchObject({ language: 'pt-br', region: 'de' });

		expect(JSON.parse(getStoredFilters() ?? '{}')).toMatchObject({
			language: 'pt-br',
			region: 'de'
		});

		const row = getLanguageSettingsRow();
		expect(row).toBeDefined();
		expect(row?.metadata_locale).toBe('pt-BR');
		expect(row?.region).toBe('DE');
	});

	it('PUT preserves other language_settings fields when mirroring', async () => {
		testDb.sqlite
			.prepare(
				`INSERT INTO language_settings (id, metadata_locale, region, discover_original_filter)
				 VALUES ('singleton', 'en-US', 'US', 'ja')`
			)
			.run();

		await api.put<FiltersResponse>(PUT, { language: 'ko-KR', region: 'KR' });

		const row = getLanguageSettingsRow();
		expect(row?.metadata_locale).toBe('ko-KR');
		expect(row?.region).toBe('KR');
		expect(row?.discover_original_filter).toBe('ja');
	});

	it('PUT leaves the last good singleton values in place for unparseable language', async () => {
		testDb.sqlite
			.prepare(
				`INSERT INTO language_settings (id, metadata_locale, region) VALUES ('singleton', 'ja-JP', 'JP')`
			)
			.run();

		const { status } = await api.put<FiltersResponse>(PUT, {
			language: 'not a locale!!',
			region: 'JP'
		});

		expect(status).toBe(200);
		const row = getLanguageSettingsRow();
		// Unparseable language is skipped; last good locale survives.
		expect(row?.metadata_locale).toBe('ja-JP');
		expect(row?.region).toBe('JP');
	});

	it('PUT creates the singleton row when it does not exist yet', async () => {
		const { status } = await api.put<FiltersResponse>(PUT, { language: 'es-MX', region: 'MX' });

		expect(status).toBe(200);
		const row = getLanguageSettingsRow();
		expect(row?.metadata_locale).toBe('es-MX');
		expect(row?.region).toBe('MX');
	});

	it('PUT is admin-gated', async () => {
		const { status } = await api.put(PUT, { language: 'de-DE' }, { auth: 'user' });

		expect(status).toBe(403);
	});

	it('PUT rejects unauthenticated requests', async () => {
		const { status } = await api.put(PUT, { language: 'de-DE' }, { auth: false });

		expect(status).toBe(401);
	});
});

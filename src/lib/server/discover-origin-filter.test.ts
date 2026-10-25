import { afterAll, describe, expect, it, vi } from 'vitest';

import { createTestDb, destroyTestDb, type TestDatabase } from '../../test/db-helper';

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

// discover.ts imports tmdb (which opens the real database at import time) —
// mock the db module before importing it.
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

const { resolveWithOriginalLanguage } = await import('./discover.js');

afterAll(() => {
	destroyTestDb(testDb);
});

describe('resolveWithOriginalLanguage (discover origin filter)', () => {
	it('prefers the explicit URL param over the stored filter', () => {
		expect(resolveWithOriginalLanguage('ja', 'ko')).toBe('ja');
	});

	it('normalizes the URL param to the TMDB base tag', () => {
		expect(resolveWithOriginalLanguage('en-US', 'ja')).toBe('en');
		expect(resolveWithOriginalLanguage('PT-br', null)).toBe('pt');
	});

	it('falls back to the stored filter when the URL param is a marker or junk', () => {
		expect(resolveWithOriginalLanguage('any', 'ja')).toBe('ja');
		expect(resolveWithOriginalLanguage('!!', 'ja')).toBe('ja');
	});

	it('treats a whitespace-only URL param as absent', () => {
		expect(resolveWithOriginalLanguage('   ', 'ko')).toBe('ko');
	});

	it('uses the stored discover_original_filter when no URL param is set', () => {
		expect(resolveWithOriginalLanguage(null, 'ja')).toBe('ja');
		expect(resolveWithOriginalLanguage(undefined, 'KO')).toBe('ko');
	});

	it('reduces a stored locale to its base tag', () => {
		expect(resolveWithOriginalLanguage(null, 'en-US')).toBe('en');
		expect(resolveWithOriginalLanguage(null, 'pt-BR')).toBe('pt');
	});

	it('maps stored ISO 639-2/3 codes to their canonical base tag', () => {
		expect(resolveWithOriginalLanguage(null, 'ger')).toBe('de');
		expect(resolveWithOriginalLanguage(null, 'fra')).toBe('fr');
	});

	it('returns null for stored junk values', () => {
		expect(resolveWithOriginalLanguage(null, 'not a language!!')).toBeNull();
		expect(resolveWithOriginalLanguage(null, '')).toBeNull();
		expect(resolveWithOriginalLanguage(null, '   ')).toBeNull();
		expect(resolveWithOriginalLanguage(null, null)).toBeNull();
		expect(resolveWithOriginalLanguage(null, undefined)).toBeNull();
	});

	it('returns null for stored non-language markers', () => {
		expect(resolveWithOriginalLanguage(null, 'und')).toBeNull();
		expect(resolveWithOriginalLanguage(null, 'multi')).toBeNull();
		expect(resolveWithOriginalLanguage(null, 'unknown')).toBeNull();
		expect(resolveWithOriginalLanguage(null, 'any')).toBeNull();
		expect(resolveWithOriginalLanguage(null, 'all')).toBeNull();
	});

	it('returns null when neither a URL param nor a stored filter exists', () => {
		expect(resolveWithOriginalLanguage(null, null)).toBeNull();
		expect(resolveWithOriginalLanguage(undefined, undefined)).toBeNull();
	});
});

import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { blockedKeywords, settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const testDb: TestDatabase = createTestDb();

const { mockKeywordDetails } = vi.hoisted(() => ({
	mockKeywordDetails: vi.fn()
}));

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		keywordDetails: mockKeywordDetails
	}
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

import { keywordBlocklistService } from './KeywordBlocklistService.js';

afterAll(() => {
	destroyTestDb(testDb);
});

describe('KeywordBlocklistService', () => {
	it('returns empty list when no keywords are blocked', async () => {
		const ids = await keywordBlocklistService.getBlockedKeywordIds();
		expect(ids).toEqual([]);
	});

	it('adds a blocked keyword and returns it', async () => {
		mockKeywordDetails.mockResolvedValue({ id: 123, name: 'science fiction' });
		const entry = await keywordBlocklistService.addBlockedKeyword(123);
		expect(entry.keywordId).toBe(123);
		expect(entry.name).toBe('science fiction');
	});

	it('returns blocked keyword IDs after adding', async () => {
		const ids = await keywordBlocklistService.getBlockedKeywordIds();
		expect(ids).toContain(123);
	});

	it('does not duplicate keywords', async () => {
		mockKeywordDetails.mockResolvedValue({ id: 123, name: 'science fiction' });
		await keywordBlocklistService.addBlockedKeyword(123);
		const all = await keywordBlocklistService.getBlockedKeywords();
		const count123 = all.filter((k) => k.keywordId === 123).length;
		expect(count123).toBe(1);
	});

	it('removes a blocked keyword', async () => {
		mockKeywordDetails.mockResolvedValue({ id: 456, name: 'test keyword' });
		const entry = await keywordBlocklistService.addBlockedKeyword(456);
		await keywordBlocklistService.removeBlockedKeyword(entry.id);
		const ids = await keywordBlocklistService.getBlockedKeywordIds();
		expect(ids).not.toContain(456);
	});

	it('caches blocked IDs', async () => {
		const ids1 = await keywordBlocklistService.getBlockedKeywordIds();
		const ids2 = await keywordBlocklistService.getBlockedKeywordIds();
		expect(ids1).toEqual(ids2);
	});

	it('invalidates cache on add', async () => {
		mockKeywordDetails.mockResolvedValue({ id: 999, name: 'new keyword' });
		await keywordBlocklistService.addBlockedKeyword(999);
		const ids = await keywordBlocklistService.getBlockedKeywordIds();
		expect(ids).toContain(999);
	});
});

describe('KeywordBlocklistService.seedDefaults', () => {
	beforeEach(async () => {
		await testDb.db.delete(blockedKeywords);
		await testDb.db.delete(settings).where(eq(settings.key, 'keyword_defaults_seeded'));
		keywordBlocklistService.invalidateCache();
	});

	it('seeds default NSFW keywords when table is empty', async () => {
		const count = await keywordBlocklistService.seedDefaults();
		expect(count).toBeGreaterThan(0);

		const ids = await keywordBlocklistService.getBlockedKeywordIds();
		expect(ids.length).toBe(count);
	});

	it('includes expected keywords in the default set', async () => {
		await keywordBlocklistService.seedDefaults();
		const ids = await keywordBlocklistService.getBlockedKeywordIds();

		expect(ids).toContain(155477); // softcore
		expect(ids).toContain(910); // bondage
		expect(ids).toContain(158713); // bdsm
		expect(ids).toContain(445); // pornography
		expect(ids).toContain(33451); // masturbation
		expect(ids).toContain(11534); // sexual violence
	});

	it('seeds defaults even when custom keywords already exist', async () => {
		mockKeywordDetails.mockResolvedValue({ id: 999, name: 'custom keyword' });
		await keywordBlocklistService.addBlockedKeyword(999);

		const count = await keywordBlocklistService.seedDefaults();
		expect(count).toBeGreaterThan(0);

		const ids = await keywordBlocklistService.getBlockedKeywordIds();
		expect(ids).toContain(999);
		expect(ids).toContain(155477);
	});

	it('is idempotent', async () => {
		const first = await keywordBlocklistService.seedDefaults();
		const second = await keywordBlocklistService.seedDefaults();

		expect(first).toBeGreaterThan(0);
		expect(second).toBe(0);
	});

	it('force-seeds missing defaults when table has existing entries', async () => {
		mockKeywordDetails.mockResolvedValue({ id: 999, name: 'custom keyword' });
		await keywordBlocklistService.addBlockedKeyword(999);

		const count = await keywordBlocklistService.seedDefaults(true);
		expect(count).toBeGreaterThan(0);

		const ids = await keywordBlocklistService.getBlockedKeywordIds();
		expect(ids).toContain(999);
		expect(ids).toContain(155477);
	});
});

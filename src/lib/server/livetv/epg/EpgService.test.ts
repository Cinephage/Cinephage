import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { epgPrograms, livetvAccounts, livetvChannels } from '#lib/server/db/schema.js';
import type { EpgProgram } from '#lib/types/livetv.js';

/**
 * Real integration over an in-memory database: storeEpgData writes through the
 * actual drizzle upsert (including the migration-140 i18n columns) and the
 * read paths exercise the display-time selection chain against stored rows.
 */
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

const fetchEpgMock = vi.fn();

vi.mock('../providers', () => ({
	getProvider: () => ({
		type: 'm3u',
		hasEpgSupport: () => true,
		fetchEpg: fetchEpgMock
	})
}));

const { EpgService } = await import('./EpgService');

const SERVICE = new EpgService();

const HOUR_MS = 60 * 60 * 1000;

/**
 * Fixed programme slots (computed once) so re-syncs hit the same upsert key
 * (accountId, externalChannelId, startTime) and exercise the conflict path.
 */
const SLOT_START = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const SLOT_END = new Date(Date.now() + 90 * 60 * 1000).toISOString();
const SLOT2_START = new Date(Date.now() + 3 * HOUR_MS).toISOString();
const SLOT2_END = new Date(Date.now() + 4 * HOUR_MS).toISOString();

/** Build a valid EpgProgram with optional i18n variant lists. */
function makeProgram(overrides: Partial<EpgProgram> = {}): EpgProgram {
	const now = new Date();
	return {
		id: 'generated-in-provider',
		channelId: 'ignored-by-store',
		externalChannelId: 'c1',
		accountId: 'acct-1',
		providerType: 'm3u',
		title: 'News',
		description: 'Plain first',
		category: 'Sports',
		titleI18n: [
			{ lang: 'en', text: 'News' },
			{ lang: 'fr', text: 'Informations' },
			{ lang: 'pt-br', text: 'Jornal' }
		],
		descriptionI18n: [
			{ lang: null, text: 'Plain first' },
			{ lang: 'de', text: 'Beschreibung' }
		],
		categoryI18n: [{ lang: 'en', text: 'Sports' }],
		director: null,
		actor: null,
		startTime: SLOT_START,
		endTime: SLOT_END,
		duration: 3600,
		hasArchive: false,
		cachedAt: now.toISOString(),
		updatedAt: now.toISOString(),
		...overrides
	};
}

async function syncWithPrograms(programs: EpgProgram[]): Promise<void> {
	fetchEpgMock.mockResolvedValue(programs);
	const result = await SERVICE.syncAccount('acct-1');
	expect(result.success).toBe(true);
}

function storedRow(): Record<string, unknown> {
	return testDb.sqlite.prepare('SELECT * FROM epg_programs LIMIT 1').get() as Record<
		string,
		unknown
	>;
}

beforeEach(() => {
	testDb.db.delete(epgPrograms).run();
	testDb.db.delete(livetvChannels).run();
	testDb.db.delete(livetvAccounts).run();

	testDb.db
		.insert(livetvAccounts)
		.values({ id: 'acct-1', name: 'Test M3U', providerType: 'm3u' })
		.run();
	testDb.db
		.insert(livetvChannels)
		.values({
			id: 'chan-1',
			accountId: 'acct-1',
			providerType: 'm3u',
			externalId: 'c1',
			name: 'News Channel'
		})
		.run();

	fetchEpgMock.mockReset();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('EpgService storeEpgData — i18n columns', () => {
	it('stores the complete i18n variant lists alongside the plain columns', async () => {
		await syncWithPrograms([makeProgram()]);

		const row = storedRow();
		expect(row.title).toBe('News');
		expect(row.description).toBe('Plain first');
		expect(row.category).toBe('Sports');
		expect(JSON.parse(row.title_i18n as string)).toEqual([
			{ lang: 'en', text: 'News' },
			{ lang: 'fr', text: 'Informations' },
			{ lang: 'pt-br', text: 'Jornal' }
		]);
		expect(JSON.parse(row.description_i18n as string)).toEqual([
			{ lang: null, text: 'Plain first' },
			{ lang: 'de', text: 'Beschreibung' }
		]);
		expect(JSON.parse(row.category_i18n as string)).toEqual([{ lang: 'en', text: 'Sports' }]);
	});

	it('stores NULL i18n columns for programs without language data', async () => {
		await syncWithPrograms([
			makeProgram({
				titleI18n: null,
				descriptionI18n: null,
				categoryI18n: null
			})
		]);

		const row = storedRow();
		expect(row.title).toBe('News');
		expect(row.title_i18n).toBeNull();
		expect(row.description_i18n).toBeNull();
		expect(row.category_i18n).toBeNull();
	});

	it('conflict-updates the i18n columns on re-sync of the same slot', async () => {
		await syncWithPrograms([makeProgram()]);
		await syncWithPrograms([
			makeProgram({
				title: 'News (updated)',
				titleI18n: [
					{ lang: 'en', text: 'News (updated)' },
					{ lang: 'de', text: 'Nachrichten' }
				],
				categoryI18n: null
			})
		]);

		const rows = testDb.sqlite.prepare('SELECT * FROM epg_programs').all();
		expect(rows).toHaveLength(1);

		const row = rows[0] as Record<string, unknown>;
		expect(row.title).toBe('News (updated)');
		expect(JSON.parse(row.title_i18n as string)).toEqual([
			{ lang: 'en', text: 'News (updated)' },
			{ lang: 'de', text: 'Nachrichten' }
		]);
		// A cleared list must not survive the conflict update.
		expect(row.category_i18n).toBeNull();
	});
});

describe('EpgService display-time language selection', () => {
	beforeEach(async () => {
		await syncWithPrograms([makeProgram()]);
	});

	it('returns the plain columns when no lang is requested (current behavior)', () => {
		const programs = SERVICE.getChannelPrograms(
			'chan-1',
			new Date(Date.now() - 2 * HOUR_MS),
			new Date(Date.now() + 2 * HOUR_MS)
		);

		expect(programs).toHaveLength(1);
		expect(programs[0].title).toBe('News');
		expect(programs[0].description).toBe('Plain first');
		expect(programs[0].category).toBe('Sports');
	});

	it('prefers the exact tag match', () => {
		const programs = SERVICE.getChannelPrograms(
			'chan-1',
			new Date(Date.now() - 2 * HOUR_MS),
			new Date(Date.now() + 2 * HOUR_MS),
			'fr'
		);

		expect(programs[0].title).toBe('Informations');
		// Description has no French entry: falls through to the first stored entry.
		expect(programs[0].description).toBe('Plain first');
		// Category has no French entry: first stored entry.
		expect(programs[0].category).toBe('Sports');
	});

	it('matches a stored regional tag by base language', () => {
		const programs = SERVICE.getChannelPrograms(
			'chan-1',
			new Date(Date.now() - 2 * HOUR_MS),
			new Date(Date.now() + 2 * HOUR_MS),
			'pt'
		);

		// Stored entry is "pt-br"; requesting the base tag "pt" matches it.
		expect(programs[0].title).toBe('Jornal');
	});

	it('falls back to the first stored entry when nothing matches', () => {
		const programs = SERVICE.getChannelPrograms(
			'chan-1',
			new Date(Date.now() - 2 * HOUR_MS),
			new Date(Date.now() + 2 * HOUR_MS),
			'nl'
		);

		expect(programs[0].title).toBe('News');
		expect(programs[0].description).toBe('Plain first');
	});

	it('uses an exact description match when available', () => {
		const programs = SERVICE.getChannelPrograms(
			'chan-1',
			new Date(Date.now() - 2 * HOUR_MS),
			new Date(Date.now() + 2 * HOUR_MS),
			'de'
		);

		// Title has no German entry → first stored entry.
		expect(programs[0].title).toBe('News');
		// Description has an exact German entry.
		expect(programs[0].description).toBe('Beschreibung');
	});

	it('falls back to the plain column when no i18n list is stored', async () => {
		await syncWithPrograms([
			makeProgram({
				startTime: SLOT2_START,
				endTime: SLOT2_END,
				title: 'Untranslated',
				description: 'Untranslated desc',
				titleI18n: null,
				descriptionI18n: null,
				categoryI18n: null
			})
		]);

		const programs = SERVICE.getChannelPrograms(
			'chan-1',
			new Date(Date.now() - 2 * HOUR_MS),
			new Date(Date.now() + 5 * HOUR_MS),
			'fr'
		);

		expect(programs).toHaveLength(2);
		const untranslated = programs.find((p) => p.title === 'Untranslated');
		expect(untranslated?.description).toBe('Untranslated desc');
	});

	it('applies the same chain in getGuideData', () => {
		const plain = SERVICE.getGuideData(
			['chan-1'],
			new Date(Date.now() - 2 * HOUR_MS),
			new Date(Date.now() + 2 * HOUR_MS)
		);
		expect(plain.get('chan-1')?.[0].title).toBe('News');

		const french = SERVICE.getGuideData(
			['chan-1'],
			new Date(Date.now() - 2 * HOUR_MS),
			new Date(Date.now() + 2 * HOUR_MS),
			'fr'
		);
		expect(french.get('chan-1')?.[0].title).toBe('Informations');
	});
});

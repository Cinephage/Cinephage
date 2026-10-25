import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';
import { epgPrograms, livetvAccounts, livetvChannels } from '#lib/server/db/schema.js';

/**
 * In-memory database so the route reads real epg_programs rows written with
 * the migration-140 i18n columns.
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

vi.mock('#lib/server/livetv/lineup/index.js', () => ({
	channelLineupService: {
		getLineup: vi.fn().mockResolvedValue([
			{
				channelId: 'chan-1',
				epgSourceChannelId: null
			}
		])
	}
}));

const { GET } = await import('./+server');

const HOUR_MS = 60 * 60 * 1000;

interface GuideProgram {
	title: string;
	description: string | null;
	category: string | null;
}

interface GuideResponse {
	success: boolean;
	programs: Record<string, GuideProgram[]>;
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
	testDb.db
		.insert(epgPrograms)
		.values({
			id: 'prog-1',
			channelId: 'chan-1',
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
			startTime: new Date(Date.now() - HOUR_MS).toISOString(),
			endTime: new Date(Date.now() + HOUR_MS).toISOString(),
			duration: 3600
		})
		.run();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('GET /api/livetv/epg/guide', () => {
	it('returns the plain columns without a lang param', async () => {
		const { status, data } = await api.get<GuideResponse>(GET, {
			url: 'http://localhost/api/livetv/epg/guide'
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.programs['chan-1']).toHaveLength(1);
		expect(data.programs['chan-1'][0].title).toBe('News');
		expect(data.programs['chan-1'][0].description).toBe('Plain first');
	});

	it('selects the requested language when given a valid lang param', async () => {
		const { status, data } = await api.get<GuideResponse>(GET, {
			url: 'http://localhost/api/livetv/epg/guide?lang=fr'
		});

		expect(status).toBe(200);
		expect(data.programs['chan-1'][0].title).toBe('Informations');
	});

	it('reduces regional tags to the base language', async () => {
		const { status, data } = await api.get<GuideResponse>(GET, {
			url: 'http://localhost/api/livetv/epg/guide?lang=pt-BR'
		});

		expect(status).toBe(200);
		// Stored "pt-br" entry selected via the base-language chain step.
		expect(data.programs['chan-1'][0].title).toBe('Jornal');
	});

	it('ignores an invalid lang param and returns the plain columns', async () => {
		const { status, data } = await api.get<GuideResponse>(GET, {
			url: 'http://localhost/api/livetv/epg/guide?lang=not-a-language'
		});

		expect(status).toBe(200);
		expect(data.programs['chan-1'][0].title).toBe('News');
		expect(data.programs['chan-1'][0].description).toBe('Plain first');
	});
});

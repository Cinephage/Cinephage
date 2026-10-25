import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../../test/db-helper';
import { api } from '../../../../../../test/api-helper';
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

const { GET } = await import('./+server');

const HOUR_MS = 60 * 60 * 1000;

interface ChannelProgram {
	title: string;
	description: string | null;
	category: string | null;
}

interface ChannelEpgResponse {
	success: boolean;
	channelId: string;
	programs: ChannelProgram[];
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
				{ lang: 'fr', text: 'Informations' }
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

describe('GET /api/livetv/epg/channel/[id]', () => {
	it('returns the plain columns without a lang param', async () => {
		const { status, data } = await api.get<ChannelEpgResponse>(GET, {
			url: 'http://localhost/api/livetv/epg/channel/chan-1',
			params: { id: 'chan-1' }
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.channelId).toBe('chan-1');
		expect(data.programs).toHaveLength(1);
		expect(data.programs[0].title).toBe('News');
		expect(data.programs[0].description).toBe('Plain first');
	});

	it('selects the requested language when given a valid lang param', async () => {
		const { status, data } = await api.get<ChannelEpgResponse>(GET, {
			url: 'http://localhost/api/livetv/epg/channel/chan-1?lang=fr',
			params: { id: 'chan-1' }
		});

		expect(status).toBe(200);
		expect(data.programs[0].title).toBe('Informations');
		// Description falls through to the first stored entry (no French).
		expect(data.programs[0].description).toBe('Plain first');
	});

	it('selects a language by exact tag for the description', async () => {
		const { status, data } = await api.get<ChannelEpgResponse>(GET, {
			url: 'http://localhost/api/livetv/epg/channel/chan-1?lang=de',
			params: { id: 'chan-1' }
		});

		expect(status).toBe(200);
		expect(data.programs[0].title).toBe('News');
		expect(data.programs[0].description).toBe('Beschreibung');
	});

	it('ignores an invalid lang param and returns the plain columns', async () => {
		const { status, data } = await api.get<ChannelEpgResponse>(GET, {
			url: 'http://localhost/api/livetv/epg/channel/chan-1?lang=zz',
			params: { id: 'chan-1' }
		});

		expect(status).toBe(200);
		expect(data.programs[0].title).toBe('News');
		expect(data.programs[0].description).toBe('Plain first');
	});
});

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { storageItems, mediaBrowserServers } from '#lib/server/db/schema.js';

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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

import { MissingFromMediaServerRule } from './MissingFromMediaServerRule.js';
import type { RuleContext } from '../types.js';
import { createStorageItem } from '../../../../../test/fixtures/storage.js';

describe('MissingFromMediaServerRule', () => {
	const rule = new MissingFromMediaServerRule();

	afterAll(() => destroyTestDb(testDb));
	beforeEach(async () => {
		await clearTestDb(testDb);
	});

	it('has type "missing-from-media-server"', () => {
		expect(rule.type).toBe('missing-from-media-server');
	});

	it('returns zero findings when no media servers are configured', async () => {
		await testDb.db
			.insert(storageItems)
			.values(createStorageItem({ sourceSystem: 'local', tmdbId: 100 }));
		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});

	it('counts local-only items when a media server is configured', async () => {
		await testDb.db.insert(mediaBrowserServers).values({
			id: 'srv-1',
			name: 'Jellyfin',
			serverType: 'jellyfin',
			host: 'http://test',
			apiKey: 'key',
			enabled: true
		});
		await testDb.db
			.insert(storageItems)
			.values([
				createStorageItem({ sourceSystem: 'local', tmdbId: 100, title: 'Movie A' }),
				createStorageItem({ sourceSystem: 'both', tmdbId: 200, title: 'Movie B' }),
				createStorageItem({ sourceSystem: 'server', tmdbId: 300, title: 'Movie C' })
			]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(1);
		expect(findings[0].severity).toBe('info');
		expect(findings[0].scope).toBe('global');
		expect(findings[0].title).toContain('missing from');
	});

	it('summary breaks down the raw item count by movies vs series', async () => {
		await testDb.db.insert(mediaBrowserServers).values({
			id: 'srv-1',
			name: 'Jellyfin',
			serverType: 'jellyfin',
			host: 'http://test',
			apiKey: 'key',
			enabled: true
		});
		await testDb.db.insert(storageItems).values([
			createStorageItem({ sourceSystem: 'local', itemType: 'movie', tmdbId: 700 }),
			createStorageItem({
				sourceSystem: 'local',
				itemType: 'episode',
				tmdbId: 800,
				seasonNumber: 1,
				episodeNumber: 1
			}),
			createStorageItem({
				sourceSystem: 'local',
				itemType: 'episode',
				tmdbId: 800,
				seasonNumber: 1,
				episodeNumber: 2
			})
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(3);
		expect(findings[0].summary).toContain('3 items');
		expect(findings[0].summary).toContain('1 Movie');
		expect(findings[0].summary).toContain('1 Series');
	});

	it('returns zero findings when all items are on servers', async () => {
		await testDb.db.insert(mediaBrowserServers).values({
			id: 'srv-1',
			name: 'Jellyfin',
			serverType: 'jellyfin',
			host: 'http://test',
			apiKey: 'key',
			enabled: true
		});
		await testDb.db
			.insert(storageItems)
			.values(createStorageItem({ sourceSystem: 'both', tmdbId: 100 }));

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});
});

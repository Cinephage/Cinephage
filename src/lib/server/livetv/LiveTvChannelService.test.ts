import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { livetvAccounts, livetvChannels } from '#lib/server/db/schema.js';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper';

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

import { getLiveTvChannelService } from './LiveTvChannelService';

const ACCOUNT_ID = 'country-test-account';

async function insertChannel(externalId: string, countryCode: string | null): Promise<void> {
	const now = new Date().toISOString();
	await testDb.db.insert(livetvChannels).values({
		accountId: ACCOUNT_ID,
		providerType: 'cinephage-live',
		externalId,
		name: `Channel ${externalId}`,
		cinephageData: countryCode ? { countryCode } : undefined,
		createdAt: now,
		updatedAt: now
	});
}

beforeEach(async () => {
	await testDb.db.delete(livetvChannels);
	await testDb.db.delete(livetvAccounts);
	const now = new Date().toISOString();
	await testDb.db.insert(livetvAccounts).values({
		id: ACCOUNT_ID,
		name: 'Country Test',
		providerType: 'cinephage-live',
		enabled: true,
		createdAt: now,
		updatedAt: now
	});
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('LiveTvChannelService country filtering', () => {
	it('filters channels by country code from Cinephage metadata', async () => {
		await insertChannel('gb-1', 'GB');
		await insertChannel('us-1', 'US');
		await insertChannel('none-1', null);

		const service = getLiveTvChannelService();
		const result = await service.getChannels({ countryCodes: ['GB'] });

		expect(result.total).toBe(1);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ externalId: 'gb-1', providerType: 'cinephage-live' });
		expect(result.items[0]?.cinephageLive).toEqual({ countryCode: 'GB' });
	});

	it('aggregates a distinct country facet with counts', async () => {
		await insertChannel('gb-1', 'GB');
		await insertChannel('gb-2', 'GB');
		await insertChannel('us-1', 'US');
		await insertChannel('none-1', null);

		const service = getLiveTvChannelService();
		const countries = await service.getChannelCountries();

		expect(countries).toEqual([
			{ code: 'GB', channelCount: 2 },
			{ code: 'US', channelCount: 1 }
		]);
	});

	it('scopes the facet to the requested account', async () => {
		await insertChannel('gb-1', 'GB');

		const now = new Date().toISOString();
		await testDb.db.insert(livetvAccounts).values({
			id: 'other-account',
			name: 'Other',
			providerType: 'cinephage-live',
			enabled: true,
			createdAt: now,
			updatedAt: now
		});
		await testDb.db.insert(livetvChannels).values({
			accountId: 'other-account',
			providerType: 'cinephage-live',
			externalId: 'us-1',
			name: 'US Channel',
			cinephageData: { countryCode: 'US' },
			createdAt: now,
			updatedAt: now
		});

		const service = getLiveTvChannelService();
		const scoped = await service.getChannelCountries([ACCOUNT_ID]);
		expect(scoped).toEqual([{ code: 'GB', channelCount: 1 }]);

		const everything = await service.getChannelCountries();
		expect(everything.map((c) => c.code)).toEqual(['GB', 'US']);

		const byAccount = await service.getChannels({ accountIds: ['other-account'] });
		expect(byAccount.items[0]?.accountId).toBe('other-account');
		await testDb.db.delete(livetvAccounts).where(eq(livetvAccounts.id, 'other-account'));
	});
});

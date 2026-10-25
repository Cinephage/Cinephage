/**
 * Tests for the request settings services.
 *
 * The DB is real so upsert semantics, inheritance defaults, and
 * corrupt-row degradation are exercised for truth. Security-relevant
 * behavior: the global settings row can never brick the request system (a
 * corrupt value falls back to schema defaults) and per-user rows are
 * strictly keyed by userId.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import { settings, user, userRequestSettings } from '#lib/server/db/schema.js';
import { createTestUser } from '../../../test/fixtures/auth.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const { getRequestSettingsService, REQUEST_SETTINGS_KEY, requestSettingsSchema } =
	await import('./RequestSettingsService.js');
const { getUserRequestSettingsService } = await import('./UserRequestSettingsService.js');

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(userRequestSettings).run();
	testDb.db.delete(settings).run();
	testDb.db.delete(user).run();
	getRequestSettingsService().invalidateCache();
	testDb.db
		.insert(user)
		.values(
			createTestUser({
				id: (userId = randomUUID()),
				username: 'reqsettings',
				email: 'r@test.local'
			})
		)
		.run();
});

let userId: string;

describe('RequestSettingsService', () => {
	it('returns schema defaults when no settings row exists', async () => {
		const svc = getRequestSettingsService();
		const value = await svc.getRequestSettings();

		expect(value.requestsEnabled).toBe(true);
		expect(value.autoApprove).toEqual({ movie: false, series: false });
		expect(value.defaultQuotas.movie).toEqual({ limit: null, days: null });
		expect(value.tvQuotaUnit).toBe('episodes');
		expect(value.pendingTtlDays).toBe(30);
		expect(value.reRequestCooldownDays).toBe(7);
	});

	it('persists and reloads a full update', async () => {
		const svc = getRequestSettingsService();
		await svc.saveRequestSettings({
			requestsEnabled: false,
			autoApprove: { movie: true, series: false },
			defaultQuotas: {
				movie: { limit: 5, days: 7 },
				tv: { limit: null, days: null }
			},
			tvQuotaUnit: 'seasons',
			pendingTtlDays: 14,
			reRequestCooldownDays: 3
		});
		svc.invalidateCache();

		const value = await svc.getRequestSettings();
		expect(value.requestsEnabled).toBe(false);
		expect(value.autoApprove.movie).toBe(true);
		expect(value.defaultQuotas.movie).toEqual({ limit: 5, days: 7 });
		expect(value.tvQuotaUnit).toBe('seasons');
		expect(value.pendingTtlDays).toBe(14);

		const row = testDb.sqlite
			.prepare(`SELECT value FROM settings WHERE key = ?`)
			.get(REQUEST_SETTINGS_KEY) as { value: string };
		expect(() => requestSettingsSchema.parse(JSON.parse(row.value))).not.toThrow();
	});

	it('degrades to defaults when the stored row is corrupt', async () => {
		testDb.sqlite
			.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
			.run(REQUEST_SETTINGS_KEY, '{"requestsEnabled": "not-a-boolean",');
		getRequestSettingsService().invalidateCache();

		const value = await getRequestSettingsService().getRequestSettings();
		expect(value.requestsEnabled).toBe(true);
	});

	it('fills partial nested objects from defaults on save', async () => {
		const svc = getRequestSettingsService();
		// The schema is the gate: a nested object replaces wholesale and the
		// parse fills any missing member with its default.
		const value = await svc.saveRequestSettings({ autoApprove: { movie: true, series: false } });
		expect(value.requestsEnabled).toBe(true);
		expect(value.autoApprove.series).toBe(false);
	});
});

describe('UserRequestSettingsService', () => {
	it('returns inherit-everything defaults when no row exists', async () => {
		const row = await getUserRequestSettingsService().getUserRequestSettings(userId);
		expect(row).toEqual({
			userId,
			requestsDisabled: false,
			autoApprove: null,
			movieQuotaLimit: null,
			movieQuotaDays: null,
			tvQuotaLimit: null,
			tvQuotaDays: null
		});
	});

	it('applies partial updates without clobbering other fields', async () => {
		const svc = getUserRequestSettingsService();
		await svc.updateUserRequestSettings(userId, { requestsDisabled: true });
		let row = await svc.getUserRequestSettings(userId);
		expect(row.requestsDisabled).toBe(true);
		expect(row.autoApprove).toBeNull();

		await svc.updateUserRequestSettings(userId, {
			requestsDisabled: false,
			autoApprove: true,
			tvQuotaLimit: 20,
			tvQuotaDays: 30
		});
		row = await svc.getUserRequestSettings(userId);
		expect(row.requestsDisabled).toBe(false);
		expect(row.autoApprove).toBe(true);
		expect(row.tvQuotaLimit).toBe(20);
		expect(row.tvQuotaDays).toBe(30);
		expect(row.movieQuotaLimit).toBeNull();
	});

	it('resets an override back to inherit with null', async () => {
		const svc = getUserRequestSettingsService();
		await svc.updateUserRequestSettings(userId, { movieQuotaLimit: 5, movieQuotaDays: 7 });
		await svc.updateUserRequestSettings(userId, { movieQuotaLimit: null, movieQuotaDays: null });

		const row = await svc.getUserRequestSettings(userId);
		expect(row.movieQuotaLimit).toBeNull();
		expect(row.movieQuotaDays).toBeNull();
	});

	it('scopes rows per user', async () => {
		const otherId = randomUUID();
		testDb.db
			.insert(user)
			.values(createTestUser({ id: otherId, username: 'otherreq', email: 'o@test.local' }))
			.run();

		const svc = getUserRequestSettingsService();
		await svc.updateUserRequestSettings(userId, { requestsDisabled: true });

		expect((await svc.getUserRequestSettings(userId)).requestsDisabled).toBe(true);
		expect((await svc.getUserRequestSettings(otherId)).requestsDisabled).toBe(false);
	});
});

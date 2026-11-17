/**
 * Connection store: persistence, encryption at rest, redaction, secret
 * preservation on update, and event-list sanitisation. The DB is real.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

vi.mock('#lib/logging/index.js', () => {
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis(),
		fatal: vi.fn(),
		trace: vi.fn()
	};
	return { createChildLogger: () => logger, logger };
});

const { NotificationConnectionStore, NotificationConnectionError } =
	await import('./connections.js');
const { notificationConnections } = await import('#lib/server/db/schema.js');

const store = new NotificationConnectionStore();

beforeEach(() => {
	process.env.BETTER_AUTH_SECRET =
		process.env.BETTER_AUTH_SECRET || 'test-secret-for-notifications';
	clearTestDb(testDb);
});

afterAll(() => {
	destroyTestDb(testDb);
});

const webhookInput = {
	name: 'Home Assistant',
	provider: 'webhook',
	events: ['import'],
	config: {
		url: 'https://example.com/hooks/cinephage',
		method: 'POST',
		authorization: 'Bearer super-secret'
	}
};

describe('NotificationConnectionStore', () => {
	it('creates a connection and encrypts the config at rest', async () => {
		const created = await store.create(webhookInput);

		expect(created.name).toBe('Home Assistant');
		expect(created.provider).toBe('webhook');
		expect(created.events).toEqual(['import']);

		const [row] = await testDb.db.select().from(notificationConnections);
		expect(row.config.startsWith('cphg1.')).toBe(true);
		expect(row.config).not.toContain('super-secret');
	});

	it('never returns a stored secret, only the fact that it exists', async () => {
		const created = await store.create(webhookInput);

		expect(created.config.authorization).toBe('');
		expect(created.configuredSecrets).toEqual(['authorization']);

		const listed = await store.list();
		expect(listed[0].config.authorization).toBe('');
		expect(listed[0].configuredSecrets).toEqual(['authorization']);
	});

	it('keeps the stored secret when an update submits a blank value', async () => {
		const created = await store.create(webhookInput);
		await store.update(created.id, {
			name: 'Home Assistant (renamed)',
			config: { url: 'https://example.com/hooks/cinephage', method: 'POST', authorization: '' }
		});

		const record = await store.getRecord(created.id);
		expect(record?.config.authorization).toBe('Bearer super-secret');
		expect(record?.name).toBe('Home Assistant (renamed)');
	});

	it('replaces the secret when a new value is submitted', async () => {
		const created = await store.create(webhookInput);
		await store.update(created.id, {
			config: {
				url: 'https://example.com/hooks/cinephage',
				method: 'POST',
				authorization: 'Bearer new'
			}
		});

		const record = await store.getRecord(created.id);
		expect(record?.config.authorization).toBe('Bearer new');
	});

	it('rejects a connection that is missing a required field', async () => {
		await expect(
			store.create({ name: 'Broken', provider: 'webhook', events: ['import'], config: {} })
		).rejects.toBeInstanceOf(NotificationConnectionError);
	});

	it('rejects an unknown provider', async () => {
		await expect(
			store.create({ name: 'Nope', provider: 'carrier-pigeon', events: ['import'], config: {} })
		).rejects.toBeInstanceOf(NotificationConnectionError);
	});

	it('sanitises the event list to the known vocabulary', async () => {
		const created = await store.create({
			...webhookInput,
			events: ['import', 'not-a-real-event']
		});
		expect(created.events).toEqual(['import']);

		const fallback = await store.create({ ...webhookInput, name: 'Bogus only', events: ['nope'] });
		expect(fallback.events).not.toContain('nope');
		expect(fallback.events.length).toBeGreaterThan(1);
	});

	it('deletes a connection', async () => {
		const created = await store.create(webhookInput);
		expect(await store.delete(created.id)).toBe(true);
		expect(await store.get(created.id)).toBeNull();
	});

	it('records success and failure state on the row', async () => {
		const created = await store.create(webhookInput);
		await store.recordFailure(created.id, 'boom', new Date(Date.now() + 60_000).toISOString());
		let current = await store.get(created.id);
		expect(current?.consecutiveFailures).toBe(1);
		expect(current?.lastError).toBe('boom');
		expect(current?.disabledUntil).not.toBeNull();

		await store.recordSuccess(created.id);
		current = await store.get(created.id);
		expect(current?.consecutiveFailures).toBe(0);
		expect(current?.lastError).toBeNull();
		expect(current?.lastSuccessAt).not.toBeNull();
	});
});

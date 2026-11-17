/**
 * Delivery fan-out: event filtering, per-connection isolation, the delivery
 * log and the failure backoff. Agents run for real against a loopback HTTP
 * server, so the whole path (registry -> provider -> fetch -> DB) is
 * exercised instead of a stubbed transport.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
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

const { NotificationDeliveryService } = await import('./delivery.js');
const { NotificationConnectionStore } = await import('./connections.js');
const { notificationDeliveries } = await import('#lib/server/db/schema.js');

const store = new NotificationConnectionStore();
const received: Array<{ path: string; body: Record<string, unknown> }> = [];
let server: Server;
let baseUrl = '';

beforeAll(async () => {
	process.env.BETTER_AUTH_SECRET =
		process.env.BETTER_AUTH_SECRET || 'test-secret-for-notifications';
	server = createServer((request, response) => {
		let body = '';
		request.on('data', (chunk) => (body += chunk));
		request.on('end', () => {
			received.push({ path: request.url ?? '', body: body ? JSON.parse(body) : {} });
			response.statusCode = 200;
			response.end('ok');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	destroyTestDb(testDb);
});

beforeEach(() => {
	received.length = 0;
	clearTestDb(testDb);
});

async function deliveriesFor(connectionId: string) {
	return testDb.db
		.select()
		.from(notificationDeliveries)
		.where(eq(notificationDeliveries.connectionId, connectionId));
}

describe('NotificationDeliveryService.publish', () => {
	it('delivers only to connections subscribed to the event', async () => {
		const delivery = new NotificationDeliveryService();
		const importer = await store.create({
			name: 'Importer only',
			provider: 'webhook',
			events: ['import'],
			config: { url: `${baseUrl}/import` }
		});
		const grabber = await store.create({
			name: 'Grab only',
			provider: 'webhook',
			events: ['grab'],
			config: { url: `${baseUrl}/grab` }
		});

		await delivery.publish('import', {
			event: 'import',
			media: { type: 'movie', title: 'Arrival', year: 2016 }
		});

		expect(received).toHaveLength(1);
		expect(received[0].path).toBe('/import');
		expect(received[0].body.event).toBe('import');
		expect(received[0].body.title).toBe('Imported: Arrival (2016)');
		expect(await deliveriesFor(importer.id)).toHaveLength(1);
		expect(await deliveriesFor(grabber.id)).toHaveLength(0);
	});

	it('treats the wildcard subscription as every event', async () => {
		const delivery = new NotificationDeliveryService();
		const all = await store.create({
			name: 'Everything',
			provider: 'webhook',
			events: ['*'],
			config: { url: `${baseUrl}/all` }
		});

		await delivery.publish('grab', { event: 'grab', releaseName: 'Some.Release.1080p' });

		expect(received).toHaveLength(1);
		expect(await deliveriesFor(all.id)).toHaveLength(1);
	});

	it('skips disabled connections and disabled events', async () => {
		const delivery = new NotificationDeliveryService();
		const disabled = await store.create({
			name: 'Off',
			provider: 'webhook',
			enabled: false,
			events: ['*'],
			config: { url: `${baseUrl}/off` }
		});

		await delivery.publish('import', { event: 'import', media: { type: 'movie', title: 'X' } });

		expect(received).toHaveLength(0);
		expect(await deliveriesFor(disabled.id)).toHaveLength(0);
	});

	it('never lets one failing connection block another', async () => {
		const delivery = new NotificationDeliveryService();
		const broken = await store.create({
			name: 'Broken',
			provider: 'webhook',
			events: ['import'],
			config: { url: 'http://127.0.0.1:1/dead' }
		});
		const working = await store.create({
			name: 'Working',
			provider: 'webhook',
			events: ['import'],
			config: { url: `${baseUrl}/ok` }
		});

		await delivery.publish('import', { event: 'import', media: { type: 'movie', title: 'X' } });

		expect(received.map((entry) => entry.path)).toEqual(['/ok']);
		const failed = await deliveriesFor(broken.id);
		const succeeded = await deliveriesFor(working.id);
		expect(failed).toHaveLength(1);
		expect(failed[0].ok).toBe(false);
		expect(succeeded[0].ok).toBe(true);

		const failedConnection = await store.get(broken.id);
		expect(failedConnection?.consecutiveFailures).toBe(1);
		expect(failedConnection?.disabledUntil).not.toBeNull();
	});

	it('backs off instead of hammering a dead endpoint', async () => {
		const delivery = new NotificationDeliveryService();
		const broken = await store.create({
			name: 'Broken',
			provider: 'webhook',
			events: ['import'],
			config: { url: 'http://127.0.0.1:1/dead' }
		});

		await delivery.publish('import', { event: 'import', media: { type: 'movie', title: 'X' } });
		await delivery.publish('import', { event: 'import', media: { type: 'movie', title: 'X' } });

		expect(await deliveriesFor(broken.id)).toHaveLength(1);
	});

	it('resets the failure state after a successful test', async () => {
		const delivery = new NotificationDeliveryService();
		const connection = await store.create({
			name: 'Flaky',
			provider: 'webhook',
			events: ['import'],
			config: { url: 'http://127.0.0.1:1/dead' }
		});

		await delivery.publish('import', { event: 'import', media: { type: 'movie', title: 'X' } });
		expect((await store.get(connection.id))?.consecutiveFailures).toBe(1);

		await store.update(connection.id, { config: { url: `${baseUrl}/fixed` } });
		const result = await delivery.test(connection.id);

		expect(result.ok).toBe(true);
		const healed = await store.get(connection.id);
		expect(healed?.consecutiveFailures).toBe(0);
		expect(healed?.disabledUntil).toBeNull();
	});
});

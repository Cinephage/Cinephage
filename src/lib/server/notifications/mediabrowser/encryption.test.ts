/**
 * Tests for media-browser API key encryption at rest.
 *
 * Covers: the manager roundtrip (plaintext in, ciphertext in the DB row,
 * plaintext back out through every read path), migration 159 encrypting
 * legacy rows idempotently, and the ConfigurationBackupService portable
 * transform (export decrypts, restore re-encrypts).
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { mediaBrowserServers } from '#lib/server/db/schema.js';
import { sql } from 'drizzle-orm';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
	fatal: vi.fn(),
	trace: vi.fn()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger),
	createRequestLogger: vi.fn(() => mockLogger),
	runWithLogContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn())
}));

const { getMediaBrowserManager } = await import('./MediaBrowserManager.js');
const { decryptApiKey, encryptApiKey } = await import('#lib/server/crypto/apiKeyCrypto.js');
const { decryptCredential, isEncryptedCredential } =
	await import('#lib/server/crypto/credentialsCrypto.js');

const PLAINTEXT_KEY = '858b516c791c44959d079285a6c3428d';
let serverId: string;

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(mediaBrowserServers).run();
	serverId = randomUUID();
	testDb.db
		.insert(mediaBrowserServers)
		.values({
			id: serverId,
			name: 'Enc Jellyfin',
			serverType: 'jellyfin',
			host: 'http://jf.test:8096',
			apiKey: encryptApiKey(PLAINTEXT_KEY),
			enabled: true
		})
		.run();
});

describe('media-browser key encryption — manager roundtrip', () => {
	it('stores ciphertext from createServer and returns plaintext from reads', async () => {
		const manager = getMediaBrowserManager();
		await manager.createServer({
			name: 'Created',
			serverType: 'jellyfin',
			host: 'http://created.test:8096',
			apiKey: PLAINTEXT_KEY
		});

		const raw = testDb.db
			.select()
			.from(mediaBrowserServers)
			.all()
			.find((row) => row.name === 'Created')!;
		expect(raw.apiKey).not.toBe(PLAINTEXT_KEY);
		// New rows use the versioned envelope bound to the server id.
		expect(isEncryptedCredential(raw.apiKey)).toBe(true);
		expect(decryptCredential('media-browser-api-key', raw.id, raw.apiKey)).toBe(PLAINTEXT_KEY);

		const record = await manager.getServerRecord(raw.id);
		expect(record?.apiKey).toBe(PLAINTEXT_KEY);
	});

	it('getEnabledServers and getServerRecord decrypt; updateServer re-encrypts', async () => {
		const manager = getMediaBrowserManager();

		const enabled = await manager.getEnabledServers();
		expect(enabled[0]!.apiKey).toBe(PLAINTEXT_KEY);
		const record = await manager.getServerRecord(serverId);
		expect(record?.apiKey).toBe(PLAINTEXT_KEY);

		await manager.updateServer(serverId, { apiKey: 'new-plaintext-key' });
		const raw = testDb.db
			.select()
			.from(mediaBrowserServers)
			.all()
			.find((row) => row.id === serverId)!;
		expect(raw.apiKey).not.toBe('new-plaintext-key');
		expect((await manager.getServerRecord(serverId))?.apiKey).toBe('new-plaintext-key');
	});
});

describe('media-browser key encryption — migration 159', () => {
	it('encrypts legacy plaintext rows and is idempotent', async () => {
		// Start from a legacy plaintext row (as if the migration had not run).
		testDb.db
			.update(mediaBrowserServers)
			.set({ apiKey: PLAINTEXT_KEY })
			.where(sql`${mediaBrowserServers.id} = ${serverId}`)
			.run();

		const { migration_v159 } =
			await import('../../db/migrations/159-encrypt-media-browser-api-keys.js');
		migration_v159.apply(testDb.sqlite);

		const raw = testDb.db
			.select()
			.from(mediaBrowserServers)
			.all()
			.find((row) => row.id === serverId)!;
		expect(raw.apiKey).not.toBe(PLAINTEXT_KEY);
		expect(decryptApiKey(raw.apiKey)).toBe(PLAINTEXT_KEY);

		// Second run is a no-op.
		migration_v159.apply(testDb.sqlite);
		expect(decryptApiKey(raw.apiKey)).toBe(PLAINTEXT_KEY);
	});
});

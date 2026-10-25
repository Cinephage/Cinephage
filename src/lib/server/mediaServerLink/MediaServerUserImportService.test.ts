/**
 * Tests for the media server user import service.
 *
 * Server HTTP is mocked at the fetch boundary (the /Users roster); the
 * database is real so uniqueness and link writes are exercised for truth.
 * Account creation is exercised through an injected fake creator — the
 * endpoint binds it to auth.api.createUser, whose policy hooks are covered
 * by the auth instance tests.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import { mediaBrowserServers, user, userMediaServerLinks } from '#lib/server/db/schema.js';
import { createTestUser } from '../../../test/fixtures/auth.js';

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

// The manager reads through the same db mock; hand back server records.
vi.mock('#lib/server/notifications/mediabrowser/MediaBrowserManager.js', () => ({
	getMediaBrowserManager: () => ({
		async getServers() {
			return testDb.db.select().from(mediaBrowserServers).all();
		},
		async getServerRecord(id: string) {
			return (
				testDb.db
					.select()
					.from(mediaBrowserServers)
					.all()
					.find((row) => row.id === id) ?? null
			);
		}
	})
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { mediaServerUserImportService } = await import('./MediaServerUserImportService.js');

const SERVER_ID = randomUUID();
const SERVER_NAME = 'Main Jellyfin';
let adminUserId: string;
let viewerUserId: string;

function serverJson(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

function mockRoster(
	users: Array<{ Id: string; Name: string; Policy?: Record<string, unknown> }>
): void {
	fetchMock.mockImplementation(async (url) => {
		if (String(url).endsWith('/Users')) {
			return serverJson(200, users);
		}
		throw new Error('unexpected call ' + String(url));
	});
}

function fakeCreator(options?: { throwFor?: (username: string) => Error | undefined }) {
	const calls: Array<{ username: string; email: string; password: string }> = [];
	const creator = async (input: { username: string; email: string; password: string }) => {
		const failure = options?.throwFor?.(input.username);
		if (failure) throw failure;
		calls.push(input);
		// Stand in for auth.api.createUser: a real local row whose id the
		// link insert can reference.
		const userId = randomUUID();
		testDb.db
			.insert(user)
			.values(createTestUser({ id: userId, username: input.username, email: input.email }))
			.run();
		return { userId };
	};
	return { creator, calls };
}

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(userMediaServerLinks).run();
	testDb.db.delete(user).run();
	testDb.db.delete(mediaBrowserServers).run();
	fetchMock.mockReset();

	adminUserId = randomUUID();
	viewerUserId = randomUUID();
	testDb.db
		.insert(user)
		.values([
			createTestUser({ id: adminUserId, username: 'admin', email: 'admin@test.local' }),
			createTestUser({ id: viewerUserId, username: 'viewer', email: 'viewer@test.local' })
		])
		.run();

	testDb.db
		.insert(mediaBrowserServers)
		.values({
			id: SERVER_ID,
			name: SERVER_NAME,
			serverType: 'jellyfin',
			host: 'http://jellyfin.test:8096',
			apiKey: 'jf-admin-key',
			enabled: true
		})
		.run();
});

describe('mediaServerUserImportService — previewImport', () => {
	it('classifies every roster entry against local links and accounts', async () => {
		testDb.db
			.insert(user)
			.values(createTestUser({ username: 'someone', email: 'emailhit@main-jellyfin.users.local' }))
			.run();
		testDb.db
			.insert(userMediaServerLinks)
			.values({
				userId: viewerUserId,
				serverId: SERVER_ID,
				serverUserId: 'jf-linked',
				serverUsername: 'LinkedUser'
			})
			.run();

		mockRoster([
			{ Id: 'jf-clean', Name: 'CleanUser' },
			{ Id: 'jf-flags', Name: 'FlagUser', Policy: { IsAdministrator: true } },
			{ Id: 'jf-linked', Name: 'LinkedUser' },
			{ Id: 'jf-disabled', Name: 'DisabledUser', Policy: { IsDisabled: true } },
			{ Id: 'jf-invalid', Name: 'Has Space' },
			{ Id: 'jf-reserved', Name: 'root' },
			{ Id: 'jf-taken', Name: 'admin' },
			{ Id: 'jf-shout', Name: 'VIEWER' },
			{ Id: 'jf-email', Name: 'EmailHit' }
		]);

		const preview = await mediaServerUserImportService.previewImport(SERVER_ID);
		expect(preview.outcome).toBe('ok');
		if (preview.outcome !== 'ok') return;

		const byId = new Map(preview.users.map((candidate) => [candidate.id, candidate]));
		expect(byId.get('jf-clean')?.status).toBe('importable');
		expect(byId.get('jf-flags')?.status).toBe('importable');
		expect(byId.get('jf-flags')?.isAdministrator).toBe(true);
		expect(byId.get('jf-linked')).toMatchObject({ status: 'linked', linkedTo: 'viewer' });
		expect(byId.get('jf-disabled')?.status).toBe('disabled');
		expect(byId.get('jf-invalid')?.status).toBe('invalid-username');
		expect(byId.get('jf-reserved')?.status).toBe('invalid-username');
		expect(byId.get('jf-taken')?.status).toBe('username-taken');
		// Username collisions are case-insensitive even though SQLite's
		// unique index is not.
		expect(byId.get('jf-shout')?.status).toBe('username-taken');
		expect(byId.get('jf-email')?.status).toBe('email-taken');
		// Placeholder emails derive from the server's name.
		expect(byId.get('jf-clean')?.suggestedEmail).toBe('cleanuser@main-jellyfin.users.local');
	});

	it('returns no-server for unknown or non-jellyfin servers', async () => {
		const unknown = await mediaServerUserImportService.previewImport(randomUUID());
		expect(unknown.outcome).toBe('no-server');

		const embyId = randomUUID();
		testDb.db
			.insert(mediaBrowserServers)
			.values({
				id: embyId,
				name: 'Emby',
				serverType: 'emby',
				host: 'http://emby.test:8096',
				apiKey: 'emby-key',
				enabled: true
			})
			.run();
		const emby = await mediaServerUserImportService.previewImport(embyId);
		expect(emby.outcome).toBe('no-server');
	});

	it('returns server-error when the roster fetch fails', async () => {
		fetchMock.mockImplementation(async () => serverJson(500, {}));
		const preview = await mediaServerUserImportService.previewImport(SERVER_ID);
		expect(preview.outcome).toBe('server-error');
	});
});

describe('mediaServerUserImportService — importUsers', () => {
	it('creates, links, and reports a one-time temp password per user', async () => {
		mockRoster([
			{ Id: 'jf-a', Name: 'Alice' },
			{ Id: 'jf-b', Name: 'Bob' }
		]);
		const { creator, calls } = fakeCreator();

		const result = await mediaServerUserImportService.importUsers({
			serverId: SERVER_ID,
			serverUserIds: ['jf-a', 'jf-b'],
			createUser: creator
		});

		expect(result.outcome).toBe('ok');
		if (result.outcome !== 'ok') return;
		expect(result.results).toHaveLength(2);
		for (const row of result.results) {
			expect(row.status).toBe('created');
			expect(row.linked).toBe(true);
			expect(row.tempPassword).toMatch(
				/^[abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/
			);
		}
		expect(new Set(result.results.map((row) => row.tempPassword)).size).toBe(2);
		expect(result.results[0]).toMatchObject({
			username: 'Alice',
			email: 'alice@main-jellyfin.users.local',
			userId: result.results[0]?.userId ?? null
		});

		// The roster is fetched once for the whole batch.
		expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/Users'))).toHaveLength(
			1
		);
		expect(calls).toHaveLength(2);

		const created = testDb.db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === 'Alice');
		expect(created?.email).toBe('alice@main-jellyfin.users.local');
		const links = testDb.db.select().from(userMediaServerLinks).all();
		expect(links).toHaveLength(2);
		expect(links.find((row) => row.serverUserId === 'jf-a')).toMatchObject({
			userId: created?.id,
			serverUsername: 'Alice'
		});
	});

	it('deduplicates repeated ids within one batch', async () => {
		mockRoster([{ Id: 'jf-a', Name: 'Alice' }]);
		const { creator, calls } = fakeCreator();

		const result = await mediaServerUserImportService.importUsers({
			serverId: SERVER_ID,
			serverUserIds: ['jf-a', 'jf-a'],
			createUser: creator
		});

		expect(result.outcome).toBe('ok');
		if (result.outcome !== 'ok') return;
		expect(result.results).toHaveLength(1);
		expect(calls).toHaveLength(1);
	});

	it('fails unknown server users without calling the creator', async () => {
		mockRoster([{ Id: 'jf-a', Name: 'Alice' }]);
		const { creator, calls } = fakeCreator();

		const result = await mediaServerUserImportService.importUsers({
			serverId: SERVER_ID,
			serverUserIds: ['jf-missing'],
			createUser: creator
		});

		expect(result.outcome).toBe('ok');
		if (result.outcome !== 'ok') return;
		expect(result.results[0]).toMatchObject({ status: 'failed', linked: false });
		expect(result.results[0]?.error).toContain('Unknown server user');
		expect(calls).toHaveLength(0);
	});

	it('re-validates selections against fresh local state', async () => {
		// 'Alice' already exists locally; the preview that offered her is stale.
		testDb.db
			.insert(user)
			.values(createTestUser({ username: 'alice', email: 'alice@elsewhere.local' }))
			.run();
		mockRoster([{ Id: 'jf-a', Name: 'Alice' }]);
		const { creator, calls } = fakeCreator();

		const result = await mediaServerUserImportService.importUsers({
			serverId: SERVER_ID,
			serverUserIds: ['jf-a'],
			createUser: creator
		});

		expect(result.outcome).toBe('ok');
		if (result.outcome !== 'ok') return;
		expect(result.results[0]?.status).toBe('failed');
		expect(result.results[0]?.tempPassword).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('keeps the account when a raced link insert hits a conflict', async () => {
		mockRoster([{ Id: 'jf-a', Name: 'Alice' }]);

		// Simulate the race: another admin links this server account to a
		// different local user after validation but before our insert.
		const creator = async (input: { username: string }) => {
			testDb.db
				.insert(userMediaServerLinks)
				.values({
					userId: viewerUserId,
					serverId: SERVER_ID,
					serverUserId: 'jf-a',
					serverUsername: 'Alice'
				})
				.run();
			return { userId: `new-${input.username.toLowerCase()}` };
		};

		const result = await mediaServerUserImportService.importUsers({
			serverId: SERVER_ID,
			serverUserIds: ['jf-a'],
			createUser: creator
		});

		expect(result.outcome).toBe('ok');
		if (result.outcome !== 'ok') return;
		const row = result.results[0]!;
		expect(row.status).toBe('created');
		expect(row.linked).toBe(false);
		expect(row.error).toContain('conflict');

		// The pre-existing link was not stolen.
		const links = testDb.db.select().from(userMediaServerLinks).all();
		expect(links).toHaveLength(1);
		expect(links[0]!.userId).toBe(viewerUserId);
	});

	it('reports creator failures per row without writing a link', async () => {
		mockRoster([
			{ Id: 'jf-a', Name: 'Alice' },
			{ Id: 'jf-b', Name: 'Bob' }
		]);
		const { creator } = fakeCreator({
			throwFor: (username) => (username === 'Alice' ? new Error('User already exists') : undefined)
		});

		const result = await mediaServerUserImportService.importUsers({
			serverId: SERVER_ID,
			serverUserIds: ['jf-a', 'jf-b'],
			createUser: creator
		});

		expect(result.outcome).toBe('ok');
		if (result.outcome !== 'ok') return;
		const alice = result.results.find((row) => row.serverUserId === 'jf-a')!;
		const bob = result.results.find((row) => row.serverUserId === 'jf-b')!;
		expect(alice).toMatchObject({ status: 'failed', error: 'User already exists' });
		expect(bob.status).toBe('created');
		expect(testDb.db.select().from(userMediaServerLinks).all()).toHaveLength(1);
	});

	it('propagates no-server and server-error outcomes', async () => {
		const unknown = await mediaServerUserImportService.importUsers({
			serverId: randomUUID(),
			serverUserIds: ['jf-a'],
			createUser: fakeCreator().creator
		});
		expect(unknown.outcome).toBe('no-server');

		fetchMock.mockImplementation(async () => serverJson(502, {}));
		const failing = await mediaServerUserImportService.importUsers({
			serverId: SERVER_ID,
			serverUserIds: ['jf-a'],
			createUser: fakeCreator().creator
		});
		expect(failing.outcome).toBe('server-error');
	});
});

/**
 * Tests for the media-server linking service.
 *
 * Jellyfin HTTP is mocked at the fetch boundary; the database is real so
 * the uniqueness/scoping rules (one link per server user, per account) are
 * exercised for truth. Proves the security invariants: pairing secrets
 * stay in-process, the access token from the exchange is discarded, and
 * conflicts are refused.
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

const { mediaServerLinkService } = await import('./MediaServerLinkService.js');

const SERVER_ID = randomUUID();
let adminUserId: string;
let viewerUserId: string;

function jellyfinJson(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
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
			name: 'Main Jellyfin',
			serverType: 'jellyfin',
			host: 'http://jellyfin.test:8096',
			apiKey: 'jf-admin-key',
			enabled: true
		})
		.run();
});

describe('mediaServerLinkService - Quick Connect pairing', () => {
	it('initiates pairing, returns only the code, and stores the secret internally', async () => {
		fetchMock.mockImplementation(async (_url, init) => {
			if (String(_url).endsWith('/QuickConnect/Enabled')) {
				return jellyfinJson(200, true);
			}
			if (String(_url).endsWith('/QuickConnect/Initiate') && init?.method === 'POST') {
				return jellyfinJson(200, { Secret: 'top-secret', Code: '123456' });
			}
			throw new Error('unexpected call ' + String(_url));
		});

		const result = await mediaServerLinkService.initiatePairing(viewerUserId, SERVER_ID);
		expect(result.outcome).toBe('initiated');
		if (result.outcome !== 'initiated') return;
		expect(result.code).toBe('123456');

		// No link written yet.
		expect(testDb.db.select().from(userMediaServerLinks).all()).toHaveLength(0);
	});

	it('exchanges the secret on authorization, stores identity only, discards the token', async () => {
		fetchMock.mockImplementation(async (url) => {
			const path = String(url).replace(/^https?:\/\/[^/]+/, '');
			if (path.startsWith('/QuickConnect/Enabled')) return jellyfinJson(200, true);
			if (path.startsWith('/QuickConnect/Initiate')) {
				return jellyfinJson(200, { Secret: 'top-secret', Code: '654321' });
			}
			if (path.startsWith('/QuickConnect/Connect')) {
				return jellyfinJson(200, { Authenticated: true, Secret: 'top-secret' });
			}
			if (path.startsWith('/Users/AuthenticateWithQuickConnect')) {
				return jellyfinJson(200, {
					User: { Id: 'jf-user-1', Name: 'Eric' },
					AccessToken: 'jf-access-token'
				});
			}
			throw new Error('unexpected call ' + path);
		});

		await mediaServerLinkService.initiatePairing(viewerUserId, SERVER_ID);
		const result = await mediaServerLinkService.checkPairing(viewerUserId, SERVER_ID);

		expect(result.outcome).toBe('linked');
		if (result.outcome !== 'linked') return;
		expect(result.link.serverUserId).toBe('jf-user-1');
		expect(result.link.serverUsername).toBe('Eric');

		// The stored link carries no token material.
		const row = testDb.db.select().from(userMediaServerLinks).all()[0]!;
		expect(row.serverUserId).toBe('jf-user-1');
		expect(JSON.stringify(row)).not.toContain('jf-access-token');
		expect(JSON.stringify(row)).not.toContain('top-secret');
	});

	it('refuses a second user linking the same Jellyfin account', async () => {
		fetchMock.mockImplementation(async (url) => {
			const path = String(url).replace(/^https?:\/\/[^/]+/, '');
			if (path.startsWith('/QuickConnect/Enabled')) return jellyfinJson(200, true);
			if (path.startsWith('/QuickConnect/Initiate')) {
				return jellyfinJson(200, { Secret: 's-' + Math.random(), Code: '111111' });
			}
			if (path.startsWith('/QuickConnect/Connect')) {
				return jellyfinJson(200, { Authenticated: true });
			}
			if (path.startsWith('/Users/AuthenticateWithQuickConnect')) {
				return jellyfinJson(200, { User: { Id: 'jf-dup', Name: 'Dup' } });
			}
			throw new Error('unexpected call ' + path);
		});

		await mediaServerLinkService.initiatePairing(viewerUserId, SERVER_ID);
		const first = await mediaServerLinkService.checkPairing(viewerUserId, SERVER_ID);
		expect(first.outcome).toBe('linked');

		await mediaServerLinkService.initiatePairing(adminUserId, SERVER_ID);
		const second = await mediaServerLinkService.checkPairing(adminUserId, SERVER_ID);
		expect(second.outcome).toBe('conflict');
		expect(
			testDb.db
				.select()
				.from(userMediaServerLinks)
				.all()
				.filter((row) => row.serverUserId === 'jf-dup')
		).toHaveLength(1);
	});

	it('reports pending until Jellyfin marks the code authorized', async () => {
		fetchMock.mockImplementation(async (url) => {
			const path = String(url).replace(/^https?:\/\/[^/]+/, '');
			if (path.startsWith('/QuickConnect/Enabled')) return jellyfinJson(200, true);
			if (path.startsWith('/QuickConnect/Initiate')) {
				return jellyfinJson(200, { Secret: 's2', Code: '222222' });
			}
			if (path.startsWith('/QuickConnect/Connect')) {
				return jellyfinJson(200, { Authenticated: false });
			}
			throw new Error('unexpected call ' + path);
		});

		await mediaServerLinkService.initiatePairing(viewerUserId, SERVER_ID);
		const result = await mediaServerLinkService.checkPairing(viewerUserId, SERVER_ID);
		expect(result.outcome).toBe('pending');
		expect(testDb.db.select().from(userMediaServerLinks).all()).toHaveLength(0);
	});

	it('reports quick-connect-disabled without initiating', async () => {
		fetchMock.mockImplementation(async (url) => {
			if (String(url).endsWith('/QuickConnect/Enabled')) return jellyfinJson(200, false);
			throw new Error('unexpected call ' + String(url));
		});

		const result = await mediaServerLinkService.initiatePairing(viewerUserId, SERVER_ID);
		expect(result.outcome).toBe('quick-connect-disabled');
		expect(
			fetchMock.mock.calls.filter((call) => String(call[0]).includes('Initiate'))
		).toHaveLength(0);
	});
});

describe('mediaServerLinkService - admin-mediated linking', () => {
	it('links an existing server user to the account', async () => {
		fetchMock.mockImplementation(async (url) => {
			if (String(url).endsWith('/Users')) {
				return jellyfinJson(200, [
					{ Id: 'jf-a', Name: 'Alpha', Policy: { IsAdministrator: true } },
					{ Id: 'jf-b', Name: 'Beta', Policy: { IsAdministrator: false } }
				]);
			}
			throw new Error('unexpected call ' + String(url));
		});

		const result = await mediaServerLinkService.adminLink(viewerUserId, SERVER_ID, 'jf-b');
		expect(result.outcome).toBe('linked');
		if (result.outcome === 'linked') {
			expect(result.link.serverUsername).toBe('Beta');
		}
	});

	it('refuses unknown server user ids', async () => {
		fetchMock.mockImplementation(async (url) => {
			if (String(url).endsWith('/Users')) return jellyfinJson(200, [{ Id: 'jf-a', Name: 'Alpha' }]);
			throw new Error('unexpected call ' + String(url));
		});

		const result = await mediaServerLinkService.adminLink(viewerUserId, SERVER_ID, 'jf-missing');
		expect(result.outcome).toBe('unknown-server-user');
	});
});

describe('mediaServerLinkService - unlink', () => {
	it('removes only the caller own link', async () => {
		fetchMock.mockImplementation(async (url) => {
			if (String(url).endsWith('/Users')) return jellyfinJson(200, [{ Id: 'jf-a', Name: 'Alpha' }]);
			throw new Error('unexpected call ' + String(url));
		});

		await mediaServerLinkService.adminLink(viewerUserId, SERVER_ID, 'jf-a');

		// Give the admin a link via direct insert for the scoping check.
		testDb.db
			.insert(userMediaServerLinks)
			.values({
				userId: adminUserId,
				serverId: SERVER_ID,
				serverUserId: 'jf-admin-direct',
				serverUsername: 'AdminDirect'
			})
			.run();

		expect(await mediaServerLinkService.unlink(viewerUserId, SERVER_ID)).toBe(true);
		const remaining = testDb.db.select().from(userMediaServerLinks).all();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.userId).toBe(adminUserId);
		expect(await mediaServerLinkService.unlink(viewerUserId, SERVER_ID)).toBe(false);
	});
});

describe('mediaServerLinkService - Plex account linking', () => {
	const PLEX_ID = randomUUID();
	const FRIEND = { id: '200', username: 'friend', title: 'friend', email: 'friend@example.com' };

	function setupPlex(options: { shared: boolean; signIn?: boolean }): void {
		testDb.db
			.insert(mediaBrowserServers)
			.values({
				id: PLEX_ID,
				name: 'Home Plex',
				serverType: 'plex',
				host: 'http://plex.test:32400',
				apiKey: 'plex-owner-token',
				enabled: true,
				plexSignIn: options.signIn ?? true
			})
			.run();

		fetchMock.mockImplementation(async (url) => {
			const target = String(url);
			if (target === 'http://plex.test:32400/') {
				return new Response('<MediaContainer machineIdentifier="m1" myPlexUsername="owner"/>');
			}
			if (target === 'https://plex.tv/api/v2/user') {
				return jellyfinJson(200, { id: 1, username: 'owner' });
			}
			if (target === 'https://plex.tv/api/users') {
				const machine = options.shared ? 'm1' : 'other';
				return new Response(
					`<MediaContainer><User id="200" title="friend" username="friend" home="0"><Server machineIdentifier="${machine}" pending="0"/></User></MediaContainer>`
				);
			}
			throw new Error('unexpected call ' + target);
		});
	}

	it('links the Plex account on every server it can reach', async () => {
		setupPlex({ shared: true });
		const result = await mediaServerLinkService.linkPlexAccount(viewerUserId, FRIEND);
		expect(result.outcome).toBe('linked');
		const links = await mediaServerLinkService.getLinks(viewerUserId);
		expect(links).toMatchObject([
			{ serverId: PLEX_ID, serverType: 'plex', serverUserId: '200', serverUsername: 'friend' }
		]);
	});

	it('ignores Plex servers that have not opted into Plex sign-in', async () => {
		setupPlex({ shared: true, signIn: false });
		expect(await mediaServerLinkService.hasPlexSignInServer()).toBe(false);
		const result = await mediaServerLinkService.linkPlexAccount(viewerUserId, FRIEND);
		expect(result.outcome).toBe('no-access');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses a Plex account the server is not shared with', async () => {
		setupPlex({ shared: false });
		const result = await mediaServerLinkService.linkPlexAccount(viewerUserId, FRIEND);
		expect(result.outcome).toBe('no-access');
		expect(await mediaServerLinkService.getLinks(viewerUserId)).toEqual([]);
	});

	it('refuses to move a Plex account already linked to someone else', async () => {
		setupPlex({ shared: true });
		await mediaServerLinkService.linkPlexAccount(adminUserId, FRIEND);
		const result = await mediaServerLinkService.linkPlexAccount(viewerUserId, FRIEND);
		expect(result.outcome).toBe('conflict');
	});

	it('refuses to silently swap a different Plex account onto an existing link', async () => {
		setupPlex({ shared: true });
		testDb.db
			.insert(userMediaServerLinks)
			.values({
				userId: viewerUserId,
				serverId: PLEX_ID,
				serverUserId: '999',
				serverUsername: 'old'
			})
			.run();
		const result = await mediaServerLinkService.linkPlexAccount(viewerUserId, FRIEND);
		expect(result.outcome).toBe('conflict');
	});
});

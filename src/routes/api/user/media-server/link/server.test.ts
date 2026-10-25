/**
 * Isolated tests for /api/user/media-server/link.
 *
 * Proves the self-scoping (rows touched only for locals.user), the viewer
 * gate reachability contract, and the admin guard on the per-user admin
 * endpoint. The service layer is mocked; its own suite covers Jellyfin
 * interactions and uniqueness rules.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper';
import { user, userMediaServerLinks, mediaBrowserServers } from '#lib/server/db/schema.js';
import { callHandler } from '../../../../../test/api-helper';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis()
	},
	createChildLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	})),
	createRequestLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	})),
	runWithLogContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn())
}));

// Manager used by getLinkableServers via the service; stubbed at the service
// boundary instead so these tests focus on the HTTP contract.
const serviceMock = vi.hoisted(() => ({
	getLinks: vi.fn(async () => [] as unknown[]),
	getLinkableServers: vi.fn(async () => []),
	initiatePairing: vi.fn(),
	checkPairing: vi.fn(),
	unlink: vi.fn(async () => true),
	adminLink: vi.fn(),
	listServerUsers: vi.fn(async () => [])
}));

vi.mock('#lib/server/mediaServerLink/MediaServerLinkService.js', () => ({
	mediaServerLinkService: serviceMock
}));

const { GET, POST, PUT, DELETE } = await import('./+server.js');
const adminRoute = await import('../../../settings/users/[userId]/media-server-link/+server.js');

const OPTIONS = { auth: 'user' as const, url: 'http://localhost/api/user/media-server/link' };

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(userMediaServerLinks).run();
	testDb.db.delete(mediaBrowserServers).run();
	testDb.db.delete(user).run();
	serviceMock.getLinks.mockReset().mockResolvedValue([]);
	serviceMock.getLinkableServers.mockReset().mockResolvedValue([]);
	serviceMock.unlink.mockReset().mockResolvedValue(true);
});

describe('GET /api/user/media-server/link', () => {
	it('serves links and servers for the caller', async () => {
		serviceMock.getLinks.mockResolvedValue([
			{
				serverId: 's1',
				serverName: 'JF',
				serverType: 'jellyfin',
				serverUserId: 'u',
				serverUsername: 'n',
				linkedAt: null
			}
		]);
		const { status, data } = await callHandler<{ links: unknown[] }>(
			GET,
			'GET',
			undefined,
			OPTIONS
		);
		expect(status).toBe(200);
		expect(data.links).toHaveLength(1);
		expect(serviceMock.getLinks).toHaveBeenCalledWith('test-user-user');
	});

	it('rejects unauthenticated callers', async () => {
		const { status } = await callHandler(GET, 'GET', undefined, { url: OPTIONS.url });
		expect(status).toBe(401);
	});
});

describe('POST/PUT /api/user/media-server/link', () => {
	it('surfaces the pairing code from the service', async () => {
		serviceMock.initiatePairing.mockResolvedValue({
			outcome: 'initiated',
			code: '123456',
			expiresAt: Date.now() + 60000
		});
		const { status, data } = await callHandler<{ code?: string }>(
			POST,
			'POST',
			{ serverId: 's1' },
			OPTIONS
		);
		expect(status).toBe(200);
		expect(data.code).toBe('123456');
		expect(serviceMock.initiatePairing).toHaveBeenCalledWith('test-user-user', 's1');
	});

	it('maps already-linked to 409 and disabled to 503', async () => {
		serviceMock.initiatePairing.mockResolvedValue({ outcome: 'already-linked', link: {} });
		expect((await callHandler(POST, 'POST', { serverId: 's1' }, OPTIONS)).status).toBe(409);

		serviceMock.initiatePairing.mockResolvedValue({ outcome: 'quick-connect-disabled' });
		expect((await callHandler(POST, 'POST', { serverId: 's1' }, OPTIONS)).status).toBe(503);
	});

	it('rejects a body without serverId', async () => {
		const { status } = await callHandler(POST, 'POST', {}, OPTIONS);
		expect(status).toBe(400);
	});

	it('poll endpoint returns outcome only, never a secret', async () => {
		serviceMock.checkPairing.mockResolvedValue({ outcome: 'pending' });
		const { status, data } = await callHandler(PUT, 'PUT', { serverId: 's1' }, OPTIONS);
		expect(status).toBe(200);
		expect(JSON.stringify(data)).not.toContain('secret');
	});
});

describe('DELETE /api/user/media-server/link', () => {
	it('unlinks only with the caller identity and requires serverId', async () => {
		const missing = await callHandler(DELETE, 'DELETE', undefined, OPTIONS);
		expect(missing.status).toBe(400);

		const ok = await callHandler(DELETE, 'DELETE', undefined, {
			...OPTIONS,
			url: 'http://localhost/api/user/media-server/link?serverId=s1'
		});
		expect(ok.status).toBe(200);
		expect(serviceMock.unlink).toHaveBeenCalledWith('test-user-user', 's1');
	});
});

describe('admin route /api/settings/users/[userId]/media-server-link', () => {
	const ADMIN_ID = 'test-admin-user';

	it('rejects viewer sessions', async () => {
		const { status } = await callHandler(
			adminRoute.POST,
			'POST',
			{ serverId: 's1', serverUserId: 'u' },
			{
				auth: 'user',
				url: 'http://localhost/api/settings/users/x/media-server-link',
				params: { userId: ADMIN_ID }
			}
		);
		expect(status).toBe(403);
	});

	it('links via the service for admin sessions', async () => {
		serviceMock.adminLink.mockResolvedValue({
			outcome: 'linked',
			link: { serverId: 's1', serverUserId: 'u', serverUsername: 'Eric' }
		});
		const { status } = await callHandler(
			adminRoute.POST,
			'POST',
			{ serverId: 's1', serverUserId: 'u' },
			{
				auth: 'admin',
				url: 'http://localhost/api/settings/users/x/media-server-link',
				params: { userId: ADMIN_ID }
			}
		);
		expect(status).toBe(200);
		expect(serviceMock.adminLink).toHaveBeenCalledWith(ADMIN_ID, 's1', 'u');
	});
});

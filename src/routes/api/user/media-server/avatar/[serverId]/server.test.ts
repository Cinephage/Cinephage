/**
 * Isolated tests for the avatar proxy routes.
 *
 * The self route serves only the caller's own linked avatar; the admin
 * route serves any account but is admin-gated. The service is mocked —
 * its own suite covers the Jellyfin fetch.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../../test/db-helper';
import { user } from '#lib/server/db/schema.js';
import { callHandlerRaw } from '../../../../../../test/api-helper';

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

const fetchAvatarMock = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/mediaServerLink/MediaServerLinkService.js', () => ({
	mediaServerLinkService: { fetchAvatar: fetchAvatarMock }
}));

const { GET: selfGet } = await import('./+server.js');
const { GET: adminGet } =
	await import('../../../../settings/users/[userId]/media-server/avatar/[serverId]/+server.js');

const AVATAR = { body: new ArrayBuffer(8), contentType: 'image/png' };

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(user).run();
	fetchAvatarMock.mockReset();
});

describe('GET /api/user/media-server/avatar/[serverId]', () => {
	it('serves the caller own avatar with cache headers', async () => {
		fetchAvatarMock.mockResolvedValue(AVATAR);
		const { status, response } = await callHandlerRaw(selfGet, 'GET', undefined, {
			auth: 'user',
			url: 'http://localhost/api/user/media-server/avatar/s1',
			params: { serverId: 's1' }
		});
		expect(status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('cache-control')).toContain('max-age=86400');
		expect(fetchAvatarMock).toHaveBeenCalledWith('test-user-user', 's1');
	});

	it('404s when unlinked and 401s when anonymous', async () => {
		fetchAvatarMock.mockResolvedValue(null);
		expect(
			(
				await callHandlerRaw(selfGet, 'GET', undefined, {
					auth: 'user',
					url: 'http://localhost/api/user/media-server/avatar/s1',
					params: { serverId: 's1' }
				})
			).status
		).toBe(404);
		expect(
			(
				await callHandlerRaw(selfGet, 'GET', undefined, {
					url: 'http://localhost/api/user/media-server/avatar/s1',
					params: { serverId: 's1' }
				})
			).status
		).toBe(401);
	});
});

describe('GET /api/settings/users/[userId]/media-server/avatar/[serverId]', () => {
	it('serves any account avatar for admins, 403 for viewers', async () => {
		fetchAvatarMock.mockResolvedValue(AVATAR);
		const ok = await callHandlerRaw(adminGet, 'GET', undefined, {
			auth: 'admin',
			url: 'http://localhost/api/settings/users/u1/media-server/avatar/s1',
			params: { userId: 'u1', serverId: 's1' }
		});
		expect(ok.status).toBe(200);
		expect(fetchAvatarMock).toHaveBeenCalledWith('u1', 's1');

		const forbidden = await callHandlerRaw(adminGet, 'GET', undefined, {
			auth: 'user',
			url: 'http://localhost/api/settings/users/u1/media-server/avatar/s1',
			params: { userId: 'u1', serverId: 's1' }
		});
		expect(forbidden.status).toBe(403);
	});
});

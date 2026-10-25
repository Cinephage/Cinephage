/**
 * The series detail page's anime provider-ref lookup moved out of the page
 * load and into this dedicated endpoint, called client-side after the page
 * has already rendered, so a slow/rate-limited AniList/MAL upstream never
 * delays first paint (see +page.server.ts for the full rationale).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../../test/db-helper';
import { series, rootFolders } from '#lib/server/db/schema.js';

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

const buildMetadataProviderRegistryMock = vi.fn();
vi.mock('#lib/server/metadata/provider-registry.js', () => ({
	buildMetadataProviderRegistry: buildMetadataProviderRegistryMock
}));

const { GET } = await import('./+server');
const { api } = await import('../../../../../../test/api-helper');
const { eq } = await import('drizzle-orm');

beforeEach(() => {
	buildMetadataProviderRegistryMock.mockReset();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('GET /api/library/series/[id]/anime-refs', () => {
	it('resolves and persists a new anime provider ref', async () => {
		const seriesId = randomUUID();
		const rootFolderId = randomUUID();
		await testDb.db.insert(rootFolders).values({
			id: rootFolderId,
			name: 'Anime',
			path: '/data/Anime',
			mediaType: 'tv'
		});
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 1,
			title: 'Solo Leveling',
			year: 2024,
			seriesType: 'anime',
			rootFolderId,
			path: 'Solo Leveling (2024)'
		});

		buildMetadataProviderRegistryMock.mockResolvedValue({
			providers: new Map([
				[
					'mal',
					{
						isConfigured: () => true,
						searchTitle: vi.fn().mockResolvedValue([
							{
								id: '52299',
								title: 'Solo Leveling',
								year: 2024,
								mediaType: 'anime',
								provider: 'mal'
							}
						])
					}
				]
			])
		});

		const { status, data } = await api.get(GET, { params: { id: seriesId } });
		const payload = data as { providerRefs: Record<string, string> };

		expect(status).toBe(200);
		expect(payload.providerRefs.mal).toBe('52299');

		const [row] = await testDb.db.select().from(series).where(eq(series.id, seriesId));
		expect((row.providerRefs as Record<string, string> | null)?.mal).toBe('52299');
	});

	it('returns 404 for a missing series', async () => {
		const { status, data } = await api.get(GET, { params: { id: randomUUID() } });

		expect(status).toBe(404);
		expect((data as { success: boolean }).success).toBe(false);
	});
});

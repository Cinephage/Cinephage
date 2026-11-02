import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';

import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { indexers as indexersTable } from '#lib/server/db/schema.js';

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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

const { IndexerManager } = await import('./IndexerManager.js');
import { indexerUpdateSchema } from '#lib/validation/schemas.js';

type IndexerRow = typeof indexersTable.$inferInsert;

function seedIndexer(overrides: Partial<IndexerRow> = {}): string {
	const id = (overrides.id as string) ?? randomUUID();
	const now = new Date().toISOString();
	testDb.db
		.insert(indexersTable)
		.values({
			id,
			name: 'Test Indexer',
			definitionId: 'test-definition',
			enabled: true,
			isBuiltIn: false,
			baseUrl: 'https://example.test',
			priority: 5,
			enableAutomaticSearch: true,
			enableInteractiveSearch: true,
			protocolSettings: {
				minimumSeeders: 10,
				seedRatio: '2.0',
				seedTime: 120,
				packSeedTime: 240,
				rejectDeadTorrents: false
			},
			createdAt: now,
			updatedAt: now,
			...overrides
		})
		.run();
	return id;
}

// Replicates the field mapping in routes/api/indexers/[id]/+server.ts PUT, so
// these tests exercise the same parse -> map -> updateIndexer seam that
// produced the partial-update wipe bug.
type IndexerUpdateParsed = z.output<typeof indexerUpdateSchema>;
type IndexerUpdates = Parameters<InstanceType<typeof IndexerManager>['updateIndexer']>[1];

function routeMapping(validated: IndexerUpdateParsed): IndexerUpdates {
	return {
		name: validated.name,
		enabled: validated.enabled,
		orphaned: validated.orphaned,
		baseUrl: validated.baseUrl,
		alternateUrls: validated.alternateUrls,
		priority: validated.priority,
		settings: validated.settings ?? undefined,
		enableAutomaticSearch: validated.enableAutomaticSearch,
		enableInteractiveSearch: validated.enableInteractiveSearch,
		minimumSeeders: validated.minimumSeeders,
		seedRatio: validated.seedRatio,
		seedTime: validated.seedTime,
		packSeedTime: validated.packSeedTime,
		rejectDeadTorrents: validated.rejectDeadTorrents,
		rejectPasswordProtected: validated.rejectPasswordProtected,
		minimumCompletionPercentage: validated.minimumCompletionPercentage,
		additionalCategories: validated.additionalCategories
	};
}

describe('IndexerManager.updateIndexer — partial updates preserve existing config', () => {
	let manager: InstanceType<typeof IndexerManager>;

	beforeAll(() => {
		manager = new IndexerManager();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		testDb.db.delete(indexersTable).run();
	});

	it('toggling enabled does not wipe priority, search toggles, or seeding settings', async () => {
		const id = seedIndexer();
		// Exactly what the enable/disable switch sends.
		const validated = indexerUpdateSchema.parse({ enabled: false });
		const updated = await manager.updateIndexer(id, routeMapping(validated));

		expect(updated.enabled).toBe(false); // changed
		expect(updated.priority).toBe(5); // preserved
		expect(updated.enableAutomaticSearch).toBe(true); // preserved
		expect(updated.enableInteractiveSearch).toBe(true); // preserved
		expect(updated.minimumSeeders).toBe(10); // preserved
		expect(updated.seedRatio).toBe('2.0'); // preserved
		expect(updated.rejectDeadTorrents).toBe(false); // preserved
	});

	it('reorder (priority only) does not touch alternateUrls, enabled, or seeding settings', async () => {
		const id = seedIndexer({ alternateUrls: ['https://alt.example.test'] });
		const validated = indexerUpdateSchema.parse({ priority: 7 });
		const updated = await manager.updateIndexer(id, routeMapping(validated));

		expect(updated.priority).toBe(7); // changed
		expect(updated.enabled).toBe(true); // preserved
		expect(updated.alternateUrls).toEqual(['https://alt.example.test']); // preserved
		expect(updated.minimumSeeders).toBe(10); // preserved
		expect(updated.seedRatio).toBe('2.0'); // preserved
	});

	it('built-in indexer: priority-only reorder does not trip the restricted-field guard', async () => {
		// Regression for the "Cannot edit restricted field(s) alternateUrls on
		// built-in indexer" error during drag-to-reorder.
		const id = seedIndexer({ isBuiltIn: true, definitionId: 'cinephage-stream' });
		const validated = indexerUpdateSchema.parse({ priority: 3 });

		await expect(manager.updateIndexer(id, routeMapping(validated))).resolves.toBeDefined();

		const row = (await testDb.db.select().from(indexersTable).where(eq(indexersTable.id, id)))[0];
		expect(row.priority).toBe(3);
	});

	it('explicitly provided fields still apply (and nulls clear seedRatio)', async () => {
		const id = seedIndexer();
		const validated = indexerUpdateSchema.parse({
			priority: 9,
			seedRatio: null,
			minimumSeeders: 20
		});
		const updated = await manager.updateIndexer(id, routeMapping(validated));

		expect(updated.priority).toBe(9);
		expect(updated.minimumSeeders).toBe(20);
		expect(updated.seedRatio).toBeNull();
		// Untouched fields remain as seeded.
		expect(updated.rejectDeadTorrents).toBe(false);
		expect(updated.enableAutomaticSearch).toBe(true);
	});
});

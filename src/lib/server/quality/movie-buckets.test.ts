import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { resolveMovieMultiQuality } from './movie-buckets.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

afterAll(() => {
	destroyTestDb(testDb);
});

async function seedProfile(
	id: string,
	opts: {
		minResolution?: string | null;
		maxResolution?: string | null;
		isDefault?: boolean;
	}
) {
	const { db } = testDb;
	const { scoringProfiles } = await import('#lib/server/db/schema.js');
	await db
		.insert(scoringProfiles)
		.values({
			id,
			name: id,
			minResolution: opts.minResolution ?? null,
			maxResolution: opts.maxResolution ?? null,
			isDefault: opts.isDefault ?? false
		})
		.run();
}

describe('resolveMovieMultiQuality', () => {
	beforeEach(async () => {
		const { db } = testDb;
		const { scoringProfiles } = await import('#lib/server/db/schema.js');
		await db.delete(scoringProfiles).run();
	});

	it('fast-paths null desired qualities without touching the db', async () => {
		const ctx = await resolveMovieMultiQuality(null, 'nope');
		expect(ctx.multiQuality).toBe(false);
		expect(ctx.effective).toEqual([]);
	});

	it('fast-paths fewer than two desired qualities', async () => {
		const ctx = await resolveMovieMultiQuality(['2160p'], 'nope');
		expect(ctx.multiQuality).toBe(false);
	});

	it('returns all desired qualities when profile has no min/max', async () => {
		await seedProfile('p-noconstraints', {});
		const ctx = await resolveMovieMultiQuality(
			['2160p', '1080p'] as Resolution[],
			'p-noconstraints'
		);
		expect(ctx.multiQuality).toBe(true);
		expect(ctx.effective).toEqual(['2160p', '1080p']);
	});

	it('clamps buckets to the profile max resolution', async () => {
		await seedProfile('p-max1080', { maxResolution: '1080p' });
		const ctx = await resolveMovieMultiQuality(
			['2160p', '1080p', '720p'] as Resolution[],
			'p-max1080'
		);
		expect(ctx.effective).toEqual(['1080p', '720p']);
		expect(ctx.multiQuality).toBe(true);
	});

	it('drops to single-quality when only one bucket survives clamping', async () => {
		await seedProfile('p-max720', { maxResolution: '720p' });
		const ctx = await resolveMovieMultiQuality(['2160p', '720p'] as Resolution[], 'p-max720');
		expect(ctx.effective).toEqual(['720p']);
		expect(ctx.multiQuality).toBe(false);
	});

	it('treats a missing profile id as unconstrained', async () => {
		const ctx = await resolveMovieMultiQuality(
			['2160p', '1080p'] as Resolution[],
			'does-not-exist'
		);
		expect(ctx.multiQuality).toBe(true);
		expect(ctx.effective).toEqual(['2160p', '1080p']);
	});

	it('uses the default profile bounds when scoringProfileId is null', async () => {
		await seedProfile('p-default', { isDefault: true, maxResolution: '1080p' });
		const ctx = await resolveMovieMultiQuality(['2160p', '1080p', '720p'] as Resolution[], null);
		expect(ctx.effective).toEqual(['1080p', '720p']);
		expect(ctx.multiQuality).toBe(true);
	});

	it('uses the default profile min bound when scoringProfileId is null', async () => {
		await seedProfile('p-default-min', { isDefault: true, minResolution: '720p' });
		const ctx = await resolveMovieMultiQuality(
			['2160p', '1080p', '720p', '480p'] as Resolution[],
			null
		);
		expect(ctx.effective).toEqual(['2160p', '1080p', '720p']);
		expect(ctx.multiQuality).toBe(true);
	});
});

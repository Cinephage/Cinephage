import { beforeEach, describe, expect, it, vi } from 'vitest';

const indexer = vi.hoisted(() => ({
	row: null as { seedRatio?: string | null; seedTime?: number | null; definitionId: string } | null,
	definition: null as unknown
}));

vi.mock('#lib/server/indexers/IndexerManager.js', () => ({
	getIndexerManager: async () => ({
		getIndexer: async () => indexer.row,
		getDefinition: () => indexer.definition
	})
}));

const { resolveSeedLimits } = await import('./seed-limits.js');

function withDefinition(text: string | undefined, seedTime: string | undefined) {
	indexer.definition = {
		search: {
			fields: {
				...(text === undefined ? {} : { minimumratio: { text } }),
				...(seedTime === undefined ? {} : { minimumseedtime: { text: seedTime } })
			}
		}
	};
}

describe('resolveSeedLimits', () => {
	beforeEach(() => {
		indexer.row = { seedRatio: null, seedTime: null, definitionId: 'def' };
		indexer.definition = null;
	});

	it('returns nothing when no source declares a limit', async () => {
		const limits = await resolveSeedLimits({ indexerId: 'i', client: {} });
		expect(limits.ratio).toBeUndefined();
		expect(limits.timeMinutes).toBeUndefined();
	});

	it('takes the definition declaration when the client default is lower', async () => {
		withDefinition('1.0', '172800');
		const limits = await resolveSeedLimits({
			indexerId: 'i',
			client: { seedRatioLimit: '0.5', seedTimeLimit: 60 }
		});
		expect(limits.ratio).toBe(1);
		expect(limits.timeMinutes).toBe(2880);
	});

	it('keeps a higher client default over the declaration', async () => {
		withDefinition('1.0', '172800');
		const limits = await resolveSeedLimits({
			indexerId: 'i',
			client: { seedRatioLimit: '2.0', seedTimeLimit: 4320 }
		});
		expect(limits.ratio).toBe(2);
		expect(limits.timeMinutes).toBe(4320);
	});

	it('lets the per-release value win over everything', async () => {
		withDefinition('1.0', '172800');
		indexer.row = { seedRatio: '1.5', seedTime: 3000, definitionId: 'def' };
		const limits = await resolveSeedLimits({
			indexerId: 'i',
			client: { seedRatioLimit: '1.0', seedTimeLimit: 60 },
			release: { minimumRatio: 2.5, minimumSeedTime: 5000 }
		});
		expect(limits.ratio).toBe(2.5);
		expect(limits.timeMinutes).toBe(5000);
	});

	it('ignores a ratioless declaration', async () => {
		withDefinition('0', '0');
		const limits = await resolveSeedLimits({ indexerId: 'i', client: {} });
		expect(limits.ratio).toBeUndefined();
		expect(limits.timeMinutes).toBeUndefined();
	});

	it('works without an indexer (retry of a row that lost its indexer)', async () => {
		const limits = await resolveSeedLimits({
			indexerId: null,
			client: { seedRatioLimit: '1.2', seedTimeLimit: 1440 }
		});
		expect(limits.ratio).toBe(1.2);
		expect(limits.timeMinutes).toBe(1440);
	});
});

/**
 * Definition-declared indexer features.
 *
 * The point of this module is that the runtime stops guessing a tracker from its
 * name or base URL - which is wrong behind Prowlarr/Jackett and for renamed
 * mirrors - so the tests pin both halves: the shipped definitions declare what
 * they need, and an undeclared or unreadable definition resolves to "no special
 * behaviour" rather than inheriting someone else's.
 */

import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { YamlDefinitionLoader } from './loader/YamlDefinitionLoader.js';

const getIndexer = vi.fn();
const getDefinition = vi.fn();

vi.mock('./IndexerManager.js', () => ({
	getIndexerManager: async () => ({ getIndexer, getDefinition })
}));

vi.mock('#lib/logging/index.js', () => {
	const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
	return { logger, createChildLogger: () => logger };
});

const { NO_INDEXER_FEATURES, getIndexerFeatures, getFeaturesByIndexerId, resolveFeatures } =
	await import('./features.js');

const definitionsDir = resolve('data/indexers/definitions');

async function loadDefinition(id: string) {
	const loader = new YamlDefinitionLoader(definitionsDir);
	const result = await loader.loadOne(resolve(definitionsDir, `${id}.yaml`));
	expect(result).not.toBeNull();
	return result!.definition;
}

describe('indexer features declared by definitions', () => {
	it('RuTracker declares living season packs and forum download links', async () => {
		const features = resolveFeatures(await loadDefinition('rutracker'));
		expect(features).toEqual({ livingSeasonPacks: true, forumDownloadLinks: true });
	});

	it.each(['kinozal', 'kinozal-magnet'])('%s declares living season packs', async (id) => {
		const features = resolveFeatures(await loadDefinition(id));
		expect(features.livingSeasonPacks).toBe(true);
		// Kinozal's download endpoint is not a forum link.
		expect(features.forumDownloadLinks).toBe(false);
	});

	it('leaves a definition that declares nothing on the plain behaviour', async () => {
		const features = resolveFeatures(await loadDefinition('c411'));
		expect(features).toEqual(NO_INDEXER_FEATURES);
	});

	it('resolves a missing definition to the plain behaviour', () => {
		expect(resolveFeatures(undefined)).toEqual(NO_INDEXER_FEATURES);
		expect(resolveFeatures(null)).toEqual(NO_INDEXER_FEATURES);
	});
});

describe('getIndexerFeatures', () => {
	beforeEach(() => {
		getIndexer.mockReset();
		getDefinition.mockReset();
	});

	it('answers from the indexer definition', async () => {
		getIndexer.mockResolvedValue({ id: 'instance-1', definitionId: 'rutracker' });
		getDefinition.mockReturnValue(await loadDefinition('rutracker'));

		await expect(getIndexerFeatures('instance-1')).resolves.toEqual({
			livingSeasonPacks: true,
			forumDownloadLinks: true
		});
		expect(getDefinition).toHaveBeenCalledWith('rutracker');
	});

	it('answers "no features" when the indexer is unknown', async () => {
		getIndexer.mockResolvedValue(undefined);
		await expect(getIndexerFeatures('missing')).resolves.toEqual(NO_INDEXER_FEATURES);
	});

	it('answers "no features" when the definition is missing', async () => {
		getIndexer.mockResolvedValue({ id: 'instance-1', definitionId: 'gone' });
		getDefinition.mockReturnValue(undefined);
		await expect(getIndexerFeatures('instance-1')).resolves.toEqual(NO_INDEXER_FEATURES);
	});

	it('answers "no features" without an id', async () => {
		await expect(getIndexerFeatures(undefined)).resolves.toEqual(NO_INDEXER_FEATURES);
	});

	it('maps several indexers in one pass', async () => {
		getIndexer.mockImplementation(async (id: string) =>
			id === 'a' ? { id: 'a', definitionId: 'rutracker' } : { id, definitionId: 'gone' }
		);
		getDefinition.mockImplementation((id: string) =>
			id === 'rutracker' ? { features: { livingSeasonPacks: true } } : undefined
		);

		const map = await getFeaturesByIndexerId(['a', 'b', 'a', undefined]);
		expect([...map.keys()]).toEqual(['a', 'b']);
		expect(map.get('a')?.livingSeasonPacks).toBe(true);
		expect(map.get('b')?.livingSeasonPacks).toBe(false);
	});
});

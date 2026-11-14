/**
 * The seeding limits a grab must carry, from every source that can declare one.
 *
 * A tracker's requirement reaches the client through four places, and the
 * highest wins: the per-indexer setting the user configured, the download
 * client's own default, the definition's static declaration, and - when the
 * tracker varies it per release (freeleech, promos, per-category) - the value
 * parsed off this release.
 *
 * One owner for that composition. The grab path and the queue retry path both
 * re-add a torrent, and a retry that forgets the floor silently under-seeds a
 * private tracker; a second copy of this rule is how that drifts.
 */
import { declaredSeedLimits, maxSeedLimit } from '#lib/server/indexers/seedDefaults.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';

export interface SeedLimitInput {
	indexerId?: string | null;
	/** Hydrated download-client config; its global share limits are a source. */
	client: { seedRatioLimit?: string | number | null; seedTimeLimit?: number | null };
	/** Values the tracker declared for this specific release, when known. */
	release?: { minimumRatio?: number; minimumSeedTime?: number };
}

export interface SeedLimits {
	/** Decimal ratio, e.g. 1.0. */
	ratio?: number;
	/** Seed time in minutes, the unit both the settings and the client use. */
	timeMinutes?: number;
}

export async function resolveSeedLimits(input: SeedLimitInput): Promise<SeedLimits> {
	let indexerRatio: number | undefined;
	let indexerTime: number | undefined;
	let declaredRatio: number | undefined;
	let declaredTime: number | undefined;

	if (input.indexerId) {
		const manager = await getIndexerManager();
		const indexer = await manager.getIndexer(input.indexerId);
		if (indexer) {
			indexerRatio = indexer.seedRatio ? Number.parseFloat(indexer.seedRatio) : undefined;
			indexerTime = indexer.seedTime ?? undefined;

			const definition = manager.getDefinition(indexer.definitionId);
			if (definition) {
				const declared = declaredSeedLimits(definition);
				if (declared.ratio) declaredRatio = Number(declared.ratio);
				if (declared.seedTimeMinutes) declaredTime = declared.seedTimeMinutes;
			}
		}
	}

	const clientRatio =
		input.client.seedRatioLimit === null || input.client.seedRatioLimit === undefined
			? undefined
			: Number.parseFloat(String(input.client.seedRatioLimit));

	return {
		ratio: maxSeedLimit(indexerRatio, clientRatio, declaredRatio, input.release?.minimumRatio),
		timeMinutes: maxSeedLimit(
			indexerTime,
			input.client.seedTimeLimit ?? undefined,
			declaredTime,
			input.release?.minimumSeedTime
		)
	};
}

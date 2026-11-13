/**
 * Seeding limits an indexer definition declares for every release it returns.
 *
 * Cardigann definitions carry `minimumratio` / `minimumseedtime` in
 * `search.fields` (18 of our definitions do). The generic field loop writes
 * them into the values map, but the release whitelist in `buildReleaseResult`
 * never reads them, so a private tracker's real requirement is dropped and the
 * per-indexer Seed Ratio / Seed Time settings start blank — which silently
 * falls back to the download client's global default, often below what the
 * tracker requires.
 *
 * This module reads the *static* declarations so a newly added indexer starts
 * with the tracker's own requirement pre-filled. The user can still edit or
 * clear it, and nothing here re-applies a default to an existing indexer.
 *
 * Only literal values are usable at creation time: a field driven by
 * `selector`/`case` varies per release (nebulance declares 120 h for season
 * packs and 24 h for episodes; ncore's is size-dependent and commented out)
 * and belongs to the grab path, not to indexer creation.
 */
import type { YamlDefinition } from './schema/yamlDefinition.js';

export interface DeclaredSeedLimits {
	/** Decimal ratio string, exactly as the definition writes it (e.g. "1.0"). */
	ratio?: string;
	/** Seed time in minutes. Definitions declare seconds; the setting is minutes. */
	seedTimeMinutes?: number;
}

/**
 * Read a field only when the definition gives it a literal value.
 *
 * Returns `undefined` for a missing field, an empty value, a template
 * (`{{ .Result.x }}`) or a field whose value comes from a `selector`/`case`
 * block — all of which are per-release and cannot be pre-filled.
 */
function staticFieldValue(def: YamlDefinition, key: string): string | undefined {
	const field = def.search?.fields?.[key];
	if (field === undefined) return undefined;

	const text = typeof field === 'string' ? field : field.text;
	if (text === undefined) return undefined;

	const value = String(text).trim();
	if (value === '' || value.includes('{{')) return undefined;
	return value;
}

/**
 * Seeding limits declared by a definition, in the units the indexer settings
 * use. Both members are omitted when the definition declares nothing usable.
 */
export function declaredSeedLimits(def: YamlDefinition): DeclaredSeedLimits {
	const limits: DeclaredSeedLimits = {};

	const ratio = staticFieldValue(def, 'minimumratio');
	if (ratio !== undefined) {
		const parsed = Number(ratio);
		// `0` is the tracker's way of saying "ratioless" (nebulance). Writing it
		// into the setting would be read as "stop seeding at ratio 0" — qBittorrent
		// and Deluge both honour that literally — so it stays blank instead.
		if (Number.isFinite(parsed) && parsed > 0) {
			limits.ratio = ratio;
		}
	}

	const seconds = staticFieldValue(def, 'minimumseedtime');
	if (seconds !== undefined) {
		const parsed = Number(seconds);
		if (Number.isFinite(parsed) && parsed > 0) {
			// The setting is minutes and validated as an integer; round rather than
			// truncate so a requirement is never under-stated.
			limits.seedTimeMinutes = Math.max(1, Math.round(parsed / 60));
		}
	}

	return limits;
}

/**
 * Highest of the supplied limits, ignoring unset and non-positive values.
 *
 * Used to enforce a tracker's declared requirement as a floor: a user value or
 * an inherited client default below it would under-seed. `undefined` means
 * "send no limit", which leaves the client's own default in place.
 */
export function maxSeedLimit(...values: (number | undefined)[]): number | undefined {
	const usable = values.filter(
		(value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
	);
	return usable.length > 0 ? Math.max(...usable) : undefined;
}

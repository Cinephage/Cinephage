/**
 * Media-Server Language Normalization
 *
 * Shared ingestion rules for Plex / Emby / Jellyfin audio + subtitle language
 * stats (Phase 5). Every provider emits BOTH views per SyncedMediaItem:
 *
 * - `canonical`: tags produced by `normalizeLanguageTag`, first-seen order,
 *   deduped; empty values and unknown (`und`) results are dropped.
 * - `raw`: the untouched source strings exactly as the server reported them,
 *   first-seen order, deduped by raw value; only truly empty values are
 *   dropped. Unknown non-empty values therefore survive here only.
 */

import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';

export interface NormalizedLanguageLists {
	/** Canonical tags, first-seen order, deduped; empty and `und` results dropped. */
	canonical: string[];
	/** Untouched source strings, first-seen order, deduped; empties dropped. */
	raw: string[];
}

/**
 * Split raw stream language values into the canonical + raw views.
 * Order follows the input (part/source order for the providers); canonical
 * entries collapse onto their first occurrence, raw entries dedupe by value.
 */
export function normalizeLanguageLists(values: readonly unknown[]): NormalizedLanguageLists {
	const canonical: string[] = [];
	const raw: string[] = [];
	const seenRaw = new Set<string>();
	const seenCanonical = new Set<string>();

	for (const value of values) {
		if (typeof value !== 'string') continue;
		if (value.trim() === '') continue;

		if (!seenRaw.has(value)) {
			seenRaw.add(value);
			raw.push(value);
		}

		const tag = normalizeLanguageTag(value);
		if (tag === 'und') continue; // Unknown non-empty raws live only in `raw`.
		if (!seenCanonical.has(tag)) {
			seenCanonical.add(tag);
			canonical.push(tag);
		}
	}

	return { canonical, raw };
}

/**
 * Dedupe streams by their normalized language tag, keeping the first-seen
 * stream per tag in input order. Streams without a language normalize to
 * `und`, so only the first unlabeled stream survives. Multi-part/multi-source
 * items otherwise repeat the same track once per file version.
 */
export function dedupeStreamsByLanguage<T>(
	streams: readonly T[],
	languageOf: (stream: T) => unknown
): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const stream of streams) {
		const value = languageOf(stream);
		const tag = normalizeLanguageTag(typeof value === 'string' ? value : null);
		if (seen.has(tag)) continue;
		seen.add(tag);
		result.push(stream);
	}
	return result;
}

/**
 * True when the stream carries a default/selected marker. Covers the Plex
 * `default`/`selected` attributes and the Jellyfin/Emby `IsDefault`/
 * `IsSelected` booleans (the APIs return them as booleans or '0'/'1' strings).
 */
export function hasSelectionFlag(stream: unknown): boolean {
	if (!stream || typeof stream !== 'object') return false;
	const record = stream as Record<string, unknown>;
	for (const key of ['default', 'selected', 'IsDefault', 'IsSelected']) {
		const value = record[key];
		if (value === true || value === 1 || value === '1') return true;
	}
	return false;
}

/**
 * Deterministic primary-stream pick from an already-deduped list: the first
 * stream flagged default/selected, else the first stream overall.
 */
export function pickPrimaryStream<T>(streams: readonly T[]): T | null {
	const flagged = streams.find((stream) => hasSelectionFlag(stream));
	return flagged ?? streams[0] ?? null;
}

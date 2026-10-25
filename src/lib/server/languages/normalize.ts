/**
 * Server-side language normalizer.
 *
 * The single boundary for turning arbitrary observed language input into
 * canonical tags. Uses the full generated ISO 639-2/3 table plus the shared
 * registry aliases. Unknown values resolve to `und`; they never resolve to
 * English and never silently disappear.
 */

import { canonicalizeLanguageTag, type LanguageTag } from '#lib/shared/languages.js';
import { ISO_TO_CANONICAL } from './iso-data.generated.js';

const UNKNOWN: LanguageTag = 'und';

/** Release markers and synonyms that are not languages. */
const NON_LANGUAGE_MARKERS = new Set(['multi', 'orig', 'original', 'unknown', 'undetermined']);

/**
 * Normalize any language input to a canonical BCP-47 tag.
 * Returns `und` when the input cannot be resolved.
 */
export function normalizeLanguageTag(raw: string | null | undefined): LanguageTag {
	if (raw == null) return UNKNOWN;
	const cleaned = String(raw).trim().replace(/_/g, '-');
	if (!cleaned) return UNKNOWN;

	const lower = cleaned.toLowerCase();
	if (lower === 'und') return UNKNOWN;
	if (NON_LANGUAGE_MARKERS.has(lower)) return UNKNOWN;

	// Curated registry first: its alias table wins over the generated ISO table
	// for overlapping inputs (e.g. `nob`/`nno`/`nb`/`nn` all resolve to `no`,
	// whereas the ISO table would emit `nb`/`nn`, which the requirement matcher
	// cannot resolve). The ISO table then covers codes the curated registry
	// omits (e.g. `ast`, `yue`, `fil`).
	const fromShared = canonicalizeLanguageTag(cleaned);
	if (fromShared) return fromShared;

	const fromIso = ISO_TO_CANONICAL[lower];
	if (fromIso) return fromIso;

	return UNKNOWN;
}

export interface ObservedLanguage {
	/** Exact value as provided by the source (ffprobe, Plex, filename, ...) */
	raw: string;
	/** Canonical tag, or `und` when unresolved */
	canonical: LanguageTag;
}

/** Keep observation provenance while normalizing for comparison. */
export function parseObservedLanguage(raw: string | null | undefined): ObservedLanguage {
	const rawValue = raw == null ? '' : String(raw);
	return { raw: rawValue, canonical: normalizeLanguageTag(rawValue) };
}

/** Validate and canonicalize a TMDB response locale (e.g. `en-US`). */
export function normalizeMetadataLocale(raw: string | null | undefined): string | null {
	if (raw == null) return null;
	const cleaned = String(raw).trim().replace(/_/g, '-');
	if (!cleaned) return null;
	try {
		const [canonical] = Intl.getCanonicalLocales(cleaned);
		return canonical ?? null;
	} catch {
		return null;
	}
}

/**
 * Reduce a tag to the base language TMDB uses for `original_language`
 * and discover filters. Returns null when unresolved.
 */
export function normalizeTmdbLanguage(raw: string | null | undefined): string | null {
	const tag = normalizeLanguageTag(raw);
	if (tag === UNKNOWN) return null;
	return tag.split('-')[0];
}

/** Validate and canonicalize an ISO 3166-1 region code (2 letters, upper). */
export function normalizeRegionCode(raw: string | null | undefined): string | null {
	const value = typeof raw === 'string' ? raw.trim() : '';
	return /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}

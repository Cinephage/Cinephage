import type { KindId, MediaKind } from './types.js';

export type { KindId, MediaKind, MediaKindCapabilities } from './types.js';

// The one place a media kind is declared. Everything the app does per kind — the
// library/root-folder vocabulary, labels, sub-libraries, what surfaces may serve it —
// reads from here. Adding a kind is one entry plus its adapters; hand-widening a
// `'movie' | 'tv'` union anywhere else is the bug this module exists to prevent.
//
// Capabilities say what the app does TODAY. Flipping a bit is the roadmap entry for a
// kind (music: monitored, discover and requests are the next ones to go true), so
// consumers gate on the bit instead of maintaining parallel literal unions.

const MOVIE: MediaKind = {
	id: 'movie',
	labels: { singular: 'Movie', plural: 'Movies', rootFolder: 'Movies' },
	subTypes: ['standard', 'anime'],
	capabilities: {
		library: true,
		monitored: true,
		subtitles: true,
		upgrades: true,
		calendar: false,
		discover: true,
		import: true,
		requests: true,
		libraryExclusion: true,
		bulkAdd: true,
		contentFiltering: true
	}
};

const TV: MediaKind = {
	id: 'tv',
	labels: { singular: 'TV Show', plural: 'TV Shows', rootFolder: 'TV Shows' },
	subTypes: ['standard', 'anime'],
	capabilities: {
		library: true,
		monitored: true,
		subtitles: true,
		upgrades: true,
		calendar: true,
		discover: true,
		import: true,
		requests: true,
		libraryExclusion: true,
		bulkAdd: true,
		contentFiltering: true
	}
};

// Music today: it owns a library and imports album folders. Its monitor flag is persisted
// but nothing reads it yet; Discover, requests, the calendar and upgrades do not serve it.
const MUSIC: MediaKind = {
	id: 'music',
	labels: { singular: 'Music', plural: 'Music', rootFolder: 'Music' },
	subTypes: ['standard'],
	capabilities: {
		library: true,
		monitored: false,
		subtitles: false,
		upgrades: false,
		calendar: false,
		discover: false,
		import: true,
		requests: false,
		libraryExclusion: false,
		bulkAdd: false,
		contentFiltering: false
	}
};

export const MEDIA_KINDS: ReadonlyMap<KindId, MediaKind> = new Map([
	['movie', MOVIE],
	['tv', TV],
	['music', MUSIC]
]);

/** Every kind, in registry order. Nav items, forms and filters iterate this. */
export const MEDIA_KIND_IDS: readonly KindId[] = [...MEDIA_KINDS.keys()];

/** Kinds that can own a library or root folder — feeds the library/root-folder schemas. */
export const LIBRARY_KIND_IDS: readonly KindId[] = MEDIA_KIND_IDS.filter(
	(id) => MEDIA_KINDS.get(id)?.capabilities.library === true
);

/**
 * Kinds a catalog source can serve to Discover and as-you-type search.
 * Declared as a literal tuple on purpose: a `.filter()` result types as
 * `KindId`, which would widen every consumer back to all kinds. The registry
 * test pins this list, so changing it is a deliberate act.
 */
export const DISCOVER_KIND_IDS = ['movie', 'tv'] as const satisfies readonly KindId[];

/** The kind a smart list or Discover row is drawn from — today, the TMDB-backed kinds. */
export type DiscoverKindId = (typeof DISCOVER_KIND_IDS)[number];

/** A kind selector used by filters and list endpoints: one kind, or all of them. */
export type KindFilter = KindId | 'all';

export function isKindId(value: string): value is KindId {
	return MEDIA_KINDS.has(value as KindId);
}

/** The registry entry for a known kind. An unknown id is a programming error, not user input. */
export function kind(id: KindId): MediaKind {
	const entry = MEDIA_KINDS.get(id);
	if (!entry) throw new Error(`unknown media kind: ${id}`);
	return entry;
}

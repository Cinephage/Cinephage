import type { KindId } from '#lib/media-kinds/registry.js';
import type { CatalogSource } from './types.js';
import { tmdbCatalogSource } from './tmdb.js';
import { deezerChartSource } from './deezer.js';

export type { CatalogItem, CatalogPage, CatalogSource, Facet } from './types.js';

// One entry per source; a kind with no source stays out of Discover until it
// registers one. Today one source serves each kind; when a kind grows a
// second source (say, charts), the resolver becomes a list and the page
// decides how to merge.
const sources = new Map<string, CatalogSource>([
	['tmdb', tmdbCatalogSource],
	['deezer', deezerChartSource]
]);

export function catalogSource(id: string): CatalogSource | undefined {
	return sources.get(id);
}

/** The source serving a kind, or null when Discover cannot serve it yet. */
export function catalogSourceForKind(kind: KindId): CatalogSource | null {
	for (const source of sources.values()) {
		if (source.kinds.includes(kind)) return source;
	}
	return null;
}

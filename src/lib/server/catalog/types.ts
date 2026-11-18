import type { KindId } from '#lib/media-kinds/registry.js';

/**
 * One row from any catalog source. `meta` carries the source's own display
 * fields raw, so rich renderers keep their per-source detail; only the fields
 * every renderer needs are promoted to the interface.
 */
export interface CatalogItem {
	kind: KindId;
	/** Provider-native id: TMDB id, release-group MBID, Open Library key. */
	id: string;
	title: string;
	subtitle?: string;
	year?: number | null;
	imageUrl?: string | null;
	meta?: Record<string, unknown>;
}

export interface CatalogPage {
	items: CatalogItem[];
	pagination: { page: number; total_pages: number; total_results: number };
}

/** The filter vocabulary a source actually understands — declared, not assumed. */
export interface Facet {
	id: string;
	label: string;
}

/**
 * A source of browsable rows for Discover. The surface stays minimal on
 * purpose: `search` and dashboard `sections` join the interface when their
 * consumers do, not before.
 */
export interface CatalogSource {
	id: string;
	/** The kinds this source can serve; gated by the registry's discover kinds. */
	kinds: readonly KindId[];
	facets: readonly Facet[];
	discover(params: Record<string, string | number | boolean | null>): Promise<CatalogPage | null>;
}

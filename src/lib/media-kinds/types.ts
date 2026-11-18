/**
 * A media kind, as data. Catalog/importer/grader adapters arrive with the CatalogSource
 * step; until then the registry carries the vocabulary and capabilities that today live
 * as scattered `'movie' | 'tv'` literal unions.
 */
export type KindId = 'movie' | 'tv' | 'music';

/** What the app may show and do for a kind — today, not someday. */
export interface MediaKindCapabilities {
	/** The kind can own libraries and root folders (feeds the library/root-folder schemas). */
	library: boolean;
	/** A per-item monitor flag the app reads — persisting alone does not count. */
	monitored: boolean;
	subtitles: boolean;
	/** An upgrade/cutoff loop can replace this kind's files with better ones. */
	upgrades: boolean;
	/** Dated items of this kind appear on the calendar. */
	calendar: boolean;
	/** A catalog source serves Discover rows and as-you-type search for this kind. */
	discover: boolean;
	/** Files on disk import into items of this kind. */
	import: boolean;
	/** The requests surface accepts this kind. */
	requests: boolean;
}

export interface MediaKind {
	id: KindId;
	labels: {
		singular: string;
		plural: string;
		/** The kind's system-library / root-folder name. */
		rootFolder: string;
	};
	/** Sub-library vocabulary (`media_sub_type`) offered for this kind. */
	subTypes: readonly string[];
	capabilities: MediaKindCapabilities;
}

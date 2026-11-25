import type { KindId } from '#lib/media-kinds/registry.js';

/**
 * The filter vocabulary, shared by every media kind.
 *
 * A facet is one filter: what it is called, which control renders it, which
 * kinds understand it, and how its value moves in and out of the URL. The
 * Discover panel renders facets; it never learns a provider's parameter names.
 */

/** The control a facet renders as. Closed on purpose: a new control is a
 *  deliberate addition to FacetField, never a per-kind branch. */
export type FacetControl =
	'single' | 'multi' | 'logo-multi' | 'range' | 'slider' | 'keywords' | 'preset';

export type FacetGroupId = 'sort' | 'content' | 'release' | 'availability';

/** A facet's value, normalised out of the URL. */
export type FacetValue =
	| { kind: 'scalar'; value: string }
	| { kind: 'ids'; ids: string[] }
	| { kind: 'range'; min: string; max: string }
	| { kind: 'number'; value: string }
	| { kind: 'keywords'; include: string[]; exclude: string[] };

export interface FacetOption {
	id: string;
	label: string;
	title?: string;
	logoPath?: string | null;
}

export interface FacetRange {
	min: number;
	max: number;
	step: number;
	placeholderMin?: string;
	placeholderMax?: string;
}

/** One facet as the client renders it: label and options resolved, value attached. */
export interface FacetView {
	id: string;
	label: string;
	control: FacetControl;
	options: FacetOption[];
	range?: FacetRange;
	searchable?: boolean;
	placeholder?: string;
	/** Shown when the facet applies to only some of the kinds a tab serves. */
	hint?: string;
	/** Message key for the active-filter badge, when the facet has bespoke wording. */
	badgeKey?: string;
	value: FacetValue | null;
}

export interface FacetGroupView {
	id: FacetGroupId;
	/** Empty for the sort group, which carries no heading of its own. */
	label: string;
	facets: FacetView[];
}

/** Selected values, keyed by facet id. */
export type FacetSelection = Record<string, FacetValue>;

/** The minimal read surface a codec needs — URLSearchParams or SvelteKit's read-only view. */
export interface QueryReader {
	get(name: string): string | null;
}

/** How a facet reads and writes its own URL parameters. */
export interface FacetCodec {
	read(params: QueryReader): FacetValue | null;
	write(params: URLSearchParams, value: FacetValue | null): void;
}

/** The static declaration of one facet. Client-safe: no server imports. */
export interface FacetDef {
	id: string;
	group: FacetGroupId;
	control: FacetControl;
	/** The kinds whose panel offers this facet. */
	kinds: readonly KindId[];
	/** A value that is the facet's resting state and never counts as active. */
	defaultValue?: string;
	codec: FacetCodec;
}

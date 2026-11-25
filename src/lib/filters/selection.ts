import type { KindFilter } from '#lib/media-kinds/registry.js';
import { ALL_FACETS, facetById, facetsFor } from './defs.js';
import type { FacetGroupView, FacetSelection, FacetValue, QueryReader } from './types.js';

/**
 * Reading, writing and pruning a filter selection.
 *
 * The URL stays the single source of truth: these functions are the only way
 * a selection moves in or out of it, so the server and the client cannot
 * disagree about what is selected.
 */

export function readSelection(params: QueryReader, kind: KindFilter): FacetSelection {
	const selection: FacetSelection = {};
	for (const def of facetsFor(kind)) {
		const value = def.codec.read(params);
		if (value) selection[def.id] = value;
	}
	return selection;
}

/**
 * Rewrite every facet parameter from a selection.
 *
 * The first pass clears the parameters of *all* facets, including those the
 * current kind does not offer, so a value can never outlive its kind. The
 * second pass only sets values: no facet may delete a parameter another facet
 * owns (`with_genres` is shared by TMDB genres and music genres).
 *
 * `cleared` names facets the user deliberately cleared over an instance-level
 * default: those without a value get their explicit "no filter" marker. Any
 * other empty facet writes nothing, so a clean selection is a clean URL.
 */
export function writeSelection(
	params: URLSearchParams,
	selection: FacetSelection,
	cleared: ReadonlySet<string> = new Set()
): void {
	for (const def of ALL_FACETS) def.codec.write(params, null);
	for (const def of ALL_FACETS) {
		const value = selection[def.id];
		if (value) def.codec.write(params, value);
	}
	for (const def of ALL_FACETS) {
		if (cleared.has(def.id) && !selection[def.id]) def.codec.clearMarker?.set(params);
	}
}

/**
 * Facets whose URL carries the explicit "no filter" marker. Without a kind it
 * looks at every facet, so an override survives a tab that does not show it
 * (the language is not a music facet).
 */
export function readClearedFacets(params: QueryReader, kind?: KindFilter): Set<string> {
	const cleared = new Set<string>();
	for (const def of kind ? facetsFor(kind) : ALL_FACETS) {
		if (def.codec.clearMarker?.has(params)) cleared.add(def.id);
	}
	return cleared;
}

/** Facets of a panel the server fills with an instance-level default. */
export function instanceDefaultFacets(groups: readonly FacetGroupView[]): Set<string> {
	const ids = new Set<string>();
	for (const group of groups) {
		for (const facet of group.facets) if (facet.instanceDefault) ids.add(facet.id);
	}
	return ids;
}

/**
 * Set or clear one facet in the URL. Clearing a facet that has an instance
 * default writes its marker, so the default cannot quietly come back; clearing
 * any other facet leaves the URL clean. Existing overrides are kept.
 */
export function applyFacetChange(
	params: URLSearchParams,
	selection: FacetSelection,
	groups: readonly FacetGroupView[],
	facetId: string,
	value: FacetValue | null
): void {
	const next: FacetSelection = { ...selection };
	const cleared = readClearedFacets(params);
	if (value) {
		next[facetId] = value;
		cleared.delete(facetId);
	} else {
		delete next[facetId];
		if (instanceDefaultFacets(groups).has(facetId)) cleared.add(facetId);
		else cleared.delete(facetId);
	}
	writeSelection(params, next, cleared);
}

/** Switch tabs: keep what the target kind declares, and every override. */
export function applyKindChange(
	params: URLSearchParams,
	selection: FacetSelection,
	kind: KindFilter
): void {
	writeSelection(params, pruneSelection(selection, kind), readClearedFacets(params));
}

/**
 * Clear every facet of the panel. A facet the server would fill with an
 * instance default is cleared to its marker (the panel shows that default as
 * an active filter, so Reset must switch it off too); without one the URL
 * ends clean. Overrides of facets the panel does not show are kept.
 */
export function applyReset(params: URLSearchParams, groups: readonly FacetGroupView[]): void {
	const shown = new Set(groups.flatMap((group) => group.facets.map((facet) => facet.id)));
	const cleared = new Set([...readClearedFacets(params)].filter((id) => !shown.has(id)));
	for (const id of instanceDefaultFacets(groups)) cleared.add(id);
	writeSelection(params, {}, cleared);
}

/** Drop values whose facet the target kind does not declare. */
export function pruneSelection(selection: FacetSelection, kind: KindFilter): FacetSelection {
	const allowed = new Set(facetsFor(kind).map((def) => def.id));
	const next: FacetSelection = {};
	for (const [id, value] of Object.entries(selection)) {
		if (allowed.has(id)) next[id] = value;
	}
	return next;
}

/** True when anything other than sort is set — sort is a view preference, not a filter. */
export function hasActiveFilters(selection: FacetSelection): boolean {
	return Object.keys(selection).some((id) => facetById(id)?.group !== 'sort');
}

/** Numeric ids of a list facet — music's chart genres, TMDB's genres/providers. */
export function idsFrom(value: FacetValue | null | undefined): number[] {
	if (value?.kind !== 'ids') return [];
	return value.ids.map(Number).filter((id) => Number.isFinite(id));
}

export interface ActiveFilterView {
	id: string;
	label: string;
	count?: number;
	text?: string;
	badgeKey?: string;
}

/**
 * The header summary, derived from the rendered facets rather than from a
 * parallel list of parameter names. A facet that is not on screen cannot
 * produce a badge.
 */
export function activeFilters(groups: FacetGroupView[]): ActiveFilterView[] {
	const active: ActiveFilterView[] = [];
	for (const group of groups) {
		if (group.id === 'sort') continue;
		for (const facet of group.facets) {
			const value = facet.value;
			if (!value) continue;
			const base = { id: facet.id, label: facet.label, badgeKey: facet.badgeKey };
			if (value.kind === 'ids') {
				if (value.ids.length > 0) active.push({ ...base, count: value.ids.length });
			} else if (value.kind === 'keywords') {
				const count = value.include.length + value.exclude.length;
				if (count > 0) active.push({ ...base, count });
			} else if (value.kind === 'range') {
				if (value.min || value.max) {
					active.push({ ...base, text: `${value.min || '…'} – ${value.max || '…'}` });
				}
			} else if (value.kind === 'number') {
				if (Number(value.value) > 0) active.push({ ...base, text: `${value.value}+` });
			} else {
				const option = facet.options.find((entry) => entry.id === value.value);
				active.push({ ...base, text: option?.label ?? value.value });
			}
		}
	}
	return active;
}

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
 */
export function writeSelection(params: URLSearchParams, selection: FacetSelection): void {
	for (const def of ALL_FACETS) def.codec.write(params, null);
	for (const def of ALL_FACETS) {
		const value = selection[def.id];
		if (value) def.codec.write(params, value);
	}
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

import * as m from '#lib/paraglide/messages.js';
import { SEASONAL_PRESETS } from '#lib/config/seasonal.js';
import {
	FACET_BADGES,
	FACET_LABELS,
	GROUP_LABELS,
	GROUP_ORDER,
	SORT_OPTIONS,
	facetsFor
} from '#lib/filters/defs.js';
import type { FacetGroupView, FacetOption, FacetSelection, FacetView } from '#lib/filters/types.js';
import type { KindFilter } from '#lib/media-kinds/registry.js';

/**
 * Turns the facet declarations plus the current tab's data into the view the
 * panel renders. Labels and options are resolved here so the client never
 * needs a lookup table of its own.
 */

export interface FacetOptionSource {
	genres: { id: number; name: string }[];
	providers: { provider_id: number; provider_name: string; logo_path?: string | null }[];
	networks: { id: number; name: string; logo_path?: string | null }[];
	certifications: { certification: string; meaning?: string }[];
	languages: { code: string; name: string }[];
	musicGenres: { id: number; name: string }[];
}

export const EMPTY_FACET_OPTIONS: FacetOptionSource = {
	genres: [],
	providers: [],
	networks: [],
	certifications: [],
	languages: [],
	musicGenres: []
};

function message(key: string): string {
	if (!key) return '';
	const catalogue = m as unknown as Record<string, (() => string) | undefined>;
	return catalogue[key]?.() ?? key;
}

function sortOptions(kind: KindFilter): FacetOption[] {
	const sortKind = kind === 'all' ? 'movie' : kind;
	return SORT_OPTIONS[sortKind].map((option) => ({
		id: option.id,
		label: message(option.labelKey)
	}));
}

function optionsFor(facetId: string, kind: KindFilter, source: FacetOptionSource): FacetOption[] {
	switch (facetId) {
		case 'sort':
			return sortOptions(kind);
		case 'genres':
			return source.genres.map((genre) => ({ id: String(genre.id), label: genre.name }));
		case 'music_genre':
			return source.musicGenres.map((genre) => ({ id: String(genre.id), label: genre.name }));
		case 'providers':
			return source.providers.map((provider) => ({
				id: String(provider.provider_id),
				label: provider.provider_name,
				logoPath: provider.logo_path ?? null
			}));
		case 'networks':
			return source.networks.map((network) => ({
				id: String(network.id),
				label: network.name,
				logoPath: network.logo_path ?? null
			}));
		case 'certification':
			return source.certifications.map((certification) => ({
				id: certification.certification,
				label: certification.certification,
				title: certification.meaning
			}));
		case 'language':
			return source.languages.map((language) => ({
				id: language.code,
				label: language.name
			}));
		case 'seasonal':
			return SEASONAL_PRESETS.map((preset) => ({
				id: preset.id,
				label: message(preset.labelKey)
			}));
		default:
			return [];
	}
}

function placeholderFor(facetId: string): string | undefined {
	switch (facetId) {
		case 'genres':
		case 'music_genre':
			return m.discover_filter_anyGenre();
		case 'language':
			return m.common_all();
		case 'certification':
			return m.discover_filter_anyRating();
		case 'seasonal':
			return m.common_none();
		default:
			return undefined;
	}
}

const SEARCHABLE = new Set(['genres', 'music_genre', 'providers', 'networks', 'language']);

function hintFor(kind: KindFilter, kinds: readonly string[]): string | undefined {
	if (kind !== 'all' || kinds.length !== 1) return undefined;
	return kinds[0] === 'tv' ? m.discover_filter_tvOnly() : m.discover_filter_moviesOnly();
}

export function buildFacetGroups(
	kind: KindFilter,
	selection: FacetSelection,
	source: FacetOptionSource,
	instanceDefaults: Partial<Record<string, string>> = {}
): FacetGroupView[] {
	const defs = facetsFor(kind);
	const groups: FacetGroupView[] = [];

	for (const groupId of GROUP_ORDER) {
		const groupDefs = defs.filter((def) => def.group === groupId);
		if (groupDefs.length === 0) continue;
		groups.push({
			id: groupId,
			label: message(GROUP_LABELS[groupId]),
			facets: groupDefs.map((def): FacetView => {
				const range =
					def.id === 'year'
						? {
								min: 1900,
								max: new Date().getFullYear(),
								step: 1,
								placeholderMin: '1900',
								placeholderMax: String(new Date().getFullYear())
							}
						: def.id === 'rating'
							? { min: 0, max: 10, step: 0.5 }
							: undefined;

				return {
					id: def.id,
					label: message(FACET_LABELS[def.id] ?? def.id),
					control: def.control,
					options: optionsFor(def.id, kind, source),
					range,
					searchable: SEARCHABLE.has(def.id),
					placeholder: placeholderFor(def.id),
					hint: hintFor(kind, def.kinds),
					badgeKey: FACET_BADGES[def.id],
					instanceDefault: instanceDefaults[def.id],
					value:
						selection[def.id] ??
						(def.defaultValue ? { kind: 'scalar', value: def.defaultValue } : null)
				};
			})
		});
	}

	return groups;
}

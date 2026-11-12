/**
 * Seasonal browse presets for Discover.
 *
 * TMDB has no holiday facet. The nearest stable signal is a keyword, and both
 * `/discover/movie` and `/discover/tv` already take `with_keywords`, so a
 * seasonal shelf is a curated keyword set plus a quality floor — not a new
 * endpoint, query path or schema column.
 *
 * Two rules here come from measuring the live catalogue, not from taste:
 *
 * - Keywords are ORed (`a|b`). TMDB reads a comma as AND, and an AND over
 *   holiday tags collapses to nothing (christmas+christmas-eve: 51 titles,
 *   three tags: 1).
 * - The rating floor is a movie-view concern. The holiday keyword corpus on TV
 *   is an order of magnitude thinner than film (christmas: 3,378 movies vs 142
 *   shows), so the same floor that cleans up movies empties the TV tab
 *   completely for Valentine's, Easter, New Year and Hanukkah.
 */

import { parseKeywordIds } from '../utils/discoverParams.js';

export interface SeasonalPreset {
	/** Stable id, used as the key of the chip and in tests. */
	id: string;
	/** Paraglide message key for the label — this module stays i18n-free. */
	labelKey: string;
	/** TMDB keyword ids, matched with OR. */
	keywords: readonly number[];
	/** Minimum TMDB rating for views that include movies. Omitted = no floor. */
	minRating?: number;
}

export const SEASONAL_PRESETS: readonly SeasonalPreset[] = [
	{
		id: 'christmas',
		labelKey: 'discover_seasonal_christmas',
		// christmas, christmas eve, christmas special
		keywords: [207317, 260365, 255088],
		minRating: 6
	},
	{
		id: 'halloween',
		labelKey: 'discover_seasonal_halloween',
		// halloween, halloween night, halloween special
		keywords: [3335, 232795, 318653],
		minRating: 6
	},
	{
		id: 'thanksgiving',
		labelKey: 'discover_seasonal_thanksgiving',
		// thanksgiving, thanksgiving special
		keywords: [4543, 307493],
		minRating: 6
	},
	{
		id: 'valentines',
		labelKey: 'discover_seasonal_valentines',
		// valentine's day, valentine, cupid
		keywords: [160404, 251912, 180239],
		minRating: 6
	},
	{
		id: 'easter',
		labelKey: 'discover_seasonal_easter',
		// easter, easter bunny
		keywords: [9921, 9923],
		minRating: 5
	},
	{
		id: 'newyear',
		labelKey: 'discover_seasonal_newyear',
		// new year, happy new year
		keywords: [252123, 336526],
		minRating: 5
	},
	{
		id: 'hanukkah',
		labelKey: 'discover_seasonal_hanukkah',
		// hanukkah, chanukah
		keywords: [7328, 272884],
		minRating: 5
	}
];

/** Every floor a preset can inject — used to tell "ours" from "the viewer's". */
const PRESET_FLOORS = new Set(
	SEASONAL_PRESETS.flatMap((preset) =>
		preset.minRating === undefined ? [] : [String(preset.minRating)]
	)
);

/** The `with_keywords` value for a preset: OR-joined, never comma-joined. */
export function seasonalKeywordParam(preset: SeasonalPreset): string {
	return preset.keywords.join('|');
}

export function findActiveSeasonalPreset(
	withKeywords: string | null | undefined
): SeasonalPreset | null {
	const selected = new Set(parseKeywordIds(withKeywords ?? null));
	if (selected.size === 0) return null;
	return (
		SEASONAL_PRESETS.find(
			(preset) =>
				preset.keywords.length === selected.size && preset.keywords.every((id) => selected.has(id))
		) ?? null
	);
}

export interface SeasonalUrlChanges {
	/** Query params to set. */
	set: Record<string, string>;
	/** Query params to drop. */
	remove: string[];
}

export interface SeasonalCurrentState {
	type: string;
	withKeywords: string | null;
	minRating: string | null;
}

/**
 * URL mutations for clicking a seasonal chip.
 *
 * Applying a preset owns the keyword axis (it replaces a hand-picked keyword
 * list — the two cannot be sensibly combined) and the rating floor, because a
 * stale floor from another view is what turns a curated shelf into an empty
 * page. It never sets a floor on the TV tab: the TV corpus is too thin for one,
 * so it only unwinds a floor it previously injected. Toggling off unwinds
 * exactly what the preset added and leaves any viewer-chosen value alone.
 */
export function seasonalUrlChanges(
	preset: SeasonalPreset,
	current: SeasonalCurrentState
): SeasonalUrlChanges {
	const isActive = findActiveSeasonalPreset(current.withKeywords)?.id === preset.id;

	if (isActive) {
		const remove = ['with_keywords'];
		if (preset.minRating !== undefined && Number(current.minRating) === preset.minRating) {
			remove.push('vote_average.gte');
		}
		return { set: { page: '1' }, remove };
	}

	const set: Record<string, string> = {
		with_keywords: seasonalKeywordParam(preset),
		page: '1'
	};
	const remove: string[] = [];
	const injectedFloor = PRESET_FLOORS.has(current.minRating ?? '');

	if (current.type === 'tv') {
		if (injectedFloor) remove.push('vote_average.gte');
	} else if (preset.minRating !== undefined) {
		set['vote_average.gte'] = String(preset.minRating);
	} else if (injectedFloor) {
		remove.push('vote_average.gte');
	}

	return { set, remove };
}

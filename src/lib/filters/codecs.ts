import {
	SEASONAL_PRESETS,
	findActiveSeasonalPreset,
	seasonalUrlChanges
} from '#lib/config/seasonal.js';
import type { FacetCodec } from './types.js';

/**
 * URL codecs. Every facet owns exactly one, and it is the only place that
 * knows which parameter names a filter writes. Keeping this here means a new
 * kind adds a codec instead of a branch in the page.
 */

/** Discover has always accepted both separators: `,` for ids, `|` for OR-lists. */
function splitIds(raw: string | null, separator: RegExp): string[] {
	return (raw ?? '')
		.split(separator)
		.map((part) => part.trim())
		.filter(Boolean);
}

const YEAR = /^\d{4}$/;

/** One scalar parameter, e.g. `sort_by` or `with_original_language`.
 *
 *  `clearValue` is for facets with an explicit "no filter" marker: clearing
 *  writes the marker instead of deleting the parameter, so an instance-level
 *  default (the stored original-language filter) cannot silently come back.
 */
export function scalarParam(
	param: string,
	options: { legacy?: readonly string[]; clearValue?: string } = {}
): FacetCodec {
	const legacy = options.legacy ?? [];
	const clearValue = options.clearValue;
	return {
		read(params) {
			for (const key of [param, ...legacy]) {
				const raw = params.get(key);
				if (raw && raw !== clearValue) return { kind: 'scalar', value: raw };
			}
			return null;
		},
		write(params, value) {
			params.delete(param);
			for (const key of legacy) params.delete(key);
			if (value?.kind === 'scalar' && value.value) params.set(param, value.value);
			else if (clearValue) params.set(param, clearValue);
		}
	};
}

/** A list of ids in one parameter, e.g. `with_genres=28,12`. */
export function idsParam(
	param: string,
	options: { separator?: ',' | '|'; legacy?: readonly string[] } = {}
): FacetCodec {
	const separator = options.separator ?? ',';
	const splitter = separator === '|' ? /\|/ : /[|,]/;
	const legacy = options.legacy ?? [];
	return {
		read(params) {
			for (const key of [param, ...legacy]) {
				const ids = splitIds(params.get(key), splitter);
				if (ids.length > 0) return { kind: 'ids', ids };
			}
			return null;
		},
		write(params, value) {
			params.delete(param);
			for (const key of legacy) params.delete(key);
			if (value?.kind === 'ids' && value.ids.length > 0) {
				params.set(param, value.ids.join(separator));
			}
		}
	};
}

/** Include and exclude keyword lists, OR-joined with `|` as TMDB expects. */
export function keywordsParams(includeParam: string, excludeParam: string): FacetCodec {
	return {
		read(params) {
			const include = splitIds(params.get(includeParam), /[|,]/);
			const exclude = splitIds(params.get(excludeParam), /[|,]/);
			return include.length > 0 || exclude.length > 0
				? { kind: 'keywords', include, exclude }
				: null;
		},
		write(params, value) {
			params.delete(includeParam);
			params.delete(excludeParam);
			if (value?.kind !== 'keywords') return;
			if (value.include.length > 0) params.set(includeParam, value.include.join('|'));
			if (value.exclude.length > 0) params.set(excludeParam, value.exclude.join('|'));
		}
	};
}

/** Year inputs map onto TMDB's date bounds: a year is a whole calendar year. */
export function yearRangeParams(minParam: string, maxParam: string): FacetCodec {
	return {
		read(params) {
			const min = params.get(minParam)?.slice(0, 4) ?? '';
			const max = params.get(maxParam)?.slice(0, 4) ?? '';
			const boundedMin = YEAR.test(min) ? min : '';
			const boundedMax = YEAR.test(max) ? max : '';
			return boundedMin || boundedMax
				? { kind: 'range', min: boundedMin, max: boundedMax }
				: null;
		},
		write(params, value) {
			params.delete(minParam);
			params.delete(maxParam);
			if (value?.kind !== 'range') return;
			if (YEAR.test(value.min)) params.set(minParam, `${value.min}-01-01`);
			if (YEAR.test(value.max)) params.set(maxParam, `${value.max}-12-31`);
		}
	};
}

/** A single numeric floor, e.g. `vote_average.gte=7`. Zero means "no floor". */
export function numberParam(param: string): FacetCodec {
	return {
		read(params) {
			const raw = params.get(param);
			if (!raw) return null;
			const numeric = Number(raw);
			return Number.isFinite(numeric) && numeric > 0
				? { kind: 'number', value: String(numeric) }
				: null;
		},
		write(params, value) {
			params.delete(param);
			if (value?.kind !== 'number') return;
			const numeric = Number(value.value);
			if (Number.isFinite(numeric) && numeric > 0) params.set(param, String(numeric));
		}
	};
}

/**
 * Seasonal presets are keyword sets plus a rating floor, so the facet reads
 * and writes the two parameters the preset already owns. Reusing
 * `seasonalUrlChanges` keeps the "TV never gets a floor" rule in one place.
 */
export function seasonalCodec(): FacetCodec {
	return {
		read(params) {
			const preset = findActiveSeasonalPreset(params.get('with_keywords'));
			return preset ? { kind: 'scalar', value: preset.id } : null;
		},
		write(params, value) {
			const active = findActiveSeasonalPreset(params.get('with_keywords'));
			const targetId = value?.kind === 'scalar' ? value.value : '';
			const preset = SEASONAL_PRESETS.find((entry) => entry.id === targetId) ?? active;
			if (!preset) return;
			const { set, remove } = seasonalUrlChanges(preset, {
				type: params.get('type') ?? 'all',
				withKeywords: params.get('with_keywords'),
				minRating: params.get('vote_average.gte')
			});
			for (const key of remove) params.delete(key);
			for (const [key, next] of Object.entries(set)) params.set(key, next);
		}
	};
}

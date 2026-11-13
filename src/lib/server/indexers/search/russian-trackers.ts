/**
 * Russian tracker utilities.
 *
 * Russian trackers (RuTracker, Kinozal, etc.) need special handling:
 * - Single-lane queued searching to respect per-request throttling requirements
 * - Per-request rate limiting (every ~3 seconds minimum)
 * - Limited to 2 titles per automatic season search to avoid hammering
 * - Season-packs are pointer-ized (treated as individual episode results)
 * - Autumn search cache to avoid re-querying the same season within TTL
 */

import type { IIndexer } from '../types';

export const RUSSIAN_TRACKER_NAMES = [
	'rutracker',
	'kinozal',
	'rutor',
	'nnmclub',
	'nnm-club',
	'noname club',
	'rustorka'
];

export const RUTRACKER_AUTOMATIC_MAX_TITLES = 2;

export const RUTRACKER_AUTOMATIC_SEASON_CACHE_TTL_MS = 3 * 60_000;

export function prefersNativeCyrillicTitles(indexer: IIndexer): boolean {
	const name = (indexer.name ?? '').toLowerCase();
	if (RUSSIAN_TRACKER_NAMES.some((t) => name.includes(t))) return true;
	try {
		const hostname = new URL(indexer.baseUrl).hostname.toLowerCase();
		return hostname.endsWith('.ru') || hostname.includes('.ru.');
	} catch {
		return false;
	}
}

const CYRILLIC_REGEX = /\p{Script=Cyrillic}/u;

function isCyrillic(value: string): boolean {
	return CYRILLIC_REGEX.test(value);
}

/**
 * Order titles for a tracker that indexes Cyrillic releases.
 *
 * Cyrillic titles first, then exactly one non-Cyrillic fallback. RuTracker names
 * a topic "Русское название / English Title", so the original title is a
 * legitimate second query there - dropping every non-Cyrillic title, which is
 * what this used to do, made the English title unreachable even though the
 * releases carry it.
 *
 * The single-slot fallback is deliberate: on this tracker every title is a
 * request that can cost a browser-launched Cloudflare solve, so the list must
 * not turn into "Cyrillic titles plus everything else TMDB ever returned".
 */
export function orderTitlesForCyrillicTracker(titles: string[]): string[] {
	const cyrillic = titles.filter(isCyrillic);
	const others = titles.filter((title) => !isCyrillic(title));
	return [...cyrillic, ...others.slice(0, 1)];
}

export function isRuTrackerIndexerName(indexerName: string | undefined): boolean {
	if (!indexerName) return false;
	const normalized = indexerName.toLowerCase();
	return normalized.includes('rutracker') || normalized.includes('kinozal');
}

export function isRuTrackerHost(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	const normalized = baseUrl.toLowerCase();
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase();
		return hostname.includes('rutracker.') || hostname.includes('kinozal.');
	} catch {
		return normalized.includes('rutracker.') || normalized.includes('kinozal.');
	}
}

export function isRuTrackerRelease(indexerName: string | undefined): boolean {
	return isRuTrackerIndexerName(indexerName);
}

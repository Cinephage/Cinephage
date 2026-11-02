import { tmdb } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';
import { normalizeTmdbLanguage } from '#lib/server/languages/normalize.js';
import { tokenRegistry } from './tokens/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

/** Which TMDB details endpoint backs the localized title. */
export type LocalizedTitleKind = 'movie' | 'series';

/** Valid BCP-47-ish language spec: base tag plus optional script/region subtags. */
const LANGUAGE_SPEC_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const LOCALIZED_TITLE_TOKENS = new Set(['Title', 'CleanTitle']);

/**
 * Extract the lower-cased, deduplicated language codes referenced by localized
 * title tokens in a naming format.
 *
 * Tokens are resolved through the shared token registry so registry aliases
 * (`{SeriesCleanTitle:ja}`, `{Movie Title:pt-BR}`) work exactly like the
 * canonical `{Title:xx}` form; the spec grammar accepts full BCP-47 tags
 * (`pt-BR`, `zh-Hans`, `es-419`), not just bare 2-3 letter codes.
 */
export function extractLanguageCodes(format: string): string[] {
	const codes: string[] = [];
	for (const match of format.matchAll(/\{([^}:]+):([^}]+)\}/g)) {
		const token = tokenRegistry.get(match[1].trim());
		if (!token || !LOCALIZED_TITLE_TOKENS.has(token.name)) continue;
		const spec = match[2].trim();
		if (!LANGUAGE_SPEC_PATTERN.test(spec)) continue;
		codes.push(spec.toLowerCase());
	}
	return [...new Set(codes)];
}

/**
 * Explicit request locales for languages where likely-subtag maximization
 * would produce the wrong or an ambiguous region for TMDB (Chinese scripts:
 * TMDB serves `zh-CN` / `zh-TW`, not the bare or script-heavy forms).
 */
const EXPLICIT_REQUEST_LOCALES: Record<string, string> = {
	zh: 'zh-CN',
	'zh-hans': 'zh-CN',
	'zh-hant': 'zh-TW'
};

/**
 * Derived request locales keyed by lower-case code. `null` marks codes for
 * which no valid TMDB request locale can be derived — the fetch is skipped
 * (logged once per code) and the base title renders.
 */
const localeCache = new Map<string, string | null>();

/**
 * Derive a valid TMDB request locale (`ja-JP`, `de-DE`, ...) from a bare
 * language code.
 *
 * Order: explicit script map first, then the canonical base tag via the
 * shared ISO registry, region derived from `Intl.Locale#maximize()`, and
 * finally canonicalized with `Intl.getCanonicalLocales`. Returns null when
 * no valid locale can be derived (unknown code, `und`, unmaximizable tags).
 */
export function resolveRequestLocale(lang: string): string | null {
	const key = lang.toLowerCase();
	const cached = localeCache.get(key);
	if (localeCache.has(key)) return cached ?? null;

	let locale: string | null = EXPLICIT_REQUEST_LOCALES[key] ?? null;
	if (!locale && key.includes('-')) {
		// A full tag with an explicit region/script is authoritative
		// (`pt-BR` → pt-BR, `es-419` → es-419) — maximizing would pick the
		// wrong region for these.
		try {
			const [canonical] = Intl.getCanonicalLocales(key);
			if (canonical && canonical.includes('-')) locale = canonical;
		} catch {
			// Fall through to base-tag maximization.
		}
	}
	if (!locale) {
		const base = normalizeTmdbLanguage(key);
		if (base) {
			try {
				const maximized = new Intl.Locale(base).maximize();
				if (maximized.region) {
					// Rebuild language + region only: maximize() injects a script
					// subtag (`ja-Jpan-JP`) that TMDB does not accept.
					const [canonical] = Intl.getCanonicalLocales(`${base}-${maximized.region}`);
					locale = canonical ?? null;
				}
			} catch {
				// Invalid or unmaximizable tag (some 3-letter codes) — skip below.
			}
		}
	}

	localeCache.set(key, locale);
	if (!locale) {
		logger.warn(
			{ code: key },
			'[naming] No valid TMDB locale for language code; skipping localized-title fetch'
		);
	}
	return locale;
}

/**
 * Completed/in-flight localized-title fetches keyed by
 * `${kind}:${tmdbId}:${lang}` so preview and execute (and concurrent files of
 * the same title) share a single TMDB request per title + language.
 */
const titleCache = new Map<string, Promise<string | null>>();

function fetchLocalizedTitle(
	kind: LocalizedTitleKind,
	tmdbId: number,
	lang: string,
	locale: string
): Promise<string | null> {
	const key = `${kind}:${tmdbId}:${lang}`;
	const cached = titleCache.get(key);
	if (cached) return cached;

	const path = kind === 'series' ? '/tv' : '/movie';
	const pending = (async () => {
		try {
			const details = (await tmdb.fetch(
				`${path}/${tmdbId}?language=${locale}`,
				{},
				true
			)) as Record<string, unknown>;
			// Movie details expose `title`, TV details expose `name`.
			const title = kind === 'series' ? details.name : details.title;
			return typeof title === 'string' ? title : null;
		} catch {
			// Non-fatal: fall back to the default title (TMDB unconfigured, offline, ...).
			return null;
		}
	})();
	titleCache.set(key, pending);
	// Never pin a transient failure for the process lifetime: drop the entry
	// when the fetch resolved null so a later call retries (a stale negative
	// would rename to the base title after a TMDB blip).
	void pending.then((title) => {
		if (title === null && titleCache.get(key) === pending) {
			titleCache.delete(key);
		}
	});
	return pending;
}

/**
 * Clear the derived-locale and localized-title caches. Used by tests and by
 * callers that know TMDB settings changed underneath a long-lived process.
 */
export function clearLocalizationCaches(): void {
	localeCache.clear();
	titleCache.clear();
}

/**
 * Resolve localized titles for a movie/series TMDB id, keyed by the lower-case
 * language codes requested (matching `{Title:xx}` / `{CleanTitle:xx}` specs).
 * Codes without a derivable locale are skipped so the base title renders.
 */
export async function resolveLocalizedTitles(
	tmdbId: number,
	languages: string[],
	kind: LocalizedTitleKind = 'movie'
): Promise<Record<string, string>> {
	if (languages.length === 0) return {};

	const result: Record<string, string> = {};

	await Promise.allSettled(
		languages.map(async (lang) => {
			const locale = resolveRequestLocale(lang);
			if (!locale) return;
			const title = await fetchLocalizedTitle(kind, tmdbId, lang, locale);
			if (title) {
				result[lang] = title;
			}
		})
	);

	return result;
}

/**
 * Resolve localized titles for the codes referenced by the CURRENT naming
 * formats of a media kind. Shared by every naming writer (import, debrid
 * materialization, manual import, STRM creation, smart lists, rename) so a
 * `{Title:xx}` token renders the same localized title regardless of how the
 * file entered the library. Returns {} when the formats reference no
 * localized-title tokens (no network call).
 */
export async function resolveLocalizedTitlesForFormats(
	kind: LocalizedTitleKind,
	tmdbId: number | null | undefined
): Promise<Record<string, string>> {
	if (!tmdbId) return {};
	// Imported lazily to avoid a module cycle (settings service -> db -> ...).
	const { namingSettingsService } = await import('./NamingSettingsService.js');
	const config = namingSettingsService.getConfigSync();
	const formats =
		kind === 'movie'
			? [config.movieFolderFormat, config.movieFileFormat]
			: [
					config.seriesFolderFormat,
					config.episodeFileFormat,
					config.dailyEpisodeFormat,
					config.animeEpisodeFormat
				];
	const codes = extractLanguageCodes(formats.join(' '));
	if (codes.length === 0) return {};
	try {
		return await resolveLocalizedTitles(tmdbId, codes, kind);
	} catch {
		// Non-fatal: fall back to the base title.
		return {};
	}
}

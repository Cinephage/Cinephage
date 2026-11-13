/**
 * Search title languages - the explicit allowlist for which languages' titles
 * may be sent to an indexer.
 *
 * Without this, the languages a search may use are inferred from the item
 * (display language, original language) and the language profile. That is a
 * reasonable default, but it gives the user no way to say "search Russian and
 * English only" - and on a Cyrillic tracker every extra title is another
 * request that can cost a browser-launched Cloudflare solve.
 *
 * Stored inside `global_filters` beside the other discovery filters, so it needs
 * no schema change. An empty list means "keep inferring", which is the behaviour
 * every existing install already has.
 */
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';

const GLOBAL_FILTERS_KEY = 'global_filters';

/** Base ISO-639 code: `en-US` -> `en`, `zh_Hant` -> `zh`. */
function baseLanguageCode(tag: string): string {
	return tag.trim().replace(/_/g, '-').split('-')[0]!.toLowerCase();
}

/**
 * Languages the user pinned for search, as base codes.
 *
 * Returns an empty array when nothing is configured or the stored blob cannot be
 * read, so a corrupt setting degrades to the inferred behaviour rather than
 * disabling alternates entirely.
 */
export async function getSearchTitleLanguages(): Promise<string[]> {
	const row = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, GLOBAL_FILTERS_KEY))
		.get();

	if (!row?.value) return [];

	try {
		const parsed = JSON.parse(row.value) as { search_title_languages?: unknown };
		const raw = parsed.search_title_languages;
		if (!Array.isArray(raw)) return [];

		const codes = raw
			.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
			.map(baseLanguageCode)
			.filter((code) => code !== '');

		return [...new Set(codes)];
	} catch {
		return [];
	}
}

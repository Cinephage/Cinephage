import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { globalTmdbFiltersSchema } from '#lib/validation/schemas.js';
import { eq } from 'drizzle-orm';
import { tmdb } from '#lib/server/tmdb.js';
import type { GlobalTmdbFilters } from '#lib/types/tmdb.js';
import { parseBody } from '#lib/server/api/validate.js';
import { TMDB } from '#lib/config/constants.js';
import { normalizeMetadataLocale, normalizeRegionCode } from '#lib/server/languages/normalize.js';
import { LanguageSettingsService } from '#lib/server/subtitles/services/LanguageSettingsService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

const DEFAULT_FILTERS: GlobalTmdbFilters = {
	include_adult: false,
	min_vote_average: 0,
	min_vote_count: 0,
	language: `en-${TMDB.DEFAULT_REGION}`,
	region: TMDB.DEFAULT_REGION,
	excluded_genre_ids: []
};

export const GET: RequestHandler = async (event) => {
	// Require admin authentication
	const authError = requireAdmin(event);
	if (authError) return authError;

	const settingsData = await db.query.settings.findFirst({
		where: eq(settings.key, 'global_filters')
	});

	if (!settingsData) {
		return Response.json({ success: true, filters: DEFAULT_FILTERS });
	}

	try {
		const stored = JSON.parse(settingsData.value) as Partial<GlobalTmdbFilters>;
		return Response.json({
			success: true,
			filters: {
				...DEFAULT_FILTERS,
				...stored
			}
		});
	} catch {
		// Invalid JSON, return defaults
		return Response.json({ success: true, filters: DEFAULT_FILTERS });
	}
};

export const PUT: RequestHandler = async (event) => {
	// Require admin authentication
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	const result = await parseBody(request, globalTmdbFiltersSchema);

	await db
		.insert(settings)
		.values({
			key: 'global_filters',
			value: JSON.stringify(result)
		})
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: JSON.stringify(result) }
		});

	// Mirror the response locale/region into the language_settings singleton —
	// language_settings is the TMDB authority (migration 140 seeded it from
	// global_filters) and this keeps the two in sync until the language hub
	// replaces this UI. Unparseable values are skipped so the last good
	// singleton values survive; other singleton fields are untouched.
	const canonicalLocale = normalizeMetadataLocale(result.language);
	const canonicalRegion = normalizeRegionCode(result.region);
	if (canonicalLocale || canonicalRegion) {
		const patch: { metadataLocale?: string; region?: string } = {};
		if (canonicalLocale) patch.metadataLocale = canonicalLocale;
		if (canonicalRegion) patch.region = canonicalRegion;
		try {
			await LanguageSettingsService.getInstance().update(patch);
		} catch (e) {
			// The global_filters write already succeeded — never fail the request
			// because the mirror could not be applied.
			logger.warn({ err: e }, 'Failed to mirror filters language/region into language_settings');
		}
	}

	tmdb.invalidateSettings();

	return Response.json({ success: true, filters: result });
};

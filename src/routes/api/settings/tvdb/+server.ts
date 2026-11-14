import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { encryptSettingValue } from '#lib/server/settings/secretSettings.js';
import { parseBody } from '#lib/server/api/validate.js';
import { z } from 'zod';

const TVDB_SETTING = 'tvdb_api_key';

const tvdbSettingsSchema = z.object({
	apiKey: z.string().min(1, 'An API key is required')
});

/**
 * TheTVDB key.
 *
 * The only thing Cinephage needs from TVDB is the broadcast schedule: TMDB has
 * no air time, so the calendar and the episode tables render a time only when
 * this key is set. It lives here - not behind a raw settings write - because the
 * feature that depends on it is invisible without it.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const row = await db.query.settings.findFirst({ where: eq(settings.key, TVDB_SETTING) });

	return Response.json({ success: true, hasApiKey: Boolean(row?.value) });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { apiKey } = await parseBody(event.request, tvdbSettingsSchema);
	const trimmed = apiKey.trim();

	if (!trimmed) {
		return Response.json({ success: true, unchanged: true });
	}

	// v4 keys are long opaque strings; whitespace means a paste accident, and a
	// short value is not a key at all.
	if (/\s/.test(trimmed) || trimmed.length < 8) {
		return Response.json(
			{ error: 'That does not look like a TheTVDB v4 API key' },
			{ status: 400 }
		);
	}

	const stored = encryptSettingValue(TVDB_SETTING, trimmed);

	await db
		.insert(settings)
		.values({ key: TVDB_SETTING, value: stored })
		.onConflictDoUpdate({ target: settings.key, set: { value: stored } });

	// No cache to invalidate: TvdbClient reads the setting per call and keys its
	// token cache on the key's fingerprint, so the next request re-authenticates.

	return Response.json({ success: true });
};

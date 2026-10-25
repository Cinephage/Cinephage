import type { RequestHandler } from './$types';
import { getLanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { db } from '#lib/server/db/index.js';
import { libraries } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * GET /api/subtitles/language-settings/effective?mediaType=movie|series&libraryId=...
 *
 * Resolve the effective subtitle language profile for a NEW library item,
 * i.e. one that has not been added yet (add flow: discover, import,
 * calendar, TMDB hero).
 *
 * Resolution for a new item: per-item override cannot exist yet, so when the
 * add flow knows the destination library (`libraryId`), the library default
 * (libraries.language_profile_id) applies; otherwise the instance default
 * (language_settings.default_profile_id) is the only applicable level. The
 * response is `null` when neither resolves. The `mediaType` query parameter
 * is validated for forward compatibility but does not change resolution:
 * movies and series share the same defaults. Full resolution
 * (override > library > default) for EXISTING items is exposed by
 * GET /api/library/movies/[id] and GET /api/library/series/[id] via
 * `effectiveSubtitleRequirements` / `effectiveLanguageProfile`.
 *
 * Read-only like GET /api/subtitles/language-settings: authentication is
 * enforced by the global hooks, no admin gate (non-admin users see the add
 * forms).
 */
export const GET: RequestHandler = async (event) => {
	const mediaType = event.url.searchParams.get('mediaType');
	if (mediaType !== null && mediaType !== 'movie' && mediaType !== 'series') {
		return Response.json({ error: 'mediaType must be "movie" or "series"' }, { status: 400 });
	}

	const profileService = getLanguageProfileService();

	const libraryId = event.url.searchParams.get('libraryId');
	if (libraryId) {
		const [library] = await db
			.select({ languageProfileId: libraries.languageProfileId })
			.from(libraries)
			.where(eq(libraries.id, libraryId))
			.limit(1);

		if (library?.languageProfileId) {
			const profile = await profileService.getProfile(library.languageProfileId);
			if (profile) {
				return Response.json({ profile, source: 'library' });
			}
		}
	}

	const defaultProfile = await profileService.getDefaultProfile();
	if (!defaultProfile) {
		return Response.json(null);
	}

	return Response.json({ profile: defaultProfile, source: 'default' });
};

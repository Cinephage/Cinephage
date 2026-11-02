import type { RequestHandler } from './$types';
import { LanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { languageProfileV2CreateSchema } from '#lib/validation/schemas.js';
import { parseBody } from '#lib/server/api/validate.js';

/**
 * GET /api/subtitles/language-profiles
 * List all language profiles.
 */
export const GET: RequestHandler = async () => {
	const service = LanguageProfileService.getInstance();
	const profiles = await service.getProfiles();

	return Response.json(profiles);
};

/**
 * POST /api/subtitles/language-profiles
 * Create a new language profile (v2 shape: audio + ordered subtitle requirements).
 * The parsed schema output is forwarded directly; the service re-validates.
 */
export const POST: RequestHandler = async ({ request }) => {
	const validated = await parseBody(request, languageProfileV2CreateSchema);
	const service = LanguageProfileService.getInstance();

	const created = await service.createProfile(validated);

	return Response.json({ success: true, profile: created });
};

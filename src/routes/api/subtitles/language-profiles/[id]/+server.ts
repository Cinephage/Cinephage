import type { RequestHandler } from './$types';
import { LanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { languageProfileV2UpdateSchema } from '#lib/validation/schemas.js';
import { parseBody, assertFound } from '#lib/server/api/validate.js';

/**
 * GET /api/subtitles/language-profiles/:id
 * Get a single language profile by ID.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const service = LanguageProfileService.getInstance();

	// ?usage=1 → delete-impact preview instead of the profile body.
	if (url.searchParams.get('usage')) {
		const usage = await service.countProfileUsage(params.id);
		return Response.json(usage);
	}

	const profile = await service.getProfile(params.id);

	assertFound(profile, 'Language profile', params.id);

	return Response.json(profile);
};

/**
 * PUT /api/subtitles/language-profiles/:id
 * Update a language profile (v2 shape). The parsed schema output is forwarded
 * directly; the service re-validates.
 */
export const PUT: RequestHandler = async ({ params, request }) => {
	const validated = await parseBody(request, languageProfileV2UpdateSchema);
	const service = LanguageProfileService.getInstance();

	const updated = await service.updateProfile(params.id, validated);

	return Response.json({ success: true, profile: updated });
};

/**
 * DELETE /api/subtitles/language-profiles/:id
 * Delete a language profile.
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const service = LanguageProfileService.getInstance();
	await service.deleteProfile(params.id);
	return Response.json({ success: true });
};

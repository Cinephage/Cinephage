import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';

const patchSchema = z.object({
	defaultProfileId: z.string().min(1)
});

/** GET /api/music/settings — which music profile unassigned items inherit. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	// The instance default is not always what an item gets: the default music
	// library sits above it. Report both so an add dialog can show the truth.
	const libraries = await getLibraryEntityService().listLibraries({ mediaType: 'music' });
	const library = libraries.find((entry) => entry.isDefault) ?? libraries[0] ?? null;
	const effective = musicProfileService.resolve(null, null, library?.qualityProfileId);

	return Response.json({
		success: true,
		defaultProfileId: musicProfileService.getDefaultId(),
		effectiveProfile: { id: effective.id, name: effective.name }
	});
};

/** PATCH /api/music/settings — set the default music profile. */
export const PATCH: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const input = await parseBody(event.request, patchSchema);
	const updated = musicProfileService.setDefault(input.defaultProfileId);
	if (!updated) return Response.json({ error: 'Profile not found' }, { status: 404 });

	return Response.json({ success: true, defaultProfileId: input.defaultProfileId });
};

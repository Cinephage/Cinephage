import type { RequestHandler } from './$types';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { getRootFolderService } from '#lib/server/downloadClients/RootFolderService.js';
import {
	getEffectiveAnimeRootFolderEnforcement,
	setAnimeRootFolderEnforcement
} from '#lib/server/library/anime-root-enforcement-settings.js';
import { libraryClassificationUpdateSchema } from '#lib/validation/schemas.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const enforceAnimeSubtype = await getEffectiveAnimeRootFolderEnforcement();
	return Response.json({ enforceAnimeSubtype });
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let data: unknown;
	try {
		data = await event.request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = libraryClassificationUpdateSchema.safeParse(data);
	if (!parsed.success) {
		return Response.json(
			{ error: 'Validation failed', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	if (parsed.data.enforceAnimeSubtype) {
		const rootFolderService = getRootFolderService();
		const rootFolders = await rootFolderService.getFolders();
		const hasAnimeSubtypeFolder = rootFolders.some((folder) => folder.mediaSubType === 'anime');

		if (!hasAnimeSubtypeFolder) {
			return Response.json(
				{
					error:
						'At least one root folder with Anime subtype is required before enabling anime root folder enforcement.'
				},
				{ status: 400 }
			);
		}
	}

	await setAnimeRootFolderEnforcement(parsed.data.enforceAnimeSubtype);
	return Response.json({ success: true, enforceAnimeSubtype: parsed.data.enforceAnimeSubtype });
};

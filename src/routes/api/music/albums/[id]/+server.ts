import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { isAppError } from '#lib/errors/index.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';

const patchAlbumSchema = z
	.object({
		monitored: z.boolean().optional(),
		qualityProfileId: z.string().trim().min(1).nullable().optional(),
		title: z.string().trim().min(1).max(300).optional(),
		year: z.number().int().min(1900).max(2100).nullable().optional(),
		primaryType: z.string().trim().max(50).nullable().optional(),
		labelName: z.string().trim().max(200).nullable().optional(),
		catalogNumber: z.string().trim().max(100).nullable().optional(),
		barcode: z.string().trim().max(64).nullable().optional(),
		country: z.string().trim().max(100).nullable().optional()
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: 'Nothing to update'
	});

/** GET /api/music/albums/[id] — one album with its tracklist. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const album = musicAlbumService.getAlbum(event.params.id);
	if (!album) return Response.json({ error: 'Album not found' }, { status: 404 });

	return Response.json({ success: true, album });
};

/**
 * PATCH /api/music/albums/[id] — the album's own toggle.
 *
 * Monitoring belongs to the album because acquisition does: the album is the
 * unit that searches, grabs and imports, exactly like a movie. The artist's
 * flag only decides which albums a future discography refresh keeps.
 */
export const PATCH: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof patchAlbumSchema>;
	try {
		input = await parseBody(event.request, patchAlbumSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	try {
		let updated = true;
		if (input.monitored !== undefined) {
			updated = musicAlbumService.setMonitored(event.params.id, input.monitored) && updated;
		}
		if (input.qualityProfileId !== undefined) {
			updated = musicAlbumService.setQualityProfile(event.params.id, input.qualityProfileId) && updated;
		}

		const metadata = {
			title: input.title,
			year: input.year,
			primaryType: input.primaryType,
			labelName: input.labelName,
			catalogNumber: input.catalogNumber,
			barcode: input.barcode,
			country: input.country
		};
		if (Object.values(metadata).some((value) => value !== undefined)) {
			updated = musicAlbumService.updateMetadata(event.params.id, metadata) && updated;
		}

		if (!updated) return Response.json({ error: 'Album not found' }, { status: 404 });

		return Response.json({ success: true, album: musicAlbumService.getAlbum(event.params.id) });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(
				{ error: error.message, errorCode: error.code },
				{ status: error.statusCode }
			);
		}
		throw error;
	}
};

/** DELETE /api/music/albums/[id] — remove the album from the library. */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const removed = musicAlbumService.deleteAlbum(event.params.id);
	if (!removed) return Response.json({ error: 'Album not found' }, { status: 404 });

	return Response.json({ success: true });
};

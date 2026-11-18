import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { musicArtistService } from '#lib/server/music/MusicArtistService.js';
import { musicBrainz, MusicBrainzError } from '#lib/server/music/musicbrainz.js';

const logger = createChildLogger({ module: 'MusicArtistsApi', logDomain: 'system' });

const artistRefSchema = z.object({
	mbid: z.string().uuid(),
	name: z.string().min(1),
	sortName: z.string().nullish()
});

const addArtistSchema = z.object({
	artist: artistRefSchema,
	/** Albums to write in this call (1-25). Each costs ~3 gated MusicBrainz requests. */
	limit: z.number().int().min(1).max(25).default(25),
	libraryId: z.string().optional().nullable(),
	rootFolderId: z.string().optional().nullable(),
	monitored: z.boolean().default(true),
	/** Release-group primary types to take. Default: albums and EPs. */
	primaryTypes: z.array(z.string()).optional(),
	excludeSecondaryTypes: z.array(z.string()).optional()
});

/** GET /api/music/artists/[mbid]/preview?artistName= — what an add would do, without writing. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const mbid = event.url.searchParams.get('mbid')?.trim() ?? '';
	const name = event.url.searchParams.get('name')?.trim() ?? '';
	if (!mbid || !name) {
		return Response.json({ error: 'mbid and name are required' }, { status: 400 });
	}

	try {
		const preview = await musicArtistService.preview(
			{ mbid, name },
			{
				primaryTypes: event.url.searchParams.get('primaryTypes')?.split(',').filter(Boolean),
				excludeSecondaryTypes: event.url.searchParams
					.get('excludeSecondaryTypes')
					?.split(',')
					.filter(Boolean)
			}
		);
		return Response.json({ success: true, preview });
	} catch (err) {
		return Response.json(
			{
				error: 'Could not read that artist',
				details: err instanceof Error ? err.message : String(err)
			},
			{ status: err instanceof MusicBrainzError && err.status === 404 ? 404 : 502 }
		);
	}
};

/**
 * POST /api/music/artists — add an artist's discography, one batch at a time.
 *
 * The response carries `remaining`, so the caller continues until it reaches
 * zero instead of the server silently truncating a 65-album discography at one
 * request's timeout.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof addArtistSchema>;
	try {
		input = await parseBody(event.request, addArtistSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	let libraryId = input.libraryId ?? null;
	let rootFolderId = input.rootFolderId ?? null;
	if (!libraryId) {
		const musicLibraries = await getLibraryEntityService().listLibraries({ mediaType: 'music' });
		const target = musicLibraries.find((library) => library.isDefault) ?? musicLibraries[0] ?? null;
		libraryId = target?.id ?? null;
		rootFolderId = rootFolderId ?? target?.defaultRootFolderId ?? null;
	}

	try {
		const result = await musicArtistService.addArtist({
			artist: input.artist,
			limit: input.limit,
			policy: {
				libraryId,
				rootFolderId,
				monitored: input.monitored,
				primaryTypes: input.primaryTypes,
				excludeSecondaryTypes: input.excludeSecondaryTypes
			}
		});

		logger.info(
			{ artist: input.artist.name, added: result.added, remaining: result.remaining },
			'[MusicArtists] artist batch added'
		);
		return Response.json({ success: true, ...result }, { status: 201 });
	} catch (err) {
		logger.error(
			{ err: err instanceof Error ? err.message : String(err) },
			'[MusicArtists] add failed'
		);
		return Response.json(
			{
				error: 'Could not add that artist',
				details: err instanceof Error ? err.message : String(err)
			},
			{ status: err instanceof MusicBrainzError && err.status === 404 ? 404 : 502 }
		);
	}
};


const bulkMonitoredSchema = z.object({
	ids: z.array(z.string().min(1)).min(1).max(500),
	monitored: z.boolean()
});

/**
 * PATCH /api/music/artists — the list page's Monitor All / Unmonitor All.
 *
 * Monitoring an artist only decides what a discography refresh treats as
 * wanted; each album keeps its own acquisition flag, and this route does not
 * touch those.
 */
export const PATCH: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof bulkMonitoredSchema>;
	try {
		input = await parseBody(event.request, bulkMonitoredSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	let updated = 0;
	for (const id of input.ids) {
		if (musicArtistService.updateArtist(id, { monitored: input.monitored })) updated += 1;
	}

	return Response.json({ success: true, updated, requested: input.ids.length });
};

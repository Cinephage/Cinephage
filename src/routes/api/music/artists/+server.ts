import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { musicArtistService } from '#lib/server/music/MusicArtistService.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { searchAddedAlbums } from '#lib/server/music/MusicAutoSearch.js';
import { MusicBrainzError } from '#lib/server/music/musicbrainz.js';

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
	excludeSecondaryTypes: z.array(z.string()).optional(),
	/** Search the indexers for every album this call creates. */
	searchOnAdd: z.boolean().default(false),
	/** The artist's ladder; albums added by this run inherit it. */
	qualityProfileId: z.string().trim().min(1).nullable().optional()
});

const listQuerySchema = z.object({
	q: z.string().trim().max(200).optional(),
	file: z.enum(['all', 'downloaded', 'missing']).default('all'),
	monitor: z.enum(['all', 'monitored', 'unmonitored']).default('all'),
	libraryId: z.string().trim().min(1).optional(),
	quality: z.string().trim().min(1).optional(),
	sort: z.enum(['name-asc', 'name-desc', 'albums-desc', 'missing-desc']).default('name-asc'),
	offset: z.coerce.number().int().min(0).default(0),
	limit: z.coerce.number().int().min(1).max(180).default(90),
	/** `1` answers with the matching ids only, for select-all and monitor-all. */
	idsOnly: z.literal('1').optional()
});

/**
 * GET /api/music/artists — the Artists tab, one window at a time.
 *
 * The list's bulk actions need the whole filtered shelf, not only the rows the
 * reader has scrolled to, so `idsOnly=1` runs the same filters and returns ids.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const parsed = listQuerySchema.safeParse(Object.fromEntries(event.url.searchParams));
	if (!parsed.success) {
		return Response.json({ error: 'Invalid query' }, { status: 400 });
	}

	const { idsOnly, offset, limit, sort, ...filters } = parsed.data;
	if (idsOnly) {
		const ids = musicArtistService.listArtistIds(filters);
		return Response.json({ success: true, ids, total: ids.length });
	}

	const { rows, total } = musicArtistService.listArtistsPage({ ...filters, sort, offset, limit });
	return Response.json({
		success: true,
		artists: rows,
		total,
		hasMore: offset + rows.length < total
	});
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

	if (input.qualityProfileId && !musicProfileService.get(input.qualityProfileId)) {
		return Response.json(
			{ error: `Unknown music quality profile: ${input.qualityProfileId}` },
			{ status: 400 }
		);
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
				excludeSecondaryTypes: input.excludeSecondaryTypes,
				qualityProfileId: input.qualityProfileId ?? null
			}
		});

		logger.info(
			{ artist: input.artist.name, added: result.added, remaining: result.remaining },
			'[MusicArtists] artist batch added'
		);

		// The batch answers now; its new albums are searched behind it. A
		// discography is many searches, so they run one at a time in the
		// background rather than holding the add open.
		if (input.searchOnAdd) {
			const created = result.albums
				.filter((album) => album.created)
				.map((album) => musicAlbumService.getAlbum(album.albumId))
				.filter((album): album is NonNullable<typeof album> => album !== null)
				.map((album) => ({ id: album.id, title: album.title, artistName: album.artistName }));
			if (created.length > 0) void searchAddedAlbums(created);
		}

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


const bulkUpdateSchema = z
	.object({
		ids: z.array(z.string().min(1)).min(1).max(500),
		monitored: z.boolean().optional(),
		/** null clears the artist's own choice (inherit the library/default). */
		qualityProfileId: z.string().trim().min(1).nullable().optional()
	})
	.refine((value) => value.monitored !== undefined || value.qualityProfileId !== undefined, {
		message: 'Nothing to update'
	});

/**
 * PATCH /api/music/artists — the list page's bulk actions.
 *
 * Monitoring an artist only decides what a discography refresh treats as
 * wanted; each album keeps its own acquisition flag. A profile write is the
 * artist-level default every album inherits unless it names its own.
 */
export const PATCH: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof bulkUpdateSchema>;
	try {
		input = await parseBody(event.request, bulkUpdateSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	if (input.qualityProfileId && !musicProfileService.get(input.qualityProfileId)) {
		return Response.json(
			{ error: `Unknown music quality profile: ${input.qualityProfileId}` },
			{ status: 400 }
		);
	}

	let updated = 0;
	for (const id of input.ids) {
		if (
			musicArtistService.updateArtist(id, {
				...(input.monitored !== undefined ? { monitored: input.monitored } : {}),
				...(input.qualityProfileId !== undefined
					? { qualityProfileId: input.qualityProfileId }
					: {})
			})
		) {
			updated += 1;
		}
	}

	return Response.json({ success: true, updated, requested: input.ids.length });
};

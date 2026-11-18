import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import {
	musicBrainz,
	MusicBrainzError,
	pickPrimaryRelease
} from '#lib/server/music/musicbrainz.js';

const logger = createChildLogger({ module: 'MusicAlbumsApi', logDomain: 'system' });

const addAlbumSchema = z.object({
	/** The release group (the work) picked from a search result. */
	releaseGroupMbid: z.string().uuid(),
	/** A specific edition; omitted means "pick the primary one". */
	releaseMbid: z.string().uuid().optional().nullable(),
	libraryId: z.string().optional().nullable(),
	rootFolderId: z.string().optional().nullable(),
	monitored: z.boolean().default(true)
});

/** GET /api/music/albums?libraryId= — the library list. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const libraryId = event.url.searchParams.get('libraryId')?.trim() || null;
	return Response.json({ success: true, albums: musicAlbumService.listAlbums({ libraryId }) });
};

/**
 * POST /api/music/albums — add one album.
 *
 * The reference is a release *group*; the edition and its tracklist are fetched
 * here rather than trusted from the client, so a stale or hand-edited search
 * result cannot write a tracklist. Idempotent: re-adding an album returns the
 * existing row with `created: false`.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof addAlbumSchema>;
	try {
		input = await parseBody(event.request, addAlbumSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	try {
		// An album added without a library goes to the default music library, with
		// that library's default root folder — otherwise it is stored with no home
		// and never shows up in a library view.
		let libraryId = input.libraryId ?? null;
		let rootFolderId = input.rootFolderId ?? null;
		if (!libraryId) {
			const musicLibraries = await getLibraryEntityService().listLibraries({ mediaType: 'music' });
			const target =
				musicLibraries.find((library) => library.isDefault) ?? musicLibraries[0] ?? null;
			libraryId = target?.id ?? null;
			rootFolderId = rootFolderId ?? target?.defaultRootFolderId ?? null;
		}

		const releaseGroup = await musicBrainz.getReleaseGroup(input.releaseGroupMbid);

		let releaseMbid = input.releaseMbid ?? null;
		if (!releaseMbid) {
			const editions = await musicBrainz.getReleaseGroupReleases(releaseGroup.mbid);
			const primary = pickPrimaryRelease(editions);
			if (!primary) {
				return Response.json(
					{ error: 'That release group has no editions to import' },
					{ status: 422 }
				);
			}
			releaseMbid = primary.mbid;
		}

		const release = await musicBrainz.getRelease(releaseMbid);
		const result = musicAlbumService.addAlbum({
			releaseGroup,
			release,
			libraryId,
			rootFolderId,
			monitored: input.monitored
		});

		return Response.json(
			{ success: true, ...result, album: musicAlbumService.getAlbum(result.albumId) },
			{ status: result.created ? 201 : 200 }
		);
	} catch (err) {
		if (err instanceof MusicBrainzError) {
			logger.warn(
				{ err: err.message, status: err.status, retryable: err.retryable },
				'[MusicAlbums] MusicBrainz failed while adding an album'
			);
			return Response.json(
				{ error: 'MusicBrainz request failed', details: err.message, retryable: err.retryable },
				{ status: err.status === 404 ? 404 : 502 }
			);
		}
		logger.error(
			{ err: err instanceof Error ? err.message : String(err) },
			'[MusicAlbums] add failed'
		);
		return Response.json(
			{
				error: 'Could not add the album',
				details: err instanceof Error ? err.message : String(err)
			},
			{ status: 500 }
		);
	}
};


const bulkMonitoredSchema = z.object({
	ids: z.array(z.string().min(1)).min(1).max(500),
	monitored: z.boolean()
});

/**
 * PATCH /api/music/albums — the list page's Monitor All / Unmonitor All.
 *
 * One request for a whole filtered shelf: the library toolbar acts on what the
 * user is looking at, and a loop of per-album PATCHes would be N round trips
 * with no atomicity between them.
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
		if (musicAlbumService.setMonitored(id, input.monitored)) updated += 1;
	}

	return Response.json({ success: true, updated, requested: input.ids.length });
};

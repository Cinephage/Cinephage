import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { rejectedReleases, movies, series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { grabService } from '#lib/server/downloads/GrabService.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'ReportsRejectedOverride', logDomain: 'downloads' });

/**
 * POST /api/reports/rejected-releases/[id]/override
 * Force-grab a previously rejected release, bypassing the decision pipeline.
 * On success, marks the record as 'overridden'.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const { id } = event.params;

	const record = await db.query.rejectedReleases.findFirst({
		where: eq(rejectedReleases.id, id)
	});

	if (!record) {
		return Response.json({ success: false, error: 'Record not found' }, { status: 404 });
	}

	if (!record.downloadUrl && !record.magnetUrl && !record.infoHash) {
		return Response.json(
			{
				success: false,
				error:
					'This record was rejected before grab data was stored. Re-search to find a new release.'
			},
			{ status: 422 }
		);
	}

	// Resolve the grab target from the linked media
	let target: Parameters<typeof grabService.grab>[0]['target'];
	if (record.mediaType === 'movie' && record.tmdbId) {
		const movie = await db.query.movies.findFirst({
			where: eq(movies.tmdbId, record.tmdbId)
		});
		if (!movie) {
			return Response.json(
				{ success: false, error: 'Linked movie not found in library' },
				{ status: 422 }
			);
		}
		target = { type: 'movie', movieId: movie.id };
	} else if (record.mediaType === 'tv' && record.tmdbId) {
		const show = await db.query.series.findFirst({
			where: eq(series.tmdbId, record.tmdbId)
		});
		if (!show) {
			return Response.json(
				{ success: false, error: 'Linked series not found in library' },
				{ status: 422 }
			);
		}
		target = { type: 'series', seriesId: show.id, episodeIds: [] };
	} else {
		return Response.json(
			{ success: false, error: 'Cannot resolve grab target — no linked media' },
			{ status: 422 }
		);
	}

	try {
		const result = await grabService.grab(
			{
				release: {
					title: record.releaseTitle,
					downloadUrl: record.downloadUrl ?? undefined,
					magnetUrl: record.magnetUrl ?? undefined,
					infoHash: record.infoHash ?? undefined,
					guid: record.indexerGuid ?? undefined,
					indexerId: record.indexerId ?? undefined,
					indexerName: record.indexerName ?? undefined,
					protocol: (record.protocol as 'torrent' | 'usenet' | 'streaming') ?? 'torrent',
					size: record.releaseSize ?? undefined,
					releaseGroup: record.releaseGroup ?? undefined
				},
				target,
				options: {
					isAutomatic: false,
					force: true,
					skipBlocklist: true,
					allowSidegrade: false,
					acquisitionProtocol: 'default'
				}
			},
			{ forceOverride: true }
		);

		if (!result.success) {
			logger.warn(
				{ id, title: record.releaseTitle, error: result.error },
				'[Reports] Override grab failed'
			);
			return Response.json(
				{ success: false, error: result.error ?? 'Grab failed' },
				{ status: 500 }
			);
		}

		// Mark record as overridden
		await db
			.update(rejectedReleases)
			.set({ status: 'overridden' })
			.where(eq(rejectedReleases.id, id));

		return Response.json({ success: true, data: { download: result.download } });
	} catch (err) {
		logger.error({ err, id, title: record.releaseTitle }, '[Reports] Override grab threw');
		return Response.json({ success: false, error: 'Internal error during grab' }, { status: 500 });
	}
};

import type { RequestHandler } from './$types';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { grabService } from '#lib/server/downloads/GrabService.js';
import { parseBody } from '#lib/server/api/validate.js';
import { grabRequestSchema, type GrabRequest as GrabRequestBody } from '#lib/validation/schemas.js';
import type { GrabResponse } from '#lib/types/queue.js';
import type { GrabRequest as ServiceGrabRequest } from '#lib/server/downloads/grab-types.js';
import type { GrabTarget } from '#lib/server/filters/stages/grab/types.js';
import {
	categoryMatchesSearchType,
	getCategoryContentType
} from '#lib/server/indexers/types/index.js';
import { logger } from '#lib/logging/index.js';
import { isAppError } from '#lib/errors/index.js';
import { getDefaultAcquisitionProtocol } from '#lib/server/settings/acquisition.js';

export const POST: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	let data: GrabRequestBody;
	try {
		data = await parseBody(event.request, grabRequestSchema);
	} catch (error) {
		// parseBody throws AppError (e.g. ValidationError) on invalid input. Return it with
		// its real status code instead of letting SvelteKit surface an opaque 500.
		if (isAppError(error)) {
			logger.warn(
				{ logDomain: 'downloads', code: error.code, context: error.context },
				'[Grab] Rejected: invalid request body'
			);
			return Response.json(
				{ success: false, error: error.message, errorCode: error.code } satisfies GrabResponse,
				{ status: error.statusCode }
			);
		}
		throw error;
	}

	if (data.categories && data.categories.length > 0) {
		const searchType = data.mediaType === 'movie' ? 'movie' : 'tv';
		const hasMatchingCategory = data.categories.some((cat) =>
			categoryMatchesSearchType(cat, searchType)
		);

		if (!hasMatchingCategory) {
			const actualContentType = getCategoryContentType(data.categories[0]);
			logger.error(
				{
					logDomain: 'downloads',
					title: data.title,
					expectedType: data.mediaType,
					actualContentType,
					categories: data.categories
				},
				'[Grab] BLOCKED: Release category mismatch - potential wrong content type'
			);
			return Response.json(
				{
					success: false,
					error: `Category mismatch: ${actualContentType} release cannot be grabbed for ${data.mediaType}`
				} satisfies GrabResponse,
				{ status: 422 }
			);
		}
	}

	if (!data.protocol) {
		logger.warn(
			{
				logDomain: 'downloads',
				title: data.title,
				mediaType: data.mediaType,
				indexerId: data.indexerId,
				indexerName: data.indexerName,
				hasDownloadUrl: !!data.downloadUrl,
				hasMagnetUrl: !!data.magnetUrl,
				hasInfoHash: !!data.infoHash
			},
			'[Grab] BLOCKED: Missing protocol field in request'
		);
		return Response.json({ success: false, error: 'protocol is required' } satisfies GrabResponse, {
			status: 422
		});
	}

	const force = data.isAutomatic ? (data.force ?? false) : (data.force ?? true);

	const target = buildTarget(data);

	const serviceRequest: ServiceGrabRequest = {
		release: {
			title: data.title,
			downloadUrl: data.downloadUrl,
			magnetUrl: data.magnetUrl,
			infoHash: data.infoHash,
			indexerId: data.indexerId,
			indexerName: data.indexerName,
			size: data.size,
			publishDate: data.publishDate ? new Date(data.publishDate) : undefined,
			protocol: data.protocol,
			guid: data.guid,
			commentsUrl: data.commentsUrl,
			categories: data.categories,
			tmdbId: data.tmdbId,
			imdbId: data.imdbId,
			tvdbId: data.tvdbId,
			releaseGroup: undefined
		},
		target,
		options: {
			force,
			skipBlocklist: false,
			allowSidegrade: false,
			isAutomatic: data.isAutomatic ?? false,
			source: data.source,
			downloadClientId: undefined,
			isUpgrade: data.isUpgrade,
			streamUsenet: data.streamUsenet,
			acquisitionProtocol:
				data.acquisitionProtocol ?? (data.isAutomatic ? getDefaultAcquisitionProtocol() : 'default')
		}
	};

	let result:
		| {
				success: false;
				decision: Awaited<ReturnType<typeof grabService.grab>>['decision'];
				error: string;
		  }
		| Awaited<ReturnType<typeof grabService.grab>>;
	try {
		result = await grabService.grab(serviceRequest);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error(
			{ logDomain: 'downloads', error: message, title: data.title },
			'Failed to grab release'
		);
		return Response.json({ success: false, error: message } satisfies GrabResponse, {
			status: 500
		});
	}

	if (!result.success) {
		if (result.error) {
			return Response.json(
				{
					success: false,
					error: result.error,
					decision: result.decision
				} satisfies GrabResponse,
				{ status: 500 }
			);
		}

		return Response.json(
			{
				success: false,
				error: result.decision.reason || 'Release does not meet requirements',
				rejectionType: result.decision.rejectionType,
				decision: result.decision
			} satisfies GrabResponse,
			{ status: 422 }
		);
	}

	return Response.json({
		success: true,
		data: {
			...result.download!,
			hash: result.download!.hash ?? ''
		},
		decision: result.decision
	} satisfies GrabResponse);
};

function buildTarget(data: {
	movieId?: string;
	seriesId?: string;
	episodeIds?: string[];
	seasonNumber?: number;
}): GrabTarget {
	if (data.movieId) {
		return { type: 'movie', movieId: data.movieId };
	}

	const seriesId = data.seriesId!;

	if (data.seasonNumber != null && (!data.episodeIds || data.episodeIds.length === 0)) {
		return { type: 'season', seriesId, seasonNumber: data.seasonNumber, episodeIds: [] };
	}

	if (data.episodeIds && data.episodeIds.length === 1) {
		return { type: 'episode', episodeId: data.episodeIds[0], seriesId };
	}

	if (data.episodeIds && data.episodeIds.length > 1 && data.seasonNumber != null) {
		return {
			type: 'season',
			seriesId,
			seasonNumber: data.seasonNumber,
			episodeIds: data.episodeIds
		};
	}

	return { type: 'series', seriesId, episodeIds: data.episodeIds ?? [] };
}

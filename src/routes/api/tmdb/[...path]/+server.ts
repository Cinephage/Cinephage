import { tmdb } from '#lib/server/tmdb.js';
import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { isAppError, getErrorMessage } from '#lib/errors/index.js';
import {
	enrichWithLibraryStatus,
	filterBlockedMedia,
	annotateRequestState
} from '#lib/server/library/status.js';
import { enrichWithReleaseDates } from '#lib/server/release-enrichment.js';

/**
 * Determine media type from TMDB endpoint path for library status enrichment
 */
function getMediaTypeFromPath(path: string): 'movie' | 'tv' | 'all' {
	if (path.startsWith('movie/') || path.includes('/movie')) return 'movie';
	if (path.startsWith('tv/') || path.includes('/tv')) return 'tv';
	return 'all';
}

const handler: RequestHandler = async ({ params, url, locals }) => {
	const { correlationId } = locals;
	const log = createChildLogger({ correlationId, service: 'tmdb-proxy' });

	// Rate limiting: the central /api gate in hooks.server.ts already caps
	// unauthenticated clients far below anything this per-route limiter would
	// have caught, and authenticated sessions are deliberately unthrottled —
	// the old 1000/min in-memory limit here was unreachable dead weight.

	const path = params.path;
	if (!path) {
		log.warn('Request missing path');
		return Response.json({ error: 'No path provided', correlationId }, { status: 400 });
	}

	// Forward query params
	const query = url.searchParams.toString();
	const endpoint = query ? `${path}?${query}` : path;

	try {
		log.debug({ endpoint }, 'Proxying TMDB request');

		const data = await tmdb.fetch(endpoint);

		log.debug({ endpoint }, 'TMDB request successful');

		// Enrich results with library status if this is a list response
		if (data && typeof data === 'object' && 'results' in data && Array.isArray(data.results)) {
			const mediaType = getMediaTypeFromPath(path);
			const enrichedResults = await enrichWithLibraryStatus(data.results, mediaType);
			const filteredResults = await filterBlockedMedia(enrichedResults, mediaType);
			const withReleaseDates = await enrichWithReleaseDates(filteredResults);
			// Request-state badges ride the same response (server truth, no
			// client-side request-list filtering).
			const withRequestState = await annotateRequestState(
				withReleaseDates,
				mediaType,
				locals.user?.id ?? null
			);
			return Response.json({ ...data, results: withRequestState });
		}

		return Response.json(data);
	} catch (e) {
		const message = getErrorMessage(e);
		const statusCode = isAppError(e) ? e.statusCode : 500;

		log.error({ err: e, ...{ endpoint } }, 'TMDB proxy error');

		return Response.json({ error: message, correlationId }, { status: statusCode });
	}
};

// Only expose GET — write methods (POST/PUT/DELETE) are not used
export const GET = handler;

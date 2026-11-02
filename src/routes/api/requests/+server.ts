/**
 * User-facing request list + creation.
 *
 * GET  /api/requests — viewers see only their own (server-enforced);
 *                      admins see all. Query: filter, mediaType, take, skip,
 *                      sort (added|modified).
 * POST /api/requests — create a request (any non-banned account; further
 *                      gating lives in RequestService with machine codes).
 *
 * The viewer allowlist in hooks.server.ts admits both verbs for non-admins;
 * self-scoping is enforced HERE, never in the UI.
 */

import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { user } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import { parseBody } from '#lib/server/api/validate.js';
import { getRequestService } from '#lib/server/requests/RequestService.js';
import {
	createRequestSchema,
	toRequestErrorResponse,
	requesterFromLocals
} from '#lib/server/requests/http.js';
import type { RequestRecord } from '#lib/server/db/schema.js';
import type { RequestStatus } from '#lib/server/requests/types.js';

const FILTER_TO_STATUSES: Record<string, RequestStatus[]> = {
	all: [],
	pending: ['pending'],
	approved: ['approved', 'awaiting_target'],
	fulfilled: ['fulfilled'],
	processing: ['approved'],
	failed: ['failed'],
	declined: ['declined', 'expired'],
	cancelled: ['cancelled']
};

/**
 * Explicit response DTO: everything the client type declares plus display
 * names. actingUserId / ignoreQuota / episodeCountSnapshot never cross the
 * wire — the row spread that preceded this leaked them to viewers.
 */
function toRequestDto(
	r: RequestRecord,
	usersById: Map<string, string>
): Record<string, unknown> & { requestedByName: string | null; decidedByName: string | null } {
	return {
		id: r.id,
		mediaType: r.mediaType,
		tmdbId: r.tmdbId,
		title: r.title,
		posterPath: r.posterPath,
		year: r.year,
		movieId: r.movieId,
		seriesId: r.seriesId,
		status: r.status,
		seasons: r.seasons,
		episodes: r.episodes,
		requestedBy: r.requestedBy,
		decidedBy: r.decidedBy,
		autoApproved: r.autoApproved,
		declineReason: r.declineReason,
		failureReason: r.failureReason,
		expiresAt: r.expiresAt,
		decidedAt: r.decidedAt,
		fulfilledAt: r.fulfilledAt,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		requestedByName: usersById.get(r.requestedBy) ?? null,
		decidedByName: r.decidedBy ? (usersById.get(r.decidedBy) ?? null) : null
	};
}

export const GET: RequestHandler = async (event) => {
	const requester = requesterFromLocals(event.locals);
	if (!requester) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const filter = event.url.searchParams.get('filter') ?? 'all';
	const mediaTypeParam = event.url.searchParams.get('mediaType');
	const sortParam = event.url.searchParams.get('sort');
	const take = Number(event.url.searchParams.get('take') ?? 50);
	const skip = Number(event.url.searchParams.get('skip') ?? 0);

	const statuses = FILTER_TO_STATUSES[filter] ?? [];
	const results = await getRequestService().listRequests({
		// Viewers are hard-scoped to their own rows; admins see everything.
		requesterId: requester.role === 'admin' ? undefined : requester.id,
		statuses: statuses.length > 0 ? statuses : undefined,
		mediaType:
			mediaTypeParam === 'movie' || mediaTypeParam === 'series' ? mediaTypeParam : undefined,
		take: Number.isFinite(take) ? take : 50,
		skip: Number.isFinite(skip) ? skip : 0,
		sort: sortParam === 'modified' ? 'modified' : 'added'
	});

	// Decorate with display names so the admin queue can attribute rows.
	const userIds = [
		...new Set(results.flatMap((r) => [r.requestedBy, r.decidedBy].filter((v): v is string => !!v)))
	];
	const usersById = new Map<string, string>();
	if (userIds.length > 0) {
		const rows = await db
			.select({ id: user.id, displayUsername: user.displayUsername, name: user.name })
			.from(user)
			.where(inArray(user.id, userIds));
		for (const row of rows) {
			usersById.set(row.id, row.displayUsername || row.name || row.id);
		}
	}

	return Response.json({
		success: true,
		requests: results.map((r) => toRequestDto(r, usersById))
	});
};

export const POST: RequestHandler = async (event) => {
	const requester = requesterFromLocals(event.locals);
	if (!requester) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await parseBody(event.request, createRequestSchema);
		const created = await getRequestService().create(requester, body);
		return Response.json({ success: true, request: created }, { status: 201 });
	} catch (error) {
		return toRequestErrorResponse(error);
	}
};

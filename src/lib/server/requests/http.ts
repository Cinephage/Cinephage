import { z } from 'zod';
import { isAppError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { RequestRecord } from '#lib/server/db/schema.js';
import { RequestError, type RequesterContext } from './types.js';

const logger = createChildLogger({ module: 'RequestHttp', logDomain: 'system' });

/**
 * Builds the requester context from SvelteKit locals. Null when
 * unauthenticated. `actingUserId` captures admin impersonation.
 */
export function requesterFromLocals(locals: App.Locals): RequesterContext | null {
	if (!locals.user) return null;
	return {
		id: locals.user.id,
		role: locals.user.role === 'admin' ? 'admin' : 'user',
		actingUserId: locals.session?.impersonatedBy ?? null,
		banned: locals.user.banned ?? false
	};
}

const videoRequestSchema = z.object({
	mediaType: z.enum(['movie', 'series']),
	tmdbId: z.number().int().positive(),
	seasons: z.array(z.number().int().positive()).optional(),
	episodes: z
		.array(
			z.object({
				seasonNumber: z.number().int().positive(),
				episodeNumber: z.number().int().positive()
			})
		)
		.optional()
});

export const createRequestSchema = z.discriminatedUnion('mediaType', [
	videoRequestSchema,
	z.object({
		mediaType: z.literal('music'),
		mbid: z.string().trim().min(1).max(64)
	})
]);

/**
 * Explicit response DTO: everything the client type declares plus display
 * names. actingUserId / ignoreQuota / episodeCountSnapshot never cross the
 * wire - the row spread that preceded this leaked them to viewers.
 */export function toRequestDto(
	r: RequestRecord,
	usersById: Map<string, string>
): Record<string, unknown> & { requestedByName: string | null; decidedByName: string | null } {
	return {
		id: r.id,
		mediaType: r.mediaType,
		tmdbId: r.tmdbId,
		mbid: r.mbid,
		albumId: r.albumId,
		title: r.title,
		posterPath: r.posterPath,
		coverUrl: r.coverUrl,
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

export const declineRequestSchema = z.object({
	reason: z.string().min(1).max(500)
});

export const bulkRequestSchema = z.object({
	ids: z.array(z.string().min(1)).min(1).max(50),
	action: z.enum(['approve', 'decline']),
	reason: z.string().min(1).max(500).optional()
});

/** Maps RequestError (code + context) onto the standard error envelope. */
export function toRequestErrorResponse(error: unknown): Response {
	if (error instanceof RequestError) {
		return Response.json(
			{
				success: false,
				error: error.message,
				code: error.code,
				...error.context
			},
			{ status: error.statusCode }
		);
	}
	if (isAppError(error)) {
		return Response.json({ success: false, ...error.toJSON() }, { status: error.statusCode });
	}
	// Unknown failures never leak internals to the (viewer-reachable)
	// create path; the detail stays in the server log.
	logger.error(
		{ error: error instanceof Error ? error.message : String(error) },
		'[Requests] Unhandled error surfaced to a client'
	);
	return Response.json(
		{ success: false, error: 'Request failed', code: 'internal' },
		{ status: 500 }
	);
}

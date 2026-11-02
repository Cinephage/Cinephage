import { z } from 'zod';
import { isAppError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
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

export const createRequestSchema = z.object({
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

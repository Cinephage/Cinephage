/**
 * GET  /api/user/sessions — list the signed-in user's own sessions
 * DELETE /api/user/sessions — revoke own sessions; body { sessionId? } revokes
 * one session, an empty body revokes every OTHER session. The current
 * session can never be revoked through this endpoint (use sign-out).
 *
 * Auth: any authenticated user; rows are hard-scoped to locals.user.id so
 * the endpoint is safe for viewer accounts.
 */

import type { RequestHandler } from './$types.js';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { session } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { parseOptionalBody } from '#lib/server/api/validate.js';
import { z } from 'zod';

const logger = createChildLogger({ module: 'UserSessionsApi', logDomain: 'auth' });

const revokeSchema = z.object({
	sessionId: z.string().min(1).optional()
});

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const rows = await db
		.select({
			id: session.id,
			userAgent: session.userAgent,
			ipAddress: session.ipAddress,
			createdAt: session.createdAt,
			lastActiveAt: session.lastActiveAt,
			expiresAt: session.expiresAt,
			token: session.token
		})
		.from(session)
		.where(eq(session.userId, locals.user.id));

	const currentToken = locals.session?.token ?? null;
	return Response.json({
		success: true,
		// Tokens are only compared server-side, never shipped to the client.
		sessions: rows.map(({ token, ...rest }) => ({ ...rest, current: token === currentToken }))
	});
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const currentToken = locals.session?.token ?? null;

	// Missing body = "revoke all other sessions"; a present-but-invalid
	// body is rejected rather than silently falling back to revoke-all.
	let sessionId: string | undefined;
	try {
		sessionId = (await parseOptionalBody(request, revokeSchema)).sessionId;
	} catch {
		return Response.json({ success: false, error: 'Invalid request body' }, { status: 400 });
	}

	if (sessionId) {
		// Scoped by userId: a forged sessionId belonging to another account
		// simply matches nothing, and the current session is exempt.
		const revoked = await db
			.delete(session)
			.where(
				and(
					eq(session.id, sessionId),
					eq(session.userId, locals.user.id),
					currentToken ? ne(session.token, currentToken) : undefined
				)
			)
			.returning({ id: session.id });

		if (revoked.length === 0) {
			return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
		}

		logger.info({ userId: locals.user.id }, '[UserSessions] Revoked one own session');
		return Response.json({ success: true });
	}

	await db
		.delete(session)
		.where(
			and(
				eq(session.userId, locals.user.id),
				currentToken ? ne(session.token, currentToken) : undefined
			)
		);

	logger.info({ userId: locals.user.id }, '[UserSessions] Revoked all other own sessions');
	return Response.json({ success: true });
};

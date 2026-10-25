/**
 * Admin session revocation by opaque session id.
 *
 * POST /api/settings/users/[userId]/sessions/[sessionId]/revoke
 *
 * better-auth's revoke-user-session takes the raw session token; this
 * endpoint resolves the id -> token server-side so live bearer tokens never
 * need to ship to the admin browser. The session must belong to [userId].
 *
 * Auth: admin only.
 */

import type { RequestHandler } from './$types.js';
import { and, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { session as sessionTable } from '#lib/server/db/schema.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { auth } from '#lib/server/auth/index.js';

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { userId, sessionId } = event.params;

	const [row] = await db
		.select({ token: sessionTable.token })
		.from(sessionTable)
		.where(and(eq(sessionTable.id, sessionId), eq(sessionTable.userId, userId)))
		.limit(1);

	if (!row) {
		return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
	}

	// The admin plugin's endpoint authorizes from the request context, so the
	// admin session headers must be forwarded or it rejects with UNAUTHORIZED
	// before ever reaching the token.
	await auth.api.revokeUserSession({
		body: { sessionToken: row.token },
		headers: event.request.headers
	});

	return Response.json({ success: true });
};

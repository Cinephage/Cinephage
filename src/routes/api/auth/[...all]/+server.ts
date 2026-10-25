import type { RequestHandler } from './$types';
import { auth } from '#lib/server/auth/auth.js';

/**
 * Better Auth's catch-all endpoint — its documented SvelteKit mounting point.
 * The rest segment is optional in SvelteKit, so bare /api/auth matches too.
 *
 * Serving /api/auth through a real route (instead of intercepting the path
 * prefix in hooks.server.ts) keeps auth requests inside the full hook chain,
 * so they receive correlation IDs, security headers, and request logging
 * like every other route. All methods forward verbatim to auth.handler.
 */
const handleAuth: RequestHandler = ({ request }) => auth.handler(request);

export const GET = handleAuth;
export const POST = handleAuth;
export const PUT = handleAuth;
export const PATCH = handleAuth;
export const DELETE = handleAuth;
export const HEAD = handleAuth;
export const OPTIONS = handleAuth;

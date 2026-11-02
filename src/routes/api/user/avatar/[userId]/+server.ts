/**
 * GET /api/user/avatar/[userId]
 *
 * Serves a self-uploaded avatar for any authenticated account (not just the
 * owner) — like the Jellyfin avatar proxy, this can render in shared UI
 * (e.g. admin user management, session lists). Every /api/* route requires
 * auth by default in this app (see hooks.server.ts); this is listed in the
 * viewer allowlist there (GET-only) the same way the Jellyfin proxy is.
 * 404 when the account has no self-uploaded avatar — the UI renders the
 * initial-letter fallback in that case.
 */

import type { RequestHandler } from './$types.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AVATAR_DIR } from '#lib/server/avatars/constants.js';

const CONTENT_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp'
};

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const { userId } = params;
	if (!userId || userId.includes('..') || userId.includes('/')) {
		return new Response('Invalid path', { status: 400 });
	}

	let entries: string[];
	try {
		entries = await readdir(AVATAR_DIR);
	} catch {
		return new Response(null, { status: 404 });
	}

	const match = entries.find((entry) => entry.startsWith(`${userId}.`));
	if (!match) {
		return new Response(null, { status: 404 });
	}

	const ext = match.split('.').pop()?.toLowerCase() ?? '';
	const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

	try {
		const buffer = await readFile(join(AVATAR_DIR, match));
		return new Response(buffer, {
			headers: {
				'Content-Type': contentType,
				'Cache-Control': 'private, max-age=300'
			}
		});
	} catch {
		return new Response(null, { status: 404 });
	}
};

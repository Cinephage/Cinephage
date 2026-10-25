import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { keywordBlocklistService } from '#lib/server/settings/KeywordBlocklistService.js';
import { addBlockedKeywordSchema, removeBlockedKeywordSchema } from '#lib/validation/schemas.js';
import { tmdbCache } from '#lib/server/tmdb-cache.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const keywords = await keywordBlocklistService.getBlockedKeywords();
	return Response.json(keywords);
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();

	if (body.seed === true) {
		const count = await keywordBlocklistService.seedDefaults(true);
		return Response.json({ success: true, added: count });
	}

	const parsed = addBlockedKeywordSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: 'Invalid request body', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	try {
		const entry = await keywordBlocklistService.addBlockedKeyword(parsed.data.keywordId);
		tmdbCache.invalidate('/discover/');
		return Response.json({ success: true, entry });
	} catch (err) {
		return Response.json({ error: 'Failed to add keyword', details: String(err) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = removeBlockedKeywordSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: 'Invalid request body', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	await keywordBlocklistService.removeBlockedKeyword(parsed.data.id);
	tmdbCache.invalidate('/discover/');
	return Response.json({ success: true });
};

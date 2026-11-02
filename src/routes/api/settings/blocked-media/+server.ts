import type { RequestHandler } from './$types';
import { blockedMediaService } from '#lib/server/blocked-media/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { blockMediaSchema, unblockMediaSchema } from '#lib/validation/schemas.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { url } = event;
	const search = url.searchParams.get('search') ?? undefined;
	const mediaType = url.searchParams.get('mediaType') ?? undefined;
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100') || 100, 200);
	const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0;

	const result = await blockedMediaService.getBlockedMedia({
		search,
		mediaType,
		limit,
		offset
	});

	return Response.json(result);
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = blockMediaSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: 'Invalid request body', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	const entry = await blockedMediaService.blockMedia(parsed.data);

	return Response.json({ success: true, entry });
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = unblockMediaSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: 'Invalid request body', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	await blockedMediaService.unblockMedia(parsed.data.ids);

	return Response.json({ success: true, removed: parsed.data.ids.length });
};

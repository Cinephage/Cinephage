import type { RequestHandler } from './$types';
import { blocklistService } from '#lib/server/monitoring/specifications/BlocklistSpecification.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { addToBlocklistSchema, updateBlocklistExpirySchema } from '#lib/validation/schemas.js';
import { z } from 'zod';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { url } = event;
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50') || 50, 200);
	const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0;
	const reason = url.searchParams.get('reason') ?? undefined;
	const protocol = url.searchParams.get('protocol') ?? undefined;
	const activeOnly = url.searchParams.get('activeOnly') === 'true';

	const [entries, total] = await Promise.all([
		blocklistService.getBlocklist({
			reason: reason ?? undefined,
			protocol: protocol ?? undefined,
			activeOnly,
			limit,
			offset
		}),
		blocklistService.getBlocklistCount({
			reason: reason ?? undefined,
			protocol: protocol ?? undefined,
			activeOnly
		})
	]);

	return Response.json({ entries, total });
};

const deleteSchema = z.object({
	ids: z.array(z.string()).min(1).optional(),
	action: z.enum(['purgeExpired']).optional()
});

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = deleteSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: 'Invalid request body', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	const { ids, action } = parsed.data;

	if (action === 'purgeExpired') {
		await blocklistService.cleanExpiredEntries();
		return Response.json({ success: true, message: 'Expired entries purged' });
	}

	if (ids && ids.length > 0) {
		await blocklistService.removeFromBlocklistByIds(ids);
		return Response.json({ success: true, removed: ids.length });
	}

	return Response.json({ error: 'No action specified' }, { status: 400 });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const parsed = addToBlocklistSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: 'Invalid request body', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	const {
		title,
		infoHash,
		indexerId,
		movieId,
		seriesId,
		size,
		protocol,
		reason,
		message,
		expiresInHours
	} = parsed.data;

	const id = await blocklistService.addToBlocklist(
		{ title, infoHash, indexerId, size, protocol },
		{
			movieId: movieId ?? undefined,
			seriesId: seriesId ?? undefined,
			reason,
			message,
			expiresInHours: expiresInHours ?? undefined
		}
	);

	return Response.json({ success: true, id });
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const parsed = updateBlocklistExpirySchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: 'Invalid request body', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	const { id, expiresInHours } = parsed.data;
	await blocklistService.updateExpiry(id, expiresInHours);

	return Response.json({ success: true });
};

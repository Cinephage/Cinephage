import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { delayProfileService } from '#lib/server/monitoring/specifications/DelaySpecification.js';
import { z } from 'zod';

const createDelayProfileSchema = z.object({
	name: z.string().min(1),
	usenetDelay: z.number().int().min(0).default(0),
	torrentDelay: z.number().int().min(0).default(0),
	preferredProtocol: z
		.enum(['torrent', 'usenet'])
		.nullish()
		.transform((v) => v ?? undefined),
	bypassIfHighestQuality: z.boolean().default(true),
	bypassIfAboveScore: z
		.number()
		.int()
		.nullish()
		.transform((v) => v ?? undefined)
});

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const profiles = await delayProfileService.getProfiles();
	return Response.json(profiles);
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = createDelayProfileSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: 'Invalid request body', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	try {
		const id = await delayProfileService.createProfile(parsed.data);
		return Response.json({ success: true, id }, { status: 201 });
	} catch (err) {
		return Response.json(
			{ error: 'Failed to create delay profile', details: String(err) },
			{ status: 500 }
		);
	}
};

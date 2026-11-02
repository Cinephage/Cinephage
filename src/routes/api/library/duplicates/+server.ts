import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import * as svc from '#lib/server/library/duplicates/DuplicateDetectionService.js';
import { z } from 'zod';

const suppressSchema = z.object({
	libraryId: z.string(),
	signature: z.string(),
	signatureType: z.enum(['filename', 'filehash']),
	action: z.enum(['suppress', 'unsuppress'])
});

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const libraryId = event.url.searchParams.get('libraryId') || '';
	const mode = event.url.searchParams.get('mode') || 'filename';

	const dups =
		mode === 'filehash'
			? await svc.findHashDuplicates(libraryId)
			: await svc.findFilenameDuplicates(libraryId);

	return Response.json(dups);
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = suppressSchema.safeParse(body);
	if (!parsed.success)
		return Response.json({ success: false, error: 'Invalid request' }, { status: 400 });

	const { libraryId, signature, signatureType, action } = parsed.data;
	if (action === 'suppress') {
		await svc.suppressGroup(libraryId, signature, signatureType);
	} else {
		await svc.unsuppressGroup(libraryId, signature, signatureType);
	}

	return Response.json({ success: true });
};

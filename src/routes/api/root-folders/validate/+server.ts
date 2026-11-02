import type { RequestHandler } from './$types';
import { getRootFolderService } from '#lib/server/downloadClients/RootFolderService.js';
import { z } from 'zod';

const validatePathSchema = z.object({
	path: z.string().min(1, 'Path is required'),
	readOnly: z.boolean().optional().default(false),
	folderId: z.string().optional()
});

/**
 * POST /api/root-folders/validate
 * Validate a path exists and is accessible.
 */
export const POST: RequestHandler = async ({ request }) => {
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = validatePathSchema.safeParse(data);

	if (!result.success) {
		return Response.json(
			{
				error: 'Validation failed',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const { path, readOnly, folderId } = result.data;
	const service = getRootFolderService();

	try {
		const validation = await service.validatePath(path, readOnly, folderId);
		return Response.json(validation);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json(
			{
				valid: false,
				exists: false,
				writable: false,
				error: message
			},
			{ status: 500 }
		);
	}
};

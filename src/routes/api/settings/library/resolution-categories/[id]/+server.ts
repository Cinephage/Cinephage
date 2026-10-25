import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';
import * as svc from '#lib/server/library/resolution/ResolutionCategoryService.js';

const updateSchema = z.object({
	label: z.string().min(1).optional(),
	minWidth: z.number().int().min(0).optional(),
	minHeight: z.number().int().min(0).optional(),
	searchTerms: z.array(z.string()).optional()
});

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { id } = event.params;
	const body = await event.request.json();
	const parsed = updateSchema.safeParse(body);
	if (!parsed.success) throw error(400, 'Invalid request');

	const cat = await svc.update(id, parsed.data);
	if (!cat) throw error(404, 'Category not found');
	return Response.json(cat);
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { id } = event.params;
	const removed = await svc.remove(id);
	if (!removed) throw error(400, 'Cannot delete fallback category or not found');
	return Response.json({ success: true });
};

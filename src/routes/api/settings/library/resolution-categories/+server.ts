/**
 * Resolution Categories API
 *
 * GET  /api/settings/library/resolution-categories
 * POST /api/settings/library/resolution-categories
 * PUT  /api/settings/library/resolution-categories/[id]
 * DELETE /api/settings/library/resolution-categories/[id]
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';
import * as svc from '#lib/server/library/resolution/ResolutionCategoryService.js';

const createSchema = z.object({
	label: z.string().min(1),
	minWidth: z.number().int().min(0).default(0),
	minHeight: z.number().int().min(0).default(0),
	searchTerms: z.array(z.string()).optional(),
	isFallback: z.boolean().optional()
});

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const categories = await svc.getAll();
	return Response.json(categories);
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = createSchema.safeParse(body);
	if (!parsed.success) throw error(400, 'Invalid request');

	const cat = await svc.create(parsed.data);
	return Response.json(cat, { status: 201 });
};

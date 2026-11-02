import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { customFormats } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import {
	customFormatSchema,
	customFormatUpdateSchema,
	customFormatDeleteSchema
} from '#lib/validation/schemas.js';
import { ALL_FORMATS } from '#lib/server/scoring/index.js';
import { invalidateFormatCache } from '#lib/server/scoring/formats/registry.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { ValidationError, NotFoundError, AppError } from '#lib/errors/index.js';

const BUILT_IN_IDS = new Set(ALL_FORMATS.map((f) => f.id));

export const GET: RequestHandler = async ({ url }) => {
	const type = url.searchParams.get('type');
	const category = url.searchParams.get('category');
	const search = url.searchParams.get('search');

	const dbFormats = await db.select().from(customFormats);

	const customFormatsList = dbFormats.map((f) => ({
		id: f.id,
		name: f.name,
		description: f.description ?? undefined,
		category: f.category,
		tags: f.tags ?? [],
		conditions: f.conditions ?? [],
		enabled: f.enabled ?? true,
		isBuiltIn: false,
		createdAt: f.createdAt,
		updatedAt: f.updatedAt
	}));

	const builtInList = ALL_FORMATS.map((f) => ({
		id: f.id,
		name: f.name,
		description: f.description,
		category: f.category,
		tags: f.tags,
		conditions: f.conditions,
		enabled: true,
		isBuiltIn: true
	}));

	let allFormats = [...builtInList, ...customFormatsList];

	if (type === 'builtin') {
		allFormats = allFormats.filter((f) => f.isBuiltIn);
	} else if (type === 'custom') {
		allFormats = allFormats.filter((f) => !f.isBuiltIn);
	}

	if (category) {
		allFormats = allFormats.filter((f) => f.category === category);
	}

	if (search) {
		const query = search.toLowerCase();
		allFormats = allFormats.filter(
			(f) =>
				f.name.toLowerCase().includes(query) ||
				f.description?.toLowerCase().includes(query) ||
				f.tags.some((t) => t.toLowerCase().includes(query))
		);
	}

	return Response.json({
		formats: allFormats,
		count: allFormats.length,
		builtInCount: allFormats.filter((f) => f.isBuiltIn).length,
		customCount: allFormats.filter((f) => !f.isBuiltIn).length
	});
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const data = await parseBody(event.request, customFormatSchema);

	if (data.id && BUILT_IN_IDS.has(data.id)) {
		throw new ValidationError(`Cannot use reserved format ID '${data.id}'`);
	}

	if (data.id) {
		const existing = await db.select().from(customFormats).where(eq(customFormats.id, data.id));
		if (existing.length > 0) {
			throw new AppError(`Format with ID '${data.id}' already exists`, 'CONFLICT', 409);
		}
	}

	const newFormat = await db
		.insert(customFormats)
		.values({
			id: data.id,
			name: data.name,
			description: data.description,
			category: data.category,
			tags: data.tags,
			conditions: data.conditions,
			enabled: data.enabled
		})
		.returning();

	invalidateFormatCache();

	return Response.json(newFormat[0], { status: 201 });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { id, ...data } = await parseBody(event.request, customFormatUpdateSchema);

	if (BUILT_IN_IDS.has(id)) {
		throw new ValidationError('Cannot modify built-in formats');
	}

	const existing = await db.select().from(customFormats).where(eq(customFormats.id, id));
	if (existing.length === 0) {
		throw new NotFoundError('Format', id);
	}

	const updated = await db
		.update(customFormats)
		.set({
			name: data.name,
			description: data.description,
			category: data.category,
			tags: data.tags,
			conditions: data.conditions,
			enabled: data.enabled,
			updatedAt: new Date().toISOString()
		})
		.where(eq(customFormats.id, id))
		.returning();

	invalidateFormatCache();

	return Response.json(updated[0]);
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { id } = await parseBody(event.request, customFormatDeleteSchema);

	if (BUILT_IN_IDS.has(id)) {
		throw new ValidationError('Cannot delete built-in formats');
	}

	const deleted = await db.delete(customFormats).where(eq(customFormats.id, id)).returning();

	if (deleted.length === 0) {
		throw new NotFoundError('Format', id);
	}

	invalidateFormatCache();

	return Response.json({ success: true, deleted: deleted[0] });
};

import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
	getAlternateTitles,
	addUserAlternateTitle,
	removeAlternateTitle
} from '#lib/server/services/AlternateTitleService.js';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibrarySeriesAlternateTitlesApi', logDomain: 'scans' });

const addTitleSchema = z.object({
	title: z.string().min(1).max(500)
});

const deleteTitleSchema = z
	.object({
		id: z.number().int().positive().optional(),
		title: z.string().min(1).optional()
	})
	.refine((data) => data.id !== undefined || data.title !== undefined, {
		message: 'Either id or title must be provided'
	});

/**
 * GET /api/library/series/[id]/alternate-titles
 * Get all alternate titles for a series
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		// Verify series exists
		const [show] = await db
			.select({ id: series.id, title: series.title, originalTitle: series.originalTitle })
			.from(series)
			.where(eq(series.id, params.id));

		if (!show) {
			return Response.json({ success: false, error: 'Series not found' }, { status: 404 });
		}

		const titles = await getAlternateTitles('series', params.id);

		return Response.json({
			success: true,
			primaryTitle: show.title,
			originalTitle: show.originalTitle,
			alternateTitles: titles.map((t) => ({
				id: t.id,
				title: t.title,
				source: t.source,
				language: t.language,
				country: t.country
			}))
		});
	} catch (error) {
		logger.error(
			'[API] Error fetching series alternate titles',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch alternate titles'
			},
			{ status: 500 }
		);
	}
};

/**
 * POST /api/library/series/[id]/alternate-titles
 * Add a user-defined alternate title
 */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		// Verify series exists
		const [show] = await db.select({ id: series.id }).from(series).where(eq(series.id, params.id));

		if (!show) {
			return Response.json({ success: false, error: 'Series not found' }, { status: 404 });
		}

		const body = await request.json();
		const result = addTitleSchema.safeParse(body);

		if (!result.success) {
			throw new ValidationError('Validation failed', {
				details: result.error.flatten()
			});
		}

		const newTitle = await addUserAlternateTitle('series', params.id, result.data.title);

		if (!newTitle) {
			return Response.json(
				{ success: false, error: 'Alternate title already exists' },
				{ status: 409 }
			);
		}

		return Response.json({
			success: true,
			alternateTitle: {
				id: newTitle.id,
				title: newTitle.title,
				source: newTitle.source
			}
		});
	} catch (error) {
		logger.error(
			'[API] Error adding series alternate title',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to add alternate title'
			},
			{ status: 500 }
		);
	}
};

/**
 * DELETE /api/library/series/[id]/alternate-titles
 * Remove an alternate title (user-added only)
 */
export const DELETE: RequestHandler = async ({ params, request }) => {
	try {
		// Verify series exists
		const [show] = await db.select({ id: series.id }).from(series).where(eq(series.id, params.id));

		if (!show) {
			return Response.json({ success: false, error: 'Series not found' }, { status: 404 });
		}

		const body = await request.json();
		const result = deleteTitleSchema.safeParse(body);

		if (!result.success) {
			throw new ValidationError('Validation failed', {
				details: result.error.flatten()
			});
		}

		const deleted = await removeAlternateTitle(
			'series',
			params.id,
			result.data.id,
			result.data.title
		);

		if (!deleted) {
			return Response.json(
				{ success: false, error: 'Alternate title not found or is not user-added' },
				{ status: 404 }
			);
		}

		return Response.json({ success: true });
	} catch (error) {
		logger.error(
			'[API] Error removing series alternate title',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to remove alternate title'
			},
			{ status: 500 }
		);
	}
};

import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { movies } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
	getAlternateTitles,
	addUserAlternateTitle,
	removeAlternateTitle
} from '#lib/server/services/AlternateTitleService.js';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryMovieAlternateTitlesApi', logDomain: 'scans' });

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
 * GET /api/library/movies/[id]/alternate-titles
 * Get all alternate titles for a movie
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		// Verify movie exists
		const [movie] = await db
			.select({ id: movies.id, title: movies.title, originalTitle: movies.originalTitle })
			.from(movies)
			.where(eq(movies.id, params.id));

		if (!movie) {
			return Response.json({ success: false, error: 'Movie not found' }, { status: 404 });
		}

		const titles = await getAlternateTitles('movie', params.id);

		return Response.json({
			success: true,
			primaryTitle: movie.title,
			originalTitle: movie.originalTitle,
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
			'[API] Error fetching movie alternate titles',
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
 * POST /api/library/movies/[id]/alternate-titles
 * Add a user-defined alternate title
 */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		// Verify movie exists
		const [movie] = await db.select({ id: movies.id }).from(movies).where(eq(movies.id, params.id));

		if (!movie) {
			return Response.json({ success: false, error: 'Movie not found' }, { status: 404 });
		}

		const body = await request.json();
		const result = addTitleSchema.safeParse(body);

		if (!result.success) {
			throw new ValidationError('Validation failed', {
				details: result.error.flatten()
			});
		}

		const newTitle = await addUserAlternateTitle('movie', params.id, result.data.title);

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
			'[API] Error adding movie alternate title',
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
 * DELETE /api/library/movies/[id]/alternate-titles
 * Remove an alternate title (user-added only)
 */
export const DELETE: RequestHandler = async ({ params, request }) => {
	try {
		// Verify movie exists
		const [movie] = await db.select({ id: movies.id }).from(movies).where(eq(movies.id, params.id));

		if (!movie) {
			return Response.json({ success: false, error: 'Movie not found' }, { status: 404 });
		}

		const body = await request.json();
		const result = deleteTitleSchema.safeParse(body);

		if (!result.success) {
			throw new ValidationError('Validation failed', {
				details: result.error.flatten()
			});
		}

		const deleted = await removeAlternateTitle(
			'movie',
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
			'[API] Error removing movie alternate title',
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

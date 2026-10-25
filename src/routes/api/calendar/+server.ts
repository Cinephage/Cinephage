import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getCalendarData } from '#lib/server/calendar/queries.js';

const calendarQuerySchema = z.object({
	month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.default(() => {
			const now = new Date();
			return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
		}),
	type: z.enum(['all', 'movies', 'episodes']).default('all'),
	libraryOnly: z
		.string()
		.optional()
		.transform((v) => v === 'true'),
	minRating: z
		.string()
		.optional()
		.transform((v) => {
			const n = v ? parseFloat(v) : 0;
			return isNaN(n) ? 0 : Math.min(10, Math.max(0, n));
		}),
	genreIds: z
		.string()
		.optional()
		.transform((v) =>
			v
				? v
						.split(',')
						.map(Number)
						.filter((n) => !isNaN(n))
				: []
		),
	excludeAdult: z
		.string()
		.optional()
		.transform((v) => v === 'true'),
	certifications: z
		.string()
		.optional()
		.transform((v) => (v ? v.split(',').filter(Boolean) : []))
});

export const GET: RequestHandler = async ({ url }) => {
	const result = calendarQuerySchema.safeParse(Object.fromEntries(url.searchParams));
	if (!result.success) {
		return Response.json(
			{ error: 'Invalid parameters', details: result.error.flatten() },
			{ status: 400 }
		);
	}

	const { month, type, libraryOnly, minRating, genreIds, excludeAdult, certifications } =
		result.data;
	const days = await getCalendarData(
		month,
		type,
		libraryOnly,
		minRating,
		genreIds,
		excludeAdult,
		certifications
	);
	return Response.json(days);
};

import type { RequestHandler } from './$types';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '#lib/server/db/index.js';
import { episodes, movies, series } from '#lib/server/db/schema.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import {
	attemptBudget,
	getSearchPolicy,
	listSearchStates,
	pauseSearchState,
	resumeSearchState,
	updateSearchPolicy,
	type SearchKind,
	type SearchOwnerType
} from '#lib/server/monitoring/search/search-state.js';

const logger = createChildLogger({ module: 'MonitoringSearchesApi', logDomain: 'monitoring' });

const KINDS: SearchKind[] = ['missing', 'upgrade', 'cutoff', 'new_episode'];

const actionSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('pause'),
		ownerType: z.enum(['movie', 'episode']),
		ownerId: z.string().min(1),
		kind: z.enum(['missing', 'upgrade', 'cutoff', 'new_episode']).optional(),
		reason: z.string().max(200).optional()
	}),
	z.object({
		action: z.literal('resume'),
		ownerType: z.enum(['movie', 'episode']),
		ownerId: z.string().min(1),
		kind: z.enum(['missing', 'upgrade', 'cutoff', 'new_episode']).optional()
	}),
	z.object({ action: z.literal('pause-all') }),
	z.object({ action: z.literal('resume-all') })
]);

/**
 * Resolve display titles for the tracked items in one batch each. The caller
 * renders hundreds of rows, so this avoids a query per row.
 */
async function resolveTitles(rows: { ownerType: SearchOwnerType; ownerId: string }[]) {
	const movieIds = rows.filter((r) => r.ownerType === 'movie').map((r) => r.ownerId);
	const episodeIds = rows.filter((r) => r.ownerType === 'episode').map((r) => r.ownerId);

	const movieTitles = new Map<string, string>();
	if (movieIds.length > 0) {
		const found = await db
			.select({ id: movies.id, title: movies.title })
			.from(movies)
			.where(inArray(movies.id, movieIds));
		for (const row of found) movieTitles.set(row.id, row.title);
	}

	const episodeTitles = new Map<string, string>();
	if (episodeIds.length > 0) {
		const found = await db
			.select({
				id: episodes.id,
				seasonNumber: episodes.seasonNumber,
				episodeNumber: episodes.episodeNumber,
				seriesTitle: series.title
			})
			.from(episodes)
			.innerJoin(series, eq(episodes.seriesId, series.id))
			.where(inArray(episodes.id, episodeIds));
		for (const row of found) {
			const s = String(row.seasonNumber).padStart(2, '0');
			const e = String(row.episodeNumber).padStart(2, '0');
			episodeTitles.set(row.id, `${row.seriesTitle} S${s}E${e}`);
		}
	}

	return { movieTitles, episodeTitles };
}

/**
 * GET /api/monitoring/searches
 *
 * Every item with retry state, plus the policy in force, so the Activity
 * "Searches" view can show attempts, next attempt and why an item is idle.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const [policy, rows] = await Promise.all([getSearchPolicy(), listSearchStates()]);
		const { movieTitles, episodeTitles } = await resolveTitles(rows);

		const items = rows.map((row) => ({
			ownerType: row.ownerType,
			ownerId: row.ownerId,
			kind: row.searchKind,
			status: row.status,
			attempts: row.attempts,
			maxAttempts: attemptBudget(row.searchKind, policy),
			lastOutcome: row.lastOutcome,
			lastAttemptAt: row.lastAttemptAt,
			nextAttemptAt: row.nextAttemptAt,
			lastIndexerName: row.lastIndexerName,
			pauseReason: row.pauseReason,
			title:
				row.ownerType === 'movie'
					? (movieTitles.get(row.ownerId) ?? row.ownerId)
					: (episodeTitles.get(row.ownerId) ?? row.ownerId)
		}));

		return Response.json({ success: true, policy, items });
	} catch (error) {
		logger.error({ err: error }, '[API] Failed to list search states');
		return Response.json({ success: false, error: 'Failed to list search states' }, { status: 500 });
	}
};

/**
 * POST /api/monitoring/searches
 *
 * Pause or resume one item (`pause`/`resume`, optional kind) or every automatic
 * search (`pause-all`/`resume-all`, stored as the `auto_search_paused` setting).
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = actionSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ success: false, error: 'Invalid request body', details: parsed.error.issues },
			{ status: 400 }
		);
	}

	try {
		const action = parsed.data;

		if (action.action === 'pause-all') {
			await updateSearchPolicy({ paused: true });
			return Response.json({ success: true, paused: true });
		}
		if (action.action === 'resume-all') {
			await updateSearchPolicy({ paused: false });
			return Response.json({ success: true, paused: false });
		}

		const kinds: SearchKind[] = action.kind ? [action.kind] : KINDS;
		for (const kind of kinds) {
			if (action.action === 'pause') {
				await pauseSearchState(action.ownerType, action.ownerId, kind, {
					reason: action.reason
				});
			} else {
				await resumeSearchState(action.ownerType, action.ownerId, kind);
			}
		}

		return Response.json({ success: true, action: action.action, kinds });
	} catch (error) {
		logger.error({ err: error }, '[API] Failed to change search state');
		return Response.json({ success: false, error: 'Failed to change search state' }, { status: 500 });
	}
};

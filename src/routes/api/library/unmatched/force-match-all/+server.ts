import { randomUUID } from 'node:crypto';
import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { unmatchedFiles } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import { mediaMatcherService } from '#lib/server/library/media-matcher.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { logger, createChildLogger } from '#lib/logging/index.js';

/**
 * POST /api/library/unmatched/force-match-all
 * Force-match all eligible unmatched files to their top candidate.
 *
 * Eligible = reason is 'multiple_matches' (NOT 'ambiguous') AND top candidate
 * score >= minScore. Ambiguous rows are excluded because a near-tie between
 * candidates is not safe to resolve without human review.
 *
 * Body: { minScore: number (0–1, default 0.9) }
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const body = await event.request.json().catch(() => ({}));
		const minScore =
			typeof body.minScore === 'number' ? Math.max(0, Math.min(1, body.minScore)) : 0.9;

		const candidates = await db
			.select({
				id: unmatchedFiles.id,
				mediaType: unmatchedFiles.mediaType,
				suggestedMatches: unmatchedFiles.suggestedMatches,
				reason: unmatchedFiles.reason,
				correlationId: unmatchedFiles.correlationId
			})
			.from(unmatchedFiles)
			.where(inArray(unmatchedFiles.reason, ['multiple_matches']));

		const eligible = candidates.filter((f) => {
			const top = (f.suggestedMatches as Array<{ confidence: number; tmdbId: number }> | null)?.[0];
			return top && top.confidence >= minScore;
		});

		let matched = 0;
		let failed = 0;

		for (const file of eligible) {
			const top = (file.suggestedMatches as Array<{ tmdbId: number; confidence: number }>)[0];
			const correlationId = file.correlationId ?? randomUUID();
			const matchLogger = createChildLogger({ logDomain: 'scans' as const, correlationId });
			try {
				matchLogger.info(
					{ fileId: file.id, tmdbId: top.tmdbId, confidence: top.confidence },
					'[ForceMatchAll] Force-matching file to top candidate'
				);
				// Deliberate action: retire a displaced old file instead of
				// leaving a duplicate when the generated filename differs (#627).
				await mediaMatcherService.acceptMatch(
					file.id,
					top.tmdbId,
					file.mediaType as 'movie' | 'tv',
					{ allowReplace: true }
				);
				matched++;
				matchLogger.info(
					{ fileId: file.id, tmdbId: top.tmdbId },
					'[ForceMatchAll] Force-match successful'
				);
			} catch (err) {
				failed++;
				matchLogger.warn(
					{ fileId: file.id, tmdbId: top.tmdbId, err },
					'[ForceMatchAll] Failed to force-match file'
				);
			}
		}

		return Response.json({
			success: true,
			data: { matched, failed, eligible: eligible.length },
			meta: { timestamp: new Date().toISOString() }
		});
	} catch (error) {
		logger.error('[API] Error in force-match-all', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Force match all failed',
				data: null
			},
			{ status: 500 }
		);
	}
};

import type { RequestHandler } from './$types';
import { z } from 'zod';
import { db } from '#lib/server/db/index.js';
import { movies, series, episodes, libraries } from '#lib/server/db/schema.js';
import { inArray, and, eq } from 'drizzle-orm';
import { LanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { searchSubtitlesForMediaBatch } from '#lib/server/subtitles/services/SubtitleImportService.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { parseBody, assertFound } from '#lib/server/api/validate.js';

const logger = createChildLogger({
	module: 'SubtitleLanguageProfileBulkAssignApi',
	logDomain: 'subtitles'
});

/**
 * Schema for bulk profile assignment request
 */
const bulkAssignSchema = z
	.object({
		/** Target media type */
		mediaType: z.enum(['movie', 'series']),
		/** IDs of media items to update */
		mediaIds: z.array(z.string().uuid()).default([]),
		/** Assign to ALL items of the library instead of explicit ids.
		 * Not a UUID: seeded/built-in libraries use slug ids (e.g.
		 * 'lib-movies-standard'). */
		libraryId: z.string().min(1).optional(),
		/** Language profile ID to assign (null to remove profile) */
		languageProfileId: z.string().uuid().nullable(),
		/** Whether to enable subtitle searching for these items */
		wantsSubtitles: z.boolean().optional(),
		/** Also clear per-item subtitle requirement overrides so items inherit */
		clearOverrides: z.boolean().optional()
	})
	.refine((data) => data.libraryId || data.mediaIds.length > 0, {
		message: 'Either libraryId or at least one media ID is required'
	})
	.refine((data) => !data.libraryId || data.mediaIds.length === 0, {
		message: 'Pass either libraryId or mediaIds, not both'
	});

/**
 * POST /api/subtitles/language-profiles/bulk-assign
 * Assign a language profile to multiple movies or series at once.
 */
export const POST: RequestHandler = async ({ request }) => {
	const {
		mediaType,
		mediaIds: explicitIds,
		languageProfileId,
		wantsSubtitles,
		clearOverrides,
		libraryId
	} = await parseBody(request, bulkAssignSchema);

	// Library-wide mode: expand to all items of the library's media type.
	let mediaIds: string[];
	if (libraryId) {
		const [library] = await db
			.select({ id: libraries.id, mediaType: libraries.mediaType })
			.from(libraries)
			.where(eq(libraries.id, libraryId))
			.limit(1);
		if (!library) {
			return Response.json({ success: false, error: 'Library not found' }, { status: 404 });
		}
		const resolvedType = library.mediaType === 'tv' ? 'series' : 'movie';
		if (resolvedType !== mediaType) {
			return Response.json(
				{ success: false, error: `Library media type is ${resolvedType}, not ${mediaType}` },
				{ status: 400 }
			);
		}
		const rows =
			resolvedType === 'series'
				? await db.select({ id: series.id }).from(series).where(eq(series.libraryId, libraryId))
				: await db.select({ id: movies.id }).from(movies).where(eq(movies.libraryId, libraryId));
		mediaIds = rows.map((row) => row.id);
		if (mediaIds.length === 0) {
			return Response.json({ success: true, updated: 0 });
		}
	} else {
		mediaIds = explicitIds;
	}

	// Validate profile exists if provided
	if (languageProfileId) {
		const profileService = LanguageProfileService.getInstance();
		const profile = await profileService.getProfile(languageProfileId);
		assertFound(profile, 'Language profile', languageProfileId);
	}

	const updateData: Record<string, unknown> = {
		languageProfileId
	};

	if (clearOverrides) {
		updateData.subtitleRequirementsOverride = null;
	}

	// If wantsSubtitles is explicitly set, include it
	if (wantsSubtitles !== undefined) {
		updateData.wantsSubtitles = wantsSubtitles;
	} else if (languageProfileId) {
		// Default to enabling subtitles when assigning a profile
		updateData.wantsSubtitles = true;
	}

	// Determine if we should trigger subtitle searches
	const shouldEnableSubtitles = languageProfileId && (wantsSubtitles ?? true);

	if (mediaType === 'movie') {
		await db.update(movies).set(updateData).where(inArray(movies.id, mediaIds));

		logger.info(
			{
				count: mediaIds.length,
				languageProfileId
			},
			'[BulkAssign] Updated movies with language profile'
		);

		// Trigger subtitle search for movies with files
		if (shouldEnableSubtitles) {
			const settings = await monitoringScheduler.getSettings();
			if (settings.subtitleSearchOnImportEnabled) {
				// Get movies that have files
				const moviesWithFiles = await db
					.select({ id: movies.id })
					.from(movies)
					.where(and(inArray(movies.id, mediaIds), eq(movies.hasFile, true)));

				if (moviesWithFiles.length > 0) {
					logger.info(
						{
							count: moviesWithFiles.length
						},
						'[BulkAssign] Triggering subtitle search for movies'
					);

					const items = moviesWithFiles.map((m) => ({
						mediaType: 'movie' as const,
						mediaId: m.id
					}));

					// Fire-and-forget
					searchSubtitlesForMediaBatch(items).catch((err) => {
						logger.warn(
							{
								error: err instanceof Error ? err.message : String(err)
							},
							'[BulkAssign] Background subtitle search failed for movies'
						);
					});
				}
			}
		}
	} else {
		await db.update(series).set(updateData).where(inArray(series.id, mediaIds));

		logger.info(
			{
				count: mediaIds.length,
				languageProfileId
			},
			'[BulkAssign] Updated series with language profile'
		);

		// Trigger subtitle search for episodes with files
		if (shouldEnableSubtitles) {
			const settings = await monitoringScheduler.getSettings();
			if (settings.subtitleSearchOnImportEnabled) {
				// Get all episodes with files from these series
				const episodesWithFiles = await db
					.select({ id: episodes.id })
					.from(episodes)
					.where(and(inArray(episodes.seriesId, mediaIds), eq(episodes.hasFile, true)));

				if (episodesWithFiles.length > 0) {
					logger.info(
						{
							seriesCount: mediaIds.length,
							episodeCount: episodesWithFiles.length
						},
						'[BulkAssign] Triggering subtitle search for episodes'
					);

					const items = episodesWithFiles.map((ep) => ({
						mediaType: 'episode' as const,
						mediaId: ep.id
					}));

					// Fire-and-forget
					searchSubtitlesForMediaBatch(items).catch((err) => {
						logger.warn(
							{
								error: err instanceof Error ? err.message : String(err)
							},
							'[BulkAssign] Background subtitle search failed for episodes'
						);
					});
				}
			}
		}
	}

	return Response.json({
		success: true,
		updated: mediaIds.length
	});
};

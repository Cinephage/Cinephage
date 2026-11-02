/**
 * EPG Guide API
 *
 * GET /api/livetv/epg/guide - Get programs for time range (guide view)
 *
 * Query parameters:
 * - start: ISO date string (default: now)
 * - end: ISO date string (default: +6 hours)
 * - channelIds: Comma-separated channel IDs (optional, defaults to lineup channels)
 * - lang: Optional display language tag (e.g. "en", "fr", "pt-BR"; the base tag
 *   is used). Invalid/unknown values are ignored. When omitted, the plain EPG
 *   text columns are returned unchanged.
 */

import type { RequestHandler } from './$types';
import { getEpgService } from '#lib/server/livetv/epg/index.js';
import {
	buildResolvedEpgChannelPlan,
	mapGuideDataToRequestedChannels
} from '#lib/server/livetv/epg/epg-utils.js';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';
import { getLanguageSettingsService } from '#lib/server/subtitles/services/LanguageSettingsService.js';
import { ValidationError } from '#lib/errors/index.js';
import { z } from 'zod';

const logger = createChildLogger({ module: 'LiveTvEpgGuide', logDomain: 'livetv' });

const DEFAULT_HOURS = 6;

const paramsSchema = z.object({
	start: z.string().datetime().optional(),
	end: z.string().datetime().optional()
});

/**
 * Resolve the display language for localized EPG text.
 *
 * Order: explicit `?lang=` (canonicalized; region/script preserved so
 * `pt-BR` can beat a bare `pt`) → the instance `language_settings`
 * metadata locale → null (plain columns, pre-i18n behavior). Invalid input is
 * ignored, never an error.
 */
async function resolveLangParam(url: URL): Promise<string | null> {
	const raw = url.searchParams.get('lang');
	if (raw && raw.trim()) {
		const tag = normalizeLanguageTag(raw);
		return tag === 'und' ? null : tag;
	}
	try {
		const settings = await getLanguageSettingsService().get();
		const tag = normalizeLanguageTag(settings.metadataLocale);
		return tag === 'und' ? null : tag;
	} catch {
		return null;
	}
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const epgService = getEpgService();

		// Parse query parameters
		const parsed = paramsSchema.safeParse(Object.fromEntries(url.searchParams));
		const channelIdsParam = url.searchParams.get('channelIds');

		// Default time range: now to +6 hours
		const now = new Date();
		const start = parsed.data?.start ? new Date(parsed.data.start) : now;
		const end = parsed.data?.end
			? new Date(parsed.data.end)
			: new Date(now.getTime() + DEFAULT_HOURS * 60 * 60 * 1000);

		// Validate dates
		if (isNaN(start.getTime()) || isNaN(end.getTime())) {
			throw new ValidationError('Invalid date format');
		}

		if (start >= end) {
			throw new ValidationError('Start must be before end');
		}

		// Get channel IDs (from param or lineup)
		let channelIds: string[];
		const lineup = channelIdsParam ? [] : await channelLineupService.getLineup();
		if (channelIdsParam) {
			channelIds = channelIdsParam
				.split(',')
				.map((id) => id.trim())
				.filter(Boolean);
		} else {
			channelIds = lineup.map((item) => item.channelId);
		}

		if (channelIds.length === 0) {
			return Response.json({
				success: true,
				programs: {},
				timeRange: {
					start: start.toISOString(),
					end: end.toISOString()
				}
			});
		}

		// Get guide data
		const resolvedPlan = buildResolvedEpgChannelPlan(
			channelIds,
			lineup.length > 0
				? lineup.map((item) => ({
						channelId: item.channelId,
						epgSourceChannelId: item.epgSourceChannelId
					}))
				: []
		);
		const guideMap = mapGuideDataToRequestedChannels(
			resolvedPlan,
			epgService.getGuideData(
				resolvedPlan.sourceChannelIds,
				start,
				end,
				await resolveLangParam(url)
			)
		);

		// Convert map to object for JSON
		const programs: Record<string, unknown[]> = {};
		for (const [channelId, channelPrograms] of guideMap) {
			programs[channelId] = channelPrograms;
		}

		return Response.json({
			success: true,
			programs,
			timeRange: {
				start: start.toISOString(),
				end: end.toISOString()
			}
		});
	} catch (error) {
		// Validation errors
		if (error instanceof ValidationError) {
			return Response.json(
				{
					success: false,
					error: error.message,
					code: error.code
				},
				{ status: error.statusCode }
			);
		}
		logger.error('[API] Failed to get EPG guide', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get EPG guide data'
			},
			{ status: 500 }
		);
	}
};

/**
 * EPG Channel API
 *
 * GET /api/livetv/epg/channel/[id] - Get programs for a single channel
 *
 * Query parameters:
 * - start: ISO date string (default: now)
 * - end: ISO date string (default: +6 hours)
 * - lang: Optional display language tag (e.g. "en", "fr", "pt-BR"; the base tag
 *   is used). Invalid/unknown values are ignored. When omitted, the plain EPG
 *   text columns are returned unchanged.
 */

import type { RequestHandler } from './$types';
import { getEpgService } from '#lib/server/livetv/epg/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';
import { getLanguageSettingsService } from '#lib/server/subtitles/services/LanguageSettingsService.js';
import { ValidationError } from '#lib/errors/index.js';
import { z } from 'zod';

const logger = createChildLogger({ module: 'LiveTvEpgChannelById', logDomain: 'livetv' });

const DEFAULT_HOURS = 6;

const paramsSchema = z.object({
	start: z.string().datetime().optional(),
	end: z.string().datetime().optional()
});

/**
 * Resolve the display language for localized EPG text (same chain as the guide
 * route): explicit `?lang=` → instance metadata locale → null.
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

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const channelId = params.id;

		if (!channelId) {
			throw new ValidationError('Channel ID is required');
		}

		const epgService = getEpgService();

		// Parse query parameters
		const parsed = paramsSchema.safeParse(Object.fromEntries(url.searchParams));

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

		// Get programs for channel
		const programs = epgService.getChannelPrograms(
			channelId,
			start,
			end,
			await resolveLangParam(url)
		);

		return Response.json({
			success: true,
			channelId,
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
		logger.error('[API] Failed to get EPG for channel', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get EPG data'
			},
			{ status: 500 }
		);
	}
};

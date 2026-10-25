import type { RequestHandler } from '@sveltejs/kit';
import type { CapturedLogFilters } from '#lib/logging/log-capture.js';
import { logger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { logHistoryService } from '#lib/server/logging/log-history.js';
import { logDownloadQuerySchema } from '#lib/validation/schemas.js';

function toFilters(query: {
	level?: CapturedLogFilters['level'];
	levels?: CapturedLogFilters['levels'];
	logDomain?: CapturedLogFilters['logDomain'];
	search?: string;
	from?: string;
	to?: string;
	supportId?: string;
	requestId?: string;
	correlationId?: string;
	limit?: number;
}): CapturedLogFilters {
	const { level, levels, logDomain, search, from, to, supportId, requestId, correlationId, limit } =
		query;
	const filters: CapturedLogFilters = {};

	if (levels && levels.length > 0) {
		filters.levels = levels;
	} else if (level) {
		filters.level = level;
	}

	if (logDomain) filters.logDomain = logDomain;
	if (search) filters.search = search;
	if (from) filters.from = from;
	if (to) filters.to = to;
	if (supportId) filters.supportId = supportId;
	if (requestId) filters.requestId = requestId;
	if (correlationId) filters.correlationId = correlationId;
	filters.limit = limit ?? 500;

	return filters;
}

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const raw = Object.fromEntries(event.url.searchParams.entries());
	const parsed = logDownloadQuerySchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{
				success: false,
				error: 'Validation failed',
				details: parsed.error.flatten()
			},
			{ status: 400 }
		);
	}

	try {
		const format = parsed.data.format ?? 'jsonl';
		const entries = await logHistoryService.getSnapshot(toFilters(parsed.data));

		if (format === 'json') {
			return Response.json({ success: true, entries, total: entries.length });
		}

		const body = entries.map((entry) => JSON.stringify(entry)).join('\n');

		return new Response(body, {
			headers: {
				'Content-Type': 'application/x-ndjson; charset=utf-8',
				'Content-Disposition': 'attachment; filename="cinephage-logs.jsonl"'
			}
		});
	} catch (error) {
		logger.error({ err: error }, 'Failed to download log history');
		return Response.json(
			{ success: false, error: 'Failed to download log history' },
			{ status: 500 }
		);
	}
};

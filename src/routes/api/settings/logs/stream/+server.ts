import type { RequestHandler } from '@sveltejs/kit';

import type { CapturedLogFilters } from '#lib/logging/log-capture.js';
import { logger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { logCaptureStore } from '#lib/server/logging/log-capture-store.js';
import { logHistoryService } from '#lib/server/logging/log-history.js';
import { createSSEStream } from '#lib/server/sse.js';
import { logFilterQuerySchema } from '#lib/validation/schemas.js';

function parseFilters(url: URL): CapturedLogFilters {
	const raw = Object.fromEntries(url.searchParams.entries());
	const result = logFilterQuerySchema.safeParse(raw);

	if (!result.success) {
		return { limit: 200 };
	}

	const { level, levels, logDomain, search, from, to, supportId, requestId, correlationId, limit } =
		result.data;
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
	filters.limit = limit ?? 200;

	return filters;
}

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const raw = Object.fromEntries(event.url.searchParams.entries());
	const parsed = logFilterQuerySchema.safeParse(raw);
	if (!parsed.success) {
		return new Response(JSON.stringify({ success: false, error: 'Validation failed' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const filters = parseFilters(event.url);

	return createSSEStream(async (send) => {
		let seedEntries: Awaited<ReturnType<typeof logHistoryService.getSnapshot>> = [];
		try {
			seedEntries = await logHistoryService.getSnapshot(filters);
		} catch (error) {
			logger.error({ err: error }, 'Failed to load log stream seed');
		}

		send('logs:seed', { entries: seedEntries });

		const unsubscribe = logCaptureStore.subscribe((entry) => {
			if (logCaptureStore.matches(entry, filters)) {
				send('log:entry', entry);
			}
		});

		return () => {
			unsubscribe();
		};
	});
};

import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

import {
	CAPTURED_LOG_DOMAINS,
	CAPTURED_LOG_LEVELS,
	DEFAULT_CAPTURED_LOG_LEVEL
} from '#lib/logging/log-capture.js';
import {
	DEFAULT_LOG_RETENTION_DAYS,
	MAX_LOG_RETENTION_DAYS,
	logHistoryService
} from '#lib/server/logging/log-history.js';

export const load = async ({ locals }: RequestEvent) => {
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	if (locals.user.role !== 'admin') {
		throw error(403, 'Forbidden');
	}

	const oneDayAgo = new Date();
	oneDayAgo.setDate(oneDayAgo.getDate() - 1);

	const initialHistory = await logHistoryService.search({
		page: 1,
		pageSize: 100,
		levels: ['debug', 'info', 'warn', 'error'],
		from: oneDayAgo.toISOString()
	});

	return {
		initialEntries: initialHistory.entries,
		initialTotal: initialHistory.total,
		initialHasMore: initialHistory.hasMore,
		initialPage: initialHistory.page,
		initialPageSize: initialHistory.pageSize,
		availableLevels: [...CAPTURED_LOG_LEVELS],
		availableDomains: [...CAPTURED_LOG_DOMAINS],
		retentionDays: await logHistoryService.getRetentionDays(),
		defaultRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
		maxRetentionDays: MAX_LOG_RETENTION_DAYS,
		minLevel: await logHistoryService.getMinCaptureLevel(),
		defaultMinLevel: DEFAULT_CAPTURED_LOG_LEVEL
	};
};

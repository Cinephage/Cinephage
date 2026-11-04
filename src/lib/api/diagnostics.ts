/**
 * Diagnostics API helpers (bug report evidence kit).
 */

import { apiPost } from './client.js';
import type { BugReportDiagnosticsResult } from '#lib/server/diagnostics/report-builder.js';
import type { BugReportDiagnosticsQuery } from '#lib/validation/schemas.js';

/**
 * Fetch the technical evidence for a bug report (system info + scoped log
 * slice). Admin-only endpoint.
 */
export async function fetchBugReportDiagnostics(query: BugReportDiagnosticsQuery) {
	return apiPost<BugReportDiagnosticsResult>('/api/system/diagnostics/report', query);
}

/**
 * Anchor href for the untrimmed plain-text log file matching the current
 * scope inputs - the file the user drags onto the GitHub issue as an
 * attachment. Served by the admin-guarded logs download endpoint.
 */
export function buildBugReportLogsUrl(query: BugReportDiagnosticsQuery): string {
	const params = new URLSearchParams();
	if (query.supportId) params.set('supportId', query.supportId);
	if (query.area) params.set('area', query.area);
	params.set('logScope', query.logScope);
	if (query.keyword) params.set('keyword', query.keyword);
	return `/api/system/diagnostics/report/logs?${params.toString()}`;
}

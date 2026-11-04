/**
 * Bug Report Full Log File Download
 *
 * Serves the untrimmed, scope-filtered log history as a plain-text file the
 * user drags onto the GitHub issue as an attachment. The copyable slice in
 * the report form is budget-trimmed for pasting; this file is the full truth.
 */

import type { RequestHandler } from './$types.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { formatLogLine, resolveLogEntries } from '#lib/server/diagnostics/report-builder.js';
import { bugReportDiagnosticsSchema } from '#lib/validation/schemas.js';

const logger = createChildLogger({ module: 'diagnostics', logDomain: 'system' });

/** Hard cap so a noisy history cannot produce an unmanageable attachment. */
const MAX_DOWNLOAD_ENTRIES = 10_000;

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const parsed = bugReportDiagnosticsSchema.safeParse(
		Object.fromEntries(event.url.searchParams.entries())
	);
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
		const logs = await resolveLogEntries(parsed.data);
		const capped = logs.entries.length > MAX_DOWNLOAD_ENTRIES;
		const entries = logs.entries.slice(-MAX_DOWNLOAD_ENTRIES);
		const header = [
			`# Cinephage logs - ${logs.scopeDescription}`,
			`# Generated ${new Date().toISOString()} - ${entries.length} entries`,
			...(capped ? [`# ... capped at the newest ${MAX_DOWNLOAD_ENTRIES} entries`] : [])
		];

		const body = [...header, ...entries.map(formatLogLine)].join('\n');
		const date = new Date().toISOString().slice(0, 10);
		const supportSuffix = parsed.data.supportId ? `-${parsed.data.supportId}` : '';

		return new Response(body, {
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Content-Disposition': `attachment; filename="cinephage-logs${supportSuffix}-${date}.txt"`,
				'cache-control': 'no-store'
			}
		});
	} catch (error) {
		logger.error({ err: error }, 'Failed to build bug report log file');
		return Response.json(
			{ success: false, error: 'Failed to build bug report log file' },
			{ status: 500 }
		);
	}
};

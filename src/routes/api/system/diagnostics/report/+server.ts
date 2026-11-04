/**
 * Bug Report Diagnostics API Endpoint
 *
 * Assembles the technical sections of a guided bug report (system info plus a
 * scoped, redacted, budgeted slice of log history) for the in-app report
 * form. Admin-only; the report flow lives behind the bug icon in the sidebar,
 * the error page, and Settings > Monitoring.
 */

import type { RequestHandler } from './$types.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { buildBugReportDiagnostics } from '#lib/server/diagnostics/report-builder.js';
import { bugReportDiagnosticsSchema } from '#lib/validation/schemas.js';

const logger = createChildLogger({ module: 'diagnostics', logDomain: 'system' });

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = bugReportDiagnosticsSchema.safeParse(body);
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
		const result = await buildBugReportDiagnostics(parsed.data);
		return Response.json({ success: true, ...result });
	} catch (error) {
		logger.error({ err: error }, 'Failed to assemble bug report diagnostics');
		return Response.json(
			{ success: false, error: 'Failed to assemble bug report diagnostics' },
			{ status: 500 }
		);
	}
};

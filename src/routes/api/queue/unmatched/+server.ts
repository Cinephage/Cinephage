/**
 * GET /api/queue/unmatched
 *
 * Lists downloads present in clients under a Cinephage-managed label with no
 * corresponding download_queue row. Read-only: listing never mutates anything.
 *
 * Query params: clientId?, page? (default 1), limit? (default 25, max 100),
 * search? (case-insensitive contains on the release name, applied before
 * total/pagination so results outside the current page are still found).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'QueueUnmatchedApi', logDomain: 'downloads' });

function toOptionalInt(value: string | null): number | undefined {
	if (value === null || value.trim() === '') return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	try {
		const clientId = url.searchParams.get('clientId') ?? undefined;
		const search = url.searchParams.get('search') ?? undefined;
		const result = await downloadMonitor.listUnmatchedDownloads({
			clientId,
			page: toOptionalInt(url.searchParams.get('page')),
			limit: toOptionalInt(url.searchParams.get('limit')),
			search
		});

		return json({ success: true, ...result });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Unmatched listing failed');
		return json({ success: false, error: message }, { status: 500 });
	}
};

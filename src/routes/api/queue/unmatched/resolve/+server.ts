/**
 * GET /api/queue/unmatched/resolve
 *
 * Resolves unmatched client hashes to server-local source paths for the
 * import wizard. Read-only: never mutates. Accepts
 * ?entries=<clientId>:<hash>,<clientId>:<hash> (max 100).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'QueueUnmatchedResolveApi', logDomain: 'downloads' });

export const GET: RequestHandler = async ({ url, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	try {
		const raw = url.searchParams.get('entries') ?? '';
		const entries = raw
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean)
			.slice(0, 100)
			.map((part) => {
				const idx = part.indexOf(':');
				if (idx <= 0) return null;
				return { clientId: part.slice(0, idx), hash: part.slice(idx + 1) };
			})
			.filter((e): e is { clientId: string; hash: string } => Boolean(e?.clientId && e?.hash));

		if (entries.length === 0) {
			return json({ success: false, error: 'No valid entries' }, { status: 400 });
		}

		const result = await downloadMonitor.resolveUnmatchedEntries(entries);

		return json({ success: true, ...result });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Unmatched resolve failed');
		return json({ success: false, error: message }, { status: 500 });
	}
};

import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import {
	getJackettConnection,
	fetchJackettIndexers,
	normalizeJackettUrl,
	jackettIndexerUrl,
	isIndexerFromJackett,
	extractJackettIndexerId
} from '#lib/server/indexers/jackett/JackettConnectionService.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';

/**
 * GET: fetch indexers from the stored Jackett connection.
 * The API key is never sent to the client.
 * Each indexer includes `alreadyImported: boolean` based on live Cinephage indexers.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const conn = await getJackettConnection();
	if (!conn) {
		return Response.json({ error: 'No Jackett connection configured.' }, { status: 400 });
	}

	const base = normalizeJackettUrl(conn.url);

	let rawIndexers;
	try {
		rawIndexers = await fetchJackettIndexers(base, conn.apiKey);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const isTimeout = message.toLowerCase().includes('timeout') || message.includes('TimeoutError');
		return Response.json(
			{
				error: isTimeout
					? 'Connection timed out. Check that Jackett is still running.'
					: message.includes('Authentication')
						? message
						: 'Unable to reach Jackett. Check that it is still accessible.'
			},
			{ status: 502 }
		);
	}

	const manager = await getIndexerManager();
	const existingIndexers = await manager.getIndexers();

	const indexers = [];
	for (const raw of rawIndexers) {
		const baseUrl = jackettIndexerUrl(base, raw.id);
		const existing = existingIndexers.find((e) => {
			if (!isIndexerFromJackett(e, base)) return false;
			const s = e.settings as Record<string, unknown> | null;
			return extractJackettIndexerId(e.baseUrl, base, s) === raw.id;
		});
		if (existing && existing.name !== raw.name) {
			await manager.updateIndexer(existing.id, { name: raw.name });
		}
		indexers.push({
			id: raw.id,
			name: raw.name,
			type: raw.type ?? 'unknown',
			baseUrl,
			alreadyImported: Boolean(existing)
		});
	}

	indexers.sort((a, b) => a.name.localeCompare(b.name));

	return Response.json({ indexers });
};

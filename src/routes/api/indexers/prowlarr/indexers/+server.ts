import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import {
	getProwlarrConnection,
	fetchProwlarrIndexers,
	normalizeProwlarrUrl,
	isIndexerFromConnection,
	getProwlarrId
} from '#lib/server/indexers/prowlarr/ProwlarrConnectionService.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';

/**
 * GET - fetch indexers from Prowlarr using the stored connection's API key.
 * The API key is never sent to the client.
 * Each indexer includes `alreadyImported: boolean` based on the live Cinephage indexer list.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const conn = await getProwlarrConnection();
	if (!conn) {
		return Response.json({ error: 'No Prowlarr connection configured.' }, { status: 400 });
	}

	const base = normalizeProwlarrUrl(conn.url);

	let rawIndexers;
	try {
		rawIndexers = await fetchProwlarrIndexers(base, conn.apiKey);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const isTimeout = message.toLowerCase().includes('timeout') || message.includes('TimeoutError');
		return Response.json(
			{
				error: isTimeout
					? 'Connection timed out. Check that Prowlarr is still running.'
					: message.includes('Authentication')
						? message
						: 'Unable to reach Prowlarr. Check that it is still accessible.'
			},
			{ status: 502 }
		);
	}

	const manager = await getIndexerManager();
	const existingIndexers = await manager.getIndexers();

	const managedIndexers = existingIndexers.filter((i) => isIndexerFromConnection(i, base));
	const existingProwlarrIds = new Set(managedIndexers.map((i) => getProwlarrId(i, base)));
	const existingById = new Map(managedIndexers.map((i) => [getProwlarrId(i, base), i]));

	const indexers = [];
	for (const raw of rawIndexers) {
		const protocol = raw.protocol === 'usenet' ? 'usenet' : 'torrent';
		const existing = existingById.get(raw.id);

		if (existing && existing.name !== raw.name) {
			await manager.updateIndexer(existing.id, { name: raw.name });
		}

		indexers.push({
			id: raw.id,
			name: raw.name,
			enabled: raw.enable === true,
			protocol,
			definitionId: 'prowlarr',
			baseUrl: `${base}/${raw.id}`,
			privacy: typeof raw.privacy === 'string' ? raw.privacy : 'unknown',
			alreadyImported: existingProwlarrIds.has(raw.id)
		});
	}

	indexers.sort((a, b) => {
		if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return Response.json({ indexers });
};

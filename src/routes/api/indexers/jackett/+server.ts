import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import {
	normalizeJackettUrl,
	fetchJackettIndexers,
	jackettIndexerUrl,
	isIndexerFromJackett,
	extractJackettIndexerId
} from '#lib/server/indexers/jackett/JackettConnectionService.js';

const requestSchema = z.object({
	url: z.string().url('Jackett URL must be a valid URL'),
	apiKey: z.string().min(1, 'API key is required')
});

export interface JackettImportIndexer {
	id: string;
	name: string;
	type: string;
	baseUrl: string;
	alreadyImported: boolean;
}

/** POST: verify connection and return indexer list with alreadyImported flags. */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = requestSchema.safeParse(body);
	if (!result.success) {
		return Response.json(
			{ error: result.error.issues[0]?.message ?? 'Invalid request' },
			{ status: 400 }
		);
	}

	const { url: rawUrl, apiKey } = result.data;
	const jackettBase = normalizeJackettUrl(rawUrl);

	let rawIndexers;
	try {
		rawIndexers = await fetchJackettIndexers(jackettBase, apiKey);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const isTimeout = message.toLowerCase().includes('timeout') || message.includes('TimeoutError');
		return Response.json(
			{
				error: isTimeout
					? 'Connection timed out. Check that Jackett is running and the URL is correct.'
					: message.includes('Authentication')
						? message
						: 'Unable to reach Jackett. Check the URL and ensure Jackett is accessible.'
			},
			{ status: 502 }
		);
	}

	const manager = await getIndexerManager();
	const existingIndexers = await manager.getIndexers();

	const indexers: JackettImportIndexer[] = [];
	for (const raw of rawIndexers) {
		const baseUrl = jackettIndexerUrl(jackettBase, raw.id);
		const existing = existingIndexers.find((e) => {
			if (!isIndexerFromJackett(e, jackettBase)) return false;
			const s = e.settings as Record<string, unknown> | null;
			return extractJackettIndexerId(e.baseUrl, jackettBase, s) === raw.id;
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

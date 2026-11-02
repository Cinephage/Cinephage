import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import {
	normalizeProwlarrUrl,
	isIndexerFromConnection,
	getProwlarrId
} from '#lib/server/indexers/prowlarr/ProwlarrConnectionService.js';

const requestSchema = z.object({
	url: z.string().url('Prowlarr URL must be a valid URL'),
	apiKey: z.string().min(1, 'API key is required')
});

interface ProwlarrApiIndexer {
	id: number;
	name: string;
	enable: boolean;
	protocol: string;
	privacy?: string;
}

export interface ProwlarrImportIndexer {
	id: number;
	name: string;
	enabled: boolean;
	protocol: 'torrent' | 'usenet';
	definitionId: 'prowlarr';
	baseUrl: string;
	privacy: string;
	alreadyImported: boolean;
}

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

	// Normalize: strip trailing slash
	const prowlarrUrl = rawUrl.replace(/\/+$/, '');

	let apiResponse: Response;
	try {
		apiResponse = await fetch(`${prowlarrUrl}/api/v1/indexer`, {
			headers: {
				'X-Api-Key': apiKey,
				Accept: 'application/json'
			},
			signal: AbortSignal.timeout(10000)
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const isTimeout = message.toLowerCase().includes('timeout') || message.includes('TimeoutError');
		return Response.json(
			{
				error: isTimeout
					? 'Connection timed out. Check that Prowlarr is running and the URL is correct.'
					: 'Unable to reach Prowlarr. Check the URL and ensure Prowlarr is accessible.'
			},
			{ status: 502 }
		);
	}

	if (apiResponse.status === 401 || apiResponse.status === 403) {
		return Response.json(
			{ error: 'Authentication failed. Check your Prowlarr API key.' },
			{ status: 401 }
		);
	}

	if (!apiResponse.ok) {
		return Response.json(
			{ error: `Prowlarr returned an unexpected error (HTTP ${apiResponse.status}).` },
			{ status: 502 }
		);
	}

	let rawIndexers: unknown;
	try {
		rawIndexers = await apiResponse.json();
	} catch {
		return Response.json({ error: 'Prowlarr returned an invalid response.' }, { status: 502 });
	}

	if (!Array.isArray(rawIndexers)) {
		return Response.json({ error: 'Unexpected response format from Prowlarr.' }, { status: 502 });
	}

	const manager = await getIndexerManager();
	const existingIndexers = await manager.getIndexers();

	const prowlarrBase = normalizeProwlarrUrl(prowlarrUrl);
	const managedIndexers = existingIndexers.filter((i) => isIndexerFromConnection(i, prowlarrBase));
	const existingProwlarrIds = new Set(managedIndexers.map((i) => getProwlarrId(i, prowlarrBase)));
	const existingById = new Map(managedIndexers.map((i) => [getProwlarrId(i, prowlarrBase), i]));

	const indexers: ProwlarrImportIndexer[] = [];

	for (const raw of rawIndexers as ProwlarrApiIndexer[]) {
		if (typeof raw.id !== 'number' || typeof raw.name !== 'string') continue;

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
			baseUrl: `${prowlarrBase}/${raw.id}`,
			privacy: typeof raw.privacy === 'string' ? raw.privacy : 'unknown',
			alreadyImported: existingProwlarrIds.has(raw.id)
		});
	}

	// Sort: enabled first, then by name
	indexers.sort((a, b) => {
		if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return Response.json({ indexers });
};

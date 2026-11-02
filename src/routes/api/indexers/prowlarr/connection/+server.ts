import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import {
	getProwlarrConnection,
	saveProwlarrConnection,
	deleteProwlarrConnection,
	fetchProwlarrIndexers,
	normalizeProwlarrUrl,
	propagateProwlarrApiKey
} from '#lib/server/indexers/prowlarr/ProwlarrConnectionService.js';
import { z } from 'zod';

/**
 * When apiKey is omitted or empty, the stored key is preserved.
 * This lets "Save settings" (auto-sync toggle, interval) work without
 * requiring the user to re-enter their API key.
 */
const connectionSchema = z.object({
	url: z.string().url('Must be a valid URL'),
	apiKey: z.string().optional(),
	autoSync: z.boolean().default(false),
	syncIntervalHours: z.number().int().min(1).max(168).default(24),
	syncAddNew: z.boolean().default(false),
	useAggregateEndpoint: z.boolean().default(false)
});

/** GET - return current connection. The API key is never included in the response. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const conn = await getProwlarrConnection();
	if (!conn) return Response.json({ connection: null });

	return Response.json({
		connection: {
			url: conn.url,
			autoSync: conn.autoSync,
			syncIntervalHours: conn.syncIntervalHours,
			syncAddNew: conn.syncAddNew,
			useAggregateEndpoint: conn.useAggregateEndpoint,
			lastSyncAt: conn.lastSyncAt,
			lastSyncResult: conn.lastSyncResult,
			lastSyncError: conn.lastSyncError
		}
	});
};

/**
 * PUT - save or update connection.
 * If apiKey is provided and non-empty, connectivity is verified with it.
 * If omitted, the stored API key is reused (settings-only update).
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = connectionSchema.safeParse(body);
	if (!result.success) {
		return Response.json(
			{ error: result.error.issues[0]?.message ?? 'Invalid request' },
			{ status: 400 }
		);
	}

	const {
		url: rawUrl,
		apiKey: providedKey,
		autoSync,
		syncIntervalHours,
		syncAddNew,
		useAggregateEndpoint
	} = result.data;
	const url = normalizeProwlarrUrl(rawUrl);

	const existing = await getProwlarrConnection();
	const newKey = providedKey?.trim();

	// Determine which API key to use
	let apiKey: string;
	if (newKey) {
		// New key provided; verify it works
		apiKey = newKey;
		try {
			await fetchProwlarrIndexers(url, apiKey);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const isTimeout =
				message.toLowerCase().includes('timeout') || message.includes('TimeoutError');
			return Response.json(
				{
					error: isTimeout
						? 'Connection timed out. Check the URL and ensure Prowlarr is accessible.'
						: message.includes('Authentication')
							? message
							: 'Unable to reach Prowlarr. Check the URL and ensure Prowlarr is running.'
				},
				{ status: 502 }
			);
		}
	} else if (existing?.apiKey) {
		// No new key - reuse the stored one
		apiKey = existing.apiKey;
	} else {
		return Response.json({ error: 'API key is required.' }, { status: 400 });
	}

	await saveProwlarrConnection({
		url,
		apiKey,
		autoSync,
		syncIntervalHours,
		syncAddNew,
		useAggregateEndpoint: existing?.useAggregateEndpoint ?? useAggregateEndpoint,
		// Preserve sync history when the URL hasn't changed
		lastSyncAt: existing?.url === url ? (existing.lastSyncAt ?? null) : null,
		lastSyncResult: existing?.url === url ? (existing.lastSyncResult ?? null) : null,
		lastSyncError: existing?.url === url ? (existing.lastSyncError ?? null) : null
	});

	// If the API key changed, push the new key to all existing Prowlarr-sourced
	// indexers immediately so they don't 401 until the next scheduled sync.
	if (newKey && newKey !== existing?.apiKey) {
		propagateProwlarrApiKey(newKey).catch(() => {});
	}

	return Response.json({ success: true });
};

/** DELETE - remove connection. Already-imported indexers are not affected. */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	await deleteProwlarrConnection();
	return Response.json({ success: true });
};

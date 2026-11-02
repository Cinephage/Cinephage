import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import {
	getJackettConnection,
	saveJackettConnection,
	deleteJackettConnection,
	fetchJackettIndexers,
	normalizeJackettUrl,
	propagateJackettApiKey
} from '#lib/server/indexers/jackett/JackettConnectionService.js';
import { z } from 'zod';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

const connectionSchema = z.object({
	url: z.string().url('Must be a valid URL'),
	apiKey: z.string().optional(),
	adminPassword: z.string().optional(),
	autoSync: z.boolean().default(false),
	syncIntervalHours: z.number().int().min(1).max(168).default(24),
	syncAddNew: z.boolean().default(false)
});

/** GET: return current connection. The API key is never included in the response. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const conn = await getJackettConnection();
	if (!conn) return Response.json({ connection: null });

	return Response.json({
		connection: {
			url: conn.url,
			autoSync: conn.autoSync,
			syncIntervalHours: conn.syncIntervalHours,
			syncAddNew: conn.syncAddNew,
			lastSyncAt: conn.lastSyncAt,
			lastSyncResult: conn.lastSyncResult,
			lastSyncError: conn.lastSyncError
		}
	});
};

/**
 * PUT: save or update connection.
 * If apiKey is provided and non-empty, connectivity is verified.
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
		adminPassword: providedAdminPassword,
		autoSync,
		syncIntervalHours,
		syncAddNew
	} = result.data;
	const url = normalizeJackettUrl(rawUrl);

	const existing = await getJackettConnection();
	const newKey = providedKey?.trim();

	// Admin password: use provided value if non-empty, otherwise keep existing stored value.
	const adminPassword =
		providedAdminPassword !== undefined && providedAdminPassword !== ''
			? providedAdminPassword
			: (existing?.adminPassword ?? '');

	let apiKey: string;
	if (newKey) {
		apiKey = newKey;
		try {
			await fetchJackettIndexers(url, apiKey, adminPassword);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
			logger.error({ err, url }, '[Jackett] Connection verification failed');
			const isTimeout =
				message.toLowerCase().includes('timeout') || message.includes('TimeoutError');
			const detail = cause ? ` (${cause})` : '';
			return Response.json(
				{
					error: isTimeout
						? `Connection timed out. Check the URL and ensure Jackett is accessible.${detail}`
						: `Unable to reach Jackett: ${message}${detail}`
				},
				{ status: 502 }
			);
		}
	} else if (existing?.apiKey) {
		apiKey = existing.apiKey;
	} else {
		return Response.json({ error: 'API key is required.' }, { status: 400 });
	}

	await saveJackettConnection({
		url,
		apiKey,
		adminPassword: adminPassword || undefined,
		autoSync,
		syncIntervalHours,
		syncAddNew,
		lastSyncAt: existing?.url === url ? (existing.lastSyncAt ?? null) : null,
		lastSyncResult: existing?.url === url ? (existing.lastSyncResult ?? null) : null,
		lastSyncError: existing?.url === url ? (existing.lastSyncError ?? null) : null
	});

	// If the API key changed, push the new key to all existing Jackett-sourced
	// indexers immediately so they don't 401 until the next scheduled sync.
	if (newKey && newKey !== existing?.apiKey) {
		propagateJackettApiKey(newKey).catch(() => {});
	}

	return Response.json({ success: true });
};

/** DELETE: remove connection. Already-imported indexers are not affected. */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	await deleteJackettConnection();
	return Response.json({ success: true });
};

/**
 * History Retention API
 *
 * GET  /api/settings/library/history-retention
 * PUT  /api/settings/library/history-retention
 * GET  /api/settings/library/history-retention/forecast
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { librarySettings } from '#lib/server/db/schema.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';

const DEFAULTS = { fileHistoryDays: 30, libraryHistoryDays: 365, scanHistoryDays: 30 };

const retentionSchema = z.object({
	fileHistoryDays: z.number().int().min(0).max(3650),
	libraryHistoryDays: z.number().int().min(0).max(3650),
	scanHistoryDays: z.number().int().min(0).max(3650)
});

async function readAll(): Promise<{
	fileHistoryDays: number;
	libraryHistoryDays: number;
	scanHistoryDays: number;
}> {
	const rows = await db.select().from(librarySettings).all();
	const map = new Map(rows.map((r) => [r.key, r.value]));
	return {
		fileHistoryDays: Number(map.get('history_retention_file_days') ?? DEFAULTS.fileHistoryDays),
		libraryHistoryDays: Number(
			map.get('history_retention_library_days') ?? DEFAULTS.libraryHistoryDays
		),
		scanHistoryDays: Number(map.get('history_retention_scan_days') ?? DEFAULTS.scanHistoryDays)
	};
}

async function writeAll(values: {
	fileHistoryDays: number;
	libraryHistoryDays: number;
	scanHistoryDays: number;
}) {
	const upsert = (key: string, value: string) =>
		db
			.insert(librarySettings)
			.values({ key, value })
			.onConflictDoUpdate({ target: librarySettings.key, set: { value } });
	await upsert('history_retention_file_days', String(values.fileHistoryDays));
	await upsert('history_retention_library_days', String(values.libraryHistoryDays));
	await upsert('history_retention_scan_days', String(values.scanHistoryDays));
}

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const retention = await readAll();
	return Response.json(retention);
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = retentionSchema.safeParse(body);
	if (!parsed.success) throw error(400, 'Invalid retention settings');

	await writeAll(parsed.data);
	return Response.json({ success: true });
};

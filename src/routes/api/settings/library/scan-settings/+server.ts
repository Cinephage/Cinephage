/**
 * Library Scan Settings API
 *
 * GET  /api/settings/library/scan-settings
 * PUT  /api/settings/library/scan-settings
 *
 * Surfaces the previously-hidden librarySettings keys that controlled
 * the LibraryScheduler but had no UI:
 *   - scan_interval_hours (default 12) — periodic scan interval
 *   - watch_enabled (default true)     — filesystem watching
 *   - auto_match_threshold (default 0.8) — auto-match confidence
 *   - scan_on_startup (default true)   — scan on app startup
 *
 * Phase 4 (per-library scan modes) will give these proper per-library
 * treatment; this interim UI makes them visible and editable now.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { librarySettings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';

const KEYS = {
	scanIntervalHours: 'scan_interval_hours',
	watchEnabled: 'watch_enabled',
	autoMatchThreshold: 'auto_match_threshold',
	scanOnStartup: 'scan_on_startup'
} as const;

const DEFAULTS = {
	scanIntervalHours: 12,
	watchEnabled: true,
	autoMatchThreshold: 0.8,
	scanOnStartup: true
} as const;

const scanSettingsSchema = z.object({
	scanIntervalHours: z.number().min(1).max(168),
	watchEnabled: z.boolean(),
	autoMatchThreshold: z.number().min(0).max(1),
	scanOnStartup: z.boolean()
});

async function readSetting(key: string): Promise<string | null> {
	const row = await db
		.select()
		.from(librarySettings)
		.where(eq(librarySettings.key, key))
		.limit(1)
		.get();
	return row?.value ?? null;
}

async function writeSetting(key: string, value: string): Promise<void> {
	await db
		.insert(librarySettings)
		.values({ key, value })
		.onConflictDoUpdate({ target: librarySettings.key, set: { value } });
}

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const [intervalRaw, watchRaw, thresholdRaw, startupRaw] = await Promise.all([
		readSetting(KEYS.scanIntervalHours),
		readSetting(KEYS.watchEnabled),
		readSetting(KEYS.autoMatchThreshold),
		readSetting(KEYS.scanOnStartup)
	]);

	return Response.json({
		scanIntervalHours: intervalRaw ? Number(intervalRaw) : DEFAULTS.scanIntervalHours,
		watchEnabled: watchRaw !== null ? watchRaw === 'true' : DEFAULTS.watchEnabled,
		autoMatchThreshold: thresholdRaw ? Number(thresholdRaw) : DEFAULTS.autoMatchThreshold,
		scanOnStartup: startupRaw !== null ? startupRaw === 'true' : DEFAULTS.scanOnStartup
	});
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = scanSettingsSchema.safeParse(body);
	if (!parsed.success) {
		throw error(400, 'Invalid scan settings');
	}

	const { scanIntervalHours, watchEnabled, autoMatchThreshold, scanOnStartup } = parsed.data;

	await Promise.all([
		writeSetting(KEYS.scanIntervalHours, String(scanIntervalHours)),
		writeSetting(KEYS.watchEnabled, String(watchEnabled)),
		writeSetting(KEYS.autoMatchThreshold, String(autoMatchThreshold)),
		writeSetting(KEYS.scanOnStartup, String(scanOnStartup))
	]);

	return Response.json({ success: true });
};

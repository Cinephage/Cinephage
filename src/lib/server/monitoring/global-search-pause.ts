/**
 * Global "pause all automatic search" switch, independent of per-item pause
 * (movies.autoSearchPaused / episodes.autoSearchPaused). Stored as a single
 * monitoring_settings key rather than threaded through MonitoringScheduler's
 * MonitoringSettings interface/settings form, since this is an operational
 * kill switch surfaced on the Activity > Searches tab, not a persistent
 * scheduling preference.
 *
 * Unlike per-item pause (which a manual single-item "Search Now" bypasses,
 * same as it bypasses monitoring entirely), this blocks every automatic
 * search entry point in MonitoringSearchService - including a manual "Run
 * Now" on the whole task - since the point of a global stop is "nothing
 * runs, no exceptions" rather than a rate limit.
 */
import { db } from '#lib/server/db/index.js';
import { monitoringSettings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const SETTING_KEY = 'auto_search_globally_paused';

export async function isAutoSearchGloballyPaused(): Promise<boolean> {
	const [row] = await db
		.select({ value: monitoringSettings.value })
		.from(monitoringSettings)
		.where(eq(monitoringSettings.key, SETTING_KEY));
	return row?.value === 'true';
}

export async function setAutoSearchGloballyPaused(paused: boolean): Promise<void> {
	await db
		.insert(monitoringSettings)
		.values({ key: SETTING_KEY, value: String(paused) })
		.onConflictDoUpdate({ target: monitoringSettings.key, set: { value: String(paused) } });
}

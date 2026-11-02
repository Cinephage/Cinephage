/**
 * ARR COMPATIBILITY — UNSUPPORTED, BEST-EFFORT, NON-PRIORITY.
 *
 * Cinephage is its own thing, not a Radarr/Sonarr clone. The Radarr/Sonarr-
 * compatible surface exists only as a convenience for external tools; it is
 * not a product goal and we will not shape Cinephage around it. When an arr
 * client's expectations conflict with Cinephage behavior, Cinephage wins,
 * always. Never reshape, gate, or slow down core behavior to satisfy arr
 * compatibility, and arr-only failures are not release blockers.
 *
 * The arr projects are good at what they are — we're just not interested in
 * being one of them.
 *
 * Toggle for the Radarr/Sonarr-compatible API layer. Off by default.
 */

import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';

export const ARR_COMPAT_ENABLED_KEY = 'arr_compat_enabled';

export function isArrCompatEnabled(): boolean {
	const row = db.select().from(settings).where(eq(settings.key, ARR_COMPAT_ENABLED_KEY)).get();
	return row?.value === 'true';
}

export function setArrCompatEnabled(value: boolean): void {
	const stored = value ? 'true' : 'false';
	db.insert(settings)
		.values({ key: ARR_COMPAT_ENABLED_KEY, value: stored })
		.onConflictDoUpdate({ target: settings.key, set: { value: stored } })
		.run();
}

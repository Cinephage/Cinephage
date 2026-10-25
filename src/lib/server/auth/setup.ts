import { redirect, type RequestEvent } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';

/**
 * Check if admin setup is complete.
 *
 * Cached in module state because this runs on every request; the cache is
 * invalidated by markSetupComplete()/resetSetupCompleteCache() when the user
 * table changes (sign-up hook, tests). A missing user table (first run) is a
 * transient state and is never cached.
 */
let setupCompleteCache: boolean | null = null;

export async function isSetupComplete(): Promise<boolean> {
	if (setupCompleteCache !== null) {
		return setupCompleteCache;
	}
	try {
		const user = await db.query.user.findFirst({
			columns: {
				id: true
			}
		});
		setupCompleteCache = !!user;
		return setupCompleteCache;
	} catch {
		// Table doesn't exist yet (first run)
		return false;
	}
}

/** Force recomputation on the next isSetupComplete() call. */
export function resetSetupCompleteCache(): void {
	setupCompleteCache = null;
}

// The first-user bootstrap must be atomic: two parallel sign-up requests on a
// fresh instance would otherwise both observe "no users" and both insert with
// role admin. The claim row is the mutex — INSERT OR IGNORE wins once, and a
// guarded UPDATE recovers it if the winning request died before its user row
// landed (fresh-install sign-up failure), so a stuck claim cannot permanently
// lock the instance out of bootstrap.
const FIRST_USER_CLAIM_KEY = 'bootstrap_first_user_claimed_at';
const FIRST_USER_CLAIM_STALE_MS = 10 * 60 * 1000;

export async function claimFirstUserBootstrap(): Promise<boolean> {
	const now = Date.now();
	const insert = await db.run(sql`
		INSERT INTO settings (key, value) VALUES (${FIRST_USER_CLAIM_KEY}, ${String(now)})
		ON CONFLICT (key) DO NOTHING
	`);
	if (insert.changes > 0) {
		return true;
	}

	const takeover = await db.run(sql`
		UPDATE settings SET value = ${String(now)}
		WHERE key = ${FIRST_USER_CLAIM_KEY}
		  AND CAST(value AS INTEGER) < ${now - FIRST_USER_CLAIM_STALE_MS}
	`);
	return takeover.changes > 0;
}

/** Test helper: clear the bootstrap claim so a fresh first-user path can rerun. */
export async function resetFirstUserClaim(): Promise<void> {
	await db.run(sql`DELETE FROM settings WHERE key = ${FIRST_USER_CLAIM_KEY}`);
}

/**
 * Require setup to be incomplete (redirect to dashboard if setup is complete)
 * Use on setup/login pages
 */
export async function requireSetup(_event: RequestEvent): Promise<void> {
	const complete = await isSetupComplete();

	if (complete) {
		// Setup is complete, redirect to dashboard
		throw redirect(302, '/');
	}
}

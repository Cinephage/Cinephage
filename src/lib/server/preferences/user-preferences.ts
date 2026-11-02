/**
 * Per-account preference storage.
 *
 * Every preference is personal by definition: rows are keyed by
 * (userId, key) and nothing falls back to a global value. Values are JSON
 * strings validated with a per-key zod schema; a missing or unparseable
 * value yields the schema's defaults, so a corrupt row can never break a
 * page load.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '#lib/server/db/index.js';
import { userPreferences } from '#lib/server/db/schema.js';
import { calendarPreferencesSchema } from '#lib/validation/schemas.js';
import { themes } from '#lib/themes.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'UserPreferences', logDomain: 'system' });

export const preferenceSchemas = {
	calendar: calendarPreferencesSchema,
	// null = no account preference (client falls back to localStorage/system);
	// unlike calendar, an unset theme must not force a concrete value.
	theme: z.enum(themes).nullable().default(null),
	sidebarShowUsername: z.boolean().default(true)
} as const;

export type PreferenceKey = keyof typeof preferenceSchemas;

export function isPreferenceKey(key: string): key is PreferenceKey {
	return key in preferenceSchemas;
}

/**
 * A registry schema's implicit default: object schemas (calendar) default
 * their fields on `{}`, wrapped schemas (theme) default on `undefined`.
 * undefined = "no preference".
 */
function schemaFallback(schema: z.ZodType): unknown {
	const bare = schema.safeParse(undefined);
	if (bare.success) return bare.data;
	const empty = schema.safeParse({});
	return empty.success ? empty.data : undefined;
}

type CacheEntry = { value: unknown; expiresAt: number };
const CACHE_TTL_MS = 30_000;
/** Process-lifetime cache keyed `${userId}:${key}` — these rows change rarely. */
const cache = new Map<string, CacheEntry>();

function cacheKey(userId: string, key: PreferenceKey): string {
	return `${userId}:${key}`;
}

export async function getUserPreference<K extends PreferenceKey>(
	userId: string,
	key: K
): Promise<z.infer<(typeof preferenceSchemas)[K]>> {
	const schema = preferenceSchemas[key] as z.ZodType;
	const fallback = schemaFallback(schema);

	const cached = cache.get(cacheKey(userId, key));
	if (cached && cached.expiresAt > Date.now()) {
		return cached.value as z.infer<(typeof preferenceSchemas)[K]>;
	}

	const [row] = await db
		.select({ value: userPreferences.value })
		.from(userPreferences)
		.where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
		.limit(1);

	if (!row) {
		return fallback as z.infer<(typeof preferenceSchemas)[K]>;
	}

	try {
		const parsed = schema.parse(JSON.parse(row.value));
		cache.set(cacheKey(userId, key), { value: parsed, expiresAt: Date.now() + CACHE_TTL_MS });
		return parsed as z.infer<(typeof preferenceSchemas)[K]>;
	} catch (error) {
		logger.warn(
			{ err: error, userId, key },
			'[UserPreferences] Stored value failed validation; using defaults'
		);
		return fallback as z.infer<(typeof preferenceSchemas)[K]>;
	}
}

export async function setUserPreference<K extends PreferenceKey>(
	userId: string,
	key: K,
	value: z.infer<(typeof preferenceSchemas)[K]>
): Promise<void> {
	const schema = preferenceSchemas[key] as z.ZodType;
	const validated = schema.parse(value);

	await db
		.insert(userPreferences)
		.values({ userId, key, value: JSON.stringify(validated) })
		.onConflictDoUpdate({
			target: [userPreferences.userId, userPreferences.key],
			set: { value: JSON.stringify(validated), updatedAt: new Date().toISOString() }
		});

	cache.set(cacheKey(userId, key), { value: validated, expiresAt: Date.now() + CACHE_TTL_MS });
}

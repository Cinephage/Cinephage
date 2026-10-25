import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

export const REQUEST_SETTINGS_KEY = 'request_settings';

/**
 * Global request-system configuration, stored as one JSON settings key.
 * Null quota limits mean unlimited; null days mean all-time windows.
 */
export const requestSettingsSchema = z.object({
	requestsEnabled: z.boolean().default(true),
	autoApprove: z
		.object({
			movie: z.boolean().default(false),
			series: z.boolean().default(false)
		})
		.default({ movie: false, series: false }),
	defaultQuotas: z
		.object({
			movie: z.object({
				limit: z.number().int().min(0).nullable().default(null),
				days: z.number().int().min(1).nullable().default(null)
			}),
			tv: z.object({
				limit: z.number().int().min(0).nullable().default(null),
				days: z.number().int().min(1).nullable().default(null)
			})
		})
		.default({ movie: { limit: null, days: null }, tv: { limit: null, days: null } }),
	tvQuotaUnit: z.enum(['episodes', 'seasons']).default('episodes'),
	pendingTtlDays: z.number().int().min(0).default(30),
	reRequestCooldownDays: z.number().int().min(0).default(7)
});

export type RequestSettings = z.infer<typeof requestSettingsSchema>;

const CACHE_TTL_MS = 30_000;
let cache: { value: RequestSettings; expiresAt: number } | null = null;

function defaults(): RequestSettings {
	return requestSettingsSchema.parse({});
}

/**
 * Owns the `request_settings` settings key. Reads fall back to defaults on
 * a missing or corrupt row so the request system can never be bricked by a
 * bad write; writes are always schema-validated whole-object replaces.
 */
export class RequestSettingsService {
	async getRequestSettings(): Promise<RequestSettings> {
		if (cache && Date.now() < cache.expiresAt) {
			return cache.value;
		}

		const row = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, REQUEST_SETTINGS_KEY))
			.get();

		let value = defaults();
		if (row) {
			try {
				const parsed = requestSettingsSchema.safeParse(
					row.value ? (JSON.parse(row.value) as unknown) : {}
				);
				if (parsed.success) {
					value = parsed.data;
				}
			} catch {
				// Corrupt stored JSON degrades to defaults.
			}
		}

		cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
		return value;
	}

	async saveRequestSettings(update: Partial<RequestSettings>): Promise<RequestSettings> {
		const current = await this.getRequestSettings();
		const next = requestSettingsSchema.parse({ ...current, ...update });

		await db
			.insert(settings)
			.values({ key: REQUEST_SETTINGS_KEY, value: JSON.stringify(next) })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value: JSON.stringify(next) }
			});

		cache = { value: next, expiresAt: Date.now() + CACHE_TTL_MS };
		return next;
	}

	/** Test hook: drop the TTL cache. */
	invalidateCache(): void {
		cache = null;
	}
}

let _instance: RequestSettingsService | null = null;

export function getRequestSettingsService(): RequestSettingsService {
	if (!_instance) {
		_instance = new RequestSettingsService();
	}
	return _instance;
}

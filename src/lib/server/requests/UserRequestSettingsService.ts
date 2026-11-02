import { db } from '#lib/server/db/index.js';
import { userRequestSettings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Admin-managed per-user request overrides. Null values inherit the global
 * `request_settings` defaults. This is deliberately a dedicated table —
 * `user_preferences` is self-writable by the account owner and must never
 * hold admin-controlled values.
 */
export const userRequestSettingsUpdateSchema = z.object({
	requestsDisabled: z.boolean().optional(),
	// Tri-state: null inherits the global auto-approve setting.
	autoApprove: z.boolean().nullable().optional(),
	movieQuotaLimit: z.number().int().min(0).nullable().optional(),
	movieQuotaDays: z.number().int().min(1).nullable().optional(),
	tvQuotaLimit: z.number().int().min(0).nullable().optional(),
	tvQuotaDays: z.number().int().min(1).nullable().optional()
});

export type UserRequestSettingsUpdate = z.infer<typeof userRequestSettingsUpdateSchema>;

export type UserRequestSettingsRow = {
	userId: string;
	requestsDisabled: boolean;
	autoApprove: boolean | null;
	movieQuotaLimit: number | null;
	movieQuotaDays: number | null;
	tvQuotaLimit: number | null;
	tvQuotaDays: number | null;
};

// Drizzle's boolean-mode columns already round-trip JS booleans (and keep
// null as null), so the row shape maps 1:1 onto the settings shape.
function rowToSettings(row: {
	userId: string;
	requestsDisabled: boolean;
	autoApprove: boolean | null;
	movieQuotaLimit: number | null;
	movieQuotaDays: number | null;
	tvQuotaLimit: number | null;
	tvQuotaDays: number | null;
}): UserRequestSettingsRow {
	return { ...row };
}

export class UserRequestSettingsService {
	async getUserRequestSettings(userId: string): Promise<UserRequestSettingsRow> {
		const row = await db
			.select()
			.from(userRequestSettings)
			.where(eq(userRequestSettings.userId, userId))
			.get();

		if (!row) {
			return {
				userId,
				requestsDisabled: false,
				autoApprove: null,
				movieQuotaLimit: null,
				movieQuotaDays: null,
				tvQuotaLimit: null,
				tvQuotaDays: null
			};
		}
		return rowToSettings(row);
	}

	async updateUserRequestSettings(
		userId: string,
		update: UserRequestSettingsUpdate
	): Promise<UserRequestSettingsRow> {
		const current = await this.getUserRequestSettings(userId);
		const next = {
			requestsDisabled: update.requestsDisabled ?? current.requestsDisabled,
			autoApprove: update.autoApprove === undefined ? current.autoApprove : update.autoApprove,
			movieQuotaLimit:
				update.movieQuotaLimit === undefined ? current.movieQuotaLimit : update.movieQuotaLimit,
			movieQuotaDays:
				update.movieQuotaDays === undefined ? current.movieQuotaDays : update.movieQuotaDays,
			tvQuotaLimit: update.tvQuotaLimit === undefined ? current.tvQuotaLimit : update.tvQuotaLimit,
			tvQuotaDays: update.tvQuotaDays === undefined ? current.tvQuotaDays : update.tvQuotaDays
		};

		await db
			.insert(userRequestSettings)
			.values({
				userId,
				requestsDisabled: next.requestsDisabled,
				autoApprove: next.autoApprove,
				movieQuotaLimit: next.movieQuotaLimit,
				movieQuotaDays: next.movieQuotaDays,
				tvQuotaLimit: next.tvQuotaLimit,
				tvQuotaDays: next.tvQuotaDays,
				updatedAt: new Date().toISOString()
			})
			.onConflictDoUpdate({
				target: userRequestSettings.userId,
				set: {
					requestsDisabled: next.requestsDisabled,
					autoApprove: next.autoApprove,
					movieQuotaLimit: next.movieQuotaLimit,
					movieQuotaDays: next.movieQuotaDays,
					tvQuotaLimit: next.tvQuotaLimit,
					tvQuotaDays: next.tvQuotaDays,
					updatedAt: new Date().toISOString()
				}
			});

		return this.getUserRequestSettings(userId);
	}
}

let _instance: UserRequestSettingsService | null = null;

export function getUserRequestSettingsService(): UserRequestSettingsService {
	if (!_instance) {
		_instance = new UserRequestSettingsService();
	}
	return _instance;
}

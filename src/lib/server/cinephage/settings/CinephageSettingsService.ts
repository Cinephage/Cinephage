import { db } from '#lib/server/db/index.js';
import { cinephageApiConfig, cinephageApiModules } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Default subsystem configuration. Returned from getConfig() when no row
 * exists yet in the database (e.g. before migration 101 has seeded, or when
 * a test wipes the table). updateConfig() persists a row on first write.
 */
export const DEFAULT_CINEPHAGE_CONFIG = {
	enabled: true,
	baseUrl: 'https://api.cinephage.net',
	versionOverride: null as string | null,
	commitOverride: null as string | null,
	autoUpdate: true,
	latestVersion: null as string | null,
	latestCommit: null as string | null
} as const;

const DEFAULT_MODULE_SETTINGS = {} as const;

export interface CinephageSubsystemConfig {
	enabled: boolean;
	baseUrl: string;
	versionOverride: string | null;
	commitOverride: string | null;
	autoUpdate: boolean;
	latestVersion: string | null;
	latestCommit: string | null;
}

export interface CinephageModuleState {
	moduleId: string;
	enabled: boolean;
	settings: Record<string, unknown>;
	lastError: string | null;
}

type ConfigUpdate = Partial<{
	enabled: boolean;
	baseUrl: string;
	versionOverride: string | null;
	commitOverride: string | null;
	autoUpdate: boolean;
	latestVersion: string | null;
	latestCommit: string | null;
}>;

/**
 * CinephageSettingsService
 *
 * Reads and writes the CinephageAPI subsystem configuration. Owns two tables:
 *   - cinephage_api_config (singleton row, id = 1): subsystem-level config
 *   - cinephage_api_modules (one row per module): per-module enable state + settings
 *
 * Reads are tolerant of missing rows and return sensible defaults. Writes
 * upsert, creating the row on first update.
 */
export class CinephageSettingsService {
	/** Get the subsystem config, with defaults applied if no row exists. */
	async getConfig(): Promise<CinephageSubsystemConfig> {
		const rows = await db
			.select()
			.from(cinephageApiConfig)
			.where(eq(cinephageApiConfig.id, 1))
			.limit(1);

		if (rows.length === 0) {
			return { ...DEFAULT_CINEPHAGE_CONFIG };
		}

		const row = rows[0];
		return {
			enabled: row.enabled,
			baseUrl: row.baseUrl,
			versionOverride: row.versionOverride,
			commitOverride: row.commitOverride,
			autoUpdate: row.autoUpdate,
			latestVersion: row.latestVersion,
			latestCommit: row.latestCommit
		};
	}

	/** Update the subsystem config. Creates the singleton row on first write. */
	async updateConfig(updates: ConfigUpdate): Promise<void> {
		const now = new Date().toISOString();
		const setClause: Record<string, unknown> = { updatedAt: now };
		if (updates.enabled !== undefined) setClause.enabled = updates.enabled;
		if (updates.baseUrl !== undefined) setClause.baseUrl = updates.baseUrl;
		if (updates.versionOverride !== undefined) setClause.versionOverride = updates.versionOverride;
		if (updates.commitOverride !== undefined) setClause.commitOverride = updates.commitOverride;
		if (updates.autoUpdate !== undefined) setClause.autoUpdate = updates.autoUpdate;
		if (updates.latestVersion !== undefined) setClause.latestVersion = updates.latestVersion;
		if (updates.latestCommit !== undefined) setClause.latestCommit = updates.latestCommit;

		await db
			.insert(cinephageApiConfig)
			.values({
				id: 1,
				enabled: updates.enabled ?? DEFAULT_CINEPHAGE_CONFIG.enabled,
				baseUrl: updates.baseUrl ?? DEFAULT_CINEPHAGE_CONFIG.baseUrl,
				versionOverride: updates.versionOverride ?? null,
				commitOverride: updates.commitOverride ?? null,
				autoUpdate: updates.autoUpdate ?? DEFAULT_CINEPHAGE_CONFIG.autoUpdate,
				latestVersion: updates.latestVersion ?? null,
				latestCommit: updates.latestCommit ?? null,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: cinephageApiConfig.id,
				set: setClause
			});
	}

	/** Get a module's state. Returns defaults for unknown modules. */
	async getModuleConfig(moduleId: string): Promise<CinephageModuleState> {
		const rows = await db
			.select()
			.from(cinephageApiModules)
			.where(eq(cinephageApiModules.moduleId, moduleId))
			.limit(1);

		if (rows.length === 0) {
			return {
				moduleId,
				enabled: true,
				settings: { ...DEFAULT_MODULE_SETTINGS },
				lastError: null
			};
		}

		const row = rows[0];
		return {
			moduleId: row.moduleId,
			enabled: row.enabled,
			settings: row.settings,
			lastError: row.lastError
		};
	}

	/** Toggle a module's enable state. Creates the row if missing. */
	async setModuleEnabled(moduleId: string, enabled: boolean): Promise<void> {
		const now = new Date().toISOString();
		await db
			.insert(cinephageApiModules)
			.values({ moduleId, enabled, settings: {}, updatedAt: now })
			.onConflictDoUpdate({
				target: cinephageApiModules.moduleId,
				set: { enabled, updatedAt: now }
			});
	}

	/** Replace a module's settings JSON entirely. Creates the row if missing. */
	async updateModuleSettings(moduleId: string, settings: Record<string, unknown>): Promise<void> {
		const now = new Date().toISOString();
		await db
			.insert(cinephageApiModules)
			.values({ moduleId, enabled: true, settings, updatedAt: now })
			.onConflictDoUpdate({
				target: cinephageApiModules.moduleId,
				set: { settings, updatedAt: now }
			});
	}

	/** Store the error message from a failed module test() call. */
	async recordModuleError(moduleId: string, errorMessage: string): Promise<void> {
		const now = new Date().toISOString();
		await db
			.insert(cinephageApiModules)
			.values({ moduleId, enabled: true, settings: {}, lastError: errorMessage, updatedAt: now })
			.onConflictDoUpdate({
				target: cinephageApiModules.moduleId,
				set: { lastError: errorMessage, updatedAt: now }
			});
	}

	/** Clear a module's error state after a successful test(). */
	async clearModuleError(moduleId: string): Promise<void> {
		const now = new Date().toISOString();
		await db
			.update(cinephageApiModules)
			.set({ lastError: null, updatedAt: now })
			.where(eq(cinephageApiModules.moduleId, moduleId));
	}
}

// Singleton management (matches codebase convention)
let _instance: CinephageSettingsService | null = null;

export function getCinephageSettingsService(): CinephageSettingsService {
	if (!_instance) {
		_instance = new CinephageSettingsService();
	}
	return _instance;
}

export function resetCinephageSettingsService(): void {
	_instance = null;
}

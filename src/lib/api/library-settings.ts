/**
 * Library Settings API client
 *
 * Typed client for library-level settings that are not per-library-entity
 * (scan scheduler config, watcher, auto-match). Per-library-entity settings
 * go through #lib/api/settings.ts (libraries CRUD).
 */

import { apiGet, apiPut } from './client.js';

export interface ScanSettings {
	scanIntervalHours: number;
	watchEnabled: boolean;
	autoMatchThreshold: number;
	scanOnStartup: boolean;
}

/**
 * The GET endpoint returns the bare settings object, not the success/error
 * envelope.
 */
export async function getScanSettings(): Promise<ScanSettings> {
	const response = await apiGet('/api/settings/library/scan-settings');
	return response as unknown as ScanSettings;
}

export async function saveScanSettings(input: ScanSettings): Promise<{ success: boolean }> {
	return apiPut<{ success: boolean }>('/api/settings/library/scan-settings', input);
}

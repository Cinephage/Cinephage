import { apiGet, apiPut } from './client.js';

export interface HistoryRetentionSettings {
	fileHistoryDays: number;
	libraryHistoryDays: number;
	scanHistoryDays: number;
}

export interface StorageForecast {
	currentEstimatedBytes: number;
	averageDailyBytes: number;
	projectedBytes30d: number;
	projectedBytes90d: number;
}

/** The GET endpoint returns the bare retention settings, not the success envelope. */
export async function getHistoryRetention(): Promise<HistoryRetentionSettings> {
	const response = await apiGet('/api/settings/library/history-retention');
	return response as unknown as HistoryRetentionSettings;
}

export async function saveHistoryRetention(
	input: HistoryRetentionSettings
): Promise<{ success: boolean }> {
	return apiPut<{ success: boolean }>('/api/settings/library/history-retention', input);
}

/** The forecast endpoint returns the bare projection object, not the success envelope. */
export async function getStorageForecast(): Promise<StorageForecast> {
	const response = await apiGet('/api/settings/library/history-retention/forecast');
	return response as unknown as StorageForecast;
}

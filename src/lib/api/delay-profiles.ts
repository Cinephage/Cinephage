/**
 * Delay Profiles API client
 *
 * Typed CRUD for release delay profiles (download-timing policy).
 * Replaces raw fetch() calls in the Quality settings page that violated
 * the project's no-fetch-in-components rule.
 *
 * Endpoints:
 *   GET    /api/settings/delay-profiles        - list all profiles
 *   POST   /api/settings/delay-profiles        - create a profile
 *   PUT    /api/settings/delay-profiles/[id]   - update a profile
 *   DELETE /api/settings/delay-profiles/[id]   - delete a profile
 */

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

/**
 * A delay_profiles row as serialized by GET /api/settings/delay-profiles
 * (a full DB row: JSON columns already parsed, timestamps as ISO strings).
 */
export interface DelayProfile {
	id: string;
	name: string;
	sortOrder: number;
	qualityProfileId: string | null;
	scanMode: string;
	scanConfig: {
		intervalMinutes?: number;
		scheduledTime?: string;
		debounceSeconds?: number;
	} | null;
	enabled: boolean | null;
	usenetDelay: number;
	torrentDelay: number;
	qualityDelays: Record<string, number> | null;
	preferredProtocol: string | null;
	tags: string[] | null;
	bypassIfHighestQuality: boolean | null;
	bypassIfAboveScore: number | null;
	createdAt: string | null;
	updatedAt: string | null;
}

export interface DelayProfileInput {
	name: string;
	enabled?: boolean;
	torrentDelay?: number;
	usenetDelay?: number;
	preferredProtocol?: string | null;
	bypassIfHighestQuality?: boolean;
	bypassIfAboveScore?: number | null;
	tags?: string[];
	qualityDelays?: Record<string, number>;
	sortOrder?: number;
}

/**
 * List all delay profiles.
 * The endpoint returns the bare profiles array, not the success/error envelope.
 */
export async function listDelayProfiles(): Promise<DelayProfile[]> {
	const response = await apiGet('/api/settings/delay-profiles');
	return response as unknown as DelayProfile[];
}

/**
 * Create a new delay profile.
 * Returns { success, id } from the endpoint.
 */
export async function createDelayProfile(
	input: DelayProfileInput
): Promise<{ success: boolean; id: string }> {
	return apiPost<{ success: boolean; id: string }>('/api/settings/delay-profiles', input);
}

/**
 * Update an existing delay profile.
 * Returns { success } from the endpoint.
 */
export async function updateDelayProfile(
	id: string,
	input: DelayProfileInput
): Promise<{ success: boolean }> {
	return apiPut<{ success: boolean }>(`/api/settings/delay-profiles/${id}`, input);
}

/**
 * Delete a delay profile.
 * Media assigned to the profile falls back to no delay.
 */
export async function deleteDelayProfile(id: string): Promise<{ success: boolean }> {
	return apiDelete<{ success: boolean }>(`/api/settings/delay-profiles/${id}`);
}

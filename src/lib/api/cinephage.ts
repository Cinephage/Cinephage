import type { CinephageSubsystemUpdate, CinephageModuleUpdate } from '#lib/validation/schemas.js';

import { apiGet, apiPost, apiPut } from './client.js';

/**
 * CinephageAPI subsystem state (returned from GET /api/cinephage).
 * Mirrors the shape constructed by the +page.server.ts load function.
 */
export interface CinephageSubsystemState {
	config: {
		enabled: boolean;
		baseUrl: string;
		versionOverride: string | null;
		commitOverride: string | null;
		autoUpdate: boolean;
		latestVersion: string | null;
		latestCommit: string | null;
	};
	identity: {
		version: string;
		commit: string | null;
		isConfigured: boolean;
	};
	modules: Array<{
		moduleId: string;
		name: string;
		description: string;
		maturity: 'stable' | 'beta';
		enabled: boolean;
		settings: Record<string, unknown>;
		lastError: string | null;
		capabilities: { providesIndexer?: { definitionId: string } };
	}>;
}

export interface CinephageTestResult {
	success: boolean;
	error?: string;
}

export async function getCinephageState() {
	return apiGet<CinephageSubsystemState>('/api/cinephage');
}

export async function testCinephageConnection() {
	return apiPost<CinephageTestResult>('/api/cinephage/test');
}

export async function updateCinephageConfig(payload: CinephageSubsystemUpdate) {
	return apiPut<CinephageSubsystemState>('/api/cinephage/config', payload);
}

export async function updateCinephageModule(payload: CinephageModuleUpdate) {
	return apiPut<CinephageSubsystemState>(`/api/cinephage/modules/${payload.moduleId}`, payload);
}

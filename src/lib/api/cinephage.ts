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
		installKey: {
			installId: string | null;
			registered: boolean;
			keyPrefix: string | null;
			registrationEmail: string | null;
		};
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

/** Registration result - `key` is present exactly once, right after registering. */
export interface CinephageRegisterResult {
	success: boolean;
	key?: string;
	keyPrefix?: string;
	rotated?: boolean;
	installId?: string;
	error?: string;
	code?: string;
}

export interface CinephageRevokeResult {
	success: boolean;
	revoked?: boolean;
	wasRegistered?: boolean;
	error?: string;
}

export async function getCinephageState() {
	return apiGet<CinephageSubsystemState>('/api/cinephage');
}

export async function testCinephageConnection() {
	return apiPost<CinephageTestResult>('/api/cinephage/test');
}

/** Register (or rotate) this install's gateway key. Response carries the plaintext key once. */
export async function registerCinephageInstall(payload: { email: string; label?: string }) {
	return apiPost<CinephageRegisterResult>('/api/cinephage/register', payload);
}

/** Revoke this install's gateway key and drop the stored copy. */
export async function revokeCinephageInstall() {
	return apiPost<CinephageRevokeResult>('/api/cinephage/revoke');
}

export async function updateCinephageConfig(payload: CinephageSubsystemUpdate) {
	return apiPut<CinephageSubsystemState>('/api/cinephage/config', payload);
}

export async function updateCinephageModule(payload: CinephageModuleUpdate) {
	return apiPut<CinephageSubsystemState>(`/api/cinephage/modules/${payload.moduleId}`, payload);
}

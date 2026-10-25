import type {
	MonitoringSettingsUpdate,
	CaptchaSolverSettingsUpdate,
	CaptchaSolverTestRequest
} from '#lib/validation/schemas.js';

import { apiGet, apiPut, apiDelete, apiPost } from './client.js';

// ---------------------------------------------------------------------------
// Response payload types (client mirrors of the JSON the server emits)
// ---------------------------------------------------------------------------

/** Scheduling status of a single monitoring task. Dates arrive as ISO strings. */
export interface MonitoringTaskStatus {
	lastRunTime: string | null;
	nextRunTime: string | null;
	intervalHours: number;
	isRunning: boolean;
}

/** Response of GET /api/monitoring/status (scheduler status spread at top level). */
export interface MonitoringStatusResponse {
	tasks: {
		missing: MonitoringTaskStatus;
		upgrade: MonitoringTaskStatus;
		newEpisode: MonitoringTaskStatus;
		cutoffUnmet: MonitoringTaskStatus;
		pendingRelease: MonitoringTaskStatus;
		missingSubtitles: MonitoringTaskStatus;
		subtitleUpgrade: MonitoringTaskStatus;
		smartListRefresh: MonitoringTaskStatus;
		historyCleanup: MonitoringTaskStatus;
		'library-reconcile': MonitoringTaskStatus;
		dbBackup: MonitoringTaskStatus;
		'metadata-refresh': MonitoringTaskStatus;
	};
}

/** Monitoring settings block returned by the monitoring settings endpoints. */
export interface MonitoringSettings {
	missingSearchIntervalHours: number;
	upgradeSearchIntervalHours: number;
	newEpisodeCheckIntervalHours: number;
	cutoffUnmetSearchIntervalHours: number;
	stalledDownloadTimeoutMinutes: number;
	stalledDownloadProgressThreshold: number;
	stalledDownloadBlocklistHours: number;
}

/** Response of GET /api/monitoring/settings. */
export interface MonitoringSettingsResponse {
	settings: MonitoringSettings;
	status: { tasks: MonitoringStatusResponse['tasks'] };
}

/** Response of PUT /api/monitoring/settings. */
export interface MonitoringSettingsUpdateResponse extends MonitoringSettingsResponse {
	message: string;
}

/** Result of one monitoring task run, as reported by the scheduler. */
export interface MonitoringTaskResult {
	taskType: string;
	itemsProcessed: number;
	itemsGrabbed: number;
	errors: number;
	executedAt: string;
}

/**
 * Response of the manual search/processing trigger endpoints (missing,
 * new-episodes, cutoff-unmet, pending-releases, missing-subtitles,
 * subtitle-upgrade, and the non-dry-run upgrade search).
 */
export interface MonitoringSearchResponse {
	message: string;
	result: MonitoringTaskResult;
}

/** Captcha solver settings as masked by the captcha-solver endpoints. */
export interface CaptchaSolverSettings {
	enabled: boolean;
	timeoutSeconds: number;
	cacheTtlSeconds: number;
	headless: boolean;
	proxyUrl: string;
	proxyUsername: string;
	proxyPassword: string;
}

/** Solver statistics reported by the health endpoint. Dates arrive as ISO strings. */
export interface CaptchaSolverStats {
	totalAttempts: number;
	successCount: number;
	failureCount: number;
	cacheHits: number;
	avgSolveTimeMs: number;
	cacheSize: number;
	fetchAttempts: number;
	fetchSuccessCount: number;
	fetchFailureCount: number;
	avgFetchTimeMs: number;
	lastSolveAt?: string;
	lastFetchAt?: string;
	lastError?: string;
}

/** Health snapshot returned by GET /api/captcha-solver/health. */
export interface CaptchaSolverHealth {
	available: boolean;
	status: 'ready' | 'busy' | 'disabled' | 'error' | 'initializing';
	browserAvailable: boolean;
	error?: string;
	stats: CaptchaSolverStats;
}

/** Response of GET /api/captcha-solver. */
export interface CaptchaSolverSettingsResponse {
	settings: CaptchaSolverSettings;
	// Index signature: the settings page narrows this response through
	// `as Record<string, unknown>` casts, which need an index signature to compile.
	[key: string]: unknown;
}

/** Response of PUT /api/captcha-solver. */
export interface CaptchaSolverSettingsUpdateResponse {
	message: string;
	settings: CaptchaSolverSettings;
}

/** Response of DELETE /api/captcha-solver (reset to defaults). */
export interface CaptchaSolverSettingsResetResponse {
	message: string;
	settings: CaptchaSolverSettings;
}

/** Response of GET /api/captcha-solver/health. */
export interface CaptchaSolverHealthResponse {
	health: CaptchaSolverHealth;
	// Index signature: the settings page narrows this response through
	// `as Record<string, unknown>` casts, which need an index signature to compile.
	[key: string]: unknown;
}

/** Challenge types the captcha solver can detect and solve. */
export type CaptchaSolverChallengeType =
	'cloudflare' | 'cloudflare_turnstile' | 'cloudflare_managed' | 'ddos_guard' | 'unknown';

/** Response of POST /api/captcha-solver/test (fields depend on the outcome). */
export interface CaptchaSolverTestResponse {
	hasChallenge: boolean;
	/** Present when no challenge was detected. */
	message?: string;
	/** Present when a challenge was detected. */
	challengeType?: CaptchaSolverChallengeType;
	confidence?: number;
	solveTimeMs?: number;
	cookiesObtained?: number;
	userAgent?: string;
}

/** Response of DELETE /api/captcha-solver/health (cache clear + stats reset). */
export interface CaptchaSolverCacheClearResponse {
	message: string;
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

export async function getMonitoringStatus() {
	return apiGet<MonitoringStatusResponse>('/api/monitoring/status');
}

export async function getMonitoringSettings() {
	return apiGet<MonitoringSettingsResponse>('/api/monitoring/settings');
}

export async function updateMonitoringSettings(payload: MonitoringSettingsUpdate) {
	return apiPut<MonitoringSettingsUpdateResponse>('/api/monitoring/settings', payload);
}

export async function getCaptchaSolverSettings() {
	return apiGet<CaptchaSolverSettingsResponse>('/api/captcha-solver');
}

export async function updateCaptchaSolverSettings(payload: CaptchaSolverSettingsUpdate) {
	return apiPut<CaptchaSolverSettingsUpdateResponse>('/api/captcha-solver', payload);
}

export async function resetCaptchaSolverSettings() {
	return apiDelete<CaptchaSolverSettingsResetResponse>('/api/captcha-solver');
}

export async function testCaptchaSolver(payload?: CaptchaSolverTestRequest) {
	return apiPost<CaptchaSolverTestResponse>('/api/captcha-solver/test', payload);
}

export async function getCaptchaSolverHealth() {
	return apiGet<CaptchaSolverHealthResponse>('/api/captcha-solver/health');
}

export async function getMissingSearch() {
	return apiGet<MonitoringSearchResponse>('/api/monitoring/search/missing');
}

export async function getUpgradeSearch() {
	// The route also serves a ?dryRun=true variant, but this wrapper never sends it.
	return apiGet<MonitoringSearchResponse>('/api/monitoring/search/upgrade');
}

export async function getNewEpisodesSearch() {
	return apiGet<MonitoringSearchResponse>('/api/monitoring/search/new-episodes');
}

export async function getCutoffUnmetSearch() {
	return apiGet<MonitoringSearchResponse>('/api/monitoring/search/cutoff-unmet');
}

export async function getPendingReleases() {
	return apiGet<MonitoringSearchResponse>('/api/monitoring/search/pending-releases');
}

export async function getMissingSubtitles() {
	return apiGet<MonitoringSearchResponse>('/api/monitoring/search/missing-subtitles');
}

export async function getSubtitleUpgrade() {
	return apiGet<MonitoringSearchResponse>('/api/monitoring/search/subtitle-upgrade');
}

export async function clearCaptchaSolverCache() {
	return apiDelete<CaptchaSolverCacheClearResponse>('/api/captcha-solver/health');
}

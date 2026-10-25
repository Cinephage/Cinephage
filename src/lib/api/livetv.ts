import type {
	StalkerPortalCreate,
	StalkerPortalUpdate,
	LiveTvAccountCreate,
	UpdateChannel,
	AddBackupLink,
	ChannelCategoryForm
} from '#lib/validation/schemas.js';
import type {
	AccountSyncStatus,
	CachedChannel,
	ChannelBackupLink,
	ChannelCategory,
	ChannelLineupItemWithDetails,
	ChannelSyncResult,
	EpgProgram,
	EpgProgramWithProgress,
	EpgStatus,
	LiveTvAccount,
	LiveTvAccountTestResult,
	LiveTvCategory
} from '#lib/types/livetv.js';

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

// ============================================================================
// RESPONSE TYPES
//
// Client-safe mirrors of the /api/livetv endpoint payloads. Source of truth:
// the route handlers under src/routes/api/livetv/ (keep in sync).
// ============================================================================

/** Response of GET /api/livetv/channels (paginated channel cache). */
export interface LiveTvChannelsResponse {
	channels: CachedChannel[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

/** Response of POST /api/livetv/channels/sync, keyed by account ID. */
export interface ChannelSyncResponse {
	results: Record<string, ChannelSyncResult>;
}

/** Response of GET /api/livetv/channels/sync/status. */
export interface ChannelSyncStatusResponse {
	accounts: AccountSyncStatus[];
}

/** A channel that has at least one EPG program (with-epg list item). */
export interface ChannelWithEpgInfo {
	id: string;
	accountId: string;
	name: string;
	number: string | null;
	logo: string | null;
	categoryTitle: string | null;
	accountName: string;
	programCount: number;
}

/** Response of GET /api/livetv/channels/with-epg (EPG source picker). */
export interface ChannelsWithEpgResponse {
	items: ChannelWithEpgInfo[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

/** Response of GET /api/livetv/epg/guide, keyed by lineup channel ID. */
export interface EpgGuideResponse {
	programs: Record<string, EpgProgram[]>;
	timeRange: { start: string; end: string };
}

/** Current and next program for a single lineup channel. */
export interface EpgNowNextEntry {
	now: EpgProgramWithProgress | null;
	next: EpgProgram | null;
}

/** Response of GET /api/livetv/epg/now, keyed by lineup channel ID. */
export interface EpgNowResponse {
	channels: Record<string, EpgNowNextEntry>;
}

/** Response of POST /api/livetv/epg/sync (fire-and-forget start ack). */
export interface EpgSyncStartResponse {
	started: boolean;
	alreadyRunning: boolean;
	message: string;
}

/** Response of DELETE /api/livetv/epg/sync (cancel ack). */
export interface EpgSyncCancelResponse {
	cancelRequested: boolean;
	message: string;
}

/** Response of GET /api/livetv/epg/channel/[id]. */
export interface EpgChannelResponse {
	channelId: string;
	programs: EpgProgram[];
	timeRange: { start: string; end: string };
}

/** Response of GET /api/livetv/lineup. */
export interface LineupResponse {
	lineup: ChannelLineupItemWithDetails[];
	lineupChannelIds: string[];
	total: number;
}

/** Response of POST /api/livetv/lineup. */
export interface LineupAddResponse {
	added: number;
	skipped: number;
}

/** Response of PUT /api/livetv/lineup/[id]. */
export interface LineupItemResponse {
	item: ChannelLineupItemWithDetails;
}

/** Response of POST /api/livetv/lineup/remove. */
export interface LineupRemoveResponse {
	removed: number;
}

/** Response of GET /api/livetv/lineup/[id]/backups and PUT .../backups/reorder. */
export interface LineupBackupsResponse {
	backups: ChannelBackupLink[];
}

/** Response of POST /api/livetv/lineup/[id]/backups. */
export interface LineupBackupAddResponse {
	backup: ChannelBackupLink;
}

/** Response of GET /api/livetv/accounts. */
export interface LiveTvAccountsResponse {
	accounts: LiveTvAccount[];
}

/** Response of POST /api/livetv/accounts and PUT /api/livetv/accounts/[id]. */
export interface LiveTvAccountResponse {
	account: LiveTvAccount;
}

/**
 * Response of the account test endpoints (saved account and unsaved config).
 * The index signature keeps the accounts page's legacy "endpoint may return
 * the test result directly" compatibility cast working.
 */
export interface LiveTvAccountTestResponse {
	result: LiveTvAccountTestResult;
	[key: string]: unknown;
}

/** Response of GET /api/livetv/categories (provider categories). */
export interface LiveTvCategoriesResponse {
	categories: LiveTvCategory[];
}

/** A user channel category enriched with its lineup channel count. */
export interface ChannelCategoryWithCount extends ChannelCategory {
	channelCount: number;
}

/** Response of GET /api/livetv/channel-categories. */
export interface ChannelCategoriesResponse {
	categories: ChannelCategoryWithCount[];
	total: number;
}

/** Response of POST /api/livetv/channel-categories and PUT .../[id]. */
export interface ChannelCategoryResponse {
	category: ChannelCategory;
}

/** A country entry from the Cinephage IPTV catalog. */
export interface CinephageIptvCountry {
	code: string;
	name: string;
	flag: string;
}

/** Response of GET /api/livetv/cinephage-iptv/countries. */
export interface CinephageIptvCountriesResponse {
	countries: CinephageIptvCountry[];
	cached: boolean;
	count: number;
}

/** Scan summary embedded in a saved portal row. */
export interface StalkerPortalScanSummary {
	totalTested: number;
	totalFound: number;
	lastScanType: 'random' | 'sequential' | 'import';
	lastScanDate: string;
}

/** A saved Stalker portal (mirror of the server-side StalkerPortal shape). */
export interface StalkerPortalInfo {
	id: string;
	name: string;
	url: string;
	endpoint: string | null;
	serverTimezone: string | null;
	lastScannedAt: string | null;
	lastScanResults: StalkerPortalScanSummary | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

/** Response of GET /api/livetv/portals. */
export interface StalkerPortalsResponse {
	portals: StalkerPortalInfo[];
}

/**
 * Response of POST /api/livetv/portals and PATCH /api/livetv/portals/[id].
 *
 * The route nests the saved portal under `portal`. The flat `id` exists only
 * for the legacy PortalScanModal caller that reads it off the response root;
 * the route does not actually send it (that caller's inline-create flow then
 * falls back to its "No portal selected" error). Remove once the caller reads
 * `response.portal.id`.
 */
export interface StalkerPortalResponse {
	portal: StalkerPortalInfo;
	id: string | null;
}

/** Response of POST /api/livetv/portals/detect (bare payload, no envelope). */
export interface StalkerPortalDetectionResponse {
	success: boolean;
	endpoint?: string;
	serverTimezone?: string;
	error?: string;
}

/** Metadata snapshot of a just-started portal scan worker. */
export interface PortalScanMetadata {
	portalId: string;
	portalName: string;
	portalUrl: string;
	scanType: 'random' | 'sequential' | 'import';
	macPrefix?: string;
	macRangeStart?: string;
	macRangeEnd?: string;
	totalMacs: number;
	testedMacs: number;
	foundMacs: number;
	currentMac?: string;
	rateLimit: number;
	historyId?: string;
}

/** Response of POST /api/livetv/portals/[id]/scan (202 Accepted). */
export interface PortalScanStartResponse {
	workerId: string;
	status: 'started';
	metadata: PortalScanMetadata;
}

/** A portal scan run (history item). */
export interface PortalScanHistoryEntry {
	id: string;
	portalId: string;
	workerId: string | null;
	scanType: 'random' | 'sequential' | 'import';
	macPrefix: string | null;
	macRangeStart: string | null;
	macRangeEnd: string | null;
	macsToTest: number | null;
	macsTested: number;
	macsFound: number;
	status: 'running' | 'completed' | 'cancelled' | 'failed';
	error: string | null;
	startedAt: string;
	completedAt: string | null;
}

/** Response of GET /api/livetv/portals/[id]/scan/history. */
export interface PortalScanHistoryResponse {
	history: PortalScanHistoryEntry[];
}

/**
 * A MAC address discovered by a portal scan. The server JSON-parses
 * `rawProfile` into an object before responding; it is declared as the raw
 * JSON string to stay assignable to ScanResultsTable's local mirror (the only
 * consumer, which does not use the field). Update both when it is needed.
 */
export interface PortalScanResultItem {
	id: string;
	portalId: string;
	macAddress: string;
	status: 'pending' | 'approved' | 'ignored' | 'expired';
	channelCount: number | null;
	categoryCount: number | null;
	expiresAt: string | null;
	accountStatus: 'active' | 'expired' | null;
	playbackLimit: number | null;
	serverTimezone: string | null;
	rawProfile: string | null;
	discoveredAt: string;
	processedAt: string | null;
}

/** Response of GET /api/livetv/portals/[id]/scan/results. */
export interface PortalScanResultsResponse {
	results: PortalScanResultItem[];
}

/** Response of POST /api/livetv/portals/[id]/scan/results/approve. */
export interface PortalScanApproveResponse {
	approved: number;
	accountIds: string[];
}

/** Response of POST /api/livetv/portals/[id]/scan/results/ignore. */
export interface PortalScanIgnoreResponse {
	ignored: number;
}

/** Response of DELETE /api/livetv/portals/[id]/scan/results. */
export interface PortalScanClearResponse {
	deleted: number;
}

/** Response of POST /api/livetv/lineup/bulk-category. */
export interface LineupBulkCategoryResponse {
	updated: number;
}

/** Response of POST /api/livetv/lineup/bulk-clean-names. */
export interface LineupCleanNamesResponse {
	updated: number;
	skippedExistingCustom: number;
	skippedUnchanged: number;
}

/**
 * localStorage key for the EPG display-language selection. Empty means "auto":
 * the server falls back to the instance metadata locale
 * (language_settings.metadata_locale).
 */
export const EPG_DISPLAY_LANGUAGE_STORAGE_KEY = 'cinephage:epg-display-language';

/** Read the persisted EPG display language ('' = auto/instance default). */
export function getStoredEpgDisplayLanguage(): string {
	if (typeof localStorage === 'undefined') return '';
	try {
		return localStorage.getItem(EPG_DISPLAY_LANGUAGE_STORAGE_KEY) ?? '';
	} catch {
		return '';
	}
}

/** Persist the EPG display language ('' clears the override). */
export function storeEpgDisplayLanguage(language: string): void {
	if (typeof localStorage === 'undefined') return;
	try {
		if (language) {
			localStorage.setItem(EPG_DISPLAY_LANGUAGE_STORAGE_KEY, language);
		} else {
			localStorage.removeItem(EPG_DISPLAY_LANGUAGE_STORAGE_KEY);
		}
	} catch {
		// Storage unavailable (private mode): the selection stays in-memory.
	}
}

export async function getChannels(params?: Record<string, string>) {
	return apiGet<LiveTvChannelsResponse>('/api/livetv/channels', params);
}

export async function syncChannels(payload?: { accountIds?: string[] }) {
	return apiPost<ChannelSyncResponse>('/api/livetv/channels/sync', payload);
}

export async function getChannelSyncStatus() {
	return apiGet<ChannelSyncStatusResponse>('/api/livetv/channels/sync/status');
}

export async function getChannelsWithEpg() {
	return apiGet<ChannelsWithEpgResponse>('/api/livetv/channels/with-epg');
}

export async function getEpgGuide(params?: Record<string, string>) {
	return apiGet<EpgGuideResponse>('/api/livetv/epg/guide', params);
}

export async function getEpgNow() {
	return apiGet<EpgNowResponse>('/api/livetv/epg/now');
}

export async function syncEpg() {
	return apiPost<EpgSyncStartResponse>('/api/livetv/epg/sync');
}

export async function syncEpgForAccount(accountId: string) {
	return apiPost<EpgSyncStartResponse>(`/api/livetv/epg/sync?accountId=${accountId}`);
}

export async function cancelEpgSync() {
	return apiDelete<EpgSyncCancelResponse>('/api/livetv/epg/sync');
}

export async function cancelEpgSyncForAccount(accountId: string) {
	return apiDelete<EpgSyncCancelResponse>(`/api/livetv/epg/sync?accountId=${accountId}`);
}

export async function getEpgStatus() {
	return apiGet<EpgStatus>('/api/livetv/epg/status');
}

export async function getEpgChannel(id: string, params?: Record<string, string>) {
	return apiGet<EpgChannelResponse>(`/api/livetv/epg/channel/${id}`, params);
}

export async function getLineup() {
	return apiGet<LineupResponse>('/api/livetv/lineup');
}

export async function addToLineup(channels: Array<{ accountId: string; channelId: string }>) {
	return apiPost<LineupAddResponse>('/api/livetv/lineup', { channels });
}

export async function updateLineupItem(id: string, payload: UpdateChannel) {
	return apiPut<LineupItemResponse>(`/api/livetv/lineup/${id}`, payload);
}

export async function deleteLineupItem(id: string) {
	return apiDelete(`/api/livetv/lineup/${id}`);
}

export async function removeFromLineup(itemIds: string[]) {
	return apiPost<LineupRemoveResponse>('/api/livetv/lineup/remove', { itemIds });
}

export async function reorderLineup(itemIds: string[]) {
	return apiPost('/api/livetv/lineup/reorder', { itemIds });
}

export async function getLineupBackups(lineupId: string) {
	return apiGet<LineupBackupsResponse>(`/api/livetv/lineup/${lineupId}/backups`);
}

/**
 * No route currently answers POST on the backup item URL (the route only
 * exports DELETE), so this call fails at runtime; left untyped on purpose.
 */
export async function restoreLineupBackup(lineupId: string, backupId: string) {
	return apiPost(`/api/livetv/lineup/${lineupId}/backups/${backupId}`);
}

export async function deleteLineupBackup(lineupId: string, backupId: string) {
	return apiDelete(`/api/livetv/lineup/${lineupId}/backups/${backupId}`);
}

export async function reorderLineupBackups(lineupId: string, backupIds: string[]) {
	return apiPut<LineupBackupsResponse>(`/api/livetv/lineup/${lineupId}/backups/reorder`, {
		backupIds
	});
}

export async function addLineupBackup(lineupId: string, payload: AddBackupLink) {
	return apiPost<LineupBackupAddResponse>(`/api/livetv/lineup/${lineupId}/backups`, payload);
}

export async function getAccounts() {
	return apiGet<LiveTvAccountsResponse>('/api/livetv/accounts');
}

export async function createAccount(payload: LiveTvAccountCreate) {
	return apiPost<LiveTvAccountResponse>('/api/livetv/accounts', payload);
}

export async function updateAccount(id: string, payload: Record<string, unknown>) {
	return apiPut<LiveTvAccountResponse>(`/api/livetv/accounts/${id}`, payload);
}

export async function deleteAccount(id: string) {
	return apiDelete(`/api/livetv/accounts/${id}`);
}

export async function testAccount(id: string) {
	return apiPost<LiveTvAccountTestResponse>(`/api/livetv/accounts/${id}/test`);
}

export async function testAccountConfig(payload: Record<string, unknown>) {
	return apiPost<LiveTvAccountTestResponse>('/api/livetv/accounts/test', payload);
}

export async function getCategories() {
	return apiGet<LiveTvCategoriesResponse>('/api/livetv/categories');
}

export async function getChannelCategories(params?: Record<string, string>) {
	return apiGet<ChannelCategoriesResponse>('/api/livetv/channel-categories', params);
}

export async function createChannelCategory(payload: ChannelCategoryForm) {
	return apiPost<ChannelCategoryResponse>('/api/livetv/channel-categories', payload);
}

export async function updateChannelCategory(id: string, payload: Partial<ChannelCategoryForm>) {
	return apiPut<ChannelCategoryResponse>(`/api/livetv/channel-categories/${id}`, payload);
}

export async function deleteChannelCategory(id: string) {
	return apiDelete(`/api/livetv/channel-categories/${id}`);
}

export async function reorderChannelCategories(ids: string[]) {
	return apiPost('/api/livetv/channel-categories/reorder', { ids });
}

export async function getCinephageIptvCountries() {
	return apiGet<CinephageIptvCountriesResponse>('/api/livetv/cinephage-iptv/countries');
}

export async function getPortals() {
	return apiGet<StalkerPortalsResponse>('/api/livetv/portals');
}

export async function createPortal(payload: StalkerPortalCreate) {
	return apiPost<StalkerPortalResponse>('/api/livetv/portals', payload);
}

/** The route answers PATCH; the response body shape is kept for compatibility. */
export async function updatePortal(id: string, payload: StalkerPortalUpdate) {
	return apiPut<StalkerPortalResponse>(`/api/livetv/portals/${id}`, payload);
}

export async function deletePortal(id: string) {
	return apiDelete(`/api/livetv/portals/${id}`);
}

export async function scanPortal(id: string, payload?: Record<string, unknown>) {
	return apiPost<PortalScanStartResponse>(`/api/livetv/portals/${id}/scan`, payload);
}

export async function getPortalScanHistory(id: string) {
	return apiGet<PortalScanHistoryResponse>(`/api/livetv/portals/${id}/scan/history`);
}

export async function getPortalScanResults(id: string) {
	return apiGet<PortalScanResultsResponse>(`/api/livetv/portals/${id}/scan/results`);
}

export async function approvePortalScanResult(portalId: string, resultId: string) {
	return apiPost<PortalScanApproveResponse>(
		`/api/livetv/portals/${portalId}/scan/results/approve`,
		{ resultId }
	);
}

export async function batchApprovePortalScanResults(portalId: string, resultIds: string[]) {
	return apiPost<PortalScanApproveResponse>(
		`/api/livetv/portals/${portalId}/scan/results/approve`,
		{ resultIds }
	);
}

export async function ignorePortalScanResult(portalId: string, resultId: string) {
	return apiPost<PortalScanIgnoreResponse>(`/api/livetv/portals/${portalId}/scan/results/ignore`, {
		resultId
	});
}

export async function batchIgnorePortalScanResults(portalId: string, resultIds: string[]) {
	return apiPost<PortalScanIgnoreResponse>(`/api/livetv/portals/${portalId}/scan/results/ignore`, {
		resultIds
	});
}

export async function clearIgnoredScanResults(portalId: string) {
	return apiDelete<PortalScanClearResponse>(`/api/livetv/portals/${portalId}/scan/results`, {
		status: 'ignored'
	});
}

export async function detectPortal(url: string) {
	return apiPost<StalkerPortalDetectionResponse>('/api/livetv/portals/detect', { url });
}

export async function bulkAssignCategory(itemIds: string[], categoryId: string | null) {
	return apiPost<LineupBulkCategoryResponse>('/api/livetv/lineup/bulk-category', {
		itemIds,
		categoryId
	});
}

export async function bulkCleanChannelNames(itemIds: string[]) {
	return apiPost<LineupCleanNamesResponse>('/api/livetv/lineup/bulk-clean-names', { itemIds });
}

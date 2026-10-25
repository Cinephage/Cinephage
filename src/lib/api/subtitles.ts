import type {
	LanguageProfileV2Create,
	LanguageProfileV2Update,
	LanguageSettingsUpdateInput,
	LanguageSettingsValues,
	SubtitleProviderCreate,
	SubtitleProviderImplementation,
	SubtitleProviderTest,
	SubtitleProviderUpdate,
	SubtitleBatchAutoSearchRequest
} from '#lib/validation/schemas.js';
import type {
	LanguageProfileV2,
	SubtitleAccessibility,
	SubtitleVariant
} from '#lib/shared/language-profile.js';

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import { browser } from '$app/env';

// ============================================================================
// RESPONSE TYPES
//
// Client-safe mirrors of the /api/subtitles endpoint payloads. Source of
// truth: the route handlers under src/routes/api/subtitles/ and the server
// subtitle services they spread (keep in sync).
// ============================================================================

/** Why a subtitle candidate lost (mirror of the server rejection reason). */
export type SubtitleCandidateRejectionReason = 'requirement' | 'threshold';

/** Subtitle file format as reported by providers. */
export type SubtitleFormat = 'srt' | 'ass' | 'sub' | 'vtt' | 'ssa' | 'unknown';

/** Per-factor score contributions behind a result's matchScore. */
export interface SubtitleScoreBreakdown {
	hashMatch: number;
	titleMatch: number;
	yearMatch: number;
	releaseGroupMatch: number;
	sourceMatch: number;
	codecMatch: number;
	hiPenalty: number;
	forcedBonus: number;
}

/** One search result row (mirror of the server SubtitleSearchResult). */
export interface SubtitleSearchResultItem {
	providerId: string;
	providerName: string;
	providerSubtitleId: string;
	language: string;
	title: string;
	releaseName?: string;
	fileName?: string;
	isForced: boolean;
	isHearingImpaired: boolean;
	format: SubtitleFormat;
	isHashMatch: boolean;
	matchScore: number;
	scoreBreakdown?: SubtitleScoreBreakdown;
	downloadUrl?: string;
	downloadCount?: number;
	rating?: number;
	uploadDate?: string;
	uploader?: string;
	pageLink?: string;
	fileSize?: number;
	movieFileId?: string;
	movieFileName?: string;
}

/** One provider's contribution to a subtitle search. */
export interface SubtitleProviderResultSummary {
	providerId: string;
	providerName: string;
	resultCount: number;
	error?: string;
	searchTimeMs: number;
	/** Set when the provider was intentionally not queried (with the reason). */
	skipped?: string;
}

/** Timing of one priority tier in a tiered search. */
export interface SubtitleTierTiming {
	priority: number;
	providerIds: string[];
	searchTimeMs: number;
	accepted: boolean;
	stopped: boolean;
}

/**
 * Response of POST /api/subtitles/search. Bare payload (no success envelope):
 * the aggregated search result plus the resolved languages and, when every
 * candidate was rejected, the effective threshold and best rejected score.
 */
export interface SubtitleSearchResponse {
	results: SubtitleSearchResultItem[];
	totalResults: number;
	searchTimeMs: number;
	providerResults: SubtitleProviderResultSummary[];
	tierTimings?: SubtitleTierTiming[];
	languages: string[];
	effectiveMinimumScore?: number;
	bestRejectedScore?: number;
	bestRejectedReason?: SubtitleCandidateRejectionReason;
}

/** Result of a successful subtitle download (mirror of SubtitleDownloadResult). */
export interface SubtitleDownloadedFile {
	subtitleId: string;
	path: string;
	language: string;
	format: SubtitleFormat;
	wasSynced: boolean;
	syncOffset: number | null;
	wasUpgrade: boolean;
	replacedSubtitleId?: string;
}

/** Response of POST /api/subtitles/download. */
export interface SubtitleDownloadResponse {
	subtitle: SubtitleDownloadedFile;
}

/** Response of POST /api/subtitles/sync (success/error ride the envelope). */
export interface SubtitleSyncResponse {
	offsetMs: number;
}

/** Response of GET /api/subtitles/sync (bare payload, no envelope). */
export interface SubtitleSyncStatusResponse {
	available: boolean;
	message: string;
}

/** A saved language profile as served by the API (v2 shape plus timestamps). */
export interface LanguageProfileItem extends LanguageProfileV2 {
	createdAt?: string;
	updatedAt?: string;
}

/** Response of POST/PUT /api/subtitles/language-profiles. */
export interface LanguageProfileMutationResponse {
	profile: LanguageProfileItem;
}

/** Why an auto-search item or requirement ended with no download. */
export type SubtitleAutoSearchReason =
	| 'no_file'
	| 'not_monitored'
	| 'opted_out'
	| 'no_profile'
	| 'no_results'
	| 'below_threshold'
	| 'downloaded'
	| 'error';

/** Per-requirement outcome of an auto-search run. */
export interface SubtitleRequirementOutcome {
	requirementKey: string;
	tag: string;
	variant: SubtitleVariant;
	accessibility: SubtitleAccessibility;
	reason: SubtitleAutoSearchReason;
	bestRejectedScore?: number;
	bestRejectedReason?: SubtitleCandidateRejectionReason;
	language?: string;
	matchScore?: number;
	providerId?: string;
	providerName?: string;
	providerSubtitleId?: string;
	error?: string;
}

/** Response of POST /api/subtitles/auto-search. */
export interface SubtitleAutoSearchResponse {
	success: boolean;
	searched: boolean;
	downloaded: boolean;
	reason: SubtitleAutoSearchReason | 'satisfied';
	message: string;
	downloadedCount: number;
	outcomes: SubtitleRequirementOutcome[];
	bestRejectedScore?: number;
	bestRejectedReason?: SubtitleCandidateRejectionReason;
	bestScore?: number;
	subtitle?: SubtitleDownloadedFile;
	matchScore?: number;
}

/**
 * A subtitle provider config as served by the API. List responses redact
 * secrets to '[REDACTED]'/null; create/update responses carry the raw config,
 * so the secret fields cover both shapes.
 */
export interface SubtitleProviderInfo {
	id: string;
	name: string;
	implementation: SubtitleProviderImplementation;
	enabled: boolean;
	priority: number;
	apiKey?: string | null;
	username?: string;
	password?: string | null;
	settings?: Record<string, unknown> | null;
	requestsPerMinute: number;
	lastError?: string;
	lastErrorAt?: string;
	consecutiveFailures: number;
	throttledUntil?: string;
}

/** Response of POST/PUT /api/subtitles/providers. */
export interface SubtitleProviderMutationResponse {
	provider: SubtitleProviderInfo;
}

/** Response of POST /api/subtitles/providers/test (success rides the envelope). */
export interface SubtitleProviderTestResponse {
	message: string;
	responseTime: number;
}

/** Response of POST /api/subtitles/providers/reorder. */
export interface SubtitleProviderReorderResponse {
	updated: number;
}

/** One subtitle history row (mirror of the subtitle_history columns served). */
export interface SubtitleHistoryItem {
	id: string;
	movieId: string | null;
	episodeId: string | null;
	action: string;
	language: string;
	providerId: string | null;
	providerName: string | null;
	providerSubtitleId: string | null;
	matchScore: number | null;
	wasHashMatch: boolean | null;
	replacedSubtitleId: string | null;
	errorMessage: string | null;
	createdAt: string | null;
}

/** Response of GET /api/subtitles/history (bare payload, no envelope). */
export interface SubtitleHistoryResponse {
	items: SubtitleHistoryItem[];
	total: number;
	limit: number;
	offset: number;
	hasMore: boolean;
}

/** Counters from a subtitle discovery scan. */
export interface SubtitleScanResultItem {
	discovered: number;
	added: number;
	registered: number;
	updated: number;
	removed: number;
	unchanged: number;
	skipped: number;
	ambiguous: string[];
	errors: string[];
}

/** Response of POST /api/subtitles/scan, spread by scan scope. */
export type SubtitleScanResponse =
	| ({ type: 'movie' | 'series' } & SubtitleScanResultItem)
	| {
			type: 'all';
			movies: SubtitleScanResultItem;
			series: SubtitleScanResultItem;
	  };

/** One blacklisted provider subtitle row. */
export interface SubtitleBlacklistItem {
	id: string;
	movieId: string | null;
	episodeId: string | null;
	providerId: string | null;
	providerSubtitleId: string;
	reason: string | null;
	language: string;
	createdAt: string | null;
}

/** Response of GET /api/subtitles/blacklist (bare payload, no envelope). */
export interface SubtitleBlacklistResponse {
	items: SubtitleBlacklistItem[];
	total: number;
	limit: number;
	offset: number;
}

export async function searchSubtitles(payload: {
	movieId?: string;
	episodeId?: string;
	languages?: string[];
	providerIds?: string[];
	title?: string;
	year?: number;
	imdbId?: string;
	tmdbId?: number;
	seriesTitle?: string;
	season?: number;
	episode?: number;
	includeForced?: boolean;
	includeHearingImpaired?: boolean;
	excludeHearingImpaired?: boolean;
}): Promise<SubtitleSearchResponse> {
	// The endpoint returns the bare aggregated search payload, not the envelope.
	const response = await apiPost('/api/subtitles/search', payload);
	return response as unknown as SubtitleSearchResponse;
}

export async function autoSearchSubtitles(payload: {
	movieId?: string;
	episodeId?: string;
	languages?: string[];
}) {
	return apiPost<SubtitleAutoSearchResponse>('/api/subtitles/auto-search', payload);
}

export async function downloadSubtitle(payload: {
	providerId: string;
	providerSubtitleId: string;
	language: string;
	movieId?: string;
	episodeId?: string;
	isForced?: boolean;
	isHearingImpaired?: boolean;
}) {
	return apiPost<SubtitleDownloadResponse>('/api/subtitles/download', payload);
}

export async function syncSubtitle(
	subtitleId: string,
	options?: {
		referenceType?: string;
		referencePath?: string;
		splitPenalty?: number;
		noSplits?: boolean;
	}
) {
	return apiPost<SubtitleSyncResponse>('/api/subtitles/sync', { subtitleId, ...options });
}

export async function getSubtitleSyncStatus(): Promise<SubtitleSyncStatusResponse> {
	// The endpoint returns a bare availability payload, not the envelope.
	const response = await apiGet('/api/subtitles/sync');
	return response as unknown as SubtitleSyncStatusResponse;
}

export async function getLanguageProfiles(): Promise<LanguageProfileItem[]> {
	// The endpoint returns the bare profile array, not the envelope.
	const response = await apiGet('/api/subtitles/language-profiles');
	return response as unknown as LanguageProfileItem[];
}

export async function createLanguageProfile(payload: LanguageProfileV2Create) {
	return apiPost<LanguageProfileMutationResponse>('/api/subtitles/language-profiles', payload);
}

export async function updateLanguageProfile(id: string, payload: LanguageProfileV2Update) {
	return apiPut<LanguageProfileMutationResponse>(`/api/subtitles/language-profiles/${id}`, payload);
}

export async function deleteLanguageProfile(id: string) {
	return apiDelete(`/api/subtitles/language-profiles/${id}`);
}

/**
 * Read the global language settings singleton (default profile, metadata
 * locale/region, discover filter, unknown-subtitle policy, auto-sync).
 */
export async function getLanguageSettings(): Promise<LanguageSettingsValues> {
	return apiGet<LanguageSettingsValues>('/api/subtitles/language-settings');
}

/** Partially update the global language settings singleton. */
export async function updateLanguageSettings(
	payload: LanguageSettingsUpdateInput
): Promise<LanguageSettingsValues> {
	return apiPut<LanguageSettingsValues>('/api/subtitles/language-settings', payload);
}

/**
 * Where an effective subtitle profile was resolved from. The add-flow
 * endpoint only resolves the instance default for NEW items; existing items
 * can also resolve from the item override or the library.
 */
export type EffectiveSubtitleProfileSource = 'movie' | 'series' | 'library' | 'default';

/** The subtitle profile a new library item will inherit, plus its source. */
export interface EffectiveSubtitleProfile {
	profile: {
		id: string;
		name: string;
		/** Requirement list used to seed the add-flow customize editor. */
		subtitles?: Array<{ tag: string; variant: string; accessibility: string }>;
	};
	source: EffectiveSubtitleProfileSource;
}

/**
 * Resolve the effective subtitle profile for a NEW library item
 * (?mediaType=movie|series). Returns null when no default profile is
 * configured — the add flow surfaces this as a warning.
 */
export async function getEffectiveSubtitleProfile(
	mediaType: 'movie' | 'series',
	libraryId?: string
): Promise<EffectiveSubtitleProfile | null> {
	const libraryParam = libraryId ? `&libraryId=${encodeURIComponent(libraryId)}` : '';
	return apiGet<EffectiveSubtitleProfile | null>(
		`/api/subtitles/language-settings/effective?mediaType=${mediaType}${libraryParam}`
	);
}

export async function getSubtitleProviders(): Promise<SubtitleProviderInfo[]> {
	// The endpoint returns the bare (redacted) provider array, not the envelope.
	const response = await apiGet('/api/subtitles/providers');
	return response as unknown as SubtitleProviderInfo[];
}

export async function createSubtitleProvider(payload: SubtitleProviderCreate) {
	return apiPost<SubtitleProviderMutationResponse>('/api/subtitles/providers', payload);
}

export async function updateSubtitleProvider(id: string, payload: SubtitleProviderUpdate) {
	return apiPut<SubtitleProviderMutationResponse>(`/api/subtitles/providers/${id}`, payload);
}

export async function deleteSubtitleProvider(id: string) {
	return apiDelete(`/api/subtitles/providers/${id}`);
}

export async function testSubtitleProvider(payload: SubtitleProviderTest) {
	return apiPost<SubtitleProviderTestResponse>('/api/subtitles/providers/test', payload);
}

export async function reorderSubtitleProviders(providerIds: string[]) {
	return apiPost<SubtitleProviderReorderResponse>('/api/subtitles/providers/reorder', {
		providerIds
	});
}

export async function getSubtitleHistory(): Promise<SubtitleHistoryResponse> {
	// The endpoint returns a bare paginated payload, not the envelope.
	const response = await apiGet('/api/subtitles/history');
	return response as unknown as SubtitleHistoryResponse;
}

export async function scanSubtitles() {
	return apiPost<SubtitleScanResponse>('/api/subtitles/scan');
}

export async function getSubtitleBlacklist(): Promise<SubtitleBlacklistResponse> {
	// The endpoint returns a bare paginated payload, not the envelope.
	const response = await apiGet('/api/subtitles/blacklist');
	return response as unknown as SubtitleBlacklistResponse;
}

/**
 * No route answers DELETE on /api/subtitles/blacklist/[id] (removal goes
 * through query params on the collection route), so this call fails at
 * runtime; left untyped on purpose.
 */
export async function deleteSubtitleBlacklistEntry(id: string) {
	return apiDelete(`/api/subtitles/blacklist/${id}`);
}

export async function deleteSubtitle(subtitleId: string) {
	return apiDelete(`/api/subtitles/${subtitleId}`);
}

export async function batchAutoSearchSubtitles(
	payload: SubtitleBatchAutoSearchRequest
): Promise<Response> {
	if (!browser) {
		throw new Error('batchAutoSearchSubtitles can only be used in the browser');
	}
	return fetch('/api/subtitles/auto-search/batch', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
}

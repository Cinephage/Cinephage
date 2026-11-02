import type {
	IndexerCreate,
	IndexerUpdate,
	IndexerTest,
	CustomFormatCreate,
	CustomFormatUpdateBody,
	Condition
} from '#lib/validation/schemas.js';

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

/** Configured indexer as returned by the API (settings redacted server-side). */
export interface IndexerInfo {
	id: string;
	name: string;
	definitionId: string;
	enabled: boolean;
	/** Prowlarr-mirrored enabled state; null = not managed upstream. */
	upstreamEnabled: boolean | null;
	orphaned: boolean;
	isBuiltIn: boolean;
	baseUrl: string;
	alternateUrls: string[];
	priority: number;
	rateLimitPerMinute: number | null;
	protocol: 'torrent' | 'usenet' | 'streaming';
	enableAutomaticSearch: boolean;
	enableInteractiveSearch: boolean;
	settings: Record<string, unknown>;
	cachedCategories?: Array<{
		id: string;
		name: string;
		subCategories?: unknown[];
	}>;
	additionalCategories?: number[];
	minimumSeeders: number;
	seedRatio: string | null;
	seedTime: number | null;
	packSeedTime: number | null;
	rejectDeadTorrents: boolean;
	rejectPasswordProtected: boolean;
	minimumCompletionPercentage: number;
}

/** Response of GET /api/indexers (raw array payload). */
export type IndexersResponse = IndexerInfo[];

/** Response of GET /api/indexers/:id (raw indexer payload). */
export type IndexerResponse = IndexerInfo;

/** Response of POST /api/indexers and PUT /api/indexers/:id. */
export interface IndexerMutationResponse {
	indexer: IndexerInfo;
}

/** Available indexer definition from GET /api/indexers/definitions (raw array payload). */
export interface IndexerDefinitionInfo {
	id: string;
	name: string;
	description?: string;
	type: 'public' | 'semi-private' | 'private';
	protocol: 'torrent' | 'usenet' | 'streaming';
	siteUrl: string;
	alternateUrls: string[];
	isCustom?: boolean;
	capabilities: {
		search?: { available: boolean; supportedParams: string[] };
		movieSearch?: { available: boolean; supportedParams: string[] };
		tvSearch?: { available: boolean; supportedParams: string[] };
		categories?: Record<string, string>;
		limits?: { default: number; max: number };
		flags?: { supportsInfoHash?: boolean; supportsPagination?: boolean };
	};
	settings: Array<{
		name: string;
		label?: string;
		type:
			| 'text'
			| 'password'
			| 'checkbox'
			| 'select'
			| 'number'
			| 'info'
			| 'info_cookie'
			| 'info_cloudflare'
			| 'info_useragent'
			| 'info_category_8000'
			| 'cardigannCaptcha';
		required?: boolean;
		default?: string;
		helpText?: string;
		options?: Record<string, string>;
		placeholder?: string;
	}>;
}

/** Response of GET /api/indexers/definitions (raw array payload). */
export type IndexerDefinitionsResponse = IndexerDefinitionInfo[];

/** Format list entry from GET /api/custom-formats (built-in or user-defined). */
export interface CustomFormatListItem {
	id: string;
	name: string;
	description?: string;
	category:
		| 'resolution'
		| 'release_group_tier'
		| 'audio'
		| 'hdr'
		| 'streaming'
		| 'micro'
		| 'low_quality'
		| 'banned'
		| 'enhancement'
		| 'codec'
		| 'source'
		| 'other';
	tags: string[];
	conditions: Condition[];
	enabled: boolean;
	isBuiltIn: boolean;
	/** Present on user-defined rows only. */
	createdAt?: string | null;
	updatedAt?: string | null;
}

/** Response of GET /api/custom-formats. */
export interface CustomFormatsResponse {
	formats: CustomFormatListItem[];
	count: number;
	builtInCount: number;
	customCount: number;
}

/** Raw custom_formats row as returned by POST/PUT /api/custom-formats (unwrapped payload). */
export interface CustomFormatRow {
	id: string;
	name: string;
	description: string | null;
	category: CustomFormatListItem['category'];
	tags: string[] | null;
	conditions: Condition[] | null;
	enabled: boolean | null;
	createdAt: string | null;
	updatedAt: string | null;
}

/** Response of DELETE /api/custom-formats. */
export interface CustomFormatDeleteResponse {
	deleted: CustomFormatRow;
}

/** Response of POST /api/custom-formats/test. */
export interface CustomFormatTestResponse {
	matched: boolean;
	totalConditions: number;
	matchedConditions: number;
	failedConditions: number;
	parsedAttributes: {
		resolution: string;
		source: string;
		codec: string;
		hdr: string;
		audioCodec: string;
		audioChannels: string;
		hasAtmos: boolean;
		releaseGroup?: string;
		streamingService?: string;
		isRemux: boolean;
		isRepack: boolean;
		isProper: boolean;
		is3d: boolean;
	};
	conditionResults: Array<{
		name: string;
		type: string;
		required: boolean;
		negate: boolean;
		matched: boolean;
	}>;
}

export async function getIndexers() {
	return apiGet<IndexersResponse>('/api/indexers');
}

export async function getIndexer(id: string) {
	return apiGet<IndexerResponse>(`/api/indexers/${id}`);
}

export async function createIndexer(payload: IndexerCreate) {
	return apiPost<IndexerMutationResponse>('/api/indexers', payload);
}

export async function updateIndexer(id: string, payload: IndexerUpdate) {
	return apiPut<IndexerMutationResponse>(`/api/indexers/${id}`, payload);
}

export async function deleteIndexer(id: string) {
	return apiDelete(`/api/indexers/${id}`);
}

export async function testIndexer(payload: IndexerTest) {
	return apiPost('/api/indexers/test', payload);
}

export async function getIndexerDefinitions() {
	return apiGet<IndexerDefinitionsResponse>('/api/indexers/definitions');
}

// Left untyped on purpose: the /api/search payload is a union of the enriched
// and standard search shapes (nullable downloadUrl after URL redaction,
// indexerResults as an array in one mode and a record in the other), and the
// precise types conflict with consumer view types in the interactive search UI.
export async function searchReleases(params: Record<string, string>) {
	return apiGet('/api/search', params);
}

export async function getCustomFormats() {
	return apiGet<CustomFormatsResponse>('/api/custom-formats');
}

export async function createCustomFormat(payload: CustomFormatCreate) {
	return apiPost<CustomFormatRow>('/api/custom-formats', payload);
}

export async function updateCustomFormat(id: string, payload: CustomFormatUpdateBody) {
	return apiPut<CustomFormatRow>('/api/custom-formats', { ...payload, id });
}

export async function deleteCustomFormat(id: string) {
	return apiDelete<CustomFormatDeleteResponse>('/api/custom-formats', { id });
}

export async function testCustomFormat(payload: Record<string, unknown>) {
	return apiPost<CustomFormatTestResponse>('/api/custom-formats/test', payload);
}

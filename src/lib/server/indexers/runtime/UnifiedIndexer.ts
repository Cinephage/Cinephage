/**
 * UnifiedIndexer - Complete indexer implementation for all protocols.
 *
 * This single class handles torrent, usenet, and streaming indexers using
 * YAML definitions. It routes to either HTTP-based search (external indexers)
 * or database queries (internal streaming indexer).
 *
 * Key features:
 * - Protocol detection from YAML definition
 * - HTTP search for torrent/usenet/external streaming
 * - Database query support for internal streaming indexer
 * - Full compatibility with existing engine components
 */

import type {
	IIndexer,
	IndexerCapabilities,
	SearchParam,
	SearchCriteria,
	ReleaseResult,
	IndexerProtocol,
	IndexerAccessType,
	IndexerDownloadResult,
	DownloadTorrentOptions
} from '../types';
import type { YamlDefinition } from '../schema/yamlDefinition';
import { buildCapabilitiesFromYaml } from '../capabilities';
import type { IndexerRecord } from '#lib/server/db/schema.js';
import type { ProtocolSettings } from '#lib/server/indexers/types/index.js';
import { TemplateEngine, createTemplateEngine } from '../engine/TemplateEngine';
import { FilterEngine, createFilterEngine } from '../engine/FilterEngine';
import { SelectorEngine, createSelectorEngine } from '../engine/SelectorEngine';
import { RequestBuilder, createRequestBuilder } from './RequestBuilder';
import { ResponseParser, createResponseParser } from './ResponseParser';
import { AuthManager, createAuthManager } from '../auth/AuthManager';
import { CookieStore, createCookieStore } from '../auth/CookieStore';
import { isCloudflareProtected } from '../http/CloudflareDetection';
import { DownloadHandler, createDownloadHandler } from './DownloadHandler';
import { SearchCapabilityChecker } from './SearchCapabilityChecker';
import { getPersistentStatusTracker } from '../status';
import { getRateLimitRegistry } from '../ratelimit';
import { getHostRateLimiter, type HostRateLimiter } from '../ratelimit/HostRateLimiter';
import { DEFAULT_RATE_LIMIT, type RateLimitConfig } from '../ratelimit/types';
import { createChildLogger } from '#lib/logging/index.js';
import { IndexerHttp, createIndexerHttp } from '../http/IndexerHttp';
import { DatabaseQueryExecutor, createDatabaseQueryExecutor } from './DatabaseQueryExecutor';
import type { NewznabCapabilities } from '../newznab/types';

/**
 * Configuration for creating a UnifiedIndexer instance
 */
export interface UnifiedIndexerConfig {
	/** Indexer record from database */
	record: IndexerRecord;
	/** User-provided settings (apiKey, cookie, etc.) */
	settings: Record<string, string | boolean | number>;
	/** Protocol-specific settings */
	protocolSettings?: ProtocolSettings;
	/** YAML definition (parsed) */
	definition: YamlDefinition;
	/** Optional rate limit configuration override */
	rateLimit?: RateLimitConfig;
	/** Live capabilities fetched from Newznab indexer's /api?t=caps endpoint */
	liveCapabilities?: NewznabCapabilities;
	/** Extra Newznab category IDs to merge into every search request for this indexer */
	additionalCategories?: number[];
}

/**
 * Unified indexer implementation that handles all protocols.
 */
export class UnifiedIndexer implements IIndexer {
	readonly id: string;
	readonly name: string;
	readonly definitionId: string;
	readonly protocol: IndexerProtocol;
	readonly accessType: IndexerAccessType;
	readonly capabilities: IndexerCapabilities;
	readonly baseUrl: string;
	readonly enableAutomaticSearch: boolean;
	readonly enableInteractiveSearch: boolean;

	private readonly record: IndexerRecord;
	private readonly settings: Record<string, string | boolean | number>;
	private readonly _protocolSettings?: ProtocolSettings;
	private readonly definition: YamlDefinition;
	private readonly templateEngine: TemplateEngine;
	private readonly filterEngine: FilterEngine;
	private readonly selectorEngine: SelectorEngine;
	private readonly requestBuilder: RequestBuilder;
	private readonly responseParser: ResponseParser;
	private readonly authManager: AuthManager;
	private readonly downloadHandler: DownloadHandler;
	private readonly cookieStore: CookieStore;
	private readonly capabilityChecker: SearchCapabilityChecker;
	private readonly log: ReturnType<typeof createChildLogger>;
	private readonly http: IndexerHttp;
	private readonly hostRateLimiter: HostRateLimiter;
	readonly additionalCategories: number[];
	/** True when the user explicitly configured a category restriction (even an empty/open one). */
	private readonly categoryRestrictionEnabled: boolean;
	private readonly dbExecutor?: DatabaseQueryExecutor;

	private cookies: Record<string, string> = {};
	private isLoggedIn = false;
	private lastCookieRefreshMs = 0;

	private static readonly COOKIE_REFRESH_THROTTLE_MS = 60_000;

	/** Public getter for protocol-specific settings */
	get protocolSettings(): ProtocolSettings | undefined {
		return this._protocolSettings;
	}

	constructor(config: UnifiedIndexerConfig) {
		const {
			record,
			settings,
			protocolSettings,
			definition,
			rateLimit,
			liveCapabilities,
			additionalCategories
		} = config;

		this.categoryRestrictionEnabled = additionalCategories !== undefined;
		this.additionalCategories = additionalCategories ?? [];

		this.record = record;
		this.settings = settings;
		this._protocolSettings = protocolSettings;
		this.definition = definition;
		this.id = record.id;
		this.name = record.name;
		this.definitionId = record.definitionId;

		// Search capability toggles
		this.enableAutomaticSearch = record.enableAutomaticSearch ?? true;
		this.enableInteractiveSearch = record.enableInteractiveSearch ?? true;

		// settings.protocol overrides the definition for indexers (like prowlarr) that
		// serve mixed torrent/usenet content under a single definition.
		const settingsProtocol = settings.protocol;
		const resolvedProtocol =
			settingsProtocol === 'usenet' || settingsProtocol === 'torrent'
				? (settingsProtocol as string)
				: definition.protocol;
		this.protocol = this.mapProtocol(resolvedProtocol);
		this.accessType = this.mapAccessType(definition.type);

		// Build capabilities from definition
		this.capabilities = this.buildCapabilities(definition);

		// Create engines
		this.filterEngine = createFilterEngine();
		this.templateEngine = createTemplateEngine();
		this.filterEngine.setTemplateEngine(this.templateEngine);
		this.selectorEngine = createSelectorEngine(this.templateEngine, this.filterEngine);

		// Create runtime components
		this.requestBuilder = createRequestBuilder(definition, this.templateEngine, this.filterEngine);

		// Configure RequestBuilder with live capabilities (for Newznab)
		// This filters out unsupported params like tmdbid when the indexer doesn't support them
		if (liveCapabilities) {
			const caps = liveCapabilities.searching;
			if (caps.search.available) {
				this.requestBuilder.setSupportedParams('search', caps.search.supportedParams);
			}
			if (caps.movieSearch.available) {
				this.requestBuilder.setSupportedParams('movie', caps.movieSearch.supportedParams);
			}
			if (caps.tvSearch.available) {
				this.requestBuilder.setSupportedParams('tvsearch', caps.tvSearch.supportedParams);
			}
			if (caps.audioSearch.available) {
				this.requestBuilder.setSupportedParams('audio', caps.audioSearch.supportedParams);
			}
			if (caps.bookSearch.available) {
				this.requestBuilder.setSupportedParams('book', caps.bookSearch.supportedParams);
			}

			// Use the indexer's reported max limit so we fetch as many results as possible.
			// This is important for season-pack searches where packs can fall outside the
			// default top-100 window when sorted by date (individual episodes are newer).
			if (liveCapabilities.limits.max > 0) {
				this.requestBuilder.setLimitOverride(liveCapabilities.limits.max);
			}

			// Also override this.capabilities search modes with live caps
			// so that indexerSupportsSearchIds() uses the same source of truth
			// as RequestBuilder.filterBySupportedParams()
			this.overrideCapabilitiesWithLiveCaps(liveCapabilities);
		}

		this.responseParser = createResponseParser(
			definition,
			this.templateEngine,
			this.filterEngine,
			this.selectorEngine
		);

		// Create auth components
		this.cookieStore = createCookieStore();
		this.authManager = createAuthManager(
			definition,
			this.templateEngine,
			this.filterEngine,
			this.selectorEngine,
			this.cookieStore
		);

		// Create download handler
		this.downloadHandler = createDownloadHandler(
			definition,
			this.templateEngine,
			this.filterEngine,
			this.selectorEngine
		);

		// Create capability checker
		this.capabilityChecker = new SearchCapabilityChecker();

		// Configure with base URL and settings
		this.baseUrl = record.baseUrl || definition.links[0];
		this.requestBuilder.setBaseUrl(this.baseUrl);
		this.templateEngine.setSiteLink(this.baseUrl);
		this.templateEngine.setConfigWithDefaults(settings, definition.settings ?? []);

		this.log = createChildLogger({ indexer: this.name, indexerId: this.id });

		// Create unified HTTP client
		// Use config alternateUrls (from database), fall back to definition links
		this.http = createIndexerHttp({
			indexerId: this.id,
			indexerName: this.name,
			baseUrl: this.baseUrl,
			alternateUrls: record.alternateUrls?.length
				? record.alternateUrls
				: definition.links.slice(1),
			userAgent: 'Cinephage/1.0',
			rateLimit: rateLimit ?? DEFAULT_RATE_LIMIT,
			encoding: definition.encoding,
			defaultTimeout: definition.requesttimeout
		});
		this.hostRateLimiter = getHostRateLimiter();

		// Create database executor for internal streaming indexers
		if (this.isInternalStreamingIndexer()) {
			this.dbExecutor = createDatabaseQueryExecutor(definition, this.templateEngine);
		}

		// Initialize tracking
		this.initializeTracking(record.enabled ?? true, record.priority ?? 25, rateLimit);
	}

	/**
	 * Check if this is an internal streaming indexer (uses database queries)
	 */
	private isInternalStreamingIndexer(): boolean {
		if (this.protocol !== 'streaming') return false;

		const streamingConfig = this.definition.protocolConfig?.streaming;
		return streamingConfig?.dataSource === 'database' || streamingConfig?.type === 'internal';
	}

	/**
	 * Map YAML protocol to IndexerProtocol type
	 */
	private mapProtocol(protocol: string): IndexerProtocol {
		switch (protocol) {
			case 'usenet':
				return 'usenet';
			case 'streaming':
				return 'streaming';
			default:
				return 'torrent';
		}
	}

	/**
	 * Map definition type to IndexerAccessType
	 */
	private mapAccessType(type: string): IndexerAccessType {
		switch (type) {
			case 'private':
				return 'private';
			case 'semi-private':
				return 'semi-private';
			default:
				return 'public';
		}
	}

	/**
	 * Build capabilities from YAML definition
	 */
	private buildCapabilities(definition: YamlDefinition): IndexerCapabilities {
		const caps = definition.caps;
		return buildCapabilitiesFromYaml({
			modes: caps.modes ?? {},
			categories: caps.categories,
			categorymappings: caps.categorymappings,
			supportsInfoHash: this.protocol === 'torrent'
		});
	}

	/**
	 * Override capabilities search modes with live Newznab caps.
	 * This ensures indexerSupportsSearchIds() uses the same source of truth
	 * as RequestBuilder.filterBySupportedParams(), preventing mismatches
	 * where YAML declares support for params the live indexer doesn't have.
	 */
	private overrideCapabilitiesWithLiveCaps(liveCaps: NewznabCapabilities): void {
		const toSearchParams = (params: string[]): SearchParam[] => {
			const mapping: Record<string, SearchParam> = {
				q: 'q',
				imdbid: 'imdbId',
				tmdbid: 'tmdbId',
				tvdbid: 'tvdbId',
				tvmazeid: 'tvMazeId',
				traktid: 'traktId',
				season: 'season',
				ep: 'ep',
				year: 'year',
				genre: 'genre',
				artist: 'artist',
				album: 'album',
				author: 'author',
				title: 'title',
				rid: 'q' // RageID not supported, map to q
			};
			return params.map((p) => mapping[p.toLowerCase()] ?? 'q');
		};

		const caps = liveCaps.searching;

		if (caps.search.available && this.capabilities.search) {
			this.capabilities.search.supportedParams = toSearchParams(caps.search.supportedParams);
		}
		if (caps.tvSearch.available && this.capabilities.tvSearch) {
			this.capabilities.tvSearch.supportedParams = toSearchParams(caps.tvSearch.supportedParams);
		}
		if (caps.movieSearch.available && this.capabilities.movieSearch) {
			this.capabilities.movieSearch.supportedParams = toSearchParams(
				caps.movieSearch.supportedParams
			);
		}
		if (caps.audioSearch.available && this.capabilities.musicSearch) {
			this.capabilities.musicSearch.supportedParams = toSearchParams(
				caps.audioSearch.supportedParams
			);
		}
		if (caps.bookSearch.available && this.capabilities.bookSearch) {
			this.capabilities.bookSearch.supportedParams = toSearchParams(
				caps.bookSearch.supportedParams
			);
		}
	}

	/**
	 * Initialize status tracking and rate limiting
	 */
	private initializeTracking(
		enabled: boolean,
		priority: number,
		rateLimit?: RateLimitConfig
	): void {
		const statusTracker = getPersistentStatusTracker();
		statusTracker.initialize(this.id, enabled, priority);

		if (rateLimit) {
			const registry = getRateLimitRegistry();
			registry.register(this.id, rateLimit);
		} else if (this.definition.requestdelay) {
			const registry = getRateLimitRegistry();
			registry.register(this.id, {
				requests: 1,
				periodMs: this.definition.requestdelay * 1000
			});
		}
	}

	/**
	 * Check if this indexer can handle the given search criteria
	 */
	canSearch(criteria: SearchCriteria): boolean {
		return this.capabilityChecker.canSearch(criteria, this.capabilities, this.additionalCategories);
	}

	/**
	 * Perform a search - routes to HTTP or database based on indexer type
	 */
	async search(criteria: SearchCriteria): Promise<ReleaseResult[]> {
		const startTime = Date.now();

		try {
			// Route to appropriate search method
			if (this.isInternalStreamingIndexer() && this.dbExecutor) {
				return await this.executeDatabaseSearch(criteria, startTime);
			}
			return await this.executeHttpSearch(criteria, startTime);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log.error({ error: message, criteria }, 'Search failed');
			throw error;
		}
	}

	/**
	 * Execute database search for internal streaming indexer
	 */
	private async executeDatabaseSearch(
		criteria: SearchCriteria,
		startTime: number
	): Promise<ReleaseResult[]> {
		if (!this.dbExecutor) {
			throw new Error('Database executor not initialized for internal streaming indexer');
		}

		this.log.debug({ criteria }, 'Executing database search');

		const results = await this.dbExecutor.execute(criteria, {
			indexerId: this.id,
			indexerName: this.name,
			protocol: this.protocol,
			baseUrl: this.baseUrl,
			settings: this.settings
		});

		const duration = Date.now() - startTime;
		this.log.debug(
			{
				resultCount: results.length,
				durationMs: duration
			},
			'Database search completed'
		);

		return results;
	}

	/**
	 * Execute HTTP search for torrent/usenet/external streaming
	 */
	private async executeHttpSearch(
		criteria: SearchCriteria,
		startTime: number
	): Promise<ReleaseResult[]> {
		// Ensure we're logged in
		await this.ensureLoggedIn();

		// Build requests
		const requests = this.requestBuilder.buildSearchRequests(
			this.applyAdditionalCategories(criteria)
		);
		if (requests.length === 0) {
			if (criteria.searchSource === 'interactive' && criteria.searchType === 'tv') {
				this.log.debug(
					{ criteria },
					'No search requests generated for this interactive TV criteria variant'
				);
			} else {
				this.log.warn({ criteria }, 'No search requests generated');
			}
			return [];
		}

		this.log.debug({ count: requests.length }, 'Built search requests');

		// Execute requests and collect results
		const allResults: ReleaseResult[] = [];
		let successfulRequests = 0;
		const requestErrors: string[] = [];

		for (const request of requests) {
			if (criteria.signal?.aborted) {
				// Search was cancelled (race settled elsewhere); skip the remaining
				// variants instead of burning rate-limit budget on dead requests.
				this.log.debug('Search cancelled before remaining request variants ran');
				break;
			}
			this.log.debug({ url: request.url, method: request.method }, 'Executing search request');
			try {
				// Enforce both indexer and host limits per outbound request
				// to avoid multi-variant search bursts against tracker hosts.
				await this.checkRateLimit();
				await this.hostRateLimiter.waitIfNeeded(request.url);

				const results = await this.executeSearchRequest(request, criteria.signal);
				allResults.push(...results);
				successfulRequests += 1;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (criteria.signal?.aborted) {
					// The orchestrator aborts sibling variants after one wins the
					// race (early-exit movie search) and settles the overall race
					// on success or timeout. Their 'Aborted' rejections are
					// deliberate cancellations, not indexer failures.
					this.log.debug({ url: request.url, error: message }, 'Search request cancelled');
					continue;
				}
				this.log.warn({ url: request.url, error: message }, 'Search request failed');
				requestErrors.push(this.normalizeTestRequestError(message));
			}
		}

		// If all requests failed, surface the error so orchestrator can mark
		// indexer health as failed instead of treating this as a successful empty result.
		if (successfulRequests === 0 && requestErrors.length > 0) {
			const uniqueErrors = [...new Set(requestErrors.filter(Boolean))];
			throw new Error(uniqueErrors.slice(0, 2).join('; ') || 'All search requests failed');
		}

		const duration = Date.now() - startTime;
		this.log.debug(
			{
				resultCount: allResults.length,
				durationMs: duration
			},
			'HTTP search completed'
		);

		return allResults;
	}

	/**
	 * Execute a single search request
	 */
	private async executeSearchRequest(
		request: {
			url: string;
			method: 'GET' | 'POST';
			headers: Record<string, string>;
			body?: string | URLSearchParams;
			searchPath: unknown;
		},
		signal?: AbortSignal
	): Promise<ReleaseResult[]> {
		this.http.setCookies(this.cookies);

		this.log.debug(
			{
				url: request.url,
				method: request.method,
				indexer: this.name
			},
			'Executing search request'
		);

		const response =
			request.method === 'POST'
				? await this.http.post(request.url, request.body!, {
						headers: request.headers,
						followRedirects: this.definition.followredirect ?? true,
						signal
					})
				: await this.http.get(request.url, {
						headers: request.headers,
						followRedirects: this.definition.followredirect ?? true,
						signal
					});

		this.log.debug(
			{
				status: response.status,
				url: response.url,
				bodyLength: response.body.length,
				bodyPreview: response.body.substring(0, 500),
				indexer: this.name
			},
			'Search response received'
		);

		this.http.parseAndStoreCookies(response.headers);

		const mockResponse = new Response(response.body, {
			status: response.status,
			headers: response.headers
		});

		const apiError = this.detectProviderError(response.body);
		if (apiError) {
			throw new Error(apiError);
		}

		if (this.authManager.checkLoginNeeded(mockResponse, response.body)) {
			this.log.info('Login needed, re-authenticating');
			this.isLoggedIn = false;
			await this.ensureLoggedIn(true);

			this.http.setCookies(this.cookies);

			const retryResponse =
				request.method === 'POST'
					? await this.http.post(request.url, request.body!, {
							headers: request.headers,
							followRedirects: this.definition.followredirect ?? true,
							signal
						})
					: await this.http.get(request.url, {
							headers: request.headers,
							followRedirects: this.definition.followredirect ?? true,
							signal
						});

			const retryApiError = this.detectProviderError(retryResponse.body);
			if (retryApiError) {
				throw new Error(retryApiError);
			}

			return this.parseResponse(retryResponse.body, request.searchPath);
		}

		// Refresh cookie expiration after successful request to keep session alive
		// Throttled to avoid SQLite I/O on every parallel variant within a search
		if (Object.keys(this.cookies).length > 0) {
			const now = Date.now();
			if (now - this.lastCookieRefreshMs > UnifiedIndexer.COOKIE_REFRESH_THROTTLE_MS) {
				this.lastCookieRefreshMs = now;
				const context = {
					indexerId: this.id,
					baseUrl: this.requestBuilder.getBaseUrl(),
					settings: this.settings,
					encoding: this.definition.encoding
				};
				await this.authManager.refreshCookieExpiration(context);
			}
		}

		return this.parseResponse(response.body, request.searchPath);
	}

	/**
	 * Detect provider-specific API errors represented in successful HTTP responses.
	 * Example: Newznab returns <error code="100" description="..." /> with HTTP 200.
	 */
	private detectProviderError(content: string): string | null {
		// Both Newznab and Torznab use the same <error code="N" description="..."/> XML format.
		const defId = this.definition.id;
		if (defId === 'newznab' || defId === 'torznab') {
			const errorMatch = content.match(/<error\b([^>]*)\/?>/i);
			if (!errorMatch) return null;

			const attrs = errorMatch[1] ?? '';
			const codeMatch = attrs.match(/\bcode=(['"]?)([^'" >]+)\1/i);
			const descQuotedMatch = attrs.match(/\bdescription=(['"])(.*?)\1/i);
			const descBareMatch = attrs.match(/\bdescription=([^'" >]+)/i);

			const code = codeMatch?.[2] ?? 'unknown';
			const description = descQuotedMatch?.[2] ?? descBareMatch?.[1] ?? 'Unknown API error';
			return `Indexer API error ${code}: ${description}`;
		}

		return null;
	}

	/**
	 * Parse a response into release results
	 */
	private parseResponse(content: string, searchPath: unknown): ReleaseResult[] {
		this.log.debug(
			{
				indexer: this.name,
				contentLength: content.length,
				contentPreview: content.substring(0, 200)
			},
			'Parsing search response'
		);

		const parseResult = this.responseParser.parse(
			content,
			searchPath as Parameters<typeof this.responseParser.parse>[1],
			{
				indexerId: this.id,
				indexerName: this.name,
				baseUrl: this.requestBuilder.getBaseUrl(),
				protocol: this.protocol
			}
		);

		this.log.debug(
			{
				indexer: this.name,
				releasesFound: parseResult.releases.length,
				errors: parseResult.errors?.length ?? 0
			},
			'Parse complete'
		);

		if (parseResult.errors && parseResult.errors.length > 0) {
			this.log.warn({ errors: parseResult.errors }, 'Parse had errors');
		}

		return parseResult.releases;
	}

	/**
	 * Ensure we're logged in (if required)
	 */
	private async ensureLoggedIn(forceFreshLogin = false): Promise<void> {
		if (!this.authManager.requiresAuth()) {
			return;
		}

		if (!forceFreshLogin && this.isLoggedIn && Object.keys(this.cookies).length > 0) {
			return;
		}

		const context = {
			indexerId: this.id,
			baseUrl: this.requestBuilder.getBaseUrl(),
			settings: this.settings,
			encoding: this.definition.encoding
		};

		if (forceFreshLogin) {
			await this.authManager.clearCookies(context);
			this.cookies = {};
		}

		const hasStoredCookies = !forceFreshLogin && (await this.authManager.loadCookies(context));
		if (hasStoredCookies) {
			this.cookies = this.authManager.getCookies();
			this.isLoggedIn = true;
			this.log.info(
				{
					indexer: this.name,
					cookieCount: Object.keys(this.cookies).length,
					cookieNames: Object.keys(this.cookies)
				},
				'Loaded stored cookies'
			);
			return;
		}

		this.log.info({ indexer: this.name }, 'Performing login');
		const loginResult = await this.authManager.login(context);

		if (!loginResult.success) {
			this.log.error({ indexer: this.name, error: loginResult.error }, 'Login failed');
			throw new Error(`Login failed: ${loginResult.error}`);
		}

		this.cookies = loginResult.cookies;
		this.isLoggedIn = true;

		this.log.info(
			{
				indexer: this.name,
				cookieCount: Object.keys(this.cookies).length,
				cookieNames: Object.keys(this.cookies)
			},
			'Login successful'
		);

		await this.authManager.saveCookies(context);
		this.log.debug({ indexer: this.name }, 'Cookies saved');
	}

	/**
	 * Test connectivity to the indexer
	 */
	async test(): Promise<void> {
		this.log.debug('Testing indexer connectivity');

		try {
			if (this.isInternalStreamingIndexer()) {
				// For internal streaming indexers, validate URL settings format.
				// They don't perform remote indexer I/O, so configuration validation is the test.
				await this.validateInternalStreamingSettings();
				this.log.info('Internal streaming indexer test successful');
				return;
			}

			const testCriteriaCandidates: SearchCriteria[] = [
				{ searchType: 'basic', query: 'test', limit: 1 },
				{ searchType: 'tv', query: 'test', imdbId: 'tt0944947', season: 1, episode: 1, limit: 1 },
				{ searchType: 'movie', query: 'test', imdbId: 'tt0133093', year: 1999, limit: 1 }
			];
			const requests = this.buildTestRequests(testCriteriaCandidates);
			if (requests.length === 0) {
				throw new Error('No test request could be generated for this indexer definition');
			}

			await this.ensureLoggedIn();
			let successfulRequests = 0;
			let resultCount = 0;
			const requestErrors: string[] = [];

			for (const request of requests) {
				try {
					const results = await this.executeSearchRequest(request);
					successfulRequests += 1;
					resultCount += results.length;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					requestErrors.push(this.normalizeTestRequestError(message));
				}
			}

			if (successfulRequests === 0) {
				const uniqueErrors = [...new Set(requestErrors.filter(Boolean))];
				const summary =
					uniqueErrors.length > 0
						? uniqueErrors.slice(0, 2).join('; ')
						: 'All test requests failed';
				throw new Error(summary);
			}

			this.log.info(
				{
					requestCount: successfulRequests,
					resultCount
				},
				'Indexer test successful'
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log.error({ error: message }, 'Indexer test failed');
			throw error instanceof Error ? error : new Error(message);
		}
	}

	/**
	 * Apply the per-indexer category restriction when one is configured.
	 * - Not configured (null in DB) → return criteria unchanged, RequestBuilder fills defaults.
	 * - Empty restriction [] → set categories to [] so RequestBuilder sends no cat= param (open search).
	 * - Non-empty restriction → replace categories with the user-selected set.
	 *
	 * For Prowlarr native indexers (definitionId='prowlarr'), unrestricted searches
	 * send no categories so Prowlarr queries all applicable indexers without filtering.
	 */
	private applyAdditionalCategories(criteria: SearchCriteria): SearchCriteria {
		if (!this.categoryRestrictionEnabled) {
			// Prowlarr's native API uses categories= to restrict which indexers participate.
			// When no restriction is set, omit categories entirely so all indexers are searched.
			if (this.definition.id === 'prowlarr') {
				return { ...criteria, categories: [] };
			}
			return criteria;
		}
		return { ...criteria, categories: this.additionalCategories };
	}

	/**
	 * Build at least one valid test request using capability-aware fallback criteria.
	 */
	private buildTestRequests(candidates: SearchCriteria[]) {
		for (const criteria of candidates) {
			const requests = this.requestBuilder.buildSearchRequests(criteria);
			if (requests.length > 0) {
				return requests;
			}
		}
		return [];
	}

	/**
	 * Validate settings used by the internal streaming indexer.
	 * Ensures malformed Cinephage Server Address values fail the connection test.
	 */
	private async validateInternalStreamingSettings(): Promise<void> {
		const rawExternalHost = this.settings.externalHost;
		if (typeof rawExternalHost !== 'string') {
			return;
		}

		const externalHost = rawExternalHost.trim();
		if (!externalHost) {
			return;
		}

		const useHttpsValue = this.settings.useHttps;
		const useHttps =
			useHttpsValue === true || (typeof useHttpsValue === 'string' && useHttpsValue === 'true');
		const defaultProtocol = useHttps ? 'https' : 'http';
		const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(externalHost);
		const candidate = hasProtocol ? externalHost : `${defaultProtocol}://${externalHost}`;

		let parsed: URL;
		try {
			parsed = new URL(candidate);
		} catch {
			throw new Error(
				'Invalid Cinephage Server Address format. Use a hostname or IP address with an optional port, for example 192.168.1.100:3000 or media.example.com.'
			);
		}

		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(
				'Invalid Cinephage Server Address protocol. Only http and https are supported.'
			);
		}

		if (!parsed.hostname) {
			throw new Error('Invalid Cinephage Server Address. A hostname or IP address is required.');
		}

		if (parsed.hostname.toLowerCase() === 'api.cinephage.net') {
			throw new Error(
				'Cinephage Server Address must be your own Cinephage server reachable by Jellyfin, not api.cinephage.net.'
			);
		}

		if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
			throw new Error(
				'Invalid Cinephage Server Address. Do not include a path, query, or fragment.'
			);
		}

		await this.probeInternalStreamingHost(parsed);
	}

	/**
	 * Probe server address reachability for internal streaming indexer config.
	 * Any HTTP response counts as reachable; network/TLS/DNS failures do not.
	 */
	private async probeInternalStreamingHost(baseUrl: URL): Promise<void> {
		const probeUrl = new URL('/api/health', baseUrl);
		const timeoutMs = 5000;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		try {
			await fetch(probeUrl.toString(), {
				method: 'GET',
				redirect: 'manual',
				signal: controller.signal,
				headers: {
					Accept: 'application/json, text/plain, */*',
					'User-Agent': 'Cinephage/1.0'
				}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const customPortHint = !baseUrl.port
				? ` If your Cinephage server is not using the default ${baseUrl.protocol === 'https:' ? 'HTTPS' : 'HTTP'} port, include it in Cinephage Server Address.`
				: '';
			throw new Error(
				`Cinephage Server Address is unreachable (${baseUrl.host}). Check the address, port, and protocol.${customPortHint} (${message})`,
				{ cause: error }
			);
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Normalize low-level request errors into concise test-level messages.
	 * Avoids leaking full request URLs/query params in user-facing errors.
	 */
	private normalizeTestRequestError(message: string): string {
		const normalized = message.trim();
		const lower = normalized.toLowerCase();

		if (lower.includes('indexer api error')) {
			const apiErrorMatch = normalized.match(/Indexer API error[^;]+/i);
			return apiErrorMatch?.[0]?.trim() ?? 'Indexer API error';
		}

		if (
			lower.includes('wrong api key') ||
			lower.includes('invalid api key') ||
			lower.includes('missing api key')
		) {
			return 'Authentication failed: invalid API key';
		}

		if (
			lower.includes('fetch failed') ||
			lower.includes('all urls failed') ||
			lower.includes('econnrefused') ||
			lower.includes('enotfound') ||
			lower.includes('eai_again') ||
			lower.includes('etimedout') ||
			lower.includes('timeout') ||
			lower.includes('timed out') ||
			lower.includes('unable to reach')
		) {
			return 'Unable to reach indexer server';
		}

		if (lower.includes('cloudflare')) {
			return 'Cloudflare protection blocked the request';
		}

		if (
			lower.includes('login failed') ||
			lower.includes('authentication') ||
			lower.includes('unauthorized') ||
			lower.includes('forbidden')
		) {
			return 'Authentication failed';
		}

		return normalized;
	}

	/**
	 * Reconstruct a download URL that was redacted for security.
	 * This restores the API key from indexer settings when the URL contains [REDACTED].
	 * Handles both plain [REDACTED] and URL-encoded %5BREDACTED%5D.
	 *
	 * @param redactedUrl - The URL that may contain [REDACTED] placeholders
	 * @returns The reconstructed URL with proper API key, or the original if not redacted
	 */
	reconstructDownloadUrl(redactedUrl: string): string {
		// Check for both plain [REDACTED] and URL-encoded %5BREDACTED%5D
		const hasRedacted =
			redactedUrl && (redactedUrl.includes('[REDACTED]') || redactedUrl.includes('%5BREDACTED%5D'));

		if (!hasRedacted) {
			return redactedUrl;
		}

		const apikey = this.settings.apikey;
		if (!apikey || typeof apikey !== 'string') {
			this.log.warn('Cannot reconstruct URL: no API key in settings');
			return redactedUrl;
		}

		// Prefer in-place token replacement to preserve exact endpoint pathing.
		const replacedUrl = redactedUrl
			.replace(/\[REDACTED\]/g, apikey)
			.replace(/%5BREDACTED%5D/gi, encodeURIComponent(apikey));
		if (replacedUrl !== redactedUrl) {
			this.log.debug('Replaced [REDACTED] in URL with API key');
			return replacedUrl;
		}

		// Fallback: reconstruct Newznab get URL from ID while preserving configured base path.
		const idMatch = redactedUrl.match(/[?&]id=([^&]+)/);
		if (idMatch) {
			const baseUrl = new URL(this.requestBuilder.getBaseUrl());
			const normalizedPath = baseUrl.pathname.replace(/\/+$/, '');
			if (!normalizedPath.endsWith('/api')) {
				baseUrl.pathname = normalizedPath ? `${normalizedPath}/api` : '/api';
			}
			baseUrl.searchParams.set('t', 'get');
			baseUrl.searchParams.set('id', idMatch[1]);
			baseUrl.searchParams.set('apikey', apikey);
			const reconstructed = baseUrl.toString();
			this.log.debug(
				{
					original: redactedUrl.substring(0, 50) + '...',
					hasApiKey: true
				},
				'Reconstructed redacted download URL'
			);
			return reconstructed;
		}

		return redactedUrl;
	}

	/**
	 * Download a torrent/NZB file from the indexer
	 */
	async downloadTorrent(
		url: string,
		options?: DownloadTorrentOptions
	): Promise<IndexerDownloadResult> {
		const startTime = Date.now();

		url = this.reconstructDownloadUrl(url);

		this.log.debug({ url: url.substring(0, 100) }, 'Downloading content');

		try {
			await this.ensureLoggedIn();
			await this.checkRateLimit();

			if (url.startsWith('magnet:')) {
				const { extractInfoHashFromMagnet } =
					await import('#lib/server/downloadClients/utils/torrentParser.js');
				const infoHash = await extractInfoHashFromMagnet(url);
				return {
					success: true,
					magnetUrl: url,
					infoHash,
					responseTimeMs: Date.now() - startTime
				};
			}

			if (url.startsWith('stream://')) {
				// For streaming URLs, return the URL as data
				return {
					success: true,
					data: Buffer.from(url),
					responseTimeMs: Date.now() - startTime
				};
			}

			// Check if URL needs resolution (e.g., HTML page with selectors to extract magnet/torrent URL)
			// This handles indexers like Torrent Downloads that return a details page URL instead of
			// a direct torrent/magnet link. The DownloadHandler will fetch the page and extract the
			// actual download URL using CSS selectors defined in the indexer YAML definition.
			const needsRes = this.downloadHandler.needsResolution();
			this.log.debug(
				{
					needsResolution: needsRes,
					hasDownloadBlock: !!this.definition.download,
					hasSelectors: !!this.definition.download?.selectors?.length,
					selectorsCount: this.definition.download?.selectors?.length ?? 0
				},
				'Checking if download needs resolution'
			);
			if (needsRes) {
				const context = {
					baseUrl: this.requestBuilder.getBaseUrl(),
					cookies: this.cookies,
					settings: this.settings,
					encoding: this.definition.encoding,
					releaseDetailsUrl: options?.releaseDetailsUrl ?? url,
					releaseGuid: options?.releaseGuid,
					releaseTitle: options?.releaseTitle
				};

				this.log.debug(
					{
						url: url.substring(0, 80),
						baseUrl: context.baseUrl,
						hasSettings: Object.keys(context.settings).length > 0,
						settingsKeys: Object.keys(context.settings)
					},
					'Calling resolveDownload'
				);

				const resolution = await this.downloadHandler.resolveDownload(url, context);

				this.log.debug(
					{
						success: resolution.success,
						hasMagnetUrl: !!resolution.magnetUrl,
						hasRequestUrl: !!resolution.request?.url,
						error: resolution.error
					},
					'Resolution result'
				);

				if (resolution.success) {
					// If resolution returned a magnet URL, use it directly
					if (resolution.magnetUrl) {
						this.log.debug(
							{
								original: url.substring(0, 50),
								magnetHash: resolution.magnetUrl.substring(0, 60)
							},
							'Resolved download URL to magnet'
						);
						const { extractInfoHashFromMagnet } =
							await import('#lib/server/downloadClients/utils/torrentParser.js');
						const infoHash = await extractInfoHashFromMagnet(resolution.magnetUrl);
						return {
							success: true,
							magnetUrl: resolution.magnetUrl,
							infoHash,
							responseTimeMs: Date.now() - startTime
						};
					}

					// If resolution already has cached torrent data (from testTorrentLink validation),
					// use it directly — avoids a redundant second fetch that would fail with
					// one-time download tokens (e.g., nCore's &key= parameter)
					if (resolution.torrentData) {
						this.log.debug(
							{
								dataSize: resolution.torrentData.length
							},
							'Using cached torrent data from resolution'
						);

						if (this.protocol === 'usenet') {
							return {
								success: true,
								data: resolution.torrentData,
								responseTimeMs: Date.now() - startTime
							};
						}

						const { parseTorrentFile } =
							await import('#lib/server/downloadClients/utils/torrentParser.js');
						const parseResult = await parseTorrentFile(resolution.torrentData);

						if (!parseResult.success) {
							return {
								success: false,
								error: parseResult.error,
								responseTimeMs: Date.now() - startTime
							};
						}

						if (parseResult.magnetUrl) {
							return {
								success: true,
								magnetUrl: parseResult.magnetUrl,
								infoHash: parseResult.infoHash,
								responseTimeMs: Date.now() - startTime
							};
						}

						return {
							success: true,
							data: resolution.torrentData,
							infoHash: parseResult.infoHash,
							responseTimeMs: Date.now() - startTime
						};
					}

					// If resolution returned a different URL, use that for fetching
					if (resolution.request?.url && resolution.request.url !== url) {
						this.log.debug(
							{
								original: url.substring(0, 50),
								resolved: resolution.request.url.substring(0, 50)
							},
							'Resolved download URL'
						);
						url = resolution.request.url;

						// Check if the resolved URL is a magnet link
						if (url.startsWith('magnet:')) {
							const { extractInfoHashFromMagnet } =
								await import('#lib/server/downloadClients/utils/torrentParser.js');
							const infoHash = await extractInfoHashFromMagnet(url);
							return {
								success: true,
								magnetUrl: url,
								infoHash,
								responseTimeMs: Date.now() - startTime
							};
						}
					}
				} else {
					this.log.warn(
						{
							error: resolution.error
						},
						'Download URL resolution failed, trying direct fetch'
					);
					// Continue with original URL as fallback
				}
			}

			const headers: Record<string, string> = {
				Accept: 'application/x-bittorrent, application/x-nzb, */*',
				Referer: options?.releaseDetailsUrl ?? url
			};

			if (Object.keys(this.cookies).length > 0) {
				headers['Cookie'] = CookieStore.buildCookieHeader(this.cookies);
			}

			const defHeaders = this.definition.download?.headers ?? this.definition.search?.headers;
			if (defHeaders) {
				for (const [key, values] of Object.entries(defHeaders)) {
					headers[key] = this.templateEngine.expand(values[0]);
				}
			}

			const maxRedirects = 5;
			let currentUrl = url;
			let response: Response | null = null;

			for (let redirectCount = 0; redirectCount < maxRedirects; redirectCount++) {
				response = await fetch(currentUrl, {
					method: 'GET',
					headers,
					redirect: 'manual'
				});

				if ([301, 302, 303, 307, 308].includes(response.status)) {
					const location = response.headers.get('location');
					if (!location) {
						return {
							success: false,
							error: 'Redirect without location header',
							responseTimeMs: Date.now() - startTime
						};
					}

					if (location.startsWith('magnet:')) {
						const { extractInfoHashFromMagnet } =
							await import('#lib/server/downloadClients/utils/torrentParser.js');
						const infoHash = await extractInfoHashFromMagnet(location);
						return {
							success: true,
							magnetUrl: location,
							infoHash,
							responseTimeMs: Date.now() - startTime
						};
					}

					currentUrl = new URL(location, currentUrl).toString();
					continue;
				}

				break;
			}

			if (!response) {
				return {
					success: false,
					error: 'No response received',
					responseTimeMs: Date.now() - startTime
				};
			}

			if (!response.ok) {
				const _errorText = await response.text().catch(() => '');

				// Cloudflare-protected download endpoints (e.g. rutracker dl.php) reject
				// plain Node fetches regardless of valid session cookies — the challenge
				// must be solved by a real browser and the payload pulled through the
				// browser context (issue #228).
				const isCloudflare = isCloudflareProtected(response.status, response.headers, _errorText);
				if (isCloudflare || response.status === 403 || response.status === 503) {
					this.log.info({ url: currentUrl }, 'Download blocked, retrying through browser');
					const { getCaptchaSolver } = await import('#lib/server/captcha/CaptchaSolver.js');
					const solver = getCaptchaSolver();
					const browserResult = await solver.fetch({
						url: currentUrl,
						method: 'GET',
						timeout: 90,
						binary: true,
						referer: headers.Referer,
						cookies: CookieStore.toPlaywrightCookies(this.cookies, new URL(currentUrl).hostname)
					});

					if (browserResult.success && browserResult.data && browserResult.data.length > 0) {
						const data = browserResult.data;

						if (this.protocol === 'usenet') {
							return {
								success: true,
								data,
								responseTimeMs: Date.now() - startTime
							};
						}

						const { parseTorrentFile } =
							await import('#lib/server/downloadClients/utils/torrentParser.js');
						const parseResult = await parseTorrentFile(data);

						if (!parseResult.success) {
							return {
								success: false,
								error: parseResult.error,
								responseTimeMs: Date.now() - startTime
							};
						}

						if (parseResult.magnetUrl) {
							return {
								success: true,
								magnetUrl: parseResult.magnetUrl,
								infoHash: parseResult.infoHash,
								responseTimeMs: Date.now() - startTime
							};
						}

						return {
							success: true,
							data,
							infoHash: parseResult.infoHash,
							responseTimeMs: Date.now() - startTime
						};
					}

					this.log.warn({ url: currentUrl, error: browserResult.error }, 'Browser download failed');
				}

				return {
					success: false,
					error: `HTTP ${response.status}: ${response.statusText}`,
					responseTimeMs: Date.now() - startTime
				};
			}

			const arrayBuffer = await response.arrayBuffer();
			const data = Buffer.from(arrayBuffer);

			// For usenet, just return the NZB data
			if (this.protocol === 'usenet') {
				return {
					success: true,
					data,
					responseTimeMs: Date.now() - startTime
				};
			}

			// For torrent, parse the file
			const { parseTorrentFile } =
				await import('#lib/server/downloadClients/utils/torrentParser.js');
			const parseResult = await parseTorrentFile(data);

			if (!parseResult.success) {
				return {
					success: false,
					error: parseResult.error,
					responseTimeMs: Date.now() - startTime
				};
			}

			if (parseResult.magnetUrl) {
				return {
					success: true,
					magnetUrl: parseResult.magnetUrl,
					infoHash: parseResult.infoHash,
					responseTimeMs: Date.now() - startTime
				};
			}

			return {
				success: true,
				data,
				infoHash: parseResult.infoHash,
				responseTimeMs: Date.now() - startTime
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log.error({ error: message }, 'Download failed');
			return {
				success: false,
				error: message,
				responseTimeMs: Date.now() - startTime
			};
		}
	}

	/**
	 * Check rate limit before making request
	 */
	private async checkRateLimit(): Promise<void> {
		const registry = getRateLimitRegistry();
		const limiter = registry.get(this.id);

		if (!limiter.canProceed()) {
			const waitTime = limiter.getWaitTime();
			this.log.debug({ waitTimeMs: waitTime }, 'Rate limited, waiting');
			await this.delay(waitTime);
		}

		limiter.recordRequest();
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Create a new UnifiedIndexer instance
 */
export function createUnifiedIndexer(config: UnifiedIndexerConfig): UnifiedIndexer {
	return new UnifiedIndexer(config);
}

/**
 * NewznabCapabilitiesProvider - Fetches and caches Newznab indexer capabilities.
 * Queries the ?t=caps endpoint to discover supported search modes and categories.
 */

import * as cheerio from 'cheerio';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import type {
	NewznabCapabilities,
	NewznabCategory,
	NewznabSearchMode,
	CachedCapabilities
} from './types';

/**
 * Error thrown when capabilities fetch fails.
 */
export class CapabilitiesFetchError extends Error {
	constructor(
		message: string,
		public readonly statusCode?: number
	) {
		super(message);
		this.name = 'CapabilitiesFetchError';
	}
}

/**
 * Default capabilities for when fetch fails or capabilities are unavailable.
 */
export const DEFAULT_CAPABILITIES: NewznabCapabilities = {
	server: {},
	limits: {
		default: 100,
		max: 100
	},
	searching: {
		search: { available: true, supportedParams: ['q'] },
		tvSearch: { available: true, supportedParams: ['q', 'tvdbid', 'season', 'ep'] },
		movieSearch: { available: true, supportedParams: ['q', 'imdbid'] },
		audioSearch: { available: false, supportedParams: [] },
		bookSearch: { available: false, supportedParams: [] }
	},
	categories: [
		{ id: '2000', name: 'Movies' },
		{ id: '2040', name: 'Movies/HD' },
		{ id: '2045', name: 'Movies/UHD' },
		{ id: '5000', name: 'TV' },
		{ id: '5040', name: 'TV/HD' },
		{ id: '5045', name: 'TV/UHD' }
	]
};

/**
 * Provider for fetching and caching Newznab indexer capabilities.
 */
export class NewznabCapabilitiesProvider {
	/** Cache TTL: 7 days in milliseconds */
	private static readonly CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

	/** In-memory cache: baseUrl -> cached capabilities */
	private cache: Map<string, CachedCapabilities> = new Map();

	/** Resolved torznab URL cache: raw URL -> discovered endpoint URL */
	private resolvedUrlCache: Map<string, string> = new Map();

	/**
	 * Get capabilities for a Newznab indexer.
	 * Returns cached capabilities if available and not expired.
	 */
	async getCapabilities(baseUrl: string, apiKey?: string): Promise<NewznabCapabilities> {
		const cacheKey = this.getCacheKey(baseUrl, apiKey);

		// Check cache
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() < cached.expiresAt) {
			logger.debug({ baseUrl }, '[Newznab] Using cached capabilities');
			return cached.capabilities;
		}

		// Fetch fresh capabilities
		try {
			const capabilities = await this.fetchCapabilities(baseUrl, apiKey);

			// Cache the result
			this.cache.set(cacheKey, {
				capabilities,
				expiresAt: Date.now() + NewznabCapabilitiesProvider.CACHE_TTL
			});

			logger.info(
				{
					baseUrl,
					categoryCount: capabilities.categories.length,
					movieSearch: capabilities.searching.movieSearch.available,
					tvSearch: capabilities.searching.tvSearch.available
				},
				'[Newznab] Capabilities fetched and cached'
			);

			return capabilities;
		} catch (error) {
			logger.warn(
				{
					baseUrl,
					error: error instanceof Error ? error.message : 'Unknown error'
				},
				'[Newznab] Failed to fetch capabilities, using defaults'
			);

			// Return default capabilities on failure
			return DEFAULT_CAPABILITIES;
		}
	}

	/**
	 * Strictly validate a Newznab/Torznab capabilities endpoint.
	 * Unlike getCapabilities(), this throws on errors instead of returning defaults.
	 */
	async validateCapabilitiesEndpoint(
		baseUrl: string,
		apiKey?: string
	): Promise<NewznabCapabilities> {
		return this.fetchCapabilities(baseUrl, apiKey?.trim());
	}

	/**
	 * Resolve the actual Torznab endpoint URL for a given raw base URL.
	 * If the URL already ends with /api it is returned as-is.
	 * Otherwise, candidate paths are probed in order:
	 *   1. {path}/torznab/all/api  (Jackett all-indexers aggregated)
	 *   2. {path}/api              (Prowlarr per-indexer and generic torznab)
	 * The first responding endpoint is cached and returned.
	 * Falls back to appending /api without caching if no candidate responds.
	 *
	 * Note: Prowlarr has no aggregate multi-indexer endpoint. Each Prowlarr indexer
	 * must be added separately using its numeric ID (e.g. http://host:9696/23).
	 */
	async resolveTorznabBaseUrl(rawUrl: string, apiKey?: string): Promise<string> {
		const cacheKey = `resolved:${this.getCacheKey(rawUrl, apiKey)}`;
		const cached = this.resolvedUrlCache.get(cacheKey);
		if (cached) return cached;

		const url = new URL(rawUrl);
		const normalizedPath = url.pathname.replace(/\/+$/, '');
		const lowerPath = normalizedPath.toLowerCase();

		// A valid torznab endpoint always ends with /api ; anything else needs discovery.
		if (lowerPath.endsWith('/api')) {
			this.resolvedUrlCache.set(cacheKey, rawUrl);
			return rawUrl;
		}

		// Jackett all-indexers: /torznab/all/api?apikey={key}
		// Prowlarr per-indexer and generic: /api (appended to whatever path the user provided)
		const candidates: string[] = [`${normalizedPath}/torznab/all/api`, `${normalizedPath}/api`];

		for (const candidatePath of candidates) {
			const candidate = new URL(rawUrl);
			candidate.pathname = candidatePath;
			logger.debug({ url: candidate.toString() }, '[Torznab] Probing candidate endpoint');
			if (await this.probeTorznabEndpoint(candidate, apiKey)) {
				const resolved = candidate.toString();
				this.resolvedUrlCache.set(cacheKey, resolved);
				logger.info({ rawUrl, resolved }, '[Torznab] Auto-discovered endpoint');
				return resolved;
			}
		}

		// No candidate responded; fall back to /api without caching so we re-probe next time
		const fallback = new URL(rawUrl);
		fallback.pathname = normalizedPath ? `${normalizedPath}/api` : '/api';
		logger.warn({ rawUrl }, '[Torznab] Could not auto-discover endpoint, falling back to /api');
		return fallback.toString();
	}

	/**
	 * Clear cached capabilities for an indexer.
	 */
	clearCache(baseUrl: string, apiKey?: string): void {
		const cacheKey = this.getCacheKey(baseUrl, apiKey);
		this.cache.delete(cacheKey);
		this.resolvedUrlCache.delete(`resolved:${cacheKey}`);
		logger.debug({ baseUrl }, '[Newznab] Cache cleared');
	}

	/**
	 * Clear all cached capabilities.
	 */
	clearAllCache(): void {
		this.cache.clear();
		this.resolvedUrlCache.clear();
		logger.debug('[Newznab] All cache cleared');
	}

	/**
	 * Probe a candidate torznab URL by requesting ?t=caps and checking for a valid XML caps response.
	 */
	private async probeTorznabEndpoint(url: URL, apiKey?: string): Promise<boolean> {
		const probe = new URL(url.toString());
		probe.searchParams.set('t', 'caps');
		const normalizedApiKey = apiKey?.trim();
		if (normalizedApiKey) {
			probe.searchParams.set('apikey', normalizedApiKey);
		}
		const probeUrl = probe.toString().replace(/apikey=[^&]+/, 'apikey=***');
		try {
			const response = await fetch(probe.toString(), {
				headers: { Accept: 'application/xml, text/xml, */*' },
				signal: AbortSignal.timeout(5000)
			});
			const ct = (response.headers.get('content-type') ?? '').toLowerCase();
			if (!response.ok) {
				logger.debug({ url: probeUrl, status: response.status }, '[Torznab] Probe: non-OK status');
				return false;
			}
			if (ct.includes('text/html')) {
				logger.debug({ url: probeUrl, ct }, '[Torznab] Probe: HTML response');
				return false;
			}
			const text = await response.text();
			// Case-insensitive: .NET apps (Prowlarr) may return <Caps> instead of <caps>
			const hasCaps = text.toLowerCase().includes('<caps');
			logger.debug(
				{ url: probeUrl, ct, status: response.status, hasCaps, preview: text.slice(0, 120) },
				'[Torznab] Probe: response'
			);
			return hasCaps;
		} catch (err) {
			logger.debug(
				{ url: probeUrl, err: err instanceof Error ? err.message : String(err) },
				'[Torznab] Probe: fetch error'
			);
			return false;
		}
	}

	/**
	 * Fetch capabilities from the indexer.
	 */
	private async fetchCapabilities(baseUrl: string, apiKey?: string): Promise<NewznabCapabilities> {
		// Build URL
		const url = new URL(baseUrl);
		const normalizedPath = url.pathname.replace(/\/+$/, '');
		const lowerPath = normalizedPath.toLowerCase();
		// Append /api for host-only URLs (newznab convention).
		// Skip only if the path already ends with /api, or if it's a bare /torznab path
		// (e.g. Prowlarr per-indexer direct endpoint that exposes the torznab root).
		const isTorznabEndpoint = lowerPath.endsWith('/torznab');
		if (!isTorznabEndpoint && !lowerPath.endsWith('/api')) {
			url.pathname = normalizedPath ? `${normalizedPath}/api` : '/api';
		}
		url.searchParams.set('t', 'caps');
		const normalizedApiKey = apiKey?.trim();
		if (normalizedApiKey) {
			url.searchParams.set('apikey', normalizedApiKey);
		}

		logger.debug(
			{
				url: url.toString().replace(/apikey=[^&]+/, 'apikey=***')
			},
			'[Newznab] Fetching capabilities'
		);

		const response = await fetch(url.toString(), {
			headers: {
				Accept: 'application/xml, text/xml, */*'
			},
			// Indexers are created lazily before a search; an unresponsive caps
			// endpoint must not stall it indefinitely.
			signal: AbortSignal.timeout(15_000)
		});

		if (!response.ok) {
			throw new CapabilitiesFetchError(
				`Failed to fetch capabilities: ${response.status} ${response.statusText}`,
				response.status
			);
		}

		const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
		if (contentType.includes('text/html')) {
			throw new CapabilitiesFetchError(
				'Indexer returned HTML instead of XML from the caps endpoint'
			);
		}
		if (contentType.includes('application/json') || contentType.includes('text/json')) {
			throw new CapabilitiesFetchError(
				'Indexer returned JSON instead of XML from the caps endpoint'
			);
		}

		const xml = await response.text();
		if (!xml.trim()) {
			throw new CapabilitiesFetchError('Indexer returned an empty caps response');
		}
		return this.parseCapabilities(xml);
	}

	/**
	 * Parse capabilities XML response.
	 */
	private parseCapabilities(xml: string): NewznabCapabilities {
		const $ = cheerio.load(xml, { xmlMode: true });

		// Case-insensitive: Prowlarr/.NET may return <Caps> instead of <caps>
		if ($('caps').length === 0 && $('Caps').length === 0) {
			throw new CapabilitiesFetchError(
				'Invalid capabilities response: missing <caps> root element'
			);
		}

		// Check for error response
		const errorEl = $('error, Error');
		if (errorEl.length > 0) {
			const code = errorEl.attr('code') || 'unknown';
			const desc = errorEl.attr('description') || 'Unknown error';
			throw new CapabilitiesFetchError(`Indexer error ${code}: ${desc}`);
		}

		// Parse server info
		const serverEl = $('server');
		const server = {
			version: serverEl.attr('version'),
			title: serverEl.attr('title'),
			email: serverEl.attr('email'),
			url: serverEl.attr('url')
		};

		// Parse limits
		const limitsEl = $('limits');
		const limits = {
			default: parseInt(limitsEl.attr('default') || '100', 10),
			max: parseInt(limitsEl.attr('max') || '100', 10)
		};

		// Parse searching capabilities
		const searching = {
			search: this.parseSearchMode($, 'search'),
			tvSearch: this.parseSearchMode($, 'tv-search'),
			movieSearch: this.parseSearchMode($, 'movie-search'),
			audioSearch: this.parseSearchMode($, 'audio-search'),
			bookSearch: this.parseSearchMode($, 'book-search')
		};

		// Parse categories
		const categories = this.parseCategories($);

		return {
			server,
			limits,
			searching,
			categories,
			rawXml: xml
		};
	}

	/**
	 * Parse a search mode element.
	 */
	private parseSearchMode($: cheerio.CheerioAPI, element: string): NewznabSearchMode {
		const el = $(`searching > ${element}`);
		if (!el.length || el.attr('available') !== 'yes') {
			return { available: false, supportedParams: [] };
		}

		const paramsAttr = el.attr('supportedParams') || el.attr('supportedparams');
		const supportedParams = paramsAttr
			? paramsAttr.split(',').map((p) => p.trim().toLowerCase())
			: ['q'];

		return { available: true, supportedParams };
	}

	/**
	 * Parse categories from capabilities.
	 */
	private parseCategories($: cheerio.CheerioAPI): NewznabCategory[] {
		const categories: NewznabCategory[] = [];

		$('categories > category').each((_, catEl) => {
			const cat = $(catEl);
			const category: NewznabCategory = {
				id: cat.attr('id') || '',
				name: cat.attr('name') || ''
			};

			// Parse subcategories
			const subCats: NewznabCategory[] = [];
			cat.find('> subcat').each((_, subEl) => {
				const sub = $(subEl);
				subCats.push({
					id: sub.attr('id') || '',
					name: sub.attr('name') || ''
				});
			});

			if (subCats.length > 0) {
				category.subCategories = subCats;
			}

			if (category.id) {
				categories.push(category);
			}
		});

		return categories;
	}

	/**
	 * Generate cache key from URL and API key.
	 */
	private getCacheKey(baseUrl: string, apiKey?: string): string {
		// Normalize URL
		const url = new URL(baseUrl);
		const normalized = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
		// Include API key hash for uniqueness (different keys might have different access)
		return apiKey ? `${normalized}:${this.hashApiKey(apiKey)}` : normalized;
	}

	/**
	 * Simple hash for API key (for cache key uniqueness, not security).
	 */
	private hashApiKey(apiKey: string): string {
		let hash = 0;
		for (let i = 0; i < apiKey.length; i++) {
			const char = apiKey.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return hash.toString(16);
	}
}

/** Singleton instance */
let instance: NewznabCapabilitiesProvider | null = null;

/**
 * Get the singleton NewznabCapabilitiesProvider instance.
 */
export function getNewznabCapabilitiesProvider(): NewznabCapabilitiesProvider {
	if (!instance) {
		instance = new NewznabCapabilitiesProvider();
	}
	return instance;
}

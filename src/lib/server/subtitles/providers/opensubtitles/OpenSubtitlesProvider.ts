/**
 * OpenSubtitles.com Provider Implementation
 *
 * Uses the OpenSubtitles REST API (api.opensubtitles.com)
 * Supports hash-based matching for best accuracy
 */

import {
	BaseSubtitleProvider,
	DEFAULT_CAPABILITIES,
	type ProviderCapabilities
} from '../BaseProvider';
import type {
	SubtitleSearchCriteria,
	SubtitleSearchResult,
	ProviderSearchOptions,
	LanguageCode
} from '../../types';
import type {
	OpenSubtitlesSearchParams,
	OpenSubtitlesSearchResponse,
	OpenSubtitlesResult,
	OpenSubtitlesDownloadRequest,
	OpenSubtitlesDownloadResponse,
	OpenSubtitlesAuthResponse
} from './types';
import { OPENSUBTITLES_LANGUAGES } from './types';
import { calculateOpenSubtitlesHash, canHashFile } from './hash';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import {
	TooManyRequests,
	DownloadLimitExceeded,
	ServiceUnavailable,
	AuthenticationError,
	ConfigurationError
} from '../../errors/ProviderErrors';

const API_BASE_URL = 'https://api.opensubtitles.com/api/v1';
const DEFAULT_USER_AGENT = 'Cinephage v1.0';

/**
 * Normalize the `base_url` returned by POST /login. For VIP accounts the API
 * redirects clients to a dedicated host, but returns it as a bare hostname
 * (e.g. "vip-api.opensubtitles.com") rather than a full URL - no scheme, no
 * /api/v1 path. Used as-is, that breaks every subsequent request ("Failed to
 * parse URL from vip-api.opensubtitles.com/...").
 */
function normalizeApiBaseUrl(rawBaseUrl: string): string {
	let url = rawBaseUrl.trim().replace(/\/+$/, '');
	if (!/^https?:\/\//i.test(url)) {
		url = `https://${url}`;
	}
	if (!url.endsWith('/api/v1')) {
		url = `${url}/api/v1`;
	}
	return url;
}

export class OpenSubtitlesProvider extends BaseSubtitleProvider {
	// Parses hearing_impaired and moviehash_match per result.
	protected override _capabilities: ProviderCapabilities = {
		...DEFAULT_CAPABILITIES,
		hashVerifiable: true,
		hearingImpairedVerifiable: true
	};
	private token: string | null = null;
	private tokenExpiry: Date | null = null;
	private baseUrl: string = API_BASE_URL;

	get implementation(): string {
		return 'opensubtitles';
	}

	get supportedLanguages(): LanguageCode[] {
		return OPENSUBTITLES_LANGUAGES;
	}

	get supportsHashSearch(): boolean {
		return true;
	}

	/**
	 * Search for subtitles on OpenSubtitles
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		try {
			// Build search params
			const params: OpenSubtitlesSearchParams = {
				languages: criteria.languages.join(',')
			};

			// Try hash search first if file path is available
			if (criteria.filePath && (await canHashFile(criteria.filePath))) {
				try {
					const { hash } = await calculateOpenSubtitlesHash(criteria.filePath);
					params.moviehash = hash;
					params.moviehash_match = 'include'; // Include hash matches but also text results
				} catch (e) {
					logger.debug(
						{
							error: e instanceof Error ? e.message : String(e)
						},
						'[OpenSubtitles] Hash calculation failed, using text search'
					);
				}
			}

			// Add ID-based search params
			if (criteria.imdbId) {
				// OpenSubtitles expects IMDB ID without 'tt' prefix
				params.imdb_id = criteria.imdbId.replace(/^tt/, '');
			}
			if (criteria.tmdbId) {
				if (criteria.season !== undefined) {
					// For TV episodes, use parent_tmdb_id
					params.parent_tmdb_id = criteria.tmdbId;
				} else {
					params.tmdb_id = criteria.tmdbId;
				}
			}

			// Text search fallback
			if (!params.moviehash && !params.imdb_id && !params.tmdb_id) {
				params.query = criteria.title;
				if (criteria.year) {
					params.year = criteria.year;
				}
			}

			// TV episode specific
			if (criteria.season !== undefined) {
				params.season_number = criteria.season;
				params.type = 'episode';
			}
			if (criteria.episode !== undefined) {
				params.episode_number = criteria.episode;
			}

			// Hearing impaired filter
			if (criteria.excludeHearingImpaired) {
				params.hearing_impaired = 'exclude';
			} else if (criteria.includeHearingImpaired) {
				params.hearing_impaired = 'include';
			}

			// Forced subtitles
			if (criteria.includeForced) {
				params.foreign_parts_only = 'include';
			}

			// Order by download count for reliability
			params.order_by = 'download_count';
			params.order_direction = 'desc';

			// Make API request
			const response = await this.makeRequest<OpenSubtitlesSearchResponse>(
				'/subtitles',
				params as unknown as Record<string, unknown>,
				options?.timeout
			);

			// Transform results
			const results = response.data.map((item) => this.transformResult(item));

			this.logSearch(criteria, results.length);
			return results;
		} catch (error) {
			this.logError('search', error);
			throw error;
		}
	}

	/**
	 * Download a subtitle file
	 */
	async download(result: SubtitleSearchResult): Promise<Buffer> {
		try {
			// Parse file ID from provider subtitle ID
			const fileId = parseInt(result.providerSubtitleId, 10);
			if (isNaN(fileId)) {
				throw new Error(`Invalid subtitle ID: ${result.providerSubtitleId}`);
			}

			// Request download link
			const downloadRequest: OpenSubtitlesDownloadRequest = {
				file_id: fileId,
				sub_format: 'srt'
			};

			const downloadResponse = await this.makeRequest<OpenSubtitlesDownloadResponse>(
				'/download',
				downloadRequest as unknown as Record<string, unknown>,
				30000,
				'POST'
			);

			// Download the actual file
			const fileResponse = await this.fetchWithTimeout(downloadResponse.link, {
				timeout: 30000
			});

			if (!fileResponse.ok) {
				throw new Error(`Download failed: ${fileResponse.status} ${fileResponse.statusText}`);
			}

			const buffer = Buffer.from(await fileResponse.arrayBuffer());

			logger.debug(
				{
					fileId,
					size: buffer.length,
					remaining: downloadResponse.remaining
				},
				'[OpenSubtitles] Downloaded subtitle'
			);

			return buffer;
		} catch (error) {
			this.logError('download', error);
			throw error;
		}
	}

	/**
	 * Test provider connectivity and authentication
	 */
	async test(): Promise<{ success: boolean; message: string; responseTime: number }> {
		const startTime = Date.now();
		try {
			// Try to authenticate
			await this.authenticate();

			// Do a simple search to verify API access
			const response = await this.makeRequest<OpenSubtitlesSearchResponse>('/subtitles', {
				query: 'test',
				languages: 'en'
			});

			if (response.total_count === undefined) {
				throw new Error('Invalid API response');
			}

			const responseTime = Date.now() - startTime;
			logger.info('[OpenSubtitles] Provider test successful');
			return { success: true, message: 'Connection successful', responseTime };
		} catch (error) {
			const responseTime = Date.now() - startTime;
			this.logError('test', error);
			return {
				success: false,
				message: error instanceof Error ? error.message : 'Unknown error',
				responseTime
			};
		}
	}

	/**
	 * Authenticate with API and get token
	 */
	private async authenticate(): Promise<string> {
		// Return cached token if still valid
		if (this.token && this.tokenExpiry && new Date() < this.tokenExpiry) {
			return this.token;
		}

		const apiKey = this.config.apiKey;
		if (!apiKey) {
			throw new ConfigurationError('opensubtitles', 'API key is required');
		}

		// Check if we have credentials for user-based auth
		if (this.config.username && this.config.password) {
			const response = await this.fetchWithTimeout(`${API_BASE_URL}/login`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Api-Key': apiKey,
					'User-Agent': DEFAULT_USER_AGENT
				},
				body: JSON.stringify({
					username: this.config.username,
					password: this.config.password
				}),
				timeout: 15000
			});

			if (!response.ok) {
				const error = await response.text();
				if (response.status === 401 || response.status === 403) {
					throw new AuthenticationError('opensubtitles', error || 'Invalid credentials');
				}
				throw new Error(`Authentication failed: ${response.status} - ${error}`);
			}

			const data: OpenSubtitlesAuthResponse = await response.json();
			this.token = data.token;
			this.baseUrl = data.base_url ? normalizeApiBaseUrl(data.base_url) : API_BASE_URL;
			// Token is valid for 24 hours, refresh at 23 hours
			this.tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000);

			logger.debug(
				{
					downloads: data.user.allowed_downloads,
					vip: data.user.vip
				},
				'[OpenSubtitles] Authenticated successfully'
			);

			return this.token;
		}

		// API key only mode - no token needed for search
		return apiKey;
	}

	/**
	 * Make an API request
	 */
	private async makeRequest<T>(
		endpoint: string,
		params: Record<string, unknown>,
		timeout: number = 30000,
		method: 'GET' | 'POST' = 'GET'
	): Promise<T> {
		const apiKey = this.config.apiKey;
		if (!apiKey) {
			throw new ConfigurationError('opensubtitles', 'API key is required');
		}

		// Ensure authentication is performed before every request
		await this.authenticate();

		const headers: Record<string, string> = {
			'Api-Key': apiKey,
			'User-Agent': DEFAULT_USER_AGENT,
			Accept: 'application/json'
		};

		// Add auth token if available (set by authenticate() when username+password provided)
		if (this.token) {
			headers['Authorization'] = `Bearer ${this.token}`;
		}

		let url: string;
		let fetchOptions: RequestInit;

		if (method === 'GET') {
			// Build URL with query params
			const searchParams = new URLSearchParams();
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined && value !== null) {
					searchParams.append(key, String(value));
				}
			}
			url = `${this.baseUrl}${endpoint}?${searchParams.toString()}`;
			fetchOptions = {
				method: 'GET',
				headers
			};
		} else {
			url = `${this.baseUrl}${endpoint}`;
			headers['Content-Type'] = 'application/json';
			fetchOptions = {
				method: 'POST',
				headers,
				body: JSON.stringify(params)
			};
		}

		const response = await this.fetchWithTimeout(url, {
			...fetchOptions,
			timeout
		});

		if (!response.ok) {
			const errorText = await response.text();

			// Throw typed errors based on HTTP status
			switch (response.status) {
				case 401:
				case 403:
					throw new AuthenticationError(
						'opensubtitles',
						errorText || 'Invalid API key or credentials'
					);
				case 406:
					// OpenSubtitles uses 406 for download limit exceeded
					throw new DownloadLimitExceeded('opensubtitles');
				case 429: {
					// Extract retry-after header if available
					const retryAfter = response.headers.get('retry-after');
					throw new TooManyRequests('opensubtitles', retryAfter ? parseInt(retryAfter) : undefined);
				}
				case 500:
				case 502:
				case 503:
				case 504:
					throw new ServiceUnavailable('opensubtitles');
				default:
					throw new Error(`API request failed: ${response.status} - ${errorText}`);
			}
		}

		return response.json();
	}

	/**
	 * Transform API result to our format
	 */
	private transformResult(item: OpenSubtitlesResult): SubtitleSearchResult {
		const attrs = item.attributes;
		const file = attrs.files[0]; // Usually just one file

		return {
			providerId: this.id,
			providerName: this.name,
			providerSubtitleId: file?.file_id?.toString() || attrs.subtitle_id,

			language: this.normalizeLanguage(attrs.language),
			title: attrs.feature_details.title || attrs.feature_details.movie_name,
			releaseName: attrs.release,
			fileName: file?.file_name,

			isForced: attrs.foreign_parts_only,
			isHearingImpaired: attrs.hearing_impaired,
			format: file?.file_name ? this.detectFormat(file.file_name) : 'srt',

			isHashMatch: attrs.moviehash_match || false,
			matchScore: this.calculateScore(attrs),
			scoreBreakdown: {
				hashMatch: attrs.moviehash_match ? 100 : 0,
				titleMatch: 50, // Assumed match since API returned it
				yearMatch: 20,
				releaseGroupMatch: attrs.from_trusted ? 15 : 0,
				sourceMatch: attrs.hd ? 10 : 0,
				codecMatch: 0,
				hiPenalty: 0,
				forcedBonus: 0
			},

			downloadUrl: attrs.url,
			downloadCount: attrs.download_count,
			rating: attrs.ratings,
			uploadDate: attrs.upload_date,
			uploader: attrs.uploader?.name
		};
	}

	/**
	 * Calculate match score for a result
	 */
	private calculateScore(attrs: OpenSubtitlesResult['attributes']): number {
		let score = 0;

		// Hash match is highest confidence
		if (attrs.moviehash_match) {
			score += 100;
		}

		// Title/content match (base score)
		score += 50;

		// From trusted source
		if (attrs.from_trusted) {
			score += 15;
		}

		// HD quality
		if (attrs.hd) {
			score += 10;
		}

		// Popularity bonus (capped)
		score += Math.min(attrs.download_count / 1000, 10);

		// Rating bonus
		if (attrs.ratings > 0) {
			score += Math.min(attrs.ratings, 5);
		}

		return Math.round(score);
	}
}

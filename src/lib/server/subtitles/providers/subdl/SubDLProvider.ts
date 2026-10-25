/**
 * SubDL Provider Implementation
 *
 * SubDL is a modern subtitle database with a REST API.
 * Features: API key auth, 60+ languages, IMDB/TMDB search
 * API: https://subdl.com/api
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
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import {
	TooManyRequests,
	ServiceUnavailable,
	AuthenticationError,
	ConfigurationError
} from '../../errors/ProviderErrors';
import { SUBDL_LANGUAGES, SUBDL_LANGUAGE_REVERSE, type SubDLSubtitle } from './types';
import { languageSatisfies } from '../../requirement-matcher';

const API_BASE_URL = 'https://api.subdl.com/api/v1/subtitles';
const DOWNLOAD_BASE_URL = 'https://dl.subdl.com';

export class SubDLProvider extends BaseSubtitleProvider {
	// Parses the `hi` flag per result.
	protected override _capabilities: ProviderCapabilities = {
		...DEFAULT_CAPABILITIES,
		hearingImpairedVerifiable: true
	};
	get implementation(): string {
		return 'subdl';
	}

	get supportedLanguages(): LanguageCode[] {
		return Object.keys(SUBDL_LANGUAGES);
	}

	get supportsHashSearch(): boolean {
		return false;
	}

	/**
	 * Search for subtitles on SubDL
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		const apiKey = this.config.apiKey;
		if (!apiKey) {
			throw new ConfigurationError('subdl', 'API key is required');
		}

		try {
			const results: SubtitleSearchResult[] = [];

			// Build search parameters
			const params = new URLSearchParams();
			params.append('api_key', apiKey);

			// Use IMDB ID if available (most reliable)
			if (criteria.imdbId) {
				params.append('imdb_id', criteria.imdbId);
			} else if (criteria.tmdbId) {
				params.append('tmdb_id', criteria.tmdbId.toString());
			} else {
				// Fall back to title search
				const searchTitle = criteria.seriesTitle || criteria.title;
				params.append('film_name', searchTitle);
				if (criteria.year) {
					params.append('year', criteria.year.toString());
				}
			}

			// Add type
			if (criteria.season !== undefined) {
				params.append('type', 'tv');
				params.append('season_number', criteria.season.toString());
				if (criteria.episode !== undefined) {
					params.append('episode_number', criteria.episode.toString());
				}
			} else {
				params.append('type', 'movie');
			}

			// Add languages
			const langCodes = criteria.languages.map((l) => SUBDL_LANGUAGES[l]).filter(Boolean);
			if (langCodes.length > 0) {
				params.append('languages', langCodes.join(','));
			}

			// Make request
			const url = `${API_BASE_URL}?${params.toString()}`;
			const response = await this.fetchWithTimeout(url, {
				timeout: options?.timeout || 15000,
				headers: {
					Accept: 'application/json',
					'User-Agent': 'Cinephage/1.0'
				}
			});

			if (!response.ok) {
				this.handleErrorResponse(response);
			}

			const data = await response.json();

			if (!data.status) {
				logger.warn({ data }, '[SubDL] Search returned unsuccessful status');
				return results;
			}

			// Process subtitles
			const subtitles: SubDLSubtitle[] = data.subtitles || [];

			for (const sub of subtitles) {
				// Map SubDL language back to ISO code
				const isoLang = SUBDL_LANGUAGE_REVERSE[sub.lang.toLowerCase()] || sub.lang;

				// Check if this language was requested (base/region aware: a `pt`
				// request accepts a `pt-BR` result).
				if (!criteria.languages.some((requested) => languageSatisfies(isoLang, requested))) {
					continue;
				}

				results.push({
					providerId: this.id,
					providerName: this.name,
					providerSubtitleId: sub.url,

					language: isoLang,
					title: sub.name,
					releaseName: sub.release_name,

					isForced: this.isForced(sub.release_name || sub.name),
					isHearingImpaired: sub.hi || false,
					format: this.detectFormatFromUrl(sub.url),

					isHashMatch: false,
					matchScore: this.calculateScore(sub, criteria),
					scoreBreakdown: {
						hashMatch: 0,
						titleMatch: 50,
						yearMatch: 20,
						releaseGroupMatch: sub.release_name ? 15 : 0,
						sourceMatch: 0,
						codecMatch: 0,
						hiPenalty: 0,
						forcedBonus: 0
					},

					downloadCount: sub.downloads,
					rating: sub.rating,
					uploader: sub.author
				});
			}

			// Sort by score
			results.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

			// Limit results
			const maxResults = options?.maxResults || 25;
			const limited = results.slice(0, maxResults);

			this.logSearch(criteria, limited.length);
			return limited;
		} catch (error) {
			this.logError('search', error);
			throw error;
		}
	}

	/**
	 * Download a subtitle file
	 */
	async download(result: SubtitleSearchResult): Promise<Buffer> {
		const apiKey = this.config.apiKey;
		if (!apiKey) {
			throw new ConfigurationError('subdl', 'API key is required');
		}

		try {
			// SubDL download URL format
			const downloadUrl = result.providerSubtitleId.startsWith('http')
				? result.providerSubtitleId
				: `${DOWNLOAD_BASE_URL}${result.providerSubtitleId}`;

			const response = await this.fetchWithTimeout(downloadUrl, {
				timeout: 30000,
				headers: {
					'User-Agent': 'Cinephage/1.0'
				}
			});

			if (!response.ok) {
				this.handleErrorResponse(response);
			}

			const buffer = Buffer.from(await response.arrayBuffer());

			// SubDL typically returns zip files
			logger.debug(
				{
					url: downloadUrl,
					size: buffer.length
				},
				'[SubDL] Downloaded subtitle'
			);

			return buffer;
		} catch (error) {
			this.logError('download', error);
			throw error;
		}
	}

	/**
	 * Test provider connectivity
	 */
	async test(): Promise<{ success: boolean; message: string; responseTime: number }> {
		const startTime = Date.now();

		const apiKey = this.config.apiKey;
		if (!apiKey) {
			return {
				success: false,
				message: 'API key is required',
				responseTime: Date.now() - startTime
			};
		}

		try {
			// Simple search to test API
			const params = new URLSearchParams({
				api_key: apiKey,
				film_name: 'test',
				type: 'movie'
			});

			const response = await this.fetchWithTimeout(`${API_BASE_URL}?${params.toString()}`, {
				timeout: 10000,
				headers: {
					Accept: 'application/json',
					'User-Agent': 'Cinephage/1.0'
				}
			});

			if (!response.ok) {
				if (response.status === 401 || response.status === 403) {
					throw new AuthenticationError('subdl', 'Invalid API key');
				}
				throw new Error(`API returned ${response.status}`);
			}

			const responseTime = Date.now() - startTime;
			logger.info('[SubDL] Provider test successful');
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
	 * Handle HTTP error responses with typed exceptions
	 */
	private handleErrorResponse(response: Response): never {
		switch (response.status) {
			case 401:
			case 403:
				throw new AuthenticationError('subdl', 'Invalid API key');
			case 429: {
				const retryAfter = response.headers.get('retry-after');
				throw new TooManyRequests('subdl', retryAfter ? parseInt(retryAfter) : undefined);
			}
			case 500:
			case 502:
			case 503:
			case 504:
				throw new ServiceUnavailable('subdl');
			default:
				throw new Error(`API request failed: ${response.status}`);
		}
	}

	/**
	 * Calculate match score for a subtitle
	 */
	private calculateScore(sub: SubDLSubtitle, criteria: SubtitleSearchCriteria): number {
		let score = 50; // Base score for title match

		// Year match implied by IMDB/TMDB search
		score += 20;

		// Release name bonus
		if (sub.release_name) {
			score += 15;
		}

		// Popularity bonus (capped at 10)
		if (sub.downloads) {
			score += Math.min(sub.downloads / 1000, 10);
		}

		// Rating bonus (capped at 5)
		if (sub.rating) {
			score += Math.min(sub.rating / 2, 5);
		}

		// Penalty for hearing impaired if explicitly excluded
		if (sub.hi && criteria.excludeHearingImpaired) {
			score -= 5;
		}

		return Math.round(score);
	}

	/**
	 * Detect subtitle format from URL (override base to handle URL patterns)
	 */
	private detectFormatFromUrl(url: string): 'srt' | 'ass' | 'sub' | 'vtt' | 'ssa' | 'unknown' {
		const lower = url.toLowerCase();
		if (lower.includes('.srt')) return 'srt';
		if (lower.includes('.ass')) return 'ass';
		if (lower.includes('.ssa')) return 'ssa';
		if (lower.includes('.sub')) return 'sub';
		if (lower.includes('.vtt')) return 'vtt';
		return 'srt'; // Default to SRT
	}
}

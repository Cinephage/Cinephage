/**
 * YIFY Subtitles Provider Implementation
 *
 * YIFY Subtitles is a movie subtitle database (movies only, no TV shows).
 * Uses HTML scraping since there's no public API.
 * Site: https://yifysubtitles.ch (or .org)
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
import * as cheerio from 'cheerio';
import {
	TooManyRequests,
	ServiceUnavailable,
	ParseResponseError
} from '../../errors/ProviderErrors';
import { YIFY_LANGUAGES, YIFY_LANGUAGE_REVERSE } from './types';

const BASE_URL = 'https://yifysubtitles.ch';

export class YIFYSubtitlesProvider extends BaseSubtitleProvider {
	// Parses isHi per search result.
	protected override _capabilities: ProviderCapabilities = {
		...DEFAULT_CAPABILITIES,
		hearingImpairedVerifiable: true
	};
	get implementation(): string {
		return 'yifysubtitles';
	}

	get supportedLanguages(): LanguageCode[] {
		return Object.keys(YIFY_LANGUAGES);
	}

	get supportsHashSearch(): boolean {
		return false;
	}

	/**
	 * YIFY only supports movies - check criteria
	 */
	canSearch(criteria: SubtitleSearchCriteria): boolean {
		// YIFY is movies only - reject TV searches
		if (criteria.season !== undefined || criteria.episode !== undefined) {
			return false;
		}
		return super.canSearch(criteria);
	}

	/**
	 * Search for subtitles on YIFY
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		// Only movies supported
		if (criteria.season !== undefined) {
			return [];
		}

		try {
			const results: SubtitleSearchResult[] = [];

			let movieImdbId = criteria.imdbId;

			if (!movieImdbId) {
				movieImdbId = await this.resolveImdbId(criteria.title, criteria.year, options?.timeout);
				if (!movieImdbId) {
					logger.debug({ title: criteria.title }, '[YIFY] Movie not found via title search');
					return results;
				}
			}

			const searchUrl = `${BASE_URL}/movie-imdb/${movieImdbId}`;

			const response = await this.fetchWithTimeout(searchUrl, {
				timeout: options?.timeout || 15000,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
					Accept: 'text/html'
				}
			});

			if (!response.ok) {
				if (response.status === 404) {
					logger.debug(
						{
							imdbId: movieImdbId,
							title: criteria.title
						},
						'[YIFY] Movie not found'
					);
					return results;
				}
				this.handleErrorResponse(response);
			}

			const html = await response.text();
			const subtitleItems = this.parseSubtitleList(html, criteria.languages);

			// Transform to our format
			for (const item of subtitleItems) {
				results.push({
					providerId: this.id,
					providerName: this.name,
					providerSubtitleId: item.downloadUrl,

					language: item.language,
					title: criteria.title,
					releaseName: item.releaseName,

					isForced: this.isForced(item.releaseName || ''),
					isHearingImpaired: item.isHi,
					format: 'srt',

					isHashMatch: false,
					matchScore: this.calculateScore(item),
					scoreBreakdown: {
						hashMatch: 0,
						titleMatch: 50,
						yearMatch: 20,
						releaseGroupMatch: item.releaseName ? 15 : 0,
						sourceMatch: 0,
						codecMatch: 0,
						hiPenalty: 0,
						forcedBonus: 0
					},

					rating: item.rating,
					uploader: item.uploader
				});
			}

			// Sort by rating
			results.sort((a, b) => (b.rating || 0) - (a.rating || 0));

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
		try {
			// Get the subtitle page to find the download link
			const subtitlePageUrl = result.providerSubtitleId.startsWith('http')
				? result.providerSubtitleId
				: `${BASE_URL}${result.providerSubtitleId}`;

			const pageResponse = await this.fetchWithTimeout(subtitlePageUrl, {
				timeout: 30000,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
					Accept: 'text/html'
				}
			});

			if (!pageResponse.ok) {
				this.handleErrorResponse(pageResponse);
			}

			const html = await pageResponse.text();
			const $ = cheerio.load(html);

			// Find download button link
			const downloadLink =
				$('a.download-subtitle').attr('href') ||
				$('.btn-icon.download-subtitle').attr('href') ||
				$('a[href*="/subtitle/"]').attr('href');

			if (!downloadLink) {
				throw new ParseResponseError('yifysubtitles', 'Download link not found on page');
			}

			// YIFY download URLs are relative to subdomain
			const downloadUrl = downloadLink.startsWith('http')
				? downloadLink
				: `https://yifysubtitles.ch${downloadLink}`;

			// Download the file
			const downloadResponse = await this.fetchWithTimeout(downloadUrl, {
				timeout: 30000,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
					Referer: subtitlePageUrl
				}
			});

			if (!downloadResponse.ok) {
				this.handleErrorResponse(downloadResponse);
			}

			return Buffer.from(await downloadResponse.arrayBuffer());
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
		try {
			const response = await this.fetchWithTimeout(BASE_URL, {
				timeout: 10000,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
				}
			});

			if (!response.ok) {
				throw new Error(`Site returned ${response.status}`);
			}

			const responseTime = Date.now() - startTime;
			logger.info('[YIFY] Provider test successful');
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
			case 429: {
				const retryAfter = response.headers.get('retry-after');
				throw new TooManyRequests('yifysubtitles', retryAfter ? parseInt(retryAfter) : undefined);
			}
			case 500:
			case 502:
			case 503:
			case 504:
				throw new ServiceUnavailable('yifysubtitles');
			default:
				throw new Error(`Request failed: ${response.status}`);
		}
	}

	/**
	 * Parse subtitle list from movie page HTML
	 */
	private parseSubtitleList(
		html: string,
		requestedLanguages: LanguageCode[]
	): Array<{
		language: string;
		releaseName?: string;
		downloadUrl: string;
		isHi: boolean;
		rating?: number;
		uploader?: string;
	}> {
		const $ = cheerio.load(html);
		const items: Array<{
			language: string;
			releaseName?: string;
			downloadUrl: string;
			isHi: boolean;
			rating?: number;
			uploader?: string;
		}> = [];

		// Parse subtitle table rows
		$('table.other-subs tbody tr').each((_, row) => {
			const $row = $(row);

			// Get language from .sub-lang span inside .flag-cell
			const langSpan = $row.find('.flag-cell .sub-lang');
			const langText = langSpan.text().toLowerCase().trim();

			// Try to match language
			let isoLang: string | undefined;
			for (const [iso, name] of Object.entries(YIFY_LANGUAGES)) {
				if (langText === name || langText.includes(name) || name.includes(langText)) {
					isoLang = iso;
					break;
				}
			}

			// Also check reverse mapping
			if (!isoLang) {
				isoLang = YIFY_LANGUAGE_REVERSE[langText];
			}

			if (!isoLang || !requestedLanguages.includes(isoLang)) {
				return; // Skip this subtitle
			}

			// Get subtitle link and release name
			const subtitleLink = $row.find('a[href*="/subtitles/"]').attr('href');
			if (!subtitleLink) return;

			// Release name is the text after "subtitle" span
			const linkText = $row.find('a[href*="/subtitles/"]').text().trim();
			const releaseName = linkText.replace(/^subtitle\s*/i, '').trim() || undefined;

			// Check for HI (hearing impaired icon)
			const isHi =
				$row.find('.hi-icon, [title*="hearing"]').length > 0 ||
				$row.find('.other-cell').text().toLowerCase().includes('hi');

			// Get rating from .rating-cell
			const ratingText = $row.find('.rating-cell .label').text().trim();
			const ratingMatch = ratingText.match(/-?(\d+)/);
			const rating = ratingMatch ? parseInt(ratingMatch[0], 10) : undefined;

			// Get uploader from .uploader-cell
			const uploader = $row.find('.uploader-cell a').text().trim() || undefined;

			items.push({
				language: isoLang,
				releaseName,
				downloadUrl: subtitleLink,
				isHi,
				rating,
				uploader
			});
		});

		return items;
	}

	/**
	 * Resolve IMDB ID from TMDB, then fall back to YIFY's AJAX search
	 */
	private async resolveImdbId(
		title: string,
		year?: number,
		timeout?: number
	): Promise<string | undefined> {
		// Try TMDB external IDs first (most reliable)
		try {
			const { tmdb } = await import('#lib/server/tmdb.js');
			const searchResult = await tmdb.searchMovies(title, year);
			if (searchResult.results?.length > 0) {
				const match = searchResult.results[0];
				const externalIds = await tmdb.getMovieExternalIds(match.id);
				if (externalIds.imdb_id) {
					logger.debug({ title, imdbId: externalIds.imdb_id }, '[YIFY] Resolved IMDB ID via TMDB');
					return externalIds.imdb_id;
				}
			}
		} catch {
			logger.debug({ title }, '[YIFY] TMDB resolution failed, trying AJAX search');
		}

		// Fall back to YIFY's own AJAX search endpoint
		try {
			const ajaxUrl = `${BASE_URL}/ajax/search/?mov=${encodeURIComponent(title)}`;
			const response = await this.fetchWithTimeout(ajaxUrl, {
				timeout: timeout || 10000,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
					Accept: 'application/json'
				}
			});

			if (!response.ok) return undefined;

			const results: Array<{ movie: string; imdb: string }> = await response.json();
			if (results.length === 0) return undefined;

			if (year) {
				const yearMatch = results.find((r) => r.movie.includes(String(year)));
				if (yearMatch) return yearMatch.imdb;
			}

			return results[0].imdb;
		} catch {
			logger.debug({ title }, '[YIFY] AJAX search failed');
			return undefined;
		}
	}

	/**
	 * Calculate match score
	 */
	private calculateScore(item: { rating?: number; releaseName?: string }): number {
		let score = 50;

		score += 20;

		if (item.releaseName) {
			score += 15;
		}

		if (item.rating) {
			const normalizedRating = item.rating > 5 ? item.rating : item.rating * 2;
			score += Math.min(normalizedRating, 10);
		}

		return Math.round(score);
	}
}

/**
 * Subf2m Provider Implementation
 *
 * Subf2m (Subtitles For 2 Movies) is a large subtitle database.
 * Features: HTML scraping, large catalog, both movies and TV shows.
 * Site: https://subf2m.co
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
import { SUBF2M_LANGUAGES } from './types';

const BASE_URL = 'https://subf2m.co';

export class Subf2mProvider extends BaseSubtitleProvider {
	// Parses isHi per search result.
	protected override _capabilities: ProviderCapabilities = {
		...DEFAULT_CAPABILITIES,
		hearingImpairedVerifiable: true
	};
	get implementation(): string {
		return 'subf2m';
	}

	get supportedLanguages(): LanguageCode[] {
		return Object.keys(SUBF2M_LANGUAGES);
	}

	get supportsHashSearch(): boolean {
		return false;
	}

	/**
	 * Search for subtitles on Subf2m
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		try {
			const results: SubtitleSearchResult[] = [];

			// First, search for the title
			const searchTitle = criteria.seriesTitle || criteria.title;
			const titleUrl = await this.findTitleUrl(searchTitle, criteria, options?.timeout);

			if (!titleUrl) {
				logger.debug({ title: searchTitle }, '[Subf2m] Title not found');
				return results;
			}

			// Get subtitle list from title page
			const subtitleItems = await this.getSubtitleList(
				titleUrl,
				criteria.languages,
				options?.timeout
			);

			// Filter by season/episode for TV
			const filteredItems = this.filterBySeason(subtitleItems, criteria);

			// Transform to our format
			for (const item of filteredItems) {
				const displayTitle =
					criteria.season !== undefined
						? `${searchTitle} S${criteria.season.toString().padStart(2, '0')}${criteria.episode !== undefined ? `E${criteria.episode.toString().padStart(2, '0')}` : ''}`
						: searchTitle;

				results.push({
					providerId: this.id,
					providerName: this.name,
					providerSubtitleId: item.downloadUrl,

					language: item.language,
					title: displayTitle,
					releaseName: item.releaseName,

					isForced: this.isForced(item.releaseName || ''),
					isHearingImpaired: item.isHi,
					format: 'srt',

					isHashMatch: false,
					matchScore: this.calculateScore(item),
					scoreBreakdown: {
						hashMatch: 0,
						titleMatch: 50,
						yearMatch: item.year ? 20 : 0,
						releaseGroupMatch: item.releaseName ? 15 : 0,
						sourceMatch: 0,
						codecMatch: 0,
						hiPenalty: 0,
						forcedBonus: 0
					},

					downloadCount: item.downloads,
					uploader: item.uploader
				});
			}

			// Sort by downloads
			results.sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));

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
			const subtitlePageUrl = result.providerSubtitleId.startsWith('http')
				? result.providerSubtitleId
				: `${BASE_URL}${result.providerSubtitleId}`;

			const pageResponse = await this.fetchWithTimeout(subtitlePageUrl, {
				timeout: 30000,
				headers: this.getHeaders()
			});

			if (!pageResponse.ok) {
				this.handleErrorResponse(pageResponse);
			}

			const html = await pageResponse.text();
			const $ = cheerio.load(html);

			const downloadLink =
				$('#downloadButton').attr('href') || $('a[href*="/download"]').attr('href');

			if (!downloadLink) {
				throw new ParseResponseError('subf2m', 'Download link not found on page');
			}

			const downloadUrl = downloadLink.startsWith('http')
				? downloadLink
				: `${BASE_URL}${downloadLink}`;

			const downloadResponse = await this.fetchWithTimeout(downloadUrl, {
				timeout: 30000,
				headers: {
					...this.getHeaders(),
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
				headers: this.getHeaders()
			});

			if (!response.ok) {
				throw new Error(`Site returned ${response.status}`);
			}

			const responseTime = Date.now() - startTime;
			logger.info('[Subf2m] Provider test successful');
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
	 * Get standard headers for requests
	 */
	private getHeaders(): Record<string, string> {
		return {
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'en-US,en;q=0.9'
		};
	}

	/**
	 * Handle HTTP error responses with typed exceptions
	 */
	private handleErrorResponse(response: Response): never {
		switch (response.status) {
			case 429: {
				const retryAfter = response.headers.get('retry-after');
				throw new TooManyRequests('subf2m', retryAfter ? parseInt(retryAfter) : undefined);
			}
			case 500:
			case 502:
			case 503:
			case 504:
				throw new ServiceUnavailable('subf2m');
			default:
				throw new Error(`Request failed: ${response.status}`);
		}
	}

	/**
	 * Find the title URL from search results
	 */
	private async findTitleUrl(
		searchTitle: string,
		criteria: SubtitleSearchCriteria,
		timeout?: number
	): Promise<string | null> {
		// Build search URL
		const searchQuery = encodeURIComponent(searchTitle);
		const searchUrl = `${BASE_URL}/subtitles/searchbytitle?query=${searchQuery}`;

		const response = await this.fetchWithTimeout(searchUrl, {
			timeout: timeout || 15000,
			headers: this.getHeaders()
		});

		if (!response.ok) {
			if (response.status === 404) {
				return null;
			}
			this.handleErrorResponse(response);
		}

		const html = await response.text();
		const $ = cheerio.load(html);

		// Look for matching titles
		const isTV = criteria.season !== undefined;
		let bestMatch: string | null = null;
		let bestScore = 0;

		$('.title a[href*="/subtitles/"], .search-result a[href*="/subtitles/"]').each((_, el) => {
			const href = $(el).attr('href');
			const text = $(el).text().toLowerCase().trim();

			if (!href) return;

			// Score this match
			let score = 0;
			const searchLower = searchTitle.toLowerCase();
			const searchWords = searchLower.split(/\s+/);

			// Word matching
			for (const word of searchWords) {
				if (text.includes(word)) {
					score += 10;
				}
			}

			// Exact match bonus
			if (text === searchLower) {
				score += 50;
			}

			// Year matching for movies
			if (criteria.year && text.includes(criteria.year.toString())) {
				score += 20;
			}

			// Type matching (movie vs tv)
			const isTVUrl =
				href.includes('/tv-') ||
				href.includes('-tv/') ||
				text.includes('season') ||
				text.includes('episode');
			if (isTV === isTVUrl) {
				score += 30;
			}

			if (score > bestScore) {
				bestScore = score;
				bestMatch = href;
			}
		});

		return bestMatch;
	}

	/**
	 * Get subtitle list from title page
	 * Subf2m requires fetching language-specific pages (e.g., /subtitles/inception/english)
	 */
	private async getSubtitleList(
		titleUrl: string,
		requestedLanguages: LanguageCode[],
		timeout?: number
	): Promise<
		Array<{
			language: string;
			releaseName?: string;
			downloadUrl: string;
			isHi: boolean;
			downloads?: number;
			uploader?: string;
			year?: number;
			season?: number;
			episode?: number;
		}>
	> {
		const baseUrl = titleUrl.startsWith('http') ? titleUrl : `${BASE_URL}${titleUrl}`;

		const items: Array<{
			language: string;
			releaseName?: string;
			downloadUrl: string;
			isHi: boolean;
			downloads?: number;
			uploader?: string;
			year?: number;
			season?: number;
			episode?: number;
		}> = [];

		// Fetch each requested language page
		for (const langCode of requestedLanguages) {
			const subf2mLang = SUBF2M_LANGUAGES[langCode];
			if (!subf2mLang) {
				logger.debug({ langCode }, '[Subf2m] No mapping for language');
				continue;
			}

			const langUrl = `${baseUrl}/${subf2mLang}`;

			try {
				const response = await this.fetchWithTimeout(langUrl, {
					timeout: timeout || 15000,
					headers: this.getHeaders()
				});

				if (!response.ok) {
					// 404 means no subtitles for this language, not an error
					if (response.status === 404) {
						continue;
					}
					this.handleErrorResponse(response);
				}

				const html = await response.text();
				const $ = cheerio.load(html);

				// Parse subtitle rows - Subf2m structure: li.item inside content div
				$('li.item').each((_, row) => {
					const $row = $(row);

					// Get subtitle URL - uses /subtitles/ (plural) path
					const subtitleLink =
						$row.find('a.download[href*="/subtitles/"]').attr('href') ||
						$row.find('a[href*="/subtitles/"][class*="download"]').attr('href');
					if (!subtitleLink) return;

					// Get release name from scrolllist
					const releaseName =
						$row.find('ul.scrolllist li').first().text().trim() ||
						$row.find('.col-info li').first().text().trim();

					// Check for HI - look for HI indicator in classes or text
					const isHi =
						$row.find('.hi, [title*="hearing"], .hearing-impaired').length > 0 ||
						$row.find('span.hi').length > 0 ||
						$row.text().toLowerCase().includes('hearing impaired');

					// Get download count (Subf2m doesn't show counts on list page)
					const downloadsText = $row.find('.download-count, .downloads').text();
					const downloadsMatch = downloadsText.match(/(\d+)/);
					const downloads = downloadsMatch ? parseInt(downloadsMatch[1], 10) : undefined;

					// Get uploader from comment-col
					const uploader =
						$row.find('.comment-col a').text().trim() ||
						$row
							.find('.comment-col b')
							.text()
							.replace(/^By\s*/i, '')
							.trim() ||
						undefined;

					// Try to extract season/episode from release name
					let season: number | undefined;
					let episode: number | undefined;
					const seMatch = releaseName.match(/S(\d{1,2})E(\d{1,2})/i);
					if (seMatch) {
						season = parseInt(seMatch[1], 10);
						episode = parseInt(seMatch[2], 10);
					} else {
						const seasonMatch = releaseName.match(/Season\s*(\d+)/i);
						if (seasonMatch) {
							season = parseInt(seasonMatch[1], 10);
						}
					}

					// Use the language code from the loop (we know which language page we're on)
					items.push({
						language: langCode,
						releaseName,
						downloadUrl: subtitleLink,
						isHi,
						downloads,
						uploader,
						season,
						episode
					});
				});
			} catch (error) {
				// Log but don't fail - continue with other languages
				logger.warn(
					{
						langCode,
						error: error instanceof Error ? error.message : 'Unknown error'
					},
					'[Subf2m] Failed to fetch language page'
				);
			}
		}

		return items;
	}

	/**
	 * Filter subtitles by season/episode
	 */
	private filterBySeason(
		items: Array<{
			language: string;
			releaseName?: string;
			downloadUrl: string;
			isHi: boolean;
			downloads?: number;
			uploader?: string;
			year?: number;
			season?: number;
			episode?: number;
		}>,
		criteria: SubtitleSearchCriteria
	): typeof items {
		// If not a TV search, return all
		if (criteria.season === undefined) {
			return items;
		}

		return items.filter((item) => {
			// If item has season info, it must match
			if (item.season !== undefined && item.season !== criteria.season) {
				return false;
			}

			// If searching for specific episode and item has episode info
			if (criteria.episode !== undefined && item.episode !== undefined) {
				return item.episode === criteria.episode;
			}

			return true;
		});
	}

	/**
	 * Calculate match score
	 */
	private calculateScore(item: {
		downloads?: number;
		releaseName?: string;
		year?: number;
	}): number {
		let score = 50; // Base score

		// Year match bonus
		if (item.year) {
			score += 20;
		}

		// Release name bonus
		if (item.releaseName) {
			score += 15;
		}

		// Popularity bonus (capped)
		if (item.downloads) {
			score += Math.min(item.downloads / 100, 15);
		}

		return Math.round(score);
	}
}

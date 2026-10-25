/**
 * Addic7ed.com Provider Implementation
 *
 * Addic7ed specializes in TV show subtitles with high-quality translations.
 * Uses HTML scraping with authentication support.
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
	DownloadLimitExceeded,
	ServiceUnavailable,
	AuthenticationError
} from '../../errors/ProviderErrors';

const BASE_URL = 'https://www.addic7ed.com';

/** Addic7ed language codes */
const ADDIC7ED_LANGUAGES: Record<string, number> = {
	en: 1, // English
	es: 4, // Spanish
	fr: 8, // French
	de: 7, // German
	it: 9, // Italian
	pt: 10, // Portuguese
	'pt-br': 48, // Brazilian Portuguese
	nl: 11, // Dutch
	pl: 12, // Polish
	ru: 19, // Russian
	ar: 38, // Arabic
	he: 23, // Hebrew
	tr: 16, // Turkish
	el: 27, // Greek
	hu: 24, // Hungarian
	ro: 13, // Romanian
	cs: 14, // Czech
	sv: 18, // Swedish
	da: 29, // Danish
	fi: 17, // Finnish
	no: 30, // Norwegian
	ja: 37, // Japanese
	ko: 45, // Korean
	zh: 21, // Chinese
	vi: 25, // Vietnamese
	bg: 35, // Bulgarian
	hr: 31, // Croatian
	sr: 32, // Serbian
	sk: 26, // Slovak
	sl: 41, // Slovenian
	uk: 46, // Ukrainian
	ca: 49, // Catalan
	eu: 47 // Basque
};

export class Addic7edProvider extends BaseSubtitleProvider {
	// Parses isHi per search result.
	protected override _capabilities: ProviderCapabilities = {
		...DEFAULT_CAPABILITIES,
		hearingImpairedVerifiable: true
	};
	private cookies: string = '';

	get implementation(): string {
		return 'addic7ed';
	}

	get supportedLanguages(): LanguageCode[] {
		return Object.keys(ADDIC7ED_LANGUAGES);
	}

	get supportsHashSearch(): boolean {
		return false;
	}

	/**
	 * Check if this is a TV show search (Addic7ed is TV-only)
	 */
	canSearch(criteria: SubtitleSearchCriteria): boolean {
		// Addic7ed only supports TV shows
		if (criteria.season === undefined) {
			return false;
		}
		return super.canSearch(criteria);
	}

	/**
	 * Search for subtitles on Addic7ed
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		// Only TV shows supported
		if (criteria.season === undefined) {
			return [];
		}

		try {
			const results: SubtitleSearchResult[] = [];

			// Search for the show
			const showName = criteria.seriesTitle || criteria.title;
			const searchUrl = `${BASE_URL}/search.php?search=${encodeURIComponent(showName)}&Submit=Search`;

			const searchResponse = await this.makeRequest(searchUrl, options?.timeout);
			if (!searchResponse.ok) {
				logger.warn({ status: searchResponse.status }, '[Addic7ed] Search request failed');
				return results;
			}

			const searchHtml = await searchResponse.text();

			// Check if we got redirected to a show page directly
			const finalUrl = searchResponse.url;
			let showPageHtml = searchHtml;

			if (!finalUrl.includes('/show/')) {
				// Parse search results and find the best match
				const showUrl = this.findShowUrl(searchHtml, showName);
				if (!showUrl) {
					return results;
				}

				const showResponse = await this.makeRequest(`${BASE_URL}${showUrl}`, options?.timeout);
				if (!showResponse.ok) {
					return results;
				}
				showPageHtml = await showResponse.text();
			}

			// Get episode page URL
			const episodeUrl = this.findEpisodeUrl(showPageHtml, criteria.season, criteria.episode || 1);

			if (!episodeUrl) {
				return results;
			}

			// Fetch episode page
			const episodeResponse = await this.makeRequest(`${BASE_URL}${episodeUrl}`, options?.timeout);
			if (!episodeResponse.ok) {
				return results;
			}

			const episodeHtml = await episodeResponse.text();

			// Parse subtitles from episode page
			const subtitleItems = this.parseEpisodeSubtitles(episodeHtml, criteria.languages);

			// Transform to our format
			for (const item of subtitleItems) {
				results.push({
					providerId: this.id,
					providerName: this.name,
					providerSubtitleId: item.downloadUrl,

					language: item.language,
					title: `${showName} S${criteria.season?.toString().padStart(2, '0')}E${(criteria.episode || 1).toString().padStart(2, '0')}`,
					releaseName: item.version,

					isForced: false,
					isHearingImpaired: item.isHi,
					format: 'srt',

					isHashMatch: false,
					matchScore: this.calculateScore(item),

					downloadCount: item.downloads,
					uploader: item.uploader
				});
			}

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
			const downloadUrl = `${BASE_URL}${result.providerSubtitleId}`;

			const response = await this.makeRequest(downloadUrl, 30000);
			if (!response.ok) {
				throw new Error(`Download failed: ${response.status}`);
			}

			// Check for download limit message
			const contentType = response.headers.get('content-type') || '';
			if (contentType.includes('text/html')) {
				const html = await response.text();
				if (html.includes('Daily Download count exceeded')) {
					throw new DownloadLimitExceeded('addic7ed');
				}
				throw new Error('Received HTML instead of subtitle file');
			}

			return Buffer.from(await response.arrayBuffer());
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
			const response = await this.makeRequest(BASE_URL, 10000);
			if (!response.ok) {
				throw new Error(`Site returned ${response.status}`);
			}

			const responseTime = Date.now() - startTime;
			logger.info('[Addic7ed] Provider test successful');
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
	 * Make an authenticated request
	 */
	private async makeRequest(url: string, timeout: number = 15000): Promise<Response> {
		const headers: Record<string, string> = {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
			Accept: 'text/html,application/xhtml+xml,*/*',
			'Accept-Language': 'en-US,en;q=0.9',
			Referer: BASE_URL
		};

		// Add authentication cookies if we have credentials
		if (this.config.username && this.config.password && !this.cookies) {
			await this.authenticate();
		}

		if (this.cookies) {
			headers['Cookie'] = this.cookies;
		}

		const response = await this.fetchWithTimeout(url, { headers, timeout });

		// Check for common error statuses and throw typed errors
		if (!response.ok) {
			if (response.status === 429) {
				const retryAfter = response.headers.get('retry-after');
				throw new TooManyRequests('addic7ed', retryAfter ? parseInt(retryAfter) : undefined);
			}
			if (response.status === 401 || response.status === 403) {
				throw new AuthenticationError('addic7ed', 'Invalid credentials or session expired');
			}
			if (response.status >= 500) {
				throw new ServiceUnavailable('addic7ed');
			}
		}

		return response;
	}

	/**
	 * Authenticate with Addic7ed
	 */
	private async authenticate(): Promise<void> {
		if (!this.config.username || !this.config.password) {
			return;
		}

		try {
			const formData = new URLSearchParams({
				username: this.config.username,
				password: this.config.password,
				Submit: 'Log in',
				remember: '1'
			});

			const response = await this.fetchWithTimeout(`${BASE_URL}/dologin.php`, {
				method: 'POST',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
					'Content-Type': 'application/x-www-form-urlencoded',
					Referer: `${BASE_URL}/login.php`
				},
				body: formData.toString(),
				timeout: 15000
			});

			// Extract cookies
			const setCookie = response.headers.get('set-cookie');
			if (setCookie) {
				this.cookies = setCookie
					.split(',')
					.map((c) => c.split(';')[0])
					.join('; ');
			}

			logger.debug('[Addic7ed] Authentication completed');
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'[Addic7ed] Authentication failed'
			);
		}
	}

	/**
	 * Find show URL from search results
	 */
	private findShowUrl(html: string, showName: string): string | null {
		const $ = cheerio.load(html);
		const searchLower = showName.toLowerCase();

		let bestUrl: string | null = null;
		let bestScore = 0;

		$('table.tabel tbody tr td a').each((_, el) => {
			const href = $(el).attr('href');
			const text = $(el).text().toLowerCase();

			if (href?.includes('/show/')) {
				// Calculate simple match score
				let score = 0;
				const searchWords = searchLower.split(/\s+/);
				for (const word of searchWords) {
					if (text.includes(word)) {
						score += 1;
					}
				}

				if (score > 0 && score > bestScore) {
					bestUrl = href;
					bestScore = score;
				}
			}
		});

		return bestUrl;
	}

	/**
	 * Find episode URL on show page
	 */
	private findEpisodeUrl(html: string, season: number, episode: number): string | null {
		const $ = cheerio.load(html);

		let episodeUrl: string | null = null;

		$('a').each((_, el) => {
			const href = $(el).attr('href') || '';
			// Pattern: /serie/ShowName/Season/Episode/EpisodeName
			const match = href.match(/\/serie\/[^/]+\/(\d+)\/(\d+)\//);

			if (match) {
				const urlSeason = parseInt(match[1], 10);
				const urlEpisode = parseInt(match[2], 10);

				if (urlSeason === season && urlEpisode === episode) {
					episodeUrl = href;
					return false; // Break loop
				}
			}
		});

		return episodeUrl;
	}

	/**
	 * Parse subtitles from episode page
	 */
	private parseEpisodeSubtitles(
		html: string,
		requestedLanguages: LanguageCode[]
	): Array<{
		language: string;
		version: string;
		downloadUrl: string;
		isHi: boolean;
		downloads?: number;
		uploader?: string;
	}> {
		const $ = cheerio.load(html);
		const items: Array<{
			language: string;
			version: string;
			downloadUrl: string;
			isHi: boolean;
			downloads?: number;
			uploader?: string;
		}> = [];

		// Find subtitle tables
		$('.tabel95').each((_, table) => {
			const $table = $(table);

			// Get language from header
			const langHeader = $table.find('.language').text().toLowerCase().trim();
			const langEntry = Object.entries(ADDIC7ED_LANGUAGES).find(([, name]) =>
				langHeader.includes(name.toString())
			);

			if (!langEntry) return;

			const isoLang = langEntry[0];
			if (!requestedLanguages.includes(isoLang)) return;

			// Get version/release info
			const version = $table.find('.NewsTitle').text().trim();

			// Get download link
			const downloadLink = $table.find('a.buttonDownload').attr('href');
			if (!downloadLink) return;

			// Check for HI
			const isHi = $table.find('img[src*="icon-cc"]').length > 0;

			// Get uploader
			const uploader = $table.find('.newsDate a').first().text().trim();

			// Get download count
			const statsText = $table.find('.newsDate').text();
			const downloadsMatch = statsText.match(/(\d+)\s+Downloads/);
			const downloads = downloadsMatch ? parseInt(downloadsMatch[1], 10) : undefined;

			items.push({
				language: isoLang,
				version,
				downloadUrl: downloadLink,
				isHi,
				downloads,
				uploader
			});
		});

		return items;
	}

	/**
	 * Calculate match score
	 */
	private calculateScore(item: { downloads?: number; version?: string }): number {
		let score = 50; // Base score for title/episode match

		// Version/release info bonus
		if (item.version) {
			score += 15;
		}

		// Popularity bonus
		if (item.downloads) {
			score += Math.min(item.downloads / 50, 20);
		}

		return Math.round(score);
	}
}

/**
 * Legendasdivx Provider Implementation
 *
 * Portuguese subtitle provider (Portugal).
 * Based on Bazarr's subliminal_patch/providers/legendasdivx.py
 */

import { BaseSubtitleProvider } from '../BaseProvider';
import type { ISubtitleProvider, ProviderTestResult } from '../interfaces';
import type {
	SubtitleSearchCriteria,
	SubtitleSearchResult,
	SubtitleProviderConfig,
	ProviderSearchOptions,
	LanguageCode
} from '../../types';
import { GenericSubtitle } from '../../subtitle';
import { Language } from '../../language';
import { LEGENDASDIVX_LANGUAGES, LEGENDASDIVX_BASE_URL, type LegendasdivxConfig } from './types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import * as cheerio from 'cheerio';
import { extractFromZip } from '../mixins';
import { AuthenticationError, DownloadLimitExceeded } from '../../errors/ProviderErrors';

const LOGIN_URL = `${LEGENDASDIVX_BASE_URL}/forum/ucp.php?mode=login`;
const SEARCH_URL = `${LEGENDASDIVX_BASE_URL}/modules.php`;

/**
 * Legendasdivx Provider
 *
 * Portuguese subtitle provider with authentication and FPS matching.
 */
export class LegendasdivxProvider extends BaseSubtitleProvider implements ISubtitleProvider {
	private readonly skipWrongFps: boolean;
	private cookies: string = '';
	private loggedIn = false;

	constructor(config: SubtitleProviderConfig) {
		super(config);

		const settings = config.settings as LegendasdivxConfig | undefined;
		this.skipWrongFps = settings?.skipWrongFps !== false;

		this._capabilities = {
			hashVerifiable: false,
			hearingImpairedVerifiable: false,
			skipWrongFps: this.skipWrongFps,
			supportsTvShows: true,
			supportsMovies: true,
			supportsAnime: false
		};
	}

	get implementation(): string {
		return 'legendasdivx';
	}

	get supportedLanguages(): LanguageCode[] {
		return LEGENDASDIVX_LANGUAGES;
	}

	get supportsHashSearch(): boolean {
		return false;
	}

	/**
	 * Initialize - login
	 */
	protected async onInitialize(): Promise<void> {
		await this.login();
	}

	/**
	 * Login to Legendasdivx
	 */
	private async login(): Promise<void> {
		if (this.loggedIn) return;

		const username = this.config.username;
		const password = this.config.password;

		if (!username || !password) {
			throw new AuthenticationError('legendasdivx', 'Username and password required');
		}

		const response = await this.fetchWithTimeout(LOGIN_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				username,
				password,
				autologin: 'on',
				login: 'Entrar'
			}).toString(),
			redirect: 'manual',
			timeout: 15000
		});

		// Extract cookies
		const setCookie = response.headers.get('set-cookie');
		if (setCookie) {
			this.cookies = setCookie;
			this.loggedIn = true;
			logger.debug('[Legendasdivx] Logged in successfully');
		} else {
			throw new AuthenticationError('legendasdivx', 'Login failed - no cookies received');
		}
	}

	/**
	 * Search for subtitles
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		_options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		// Only Portuguese supported
		const languages = criteria.languages.filter((l) => l === 'pt');
		if (languages.length === 0) {
			return [];
		}

		await this.login();

		const language = new Language('pt');
		const results: SubtitleSearchResult[] = [];

		// Try IMDB search first
		if (criteria.imdbId) {
			const imdbResults = await this.searchByImdb(criteria, language);
			results.push(...imdbResults);
		}

		// Fallback to text search
		if (results.length === 0) {
			const textResults = await this.searchByText(criteria, language);
			results.push(...textResults);
		}

		this.logSearch(criteria, results.length);
		this.recordSuccess();

		return results;
	}

	/**
	 * Search by IMDB ID
	 */
	private async searchByImdb(
		criteria: SubtitleSearchCriteria,
		language: Language
	): Promise<SubtitleSearchResult[]> {
		const imdbId = criteria.imdbId?.replace('tt', '') || '';

		const params = new URLSearchParams({
			name: 'Downloads',
			d_op: 'search',
			op: 'story',
			story: imdbId
		});

		return this.parseSearchResults(`${SEARCH_URL}?${params.toString()}`, criteria, language);
	}

	/**
	 * Search by text
	 */
	private async searchByText(
		criteria: SubtitleSearchCriteria,
		language: Language
	): Promise<SubtitleSearchResult[]> {
		const searchTitle = criteria.seriesTitle ?? criteria.title;
		const isEpisode = criteria.season !== undefined;

		let query = searchTitle;
		if (isEpisode && criteria.season !== undefined && criteria.episode !== undefined) {
			query += ` S${String(criteria.season).padStart(2, '0')}E${String(criteria.episode).padStart(2, '0')}`;
		} else if (criteria.year) {
			query += ` ${criteria.year}`;
		}

		const params = new URLSearchParams({
			name: 'Downloads',
			d_op: 'search',
			op: 'story',
			story: query
		});

		return this.parseSearchResults(`${SEARCH_URL}?${params.toString()}`, criteria, language);
	}

	/**
	 * Parse search results page
	 */
	private async parseSearchResults(
		url: string,
		criteria: SubtitleSearchCriteria,
		language: Language
	): Promise<SubtitleSearchResult[]> {
		const response = await this.fetchWithTimeout(url, {
			headers: {
				Cookie: this.cookies
			},
			timeout: 15000
		});

		const html = await response.text();
		const $ = cheerio.load(html);
		const results: SubtitleSearchResult[] = [];

		// Check for rate limiting
		if (html.includes('limite de downloads')) {
			throw new DownloadLimitExceeded('legendasdivx');
		}

		// Parse subtitle rows
		$('div.sub_box').each((_, box) => {
			const $box = $(box);

			// Get link
			const linkEl = $box.find('a[href*="lid="]');
			const link = linkEl.attr('href') || '';

			// Get description
			const description = $box.find('.sub_titulo').text().trim();

			// Get uploader
			const _uploader = $box.find('a[href*="userdetails"]').text().trim();

			// Get downloads/hits
			const hitsMatch = $box.text().match(/(\d+)\s*downloads?/i);
			const hits = hitsMatch ? parseInt(hitsMatch[1], 10) : 0;

			// Get FPS
			const fpsMatch = $box.text().match(/(\d+\.?\d*)\s*fps/i);
			const frameRate = fpsMatch ? fpsMatch[1] : undefined;

			// Check FPS match
			if (this.skipWrongFps && frameRate && criteria.fps) {
				const subFps = parseFloat(frameRate);
				const videoFps = criteria.fps;
				if (Math.abs(subFps - videoFps) > 0.01) {
					logger.debug(`[Legendasdivx] Skipping due to FPS mismatch: ${subFps} vs ${videoFps}`);
					return;
				}
			}

			// Extract ID from link
			const lidMatch = link.match(/lid=(\d+)/);
			const id = lidMatch ? lidMatch[1] : link;

			const subtitle = new GenericSubtitle('legendasdivx', id, language, {
				releaseInfo: description,
				downloadCount: hits,
				format: 'srt'
			});

			// Store link for download
			(subtitle as unknown as { _pageLink: string })._pageLink = link;

			results.push(subtitle.toSearchResult());
		});

		return results;
	}

	/**
	 * Download a subtitle
	 */
	async download(result: SubtitleSearchResult): Promise<Buffer> {
		await this.login();

		// Get download page
		const pageLink =
			(result as unknown as { _pageLink?: string })._pageLink ||
			`${SEARCH_URL}?name=Downloads&d_op=getit&lid=${result.providerSubtitleId}`;

		const response = await this.fetchWithTimeout(pageLink, {
			headers: {
				Cookie: this.cookies
			},
			timeout: 30000
		});

		const content = Buffer.from(await response.arrayBuffer());

		// Check if it's a ZIP
		if (content[0] === 0x50 && content[1] === 0x4b) {
			const extracted = extractFromZip(content);
			if (extracted) {
				return extracted.content;
			}
		}

		return content;
	}

	/**
	 * Test provider connectivity
	 */
	async test(): Promise<ProviderTestResult> {
		const startTime = Date.now();

		try {
			await this.login();

			return {
				success: true,
				message: 'Connected to Legendasdivx',
				responseTime: Date.now() - startTime
			};
		} catch (error) {
			return {
				success: false,
				message: error instanceof Error ? error.message : 'Connection failed',
				responseTime: Date.now() - startTime
			};
		}
	}
}

/**
 * Napiprojekt Provider Implementation
 *
 * Polish subtitle provider with hash-based matching.
 * Based on Bazarr's subliminal_patch/providers/napiprojekt.py
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
import {
	NAPIPROJEKT_LANGUAGES,
	calculateSubHash,
	MACHINE_TRANSLATOR_KEYWORDS,
	type NapiprojektConfig
} from './types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import * as cheerio from 'cheerio';

/** API endpoints */
const API_URL = 'https://napiprojekt.pl/api/api-napiprojekt3.php';
const SEARCH_URL = 'https://www.napiprojekt.pl/ajax/search_catalog.php';
const SCRAPE_URL = 'https://www.napiprojekt.pl/napisy1,7,0-dla-';

/**
 * Napiprojekt Provider
 *
 * Polish-only subtitle provider with hash matching and web scraping fallback.
 */
export class NapiprojektProvider extends BaseSubtitleProvider implements ISubtitleProvider {
	private readonly onlyAuthors: boolean;
	private readonly onlyRealNames: boolean;

	constructor(config: SubtitleProviderConfig) {
		super(config);

		const settings = config.settings as NapiprojektConfig | undefined;
		this.onlyAuthors = settings?.onlyAuthors ?? false;
		this.onlyRealNames = settings?.onlyRealNames ?? false;

		this._capabilities = {
			hashVerifiable: true,
			hearingImpairedVerifiable: false,
			skipWrongFps: false,
			supportsTvShows: true,
			supportsMovies: true,
			supportsAnime: false
		};
	}

	get implementation(): string {
		return 'napiprojekt';
	}

	get supportedLanguages(): LanguageCode[] {
		return NAPIPROJEKT_LANGUAGES;
	}

	get supportsHashSearch(): boolean {
		return true;
	}

	/**
	 * Search for subtitles
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		_options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		const results: SubtitleSearchResult[] = [];

		// Only Polish is supported
		const languages = criteria.languages.filter((l) => l === 'pl');
		if (languages.length === 0) {
			return [];
		}

		const language = new Language('pl');

		// Hash-based search (most accurate)
		if (criteria.videoHash && !this.onlyAuthors && !this.onlyRealNames) {
			const hashResult = await this.queryByHash(criteria.videoHash, language);
			if (hashResult) {
				results.push(hashResult);
			}
		}

		// Scrape-based search (fallback)
		try {
			const scraped = await this.scrapeSubtitles(criteria, language);
			results.push(...scraped);
		} catch (error) {
			logger.debug(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'[Napiprojekt] Scrape failed'
			);
		}

		this.logSearch(criteria, results.length);
		this.recordSuccess();

		return results;
	}

	/**
	 * Query subtitle by hash
	 */
	private async queryByHash(
		hash: string,
		language: Language
	): Promise<SubtitleSearchResult | null> {
		const subHash = calculateSubHash(hash);

		const params = new URLSearchParams({
			v: 'dreambox',
			kolejka: 'false',
			nick: '',
			pass: '',
			napios: 'Linux',
			l: 'PL',
			f: hash,
			t: subHash
		});

		const response = await this.fetchWithTimeout(`${API_URL}?${params.toString()}`, {
			timeout: 10000
		});

		const content = Buffer.from(await response.arrayBuffer());

		// Check for "not found" response
		if (content.subarray(0, 4).toString() === 'NPc0') {
			logger.debug('[Napiprojekt] No subtitles found for hash');
			return null;
		}

		// Create subtitle
		const subtitle = new GenericSubtitle('napiprojekt', hash, language, {
			releaseInfo: hash,
			format: 'srt'
		});

		subtitle.isHashMatch = true;
		subtitle.hashVerifiable = true;

		// Store content for download
		(subtitle as unknown as { _content: Buffer })._content = content;

		return subtitle.toSearchResult();
	}

	/**
	 * Scrape subtitles from web
	 */
	private async scrapeSubtitles(
		criteria: SubtitleSearchCriteria,
		language: Language
	): Promise<SubtitleSearchResult[]> {
		const results: SubtitleSearchResult[] = [];

		// Find title on Napiprojekt
		const titleInfo = await this.findTitle(criteria);
		if (!titleInfo) {
			return [];
		}

		// Build URL
		const isEpisode = criteria.season !== undefined;
		let url = `${SCRAPE_URL}${titleInfo.slug}`;
		if (isEpisode && criteria.season !== undefined && criteria.episode !== undefined) {
			const episode = `-s${String(criteria.season).padStart(2, '0')}e${String(criteria.episode).padStart(2, '0')}`;
			url += episode;
		}

		const response = await this.fetchWithTimeout(url, { timeout: 10000 });
		const html = await response.text();
		const $ = cheerio.load(html);

		// Find subtitle rows
		$('tr[title]').each((_, row) => {
			const $row = $(row);
			const title = $row.attr('title') || '';

			$row.find('a.tableA').each((_, link) => {
				const href = $(link).attr('href') || '';
				if (!href.startsWith('napiprojekt:')) return;

				const hash = href.substring('napiprojekt:'.length);

				// Extract metadata from row
				const data = $row.find('p');
				const size = data.eq(1).text() || '';
				const length = data.eq(3).text() || '';
				let author = data.eq(4).text() || '';
				const added = data.eq(5).text() || '';

				// Fallback author extraction from title
				if (!author) {
					const authorMatch = title.match(/<b>Autor:<\/b>\s*([^(]+)\(/);
					if (authorMatch) {
						author = authorMatch[1].trim();
					}
				}

				// Filter by author settings
				if (this.onlyAuthors) {
					if (MACHINE_TRANSLATOR_KEYWORDS.includes(author.toLowerCase())) {
						return; // Skip machine translations
					}
				}

				if (this.onlyRealNames) {
					// Check for real name pattern (2+ uppercase letters and at least one lowercase)
					const hasRealName =
						/^(?=(?:.*[A-Z]){2})(?=.*[a-z]).*$/.test(author) || /^\w+\s\w+$/.test(author);
					if (!hasRealName) {
						return;
					}
				}

				// Extract resolution and FPS from title
				const resMatch = title.match(/<b>Video rozdzielczość:<\/b>\s*([^<]+)</);
				const resolution = resMatch ? resMatch[1].trim() : '';

				const fpsMatch = title.match(/<b>Video FPS:<\/b>\s*([^<]+)</);
				const fps = fpsMatch ? fpsMatch[1].trim() : '';

				// Build release info
				const releaseInfo = [author && `Autor: ${author}`, resolution, fps, size, added, length]
					.filter(Boolean)
					.join(' | ');

				const subtitle = new GenericSubtitle('napiprojekt', hash, language, {
					releaseInfo,
					format: 'srt'
				});

				if (isEpisode) {
					subtitle.season = criteria.season;
					subtitle.episode = criteria.episode;
				}

				results.push(subtitle.toSearchResult());
			});
		});

		return results;
	}

	/**
	 * Find title on Napiprojekt
	 */
	private async findTitle(
		criteria: SubtitleSearchCriteria
	): Promise<{ slug: string; matches: Set<string> } | null> {
		const isEpisode = criteria.season !== undefined;
		const searchTitle = criteria.seriesTitle ?? criteria.title;

		const response = await this.fetchWithTimeout(SEARCH_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				queryString: searchTitle,
				queryKind: isEpisode ? '1' : '2',
				queryYear: criteria.year?.toString() ?? '',
				associate: ''
			}).toString(),
			timeout: 10000
		});

		const html = await response.text();
		const $ = cheerio.load(html);

		// Try to match by IMDB ID first
		const imdbId = criteria.imdbId;
		if (imdbId) {
			const imdbLink = $(`a[href*="imdb.com/title/${imdbId}"]`);
			if (imdbLink.length > 0) {
				const container = imdbLink.closest('.greyBoxCatcher');
				const titleLink = container.find('a.movieTitleCat');
				if (titleLink.length > 0) {
					const href = titleLink.attr('href') || '';
					if (href.startsWith('napisy-')) {
						return {
							slug: href.substring('napisy-'.length),
							matches: new Set(
								isEpisode ? ['series', 'year', 'series_imdb_id'] : ['title', 'year', 'imdb_id']
							)
						};
					}
				}
			}
		}

		// Fallback to title matching
		const titleLink = $('a.movieTitleCat').first();
		if (titleLink.length > 0) {
			const href = titleLink.attr('href') || '';
			if (href.startsWith('napisy-')) {
				return {
					slug: href.substring('napisy-'.length),
					matches: new Set(isEpisode ? ['series'] : ['title'])
				};
			}
		}

		return null;
	}

	/**
	 * Download a subtitle
	 */
	async download(result: SubtitleSearchResult): Promise<Buffer> {
		// If content was cached during search
		const cachedContent = (result as unknown as { _content?: Buffer })._content;
		if (cachedContent) {
			return cachedContent;
		}

		// Otherwise, fetch by hash
		const hash = result.providerSubtitleId;
		const subHash = calculateSubHash(hash);

		const params = new URLSearchParams({
			v: 'dreambox',
			kolejka: 'false',
			nick: '',
			pass: '',
			napios: 'Linux',
			l: 'PL',
			f: hash,
			t: subHash
		});

		const response = await this.fetchWithTimeout(`${API_URL}?${params.toString()}`, {
			timeout: 10000
		});

		const content = Buffer.from(await response.arrayBuffer());

		if (content.subarray(0, 4).toString() === 'NPc0') {
			throw new Error('Subtitle not found');
		}

		return content;
	}

	/**
	 * Test provider connectivity
	 */
	async test(): Promise<ProviderTestResult> {
		const startTime = Date.now();

		try {
			// Test with a known movie hash
			const response = await this.fetchWithTimeout(`${SEARCH_URL}?queryString=test&queryKind=2`, {
				method: 'POST',
				timeout: 5000
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			return {
				success: true,
				message: 'Connected to Napiprojekt',
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

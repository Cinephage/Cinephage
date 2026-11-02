/**
 * Gestdown Provider Implementation
 *
 * Gestdown is a TV subtitle database (Addic7ed proxy).
 * Features: JSON API, TV shows only, good European language coverage.
 * API v4: https://api.gestdown.info
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
import { TooManyRequests, ServiceUnavailable } from '../../errors/ProviderErrors';
import {
	GESTDOWN_LANGUAGES,
	GESTDOWN_LANGUAGE_REVERSE,
	type GestdownShowResponse,
	type GestdownSeasonResponse,
	type GestdownSubtitle,
	type GestdownShow
} from './types';

const API_BASE_URL = 'https://api.gestdown.info';

export class GestdownProvider extends BaseSubtitleProvider {
	// Parses hearingImpaired per search result.
	protected override _capabilities: ProviderCapabilities = {
		...DEFAULT_CAPABILITIES,
		hearingImpairedVerifiable: true
	};
	get implementation(): string {
		return 'gestdown';
	}

	get supportedLanguages(): LanguageCode[] {
		return Object.keys(GESTDOWN_LANGUAGES);
	}

	get supportsHashSearch(): boolean {
		return false;
	}

	/**
	 * Gestdown only supports TV shows - check criteria
	 */
	canSearch(criteria: SubtitleSearchCriteria): boolean {
		if (criteria.season === undefined) {
			return false;
		}
		return super.canSearch(criteria);
	}

	/**
	 * Search for subtitles on Gestdown
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		if (criteria.season === undefined) {
			return [];
		}

		try {
			const results: SubtitleSearchResult[] = [];

			const show = await this.findShow(criteria, options?.timeout);
			if (!show) {
				logger.debug(
					{
						title: criteria.seriesTitle || criteria.title
					},
					'[Gestdown] Show not found'
				);
				return results;
			}

			const requestedLangs = criteria.languages.filter((lang) => GESTDOWN_LANGUAGES[lang]);

			for (const langCode of requestedLangs) {
				const gestdownLang = GESTDOWN_LANGUAGES[langCode];
				if (!gestdownLang) continue;

				try {
					const seasonData = await this.fetchSeason(
						show.id,
						criteria.season,
						gestdownLang,
						options?.timeout
					);

					if (!seasonData.episodes) continue;

					for (const episode of seasonData.episodes) {
						if (criteria.episode !== undefined && episode.number !== criteria.episode) {
							continue;
						}

						for (const sub of episode.subtitles) {
							if (!sub.completed) continue;

							const isoLang =
								GESTDOWN_LANGUAGE_REVERSE[sub.language.toLowerCase()] ||
								this.normalizeLanguage(sub.language);

							const episodeLabel = criteria.episode
								? `S${criteria.season.toString().padStart(2, '0')}E${criteria.episode.toString().padStart(2, '0')}`
								: `Season ${criteria.season}`;

							results.push({
								providerId: this.id,
								providerName: this.name,
								providerSubtitleId: sub.downloadUri,

								language: isoLang,
								title: `${criteria.seriesTitle || criteria.title} ${episodeLabel}`,
								releaseName: sub.version || sub.release || undefined,

								isForced: false,
								isHearingImpaired: sub.hearingImpaired || false,
								format: 'srt',

								isHashMatch: false,
								matchScore: this.calculateScore(sub),
								scoreBreakdown: {
									hashMatch: 0,
									titleMatch: 50,
									yearMatch: 0,
									releaseGroupMatch: sub.version ? 15 : 0,
									sourceMatch: sub.hd ? 10 : 0,
									codecMatch: 0,
									hiPenalty: 0,
									forcedBonus: 0
								},

								downloadCount: sub.downloadCount,
								uploader: sub.source
							});
						}
					}
				} catch (error) {
					logger.warn(
						{
							langCode,
							error: error instanceof Error ? error.message : 'Unknown error'
						},
						'[Gestdown] Failed to fetch language season'
					);
				}
			}

			results.sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));

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
			const downloadUrl = result.providerSubtitleId.startsWith('http')
				? result.providerSubtitleId
				: `${API_BASE_URL}${result.providerSubtitleId}`;

			const response = await this.fetchWithTimeout(downloadUrl, {
				timeout: 30000,
				headers: {
					'User-Agent': 'Cinephage/1.0',
					Accept: '*/*'
				}
			});

			if (!response.ok) {
				this.handleErrorResponse(response);
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
			const response = await this.fetchWithTimeout(`${API_BASE_URL}/shows/search/test`, {
				timeout: 10000,
				headers: {
					Accept: 'application/json',
					'User-Agent': 'Cinephage/1.0'
				}
			});

			if (!response.ok && response.status !== 404) {
				throw new Error(`API returned ${response.status}`);
			}

			const responseTime = Date.now() - startTime;
			logger.info('[Gestdown] Provider test successful');
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
	 * Find a show by title
	 */
	private async findShow(
		criteria: SubtitleSearchCriteria,
		timeout?: number
	): Promise<GestdownShow | null> {
		const showTitle = criteria.seriesTitle || criteria.title;

		const searchUrl = `${API_BASE_URL}/shows/search/${encodeURIComponent(showTitle)}`;
		const response = await this.fetchWithTimeout(searchUrl, {
			timeout: timeout || 15000,
			headers: {
				Accept: 'application/json',
				'User-Agent': 'Cinephage/1.0'
			}
		});

		if (!response.ok) {
			if (response.status === 404) {
				return null;
			}
			this.handleErrorResponse(response);
		}

		const data: GestdownShowResponse = await response.json();
		const shows = data.shows || [];

		if (shows.length === 0) {
			return null;
		}

		const bestMatch = shows[0];

		logger.debug(
			{
				searchTitle: showTitle,
				matchedShow: bestMatch.name,
				showId: bestMatch.id
			},
			'[Gestdown] Found show'
		);

		return bestMatch;
	}

	/**
	 * Fetch all subtitles for a season/language using v4 API
	 * GET /shows/{showId}/{seasonNumber}/{language}
	 */
	private async fetchSeason(
		showId: string,
		season: number,
		gestdownLanguage: string,
		timeout?: number
	): Promise<GestdownSeasonResponse> {
		const searchUrl = `${API_BASE_URL}/shows/${showId}/${season}/${gestdownLanguage}`;

		const response = await this.fetchWithTimeout(searchUrl, {
			timeout: timeout || 15000,
			headers: {
				Accept: 'application/json',
				'User-Agent': 'Cinephage/1.0'
			}
		});

		if (!response.ok) {
			if (response.status === 404) {
				return { episodes: [], seasonPacks: [] };
			}
			this.handleErrorResponse(response);
		}

		return (await response.json()) as GestdownSeasonResponse;
	}

	/**
	 * Handle HTTP error responses with typed exceptions
	 */
	private handleErrorResponse(response: Response): never {
		switch (response.status) {
			case 429: {
				const retryAfter = response.headers.get('retry-after');
				throw new TooManyRequests('gestdown', retryAfter ? parseInt(retryAfter) : undefined);
			}
			case 500:
			case 502:
			case 503:
			case 504:
				throw new ServiceUnavailable('gestdown');
			default:
				throw new Error(`API request failed: ${response.status}`);
		}
	}

	/**
	 * Calculate match score
	 */
	private calculateScore(sub: GestdownSubtitle): number {
		let score = 50;

		if (sub.completed) {
			score += 20;
		}

		if (sub.hd) {
			score += 10;
		}

		if (sub.downloadCount) {
			score += Math.min(sub.downloadCount / 100, 15);
		}

		return Math.round(score);
	}
}

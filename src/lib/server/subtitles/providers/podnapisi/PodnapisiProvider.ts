/**
 * Podnapisi.net Provider Implementation
 *
 * Podnapisi is a Slovenian subtitle database with good European language coverage.
 * Uses their public API for searching and downloading subtitles.
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

const API_BASE_URL = 'https://www.podnapisi.net/subtitles/search/old';
const DOWNLOAD_BASE_URL = 'https://www.podnapisi.net/subtitles';

/** Podnapisi supported languages with their codes */
const PODNAPISI_LANGUAGES: Record<string, string> = {
	en: '2', // English
	sl: '1', // Slovenian
	hr: '8', // Croatian
	sr: '10', // Serbian
	bs: '11', // Bosnian
	mk: '35', // Macedonian
	bg: '33', // Bulgarian
	cs: '7', // Czech
	sk: '37', // Slovak
	pl: '15', // Polish
	hu: '17', // Hungarian
	ro: '13', // Romanian
	de: '5', // German
	es: '4', // Spanish
	fr: '3', // French
	it: '6', // Italian
	pt: '9', // Portuguese
	nl: '14', // Dutch
	ru: '12', // Russian
	el: '16', // Greek
	tr: '18', // Turkish
	ar: '19', // Arabic
	he: '22', // Hebrew
	vi: '45', // Vietnamese
	zh: '21', // Chinese
	ja: '38', // Japanese
	ko: '42', // Korean
	sv: '20', // Swedish
	no: '23', // Norwegian
	da: '24', // Danish
	fi: '25', // Finnish
	uk: '46', // Ukrainian
	fa: '52', // Persian
	id: '47', // Indonesian
	th: '44', // Thai
	et: '34', // Estonian
	lv: '36', // Latvian
	lt: '39' // Lithuanian
};

interface PodnapisiSearchResult {
	id: string;
	title: string;
	year?: string;
	releases?: string;
	language: string;
	downloads: string;
	rating?: string;
	flags?: string[];
	hearing_impaired?: boolean;
}

export class PodnapisiProvider extends BaseSubtitleProvider {
	// Parses hearing_impaired from the search response.
	protected override _capabilities: ProviderCapabilities = {
		...DEFAULT_CAPABILITIES,
		hearingImpairedVerifiable: true
	};
	get implementation(): string {
		return 'podnapisi';
	}

	get supportedLanguages(): LanguageCode[] {
		return Object.keys(PODNAPISI_LANGUAGES);
	}

	get supportsHashSearch(): boolean {
		return false; // Podnapisi uses hash but we'll use title search
	}

	/**
	 * Search for subtitles on Podnapisi
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		try {
			const results: SubtitleSearchResult[] = [];

			// Search for each requested language
			for (const lang of criteria.languages) {
				const langCode = PODNAPISI_LANGUAGES[lang];
				if (!langCode) continue;

				// Build search URL
				const searchParams = new URLSearchParams();

				// Add title search
				const searchTitle = criteria.seriesTitle || criteria.title;
				searchParams.append('keywords', searchTitle);

				// Add year if available
				if (criteria.year) {
					searchParams.append('year', criteria.year.toString());
				}

				// Add language
				searchParams.append('language', langCode);

				// Add TV episode info
				if (criteria.season !== undefined) {
					searchParams.append('seasons', criteria.season.toString());
				}
				if (criteria.episode !== undefined) {
					searchParams.append('episodes', criteria.episode.toString());
				}

				// Make request
				const url = `${API_BASE_URL}?${searchParams.toString()}`;
				const response = await this.fetchWithTimeout(url, {
					timeout: options?.timeout || 15000,
					headers: {
						Accept: 'application/json',
						'User-Agent': 'Cinephage/1.0'
					}
				});

				if (!response.ok) {
					logger.warn(
						{
							status: response.status,
							language: lang
						},
						'[Podnapisi] Search request failed'
					);
					// Throw typed errors for specific status codes
					if (response.status === 429) {
						const retryAfter = response.headers.get('retry-after');
						throw new TooManyRequests('podnapisi', retryAfter ? parseInt(retryAfter) : undefined);
					}
					if (response.status >= 500) {
						throw new ServiceUnavailable('podnapisi');
					}
					continue;
				}

				// Parse response
				const data = await response.json();
				const items: PodnapisiSearchResult[] = data.data || data.subtitles || [];

				// Transform results
				for (const item of items) {
					results.push(this.transformResult(item, lang));
				}
			}

			// Sort by download count
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
			const subtitleId = result.providerSubtitleId;
			const downloadUrl = `${DOWNLOAD_BASE_URL}/${subtitleId}/download`;

			const response = await this.fetchWithTimeout(downloadUrl, {
				timeout: 30000,
				headers: {
					'User-Agent': 'Cinephage/1.0'
				}
			});

			if (!response.ok) {
				if (response.status === 429) {
					const retryAfter = response.headers.get('retry-after');
					throw new TooManyRequests('podnapisi', retryAfter ? parseInt(retryAfter) : undefined);
				}
				if (response.status >= 500) {
					throw new ServiceUnavailable('podnapisi');
				}
				throw new Error(`Download failed: ${response.status} ${response.statusText}`);
			}

			// Check if response is a zip file (Podnapisi often returns zipped subtitles)
			const contentType = response.headers.get('content-type') || '';
			const buffer = Buffer.from(await response.arrayBuffer());

			// If it's a zip, we'd need to extract it - for now return as-is
			// The download service will handle extraction
			if (contentType.includes('zip') || buffer.slice(0, 2).toString() === 'PK') {
				logger.debug(
					{
						subtitleId,
						size: buffer.length
					},
					'[Podnapisi] Downloaded zipped subtitle'
				);
			}

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
		try {
			const searchParams = new URLSearchParams({
				keywords: 'test',
				language: '2' // English
			});

			const response = await this.fetchWithTimeout(`${API_BASE_URL}?${searchParams.toString()}`, {
				timeout: 10000,
				headers: {
					Accept: 'application/json',
					'User-Agent': 'Cinephage/1.0'
				}
			});

			if (!response.ok) {
				throw new Error(`API returned ${response.status}`);
			}

			const responseTime = Date.now() - startTime;
			logger.info('[Podnapisi] Provider test successful');
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
	 * Transform API result to our format
	 */
	private transformResult(
		item: PodnapisiSearchResult,
		language: LanguageCode
	): SubtitleSearchResult {
		const downloads = parseInt(item.downloads || '0', 10);

		return {
			providerId: this.id,
			providerName: this.name,
			providerSubtitleId: item.id,

			language,
			title: item.title,
			releaseName: item.releases,

			isForced: (item.flags || []).includes('foreign_only'),
			isHearingImpaired: item.hearing_impaired || (item.flags || []).includes('hearing_impaired'),
			format: 'srt', // Podnapisi primarily has SRT

			isHashMatch: false,
			matchScore: this.calculateScore(item),
			scoreBreakdown: {
				hashMatch: 0,
				titleMatch: 50,
				yearMatch: item.year ? 20 : 0,
				releaseGroupMatch: item.releases ? 15 : 0,
				sourceMatch: 0,
				codecMatch: 0,
				hiPenalty: 0,
				forcedBonus: 0
			},

			downloadCount: downloads,
			rating: item.rating ? parseFloat(item.rating) : undefined
		};
	}

	/**
	 * Calculate match score
	 */
	private calculateScore(item: PodnapisiSearchResult): number {
		let score = 50; // Base score for title match

		// Year match bonus
		if (item.year) {
			score += 20;
		}

		// Release info bonus
		if (item.releases) {
			score += 15;
		}

		// Popularity bonus (capped)
		const downloads = parseInt(item.downloads || '0', 10);
		score += Math.min(downloads / 100, 10);

		// Rating bonus
		if (item.rating) {
			const rating = parseFloat(item.rating);
			score += Math.min(rating * 2, 10);
		}

		return Math.round(score);
	}
}

/**
 * Betaseries Provider Implementation
 *
 * French subtitle provider for TV shows.
 * Based on Bazarr's subliminal_patch/providers/betaseries.py
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
	BETASERIES_LANGUAGES,
	BETASERIES_API_URL,
	type BetaseriesConfig,
	type BetaseriesResponse,
	type BetaseriesSubtitle
} from './types';
import { extractFromZip } from '../mixins';
import { AuthenticationError, ConfigurationError } from '../../errors/ProviderErrors';
import { languageSatisfies } from '../../requirement-matcher';
import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';

/**
 * Map a Betaseries language marker to a canonical tag.
 *
 * Betaseries labels subtitles VF (French version) or VO (original version).
 * VO is not a language: its tag is the media's original language, which the
 * search criteria carry when known. English is the fallback when the original
 * language is unknown (Betaseries' dominant VO language). Markers the
 * registry cannot resolve keep the previous behavior of being skipped.
 */
export function mapBetaseriesLanguage(raw: string, originalLanguage?: string): LanguageCode | null {
	const normalized = normalizeLanguageTag(raw);
	if (raw === 'VF' || normalized === 'fr') return 'fr';
	if (raw === 'VO') return originalLanguage ?? 'en';
	if (normalized === 'en') return 'en';
	return null;
}

/**
 * Betaseries Provider
 *
 * French subtitle provider with TVDB matching (TV shows only).
 */
export class BetaseriesProvider extends BaseSubtitleProvider implements ISubtitleProvider {
	private readonly token: string;

	constructor(config: SubtitleProviderConfig) {
		super(config);

		const settings = config.settings as BetaseriesConfig | undefined;
		this.token = settings?.token ?? '';

		if (!this.token) {
			throw new ConfigurationError('betaseries', 'API token is required');
		}

		this._capabilities = {
			hashVerifiable: false,
			hearingImpairedVerifiable: false,
			skipWrongFps: false,
			supportsTvShows: true,
			supportsMovies: false, // TV shows only
			supportsAnime: false
		};
	}

	get implementation(): string {
		return 'betaseries';
	}

	get supportedLanguages(): LanguageCode[] {
		return BETASERIES_LANGUAGES;
	}

	get supportsHashSearch(): boolean {
		return false;
	}

	/**
	 * Search for subtitles
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		_options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		// TV shows only
		if (criteria.season === undefined || criteria.episode === undefined) {
			return [];
		}

		// Filter to supported languages
		const languages = criteria.languages.filter((l) => BETASERIES_LANGUAGES.includes(l));
		if (languages.length === 0) {
			return [];
		}

		const results: SubtitleSearchResult[] = [];
		const matches = new Set<string>();

		// Try TVDB ID first
		if (criteria.tvdbId) {
			const tvdbResults = await this.queryByTvdb(criteria, languages, matches);
			results.push(...tvdbResults);
		}

		// Fallback to text search
		if (results.length === 0 && criteria.seriesTitle) {
			const textResults = await this.queryByTitle(criteria, languages, matches);
			results.push(...textResults);
		}

		this.logSearch(criteria, results.length);
		this.recordSuccess();

		return results;
	}

	/**
	 * Query by TVDB ID
	 */
	private async queryByTvdb(
		criteria: SubtitleSearchCriteria,
		languages: LanguageCode[],
		matches: Set<string>
	): Promise<SubtitleSearchResult[]> {
		const params = new URLSearchParams({
			key: this.token,
			thetvdb_id: criteria.tvdbId!.toString(),
			v: '3.0',
			subtitles: '1'
		});

		// Add season/episode for specific episode
		if (criteria.season !== undefined) {
			params.set('season', criteria.season.toString());
			params.set('episode', (criteria.episode ?? 1).toString());
		}

		const response = await this.fetchWithTimeout(
			`${BETASERIES_API_URL}episodes/display?${params.toString()}`,
			{ timeout: 10000 }
		);

		const data: BetaseriesResponse = await response.json();

		// Check for errors
		if (data.errors && data.errors.length > 0) {
			const error = data.errors[0];
			if (error.code === 1001) {
				throw new AuthenticationError('betaseries', 'Invalid API token');
			}
			if (error.code === 4001) {
				// No series found
				return [];
			}
		}

		matches.add('tvdb_id');

		return this.parseSubtitles(data.episode?.subtitles ?? [], criteria, languages, matches);
	}

	/**
	 * Query by title
	 */
	private async queryByTitle(
		criteria: SubtitleSearchCriteria,
		languages: LanguageCode[],
		matches: Set<string>
	): Promise<SubtitleSearchResult[]> {
		// Search for the show first
		const showParams = new URLSearchParams({
			key: this.token,
			title: criteria.seriesTitle ?? criteria.title,
			v: '3.0'
		});

		const showResponse = await this.fetchWithTimeout(
			`${BETASERIES_API_URL}shows/search?${showParams.toString()}`,
			{ timeout: 10000 }
		);

		const showData = await showResponse.json();

		if (!showData.shows || showData.shows.length === 0) {
			return [];
		}

		// Get the first matching show
		const showId = showData.shows[0].id;
		matches.add('series');

		// Get episode subtitles
		const episodeParams = new URLSearchParams({
			key: this.token,
			id: showId.toString(),
			season: (criteria.season ?? 1).toString(),
			episode: (criteria.episode ?? 1).toString(),
			v: '3.0',
			subtitles: '1'
		});

		const episodeResponse = await this.fetchWithTimeout(
			`${BETASERIES_API_URL}episodes/display?${episodeParams.toString()}`,
			{ timeout: 10000 }
		);

		const episodeData: BetaseriesResponse = await episodeResponse.json();

		return this.parseSubtitles(episodeData.episode?.subtitles ?? [], criteria, languages, matches);
	}

	/**
	 * Parse subtitles from API response
	 */
	private parseSubtitles(
		subtitles: BetaseriesSubtitle[],
		criteria: SubtitleSearchCriteria,
		languages: LanguageCode[],
		_matches: Set<string>
	): SubtitleSearchResult[] {
		const results: SubtitleSearchResult[] = [];

		for (const sub of subtitles) {
			const langCode = mapBetaseriesLanguage(sub.language, criteria.originalLanguage);
			if (!langCode) continue;

			if (!languages.some((requested) => languageSatisfies(langCode, requested))) {
				continue;
			}

			const language = new Language(langCode);

			const subtitle = new GenericSubtitle('betaseries', sub.id.toString(), language, {
				releaseInfo: sub.file,
				pageLink: sub.url,
				downloadUrl: sub.url,
				format: 'srt'
			});

			subtitle.season = criteria.season;
			subtitle.episode = criteria.episode;

			results.push(subtitle.toSearchResult());
		}

		return results;
	}

	/**
	 * Download a subtitle
	 */
	async download(result: SubtitleSearchResult): Promise<Buffer> {
		// Prefer the explicit download URL carried on the search result, then
		// the page link.
		const downloadUrl = result.downloadUrl ?? result.pageLink;

		if (!downloadUrl) {
			throw new Error('No download URL available');
		}

		const response = await this.fetchWithTimeout(downloadUrl, {
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
			const params = new URLSearchParams({
				key: this.token,
				v: '3.0'
			});

			const response = await this.fetchWithTimeout(
				`${BETASERIES_API_URL}members/infos?${params.toString()}`,
				{ timeout: 5000 }
			);

			const data = await response.json();

			if (data.errors && data.errors.length > 0) {
				throw new Error(data.errors[0].text || 'API error');
			}

			return {
				success: true,
				message: 'Connected to Betaseries',
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

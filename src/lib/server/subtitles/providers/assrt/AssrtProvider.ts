/**
 * Assrt Provider Implementation
 *
 * Chinese subtitle provider with API.
 * Based on Bazarr's subliminal_patch/providers/assrt.py
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
	ASSRT_LANGUAGES,
	ASSRT_API_URL,
	type AssrtConfig,
	type AssrtSearchResponse,
	type AssrtDetailResponse
} from './types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import { extractFromZip } from '../mixins';
import { languageSatisfies } from '../../requirement-matcher';
import { ConfigurationError } from '../../errors/ProviderErrors';
import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';

/**
 * Resolve an Assrt subtitle's language from its metadata list.
 *
 * Assrt reports ISO-639-3 style codes ('eng', 'cht', 'jpn', …), so they run
 * through the canonical registry. A subtitle carrying one of the requested
 * languages is labelled with it; otherwise the first recognized language
 * wins. Assrt is a Chinese provider, so an empty or unrecognized list
 * defaults to Chinese.
 */
export function mapAssrtLanguage(
	langlist: readonly string[],
	requested: readonly string[]
): LanguageCode {
	const candidates = langlist
		.map((lang) => normalizeLanguageTag(lang))
		.filter((tag) => tag !== 'und');
	return (
		candidates.find((tag) => requested.some((req) => languageSatisfies(tag, req))) ??
		candidates[0] ??
		'zh'
	);
}

/**
 * Assrt Provider
 *
 * Chinese subtitle provider. Request throttling is handled centrally by the
 * shared per-provider `RateLimiter` (driven by the stored
 * `requestsPerMinute`); no provider-local delay remains.
 */
export class AssrtProvider extends BaseSubtitleProvider implements ISubtitleProvider {
	private readonly token: string;

	constructor(config: SubtitleProviderConfig) {
		super(config);

		const settings = config.settings as AssrtConfig | undefined;
		this.token = settings?.token ?? '';

		if (!this.token) {
			throw new ConfigurationError('assrt', 'API token is required');
		}

		this._capabilities = {
			hashVerifiable: false,
			hearingImpairedVerifiable: false,
			skipWrongFps: false,
			supportsTvShows: true,
			supportsMovies: true,
			supportsAnime: true // Good for anime with Chinese subs
		};
	}

	get implementation(): string {
		return 'assrt';
	}

	get supportedLanguages(): LanguageCode[] {
		return ASSRT_LANGUAGES;
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
		// Filter to supported languages
		const languages = criteria.languages.filter((l) => ASSRT_LANGUAGES.includes(l));
		if (languages.length === 0) {
			return [];
		}

		// Build search query
		const isEpisode = criteria.season !== undefined;
		let query = criteria.seriesTitle ?? criteria.title;

		if (isEpisode && criteria.season !== undefined && criteria.episode !== undefined) {
			query += ` S${String(criteria.season).padStart(2, '0')}E${String(criteria.episode).padStart(2, '0')}`;
		} else if (criteria.year) {
			query += ` ${criteria.year}`;
		}

		const params = new URLSearchParams({
			token: this.token,
			q: query
		});

		const response = await this.fetchWithTimeout(
			`${ASSRT_API_URL}/sub/search?${params.toString()}`,
			{ timeout: 15000 }
		);

		const data: AssrtSearchResponse = await response.json();

		if (data.status !== 0 && data.errmsg) {
			logger.warn(`[Assrt] API error: ${data.errmsg}`);
			return [];
		}

		const results: SubtitleSearchResult[] = [];
		const subs = data.sub?.subs ?? [];

		for (const sub of subs) {
			// Skip meaningless video names
			if (sub.videoname === '不知道') continue;

			const langCode = mapAssrtLanguage(
				sub.lang?.langlist?.map((lang) => lang.lang) ?? [],
				languages
			);

			if (!languages.some((requested) => languageSatisfies(langCode, requested))) {
				continue;
			}

			const language = new Language(langCode);

			const subtitle = new GenericSubtitle('assrt', sub.id.toString(), language, {
				releaseInfo: sub.videoname,
				format: 'srt'
			});

			if (isEpisode) {
				subtitle.season = criteria.season;
				subtitle.episode = criteria.episode;
			}

			results.push(subtitle.toSearchResult());
		}

		this.logSearch(criteria, results.length);
		this.recordSuccess();

		return results;
	}

	/**
	 * Download a subtitle
	 */
	async download(result: SubtitleSearchResult): Promise<Buffer> {
		// Get subtitle details
		const params = new URLSearchParams({
			token: this.token,
			id: result.providerSubtitleId
		});

		const response = await this.fetchWithTimeout(
			`${ASSRT_API_URL}/sub/detail?${params.toString()}`,
			{ timeout: 15000 }
		);

		const data: AssrtDetailResponse = await response.json();

		const subs = data.sub?.subs ?? [];
		if (subs.length === 0 || !subs[0].filelist?.length) {
			throw new Error('No subtitle files found');
		}

		// Get first file with a URL
		const files = subs[0].filelist;
		const file = files.find((f) => f.url);

		if (!file?.url) {
			throw new Error('No download URL available');
		}

		const downloadResponse = await this.fetchWithTimeout(file.url, { timeout: 30000 });
		const content = Buffer.from(await downloadResponse.arrayBuffer());

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
				token: this.token,
				q: 'test'
			});

			const response = await this.fetchWithTimeout(
				`${ASSRT_API_URL}/sub/search?${params.toString()}`,
				{ timeout: 15000 }
			);

			const data: AssrtSearchResponse = await response.json();

			if (data.status !== 0 && data.errmsg) {
				throw new Error(data.errmsg);
			}

			return {
				success: true,
				message: 'Connected to Assrt',
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

/**
 * OpenSubtitles.org Provider (Legacy XML-RPC API)
 *
 * For VIP users only - the legacy API is deprecated for non-VIP.
 * Based on Bazarr's subliminal_patch/providers/opensubtitles.py
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
	type OrgSubtitleResult,
	type OrgSearchParams,
	type OrgDownloadDataItem,
	ORG_LANGUAGE_MAP,
	ORG_LANGUAGE_REVERSE,
	ORG_SUPPORTED_LANGUAGES
} from './types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import {
	AuthenticationError,
	DownloadLimitExceeded,
	TooManyRequests
} from '../../errors/ProviderErrors';

/** API endpoints */
const API_URL = 'https://api.opensubtitles.org/xml-rpc';
const VIP_API_URL = 'https://vip-api.opensubtitles.org/xml-rpc';

/** User agent (required by OpenSubtitles) */
const USER_AGENT = 'Cinephage v1';

/**
 * OpenSubtitles.org Provider (Legacy XML-RPC)
 *
 * Note: This API is deprecated for non-VIP users.
 * VIP users should enable the VIP setting for better performance.
 */
export class OpenSubtitlesOrgProvider extends BaseSubtitleProvider implements ISubtitleProvider {
	private token?: string;
	private tokenExpiry?: Date;
	private readonly isVip: boolean;
	private readonly useSsl: boolean;
	private readonly skipWrongFps: boolean;

	constructor(config: SubtitleProviderConfig) {
		super(config);

		// Parse provider-specific settings
		this.isVip = config.settings?.['vip'] === true;
		this.useSsl = config.settings?.['ssl'] !== false;
		this.skipWrongFps = config.settings?.['skipWrongFps'] !== false;

		// Set capabilities
		this._capabilities = {
			hashVerifiable: true,
			hearingImpairedVerifiable: true,
			skipWrongFps: this.skipWrongFps,
			supportsTvShows: true,
			supportsMovies: true,
			supportsAnime: false
		};
	}

	get implementation(): string {
		return 'opensubtitlesorg';
	}

	get supportedLanguages(): LanguageCode[] {
		return ORG_SUPPORTED_LANGUAGES;
	}

	get supportsHashSearch(): boolean {
		return true;
	}

	/**
	 * Get API URL based on VIP status
	 */
	private get apiUrl(): string {
		return this.isVip ? VIP_API_URL : API_URL;
	}

	/**
	 * Initialize provider (login)
	 */
	protected async onInitialize(): Promise<void> {
		await this.login();
	}

	/**
	 * Terminate provider (logout)
	 */
	protected async onTerminate(): Promise<void> {
		if (this.token) {
			try {
				await this.logout();
			} catch (error) {
				logger.debug({ error }, 'Logout failed');
			}
		}
	}

	/**
	 * Ping - check if token is still valid
	 */
	protected async onPing(): Promise<boolean> {
		if (!this.token) return false;
		if (this.tokenExpiry && new Date() > this.tokenExpiry) return false;
		return true;
	}

	/**
	 * Login to OpenSubtitles.org
	 */
	private async login(): Promise<void> {
		const username = this.config.username ?? '';
		const password = this.config.password ?? '';

		const response = await this.xmlRpcCall('LogIn', [username, password, 'en', USER_AGENT]);

		if (response.status !== '200 OK') {
			throw new AuthenticationError('opensubtitlesorg', `Login failed: ${response.status}`);
		}

		this.token = response.token;
		// Token expires in 15 minutes, refresh at 10 minutes
		this.tokenExpiry = new Date(Date.now() + 10 * 60 * 1000);

		logger.debug('[OpenSubtitles.org] Logged in successfully');
	}

	/**
	 * Logout from OpenSubtitles.org
	 */
	private async logout(): Promise<void> {
		if (!this.token) return;

		await this.xmlRpcCall('LogOut', [this.token]);
		this.token = undefined;
		this.tokenExpiry = undefined;
	}

	/**
	 * Ensure we have a valid token
	 */
	private async ensureToken(): Promise<string> {
		if (!this.token || (this.tokenExpiry && new Date() > this.tokenExpiry)) {
			await this.login();
		}
		return this.token!;
	}

	/**
	 * Search for subtitles
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]> {
		let token = await this.ensureToken();
		const maxResults = options?.maxResults ?? 50;

		// Convert languages to XML-RPC format
		const languages = criteria.languages
			.map((lang) => ORG_LANGUAGE_MAP[lang])
			.filter(Boolean)
			.join(',');

		if (!languages) {
			logger.debug('[OpenSubtitles.org] No supported languages in criteria');
			return [];
		}

		// Build search queries
		const queries: OrgSearchParams[] = [];

		// Hash search (most accurate)
		if (criteria.videoHash && criteria.fileSize) {
			queries.push({
				sublanguageid: languages,
				moviehash: criteria.videoHash,
				moviebytesize: criteria.fileSize
			});
		}

		// IMDB search
		if (criteria.imdbId) {
			const imdbNum = criteria.imdbId.replace('tt', '');
			const searchParams: OrgSearchParams = {
				sublanguageid: languages,
				imdbid: imdbNum
			};

			// Add season/episode for TV
			if (criteria.season !== undefined) {
				searchParams.season = criteria.season;
				searchParams.episode = criteria.episode;
			}

			queries.push(searchParams);
		}

		// Title search (fallback)
		if (criteria.title && queries.length === 0) {
			const searchParams: OrgSearchParams = {
				sublanguageid: languages,
				query: criteria.seriesTitle ?? criteria.title
			};

			if (criteria.season !== undefined) {
				searchParams.season = criteria.season;
				searchParams.episode = criteria.episode;
			}

			queries.push(searchParams);
		}

		if (queries.length === 0) {
			return [];
		}

		try {
			const response = await this.xmlRpcCall('SearchSubtitles', [
				token,
				queries,
				{ limit: maxResults }
			]);

			if (response.status === '401 Unauthorized') {
				// Token expired, retry with fresh login
				this.token = undefined;
				token = await this.ensureToken();
				const retryResponse = await this.xmlRpcCall('SearchSubtitles', [
					token,
					queries,
					{ limit: maxResults }
				]);
				return this.parseResults((retryResponse.data ?? []) as OrgSubtitleResult[], criteria);
			}

			if (response.status === '407 Download limit reached') {
				throw new DownloadLimitExceeded('opensubtitlesorg');
			}

			if (response.status === '429 Too many requests') {
				throw new TooManyRequests('opensubtitlesorg', 60000);
			}

			if (response.data && Array.isArray(response.data)) {
				return this.parseResults(response.data as OrgSubtitleResult[], criteria);
			}

			return [];
		} catch (error) {
			if (
				error instanceof AuthenticationError ||
				error instanceof DownloadLimitExceeded ||
				error instanceof TooManyRequests
			) {
				throw error;
			}
			this.logError('Search', error);
			throw error;
		}
	}

	/**
	 * Parse XML-RPC search results
	 */
	private parseResults(
		data: OrgSubtitleResult[],
		criteria: SubtitleSearchCriteria
	): SubtitleSearchResult[] {
		const results: SubtitleSearchResult[] = [];

		for (const item of data) {
			// Skip results without required fields
			if (!item.IDSubtitleFile || !item.SubLanguageID) {
				continue;
			}

			// Convert language
			const langCode = ORG_LANGUAGE_REVERSE[item.SubLanguageID] ?? item.SubLanguageID;

			// Determine if hash match
			const isHashMatch = item.MatchedBy === 'moviehash';

			// Determine if HI
			const isHi = item.SubHearingImpaired === '1';

			// Determine if forced
			const isForced = item.SubForeignPartsOnly === '1';

			// Create Language object
			const language = new Language(langCode, { hi: isHi, forced: isForced });

			// Create subtitle
			const subtitle = new GenericSubtitle('opensubtitlesorg', item.IDSubtitleFile, language, {
				filename: item.SubFileName,
				releaseInfo: item.MovieReleaseName,
				downloadCount: parseInt(item.SubDownloadsCnt, 10) || 0,
				rating: parseFloat(item.SubRating) || 0,
				pageLink: item.SubtitlesLink,
				format: this.detectFormat(item.SubFileName)
			});

			// Set provider-specific data
			subtitle.isHashMatch = isHashMatch;
			subtitle.hashVerifiable = true;
			subtitle.hearingImpairedVerifiable = true;

			// Store for matching
			if (item.IDMovieImdb) {
				subtitle.imdbId = `tt${item.IDMovieImdb.padStart(7, '0')}`;
			}
			if (item.SeriesSeason) {
				subtitle.season = parseInt(item.SeriesSeason, 10);
			}
			if (item.SeriesEpisode) {
				subtitle.episode = parseInt(item.SeriesEpisode, 10);
			}
			subtitle.movieTitle = item.MovieName;
			if (item.MovieYear) {
				subtitle.year = parseInt(item.MovieYear, 10);
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
		const token = await this.ensureToken();

		const response = await this.xmlRpcCall('DownloadSubtitles', [
			token,
			[result.providerSubtitleId]
		]);

		if (response.status === '407 Download limit reached') {
			throw new DownloadLimitExceeded('opensubtitlesorg');
		}

		if (response.status === '429 Too many requests') {
			throw new TooManyRequests('opensubtitlesorg', 60000);
		}

		if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
			throw new Error('No subtitle data in response');
		}

		// Response contains base64 + gzip encoded subtitle
		const downloadItem = response.data[0] as OrgDownloadDataItem;
		const subtitleData = downloadItem.data;
		const buffer = Buffer.from(subtitleData, 'base64');

		// Decompress gzip
		const { gunzipSync } = await import('zlib');
		const decompressed = gunzipSync(buffer);

		return decompressed;
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
				message: `Connected to OpenSubtitles.org${this.isVip ? ' (VIP)' : ''}`,
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

	/**
	 * Make XML-RPC call
	 *
	 * Note: This is a simplified implementation.
	 * In production, use a proper XML-RPC library.
	 */
	private async xmlRpcCall(
		method: string,
		params: unknown[]
	): Promise<{ status: string; token?: string; data?: unknown[] }> {
		// Build XML-RPC request
		const xml = this.buildXmlRpcRequest(method, params);

		const response = await this.fetchWithTimeout(this.apiUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/xml',
				'User-Agent': USER_AGENT
			},
			body: xml,
			timeout: 30000
		});

		const responseText = await response.text();
		return this.parseXmlRpcResponse(responseText);
	}

	/**
	 * Build XML-RPC request body
	 */
	private buildXmlRpcRequest(method: string, params: unknown[]): string {
		const paramXml = params.map((p) => `<param>${this.valueToXml(p)}</param>`).join('');

		return `<?xml version="1.0"?>
<methodCall>
  <methodName>${method}</methodName>
  <params>${paramXml}</params>
</methodCall>`;
	}

	/**
	 * Convert value to XML-RPC format
	 */
	private valueToXml(value: unknown): string {
		if (value === null || value === undefined) {
			return '<value><string></string></value>';
		}

		if (typeof value === 'string') {
			return `<value><string>${this.escapeXml(value)}</string></value>`;
		}

		if (typeof value === 'number') {
			if (Number.isInteger(value)) {
				return `<value><int>${value}</int></value>`;
			}
			return `<value><double>${value}</double></value>`;
		}

		if (typeof value === 'boolean') {
			return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
		}

		if (Array.isArray(value)) {
			const items = value.map((v) => this.valueToXml(v)).join('');
			return `<value><array><data>${items}</data></array></value>`;
		}

		if (typeof value === 'object') {
			const members = Object.entries(value as Record<string, unknown>)
				.filter(([_, v]) => v !== undefined)
				.map(([k, v]) => `<member><name>${k}</name>${this.valueToXml(v)}</member>`)
				.join('');
			return `<value><struct>${members}</struct></value>`;
		}

		return `<value><string>${String(value)}</string></value>`;
	}

	/**
	 * Escape XML special characters
	 */
	private escapeXml(str: string): string {
		return str
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
	}

	/**
	 * Parse XML-RPC response
	 */
	private parseXmlRpcResponse(xml: string): {
		status: string;
		token?: string;
		data?: OrgSubtitleResult[];
	} {
		// Simple regex-based parsing (in production, use proper XML parser)
		const statusMatch = xml.match(
			/<name>status<\/name>\s*<value><string>([^<]+)<\/string><\/value>/
		);
		const status = statusMatch?.[1] ?? 'Unknown';

		const tokenMatch = xml.match(/<name>token<\/name>\s*<value><string>([^<]+)<\/string><\/value>/);
		const token = tokenMatch?.[1];

		// Parse data array (if present)
		let data: OrgSubtitleResult[] | undefined;
		if (xml.includes('<name>data</name>')) {
			data = this.parseDataArray(xml);
		}

		return { status, token, data };
	}

	/**
	 * Parse data array from XML-RPC response
	 */
	private parseDataArray(xml: string): OrgSubtitleResult[] {
		const results: OrgSubtitleResult[] = [];

		// Find all struct elements in the data array
		const structRegex = /<struct>([\s\S]*?)<\/struct>/g;
		let match;

		while ((match = structRegex.exec(xml)) !== null) {
			const structXml = match[1];
			const result: Record<string, string> = {};

			// Parse each member
			const memberRegex = /<name>(\w+)<\/name>\s*<value>(?:<\w+>)?([^<]*)/g;
			let memberMatch;

			while ((memberMatch = memberRegex.exec(structXml)) !== null) {
				result[memberMatch[1]] = memberMatch[2];
			}

			if (result.IDSubtitleFile) {
				results.push(result as unknown as OrgSubtitleResult);
			}
		}

		return results;
	}
}

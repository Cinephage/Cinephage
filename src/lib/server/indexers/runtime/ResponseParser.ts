/**
 * Response parser for YAML indexer definitions.
 * Parses HTML, JSON, and XML responses into ReleaseResult objects.
 */

import type { CheerioAPI, Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import type {
	YamlDefinition as CardigannDefinition,
	FieldDefinition,
	SearchPathBlock
} from '../schema/yamlDefinition';
import { resolveCategoryId } from '../schema/yamlDefinition';
import type { ReleaseResult, Category, IndexerProtocol } from '../types';
import { parseSize } from '../types';
import { TemplateEngine } from '../engine/TemplateEngine';
import { FilterEngine } from '../engine/FilterEngine';
import { SelectorEngine, type JsonValue } from '../engine/SelectorEngine';
import { createChildLogger } from '#lib/logging/index.js';
import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import { extractInfoHash } from '#lib/server/downloadClients/utils/hashUtils.js';

export interface ParseResult {
	releases: ReleaseResult[];
	errors: string[];
}

export interface ParseContext {
	indexerId: string;
	indexerName: string;
	protocol: IndexerProtocol;
	baseUrl: string;
}

export class ResponseParser {
	private definition: CardigannDefinition;
	private templateEngine: TemplateEngine;
	private filterEngine: FilterEngine;
	private selectorEngine: SelectorEngine;

	constructor(
		definition: CardigannDefinition,
		templateEngine: TemplateEngine,
		filterEngine: FilterEngine,
		selectorEngine: SelectorEngine
	) {
		this.definition = definition;
		this.templateEngine = templateEngine;
		this.filterEngine = filterEngine;
		this.selectorEngine = selectorEngine;
	}

	private shouldTraceTracker(context: ParseContext): boolean {
		const name = context.indexerName.toLowerCase();
		return name.includes('rutracker') || name.includes('kinozal');
	}

	/**
	 * Parse response content into release results.
	 */
	parse(
		content: string,
		searchPath: SearchPathBlock | undefined,
		context: ParseContext
	): ParseResult {
		const errors: string[] = [];
		const releases: ReleaseResult[] = [];

		// Determine response type
		const responseType = this.getResponseType(searchPath, content);

		try {
			if (responseType === 'json') {
				// An indexer occasionally returns HTTP 200 with an empty body (a
				// remote-side hiccup, not a bad request - the HTTP layer already
				// throws on any non-2xx status before this ever runs). JSON.parse('')
				// throws the cryptic "Unexpected end of JSON input", which reads like
				// a Cinephage parsing bug rather than what it actually is.
				if (content.trim().length === 0) {
					throw new Error('Indexer returned an empty response body');
				}
				const parsed = this.selectorEngine.parseJson(content);
				const results = this.parseJsonResponse(parsed, context);
				releases.push(...results);
			} else if (responseType === 'xml') {
				const $ = this.selectorEngine.parseXml(content);
				const results = this.parseHtmlResponse($, context);
				releases.push(...results);
			} else {
				const $ = this.selectorEngine.parseHtml(content);
				const results = this.parseHtmlResponse($, context);
				releases.push(...results);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			errors.push(`Parse error: ${errorMsg}`);
			logger.warn(
				{
					indexer: context.indexerName,
					error: errorMsg,
					responseType
				},
				'[ResponseParser] Parse failed'
			);
		}

		// Log parse summary for debugging
		if (releases.length === 0 || errors.length > 0) {
			logger.debug(
				{
					indexer: context.indexerName,
					releases: releases.length,
					errors: errors.length,
					responseType
				},
				'[ResponseParser] Parse completed'
			);
		}

		return {
			releases,
			errors
		};
	}

	/**
	 * Determine response type from path config or content.
	 *
	 * The Cardigann convention (used by most bundled definitions) declares
	 * `response.type` as a sibling of `paths`/`rows`/`fields` on the shared
	 * search block, not per-path - so a per-path override is checked first,
	 * then the search-block-level declaration, before falling back to
	 * content-sniffing for definitions that don't declare either.
	 */
	private getResponseType(
		searchPath: SearchPathBlock | undefined,
		content: string
	): 'json' | 'html' | 'xml' {
		const declaredType = searchPath?.response?.type ?? this.definition.search?.response?.type;
		if (declaredType) {
			return declaredType;
		}

		// Auto-detect from content
		return this.selectorEngine.detectResponseType(content);
	}

	/**
	 * Parse JSON response.
	 */
	private parseJsonResponse(json: JsonValue, context: ParseContext): ReleaseResult[] {
		const search = this.definition.search;
		const releases: ReleaseResult[] = [];

		if (!search.rows?.selector) {
			// No row selector, treat entire response as array
			if (Array.isArray(json)) {
				for (const item of json) {
					const release = this.extractReleaseFromJson(item, null, context);
					if (release) releases.push(release);
				}
			}
			return releases;
		}

		// Select rows using selector
		const rowSelector = search.rows.selector;
		const rows = this.selectorEngine.selectJsonAll(json, rowSelector);

		// Skip rows if 'after' is specified
		const skipCount = search.rows.after ?? 0;
		let filteredRows = rows.slice(skipCount);

		// Apply row-level filters if specified (e.g., rowandmatch)
		const rowFilters = search.rows?.filters;
		if (rowFilters && rowFilters.length > 0) {
			filteredRows = filteredRows.filter((row) => {
				if (typeof row === 'object' && row !== null) {
					const rowStr = JSON.stringify(row);
					return this.filterEngine.applyFilters(rowStr, rowFilters) !== '';
				}
				return true;
			});
		}

		// Check for 'multiple' directive - used when each row has a nested array
		// (e.g., YTS where each movie has multiple torrents)
		// 'multiple' can be a string selector (e.g., "torrents") or true (deprecated)
		const multipleSelector = typeof search.rows.multiple === 'string' ? search.rows.multiple : null;

		if (multipleSelector) {
			logger.info(
				{
					indexer: context.indexerName,
					rowCount: filteredRows.length,
					multipleSelector
				},
				'[ResponseParser] Parsing JSON with multiple directive'
			);
		}

		for (const row of filteredRows) {
			try {
				if (multipleSelector && typeof row === 'object' && row !== null) {
					// Extract nested array and create release for each item
					const nestedItems = this.selectorEngine.selectJsonAll(row, multipleSelector);
					logger.info(
						{
							indexer: context.indexerName,
							nestedItemCount: nestedItems.length
						},
						'[ResponseParser] Processing multiple directive'
					);
					for (const nestedItem of nestedItems) {
						// Pass parent row for accessing parent fields (title, imdb_code, etc.)
						const release = this.extractReleaseFromJson(nestedItem, row, context);
						if (release) {
							releases.push(release);
							logger.info(
								{
									indexer: context.indexerName,
									title: release.title
								},
								'[ResponseParser] Extracted release from nested item'
							);
						} else {
							logger.info(
								{
									indexer: context.indexerName,
									nestedItem: JSON.stringify(nestedItem).slice(0, 200)
								},
								'[ResponseParser] Failed to extract release from nested item'
							);
						}
					}
				} else {
					const release = this.extractReleaseFromJson(row, null, context);
					if (release) releases.push(release);
				}
			} catch (error) {
				logger.warn(
					{
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to parse JSON row'
				);
			}
		}

		return releases;
	}

	/**
	 * Extract release from JSON row.
	 * @param row The current JSON row (or nested item when using 'multiple')
	 * @param parentRow The parent row when using 'multiple' directive (for accessing parent fields)
	 * @param context Parse context
	 */
	private extractReleaseFromJson(
		row: JsonValue,
		parentRow: JsonValue | null,
		context: ParseContext
	): ReleaseResult | null {
		const search = this.definition.search;
		const fields = search.fields;

		if (!fields) return null;

		// Set .Result variables for template expansion
		// This allows fields to use {{ .Result.fieldname }} in their text templates
		this.setResultVariables(row, parentRow);

		const values: Record<string, string | null> = {};

		// Extract all field values
		for (const [fieldName, fieldDef] of Object.entries(fields)) {
			try {
				// First try to extract from current row
				const result = this.selectorEngine.selectJson(row, fieldDef, false);
				if (result.value !== null) {
					values[fieldName.toLowerCase()] = result.value;
				} else if (parentRow) {
					// Fall back to parent row if not found in current row
					const parentResult = this.selectorEngine.selectJson(parentRow, fieldDef, false);
					values[fieldName.toLowerCase()] = parentResult.value;
				} else {
					values[fieldName.toLowerCase()] = null;
				}
			} catch (error) {
				// Try parent row on error if available
				if (parentRow) {
					try {
						const parentResult = this.selectorEngine.selectJson(parentRow, fieldDef, false);
						values[fieldName.toLowerCase()] = parentResult.value;
						continue;
					} catch {
						// Ignore parent error
					}
				}
				// Log required field errors at warn level
				if (!this.isOptionalField(fieldName, fieldDef)) {
					logger.warn(
						{
							indexer: context.indexerName,
							field: fieldName,
							error: error instanceof Error ? error.message : String(error)
						},
						`[ResponseParser] Required field extraction failed`
					);
				}
				values[fieldName.toLowerCase()] = null;
			}
		}

		return this.buildReleaseResult(values, context);
	}

	/**
	 * Set .Result variables in template engine from row data.
	 * When using 'multiple' directive, merges parent row data first, then overlays child row data.
	 */
	private setResultVariables(row: JsonValue, parentRow: JsonValue | null): void {
		// First set parent row fields (if present)
		if (parentRow && typeof parentRow === 'object' && !Array.isArray(parentRow)) {
			for (const [key, value] of Object.entries(parentRow as Record<string, JsonValue>)) {
				if (
					value !== null &&
					value !== undefined &&
					!Array.isArray(value) &&
					typeof value !== 'object'
				) {
					this.templateEngine.setVariable(`.Result.${key}`, String(value));
				}
			}
		}

		// Then overlay current row fields (takes precedence)
		if (row && typeof row === 'object' && !Array.isArray(row)) {
			for (const [key, value] of Object.entries(row as Record<string, JsonValue>)) {
				if (
					value !== null &&
					value !== undefined &&
					!Array.isArray(value) &&
					typeof value !== 'object'
				) {
					this.templateEngine.setVariable(`.Result.${key}`, String(value));
				}
			}
		}
	}

	/**
	 * Parse HTML/XML response.
	 */
	private parseHtmlResponse($: CheerioAPI, context: ParseContext): ReleaseResult[] {
		const search = this.definition.search;
		const releases: ReleaseResult[] = [];

		if (!search.rows?.selector) {
			return releases;
		}

		// Expand template in row selector
		let rowSelector = search.rows.selector;
		rowSelector = this.templateEngine.expand(rowSelector);

		// Select all rows
		const rows = this.selectorEngine.selectHtmlAll($, $.root(), rowSelector);

		// Skip rows if 'after' is specified
		const skipCount = search.rows.after ?? 0;
		let filteredRows = rows.slice(skipCount);

		// Apply row-level filters if specified (e.g., rowandmatch)
		const rowFilters = search.rows?.filters;
		if (rowFilters && rowFilters.length > 0) {
			filteredRows = filteredRows.filter((row) => {
				// Get the HTML of the row and apply filters
				const rowHtml = row.html() ?? '';
				return this.filterEngine.applyFilters(rowHtml, rowFilters) !== '';
			});
		}

		if (this.shouldTraceTracker(context)) {
			logger.info(
				{
					indexer: context.indexerName,
					rowSelector,
					rowCount: rows.length,
					filteredRowCount: filteredRows.length,
					sampleRowHtml: filteredRows[0]?.html()?.slice(0, 500) ?? null
				},
				'[ResponseParser] HTML row selection'
			);
		}

		// Handle date headers (sticky dates)
		let currentDate: string | null = null;
		const dateHeadersSelector = search.rows.dateheaders;

		for (const [rowIndex, row] of filteredRows.entries()) {
			try {
				// Check for date header
				if (dateHeadersSelector?.selector) {
					const dateResult = this.selectorEngine.selectHtml($, row, dateHeadersSelector, false);
					if (dateResult.value) {
						currentDate = dateResult.value;
						continue; // This row is just a date header, skip to next
					}
				}

				const release = this.extractReleaseFromHtml($, row, context, currentDate, rowIndex);
				if (release) releases.push(release);
			} catch (error) {
				logger.warn(
					{
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to parse HTML row'
				);
			}
		}

		return releases;
	}

	/**
	 * Extract release from HTML row.
	 */
	private extractReleaseFromHtml(
		$: CheerioAPI,
		row: Cheerio<Element>,
		context: ParseContext,
		stickyDate: string | null,
		rowIndex?: number
	): ReleaseResult | null {
		const search = this.definition.search;
		const fields = search.fields;

		if (!fields) return null;

		const values: Record<string, string | null> = {};

		// Extract all field values
		for (const [fieldName, fieldDef] of Object.entries(fields)) {
			try {
				const result = this.selectorEngine.selectHtml(
					$,
					row,
					fieldDef,
					!this.isOptionalField(fieldName, fieldDef)
				);
				values[fieldName.toLowerCase()] = result.value;
			} catch (error) {
				if (!this.isOptionalField(fieldName, fieldDef)) {
					logger.warn(
						{
							indexer: context.indexerName,
							field: fieldName,
							error: error instanceof Error ? error.message : String(error)
						},
						'[ResponseParser] Required field extraction failed'
					);
				}
				values[fieldName.toLowerCase()] = null;
			}
		}

		if (this.shouldTraceTracker(context) && (rowIndex ?? 99) < 3) {
			logger.info(
				{
					indexer: context.indexerName,
					rowIndex,
					values: {
						title: values['title'],
						details: values['details'],
						download: values['download'],
						size: values['size'],
						seeders: values['seeders'],
						leechers: values['leechers'],
						category: values['category'],
						date: values['date']
					}
				},
				'[ResponseParser] HTML row field extraction'
			);
		}

		// Apply sticky date if no date was extracted
		if (stickyDate && !values['date'] && !values['publishdate']) {
			values['date'] = stickyDate;
		}

		const release = this.buildReleaseResult(values, context);

		if (this.shouldTraceTracker(context) && (rowIndex ?? 99) < 3 && !release) {
			logger.info(
				{
					indexer: context.indexerName,
					rowIndex,
					values: {
						title: values['title'],
						details: values['details'],
						download: values['download'],
						infohash: values['infohash'] || values['hash'],
						magnet: values['magnet'] || values['magneturl'] || values['magneturi'],
						size: values['size']
					}
				},
				'[ResponseParser] HTML row dropped before release build'
			);
		}

		return release;
	}

	/**
	 * Check if a field is optional.
	 */
	private isOptionalField(name: string, fieldDef: FieldDefinition): boolean {
		const lowerName = name.toLowerCase();

		// These fields are always optional
		const optionalFields = [
			'imdb',
			'imdbid',
			'tmdb',
			'tmdbid',
			'tvdb',
			'tvdbid',
			'description',
			'poster',
			'banner',
			'genre',
			'rageid',
			'tvmazeid',
			'traktid',
			'doubanid',
			'language',
			'languages',
			'subs',
			'subtitles'
		];
		if (optionalFields.includes(lowerName)) {
			return true;
		}

		// Check field definition
		if (typeof fieldDef === 'object' && fieldDef.optional) {
			return true;
		}

		return false;
	}

	/**
	 * Build ReleaseResult from extracted field values.
	 */
	private buildReleaseResult(
		values: Record<string, string | null>,
		context: ParseContext
	): ReleaseResult | null {
		// Required fields
		const title = values['title'];
		if (!title) return null;

		// Get download URL (required)
		const downloadUrl =
			values['download'] ||
			values['downloadurl'] ||
			values['magnet'] ||
			values['magneturl'] ||
			values['magneturi'];
		if (!downloadUrl && !values['infohash'] && !values['hash']) {
			return null;
		}

		// Build categories
		const categories = this.parseCategories(values);

		// Parse date
		let publishDate = new Date();
		const dateStr = values['date'] || values['publishdate'];
		if (dateStr) {
			const parsed = this.parseDate(dateStr);
			if (parsed) publishDate = parsed;
		}

		// Parse size
		let size = 0;
		const sizeStr = values['size'];
		if (sizeStr) {
			size = this.parseSizeValue(sizeStr);
		}

		// Build GUID
		let guid = values['guid'];
		if (!guid) {
			// Generate GUID from download URL or infohash
			const infoHash = values['infohash'] || values['hash'];
			guid = infoHash || downloadUrl || `${context.indexerId}-${title}-${Date.now()}`;
		}

		// Make URLs absolute
		const baseUrl = context.baseUrl;

		// Extract language code from definition (e.g., "ru-RU" -> "ru")
		const definitionLanguage = this.definition.language;
		const sourceLanguage = definitionLanguage
			? definitionLanguage.toLowerCase().split('-')[0]
			: undefined;

		// Prowlarr native search returns a per-result protocol field; use it when
		// present so mixed torrent/usenet results resolve correctly.
		const resultProtocol = (values['protocol'] as IndexerProtocol | undefined) ?? context.protocol;

		const result: ReleaseResult = {
			guid: String(guid),
			title: title,
			downloadUrl: this.makeAbsoluteUrl(downloadUrl || '', baseUrl),
			publishDate,
			size,
			indexerId: context.indexerId,
			indexerName: context.indexerName,
			protocol: resultProtocol,
			categories,
			sourceLanguage
		};

		// Optional fields
		const magnetUrl = values['magnet'] || values['magneturl'] || values['magneturi'];
		if (magnetUrl) {
			result.magnetUrl = magnetUrl; // Magnet URLs are already absolute
		}

		// Get infohash from field or auto-extract from magnet URI
		let infoHash: string | null | undefined = values['infohash'] || values['hash'];
		if (!infoHash && magnetUrl) {
			// Auto-extract from magnet URL (like Radarr does)
			infoHash = extractInfoHash(magnetUrl);
		}
		if (infoHash) {
			result.infoHash = infoHash.toLowerCase();
		}

		const commentsUrl = values['details'] || values['comments'];
		if (commentsUrl) {
			result.commentsUrl = this.makeAbsoluteUrl(commentsUrl, baseUrl);
		}

		const seedersStr = values['seeders'];
		if (seedersStr) {
			const seeders = parseInt(seedersStr.replace(/[^\d]/g, ''), 10);
			if (!isNaN(seeders)) result.seeders = seeders;
		}

		const leechersStr = values['leechers'] || values['peers'];
		if (leechersStr) {
			const leechers = parseInt(leechersStr.replace(/[^\d]/g, ''), 10);
			if (!isNaN(leechers)) result.leechers = leechers;
		}

		const grabsStr = values['grabs'];
		if (grabsStr) {
			const grabs = parseInt(grabsStr.replace(/[^\d]/g, ''), 10);
			if (!isNaN(grabs)) result.grabs = grabs;
		}

		// Ratio/volumefactor fields (download/upload factor)
		const downloadVolumeFactor = values['downloadvolumefactor'];
		const uploadVolumeFactor = values['uploadvolumefactor'];
		if (downloadVolumeFactor !== null || uploadVolumeFactor !== null) {
			// Initialize torrent object if needed
			if (!result.torrent) {
				result.torrent = {
					seeders: result.seeders ?? 0,
					leechers: result.leechers ?? 0
				};
			}

			if (downloadVolumeFactor !== null) {
				const dvf = parseFloat(downloadVolumeFactor);
				if (!isNaN(dvf)) {
					result.torrent.downloadFactor = dvf;
					// Freeleech if download factor is 0
					if (dvf === 0) {
						result.torrent.freeleech = true;
						result.torrent.isFreeleech = true;
					}
				}
			}

			if (uploadVolumeFactor !== null) {
				const uvf = parseFloat(uploadVolumeFactor);
				if (!isNaN(uvf)) {
					result.torrent.uploadFactor = uvf;
				}
			}
		}

		// External IDs
		const imdbId = values['imdb'] || values['imdbid'];
		if (imdbId) {
			result.imdbId = imdbId.startsWith('tt') ? imdbId : `tt${imdbId.padStart(7, '0')}`;
		}

		const tmdbIdStr = values['tmdb'] || values['tmdbid'];
		if (tmdbIdStr) {
			const tmdbId = parseInt(tmdbIdStr, 10);
			if (!isNaN(tmdbId)) result.tmdbId = tmdbId;
		}

		const tvdbIdStr = values['tvdb'] || values['tvdbid'];
		if (tvdbIdStr) {
			const tvdbId = parseInt(tvdbIdStr, 10);
			if (!isNaN(tvdbId)) result.tvdbId = tvdbId;
		}

		// Structured language attrs (torznab/newznab `language`/`subs`) — the
		// indexer asserts these; title-token parsing stays on `parsed.languages`.
		const audioLanguages = this.parseLanguageList(values['language'] ?? values['languages']);
		if (audioLanguages.length > 0) {
			result.languages = audioLanguages;
		}
		const subtitleLanguages = this.parseLanguageList(values['subs'] ?? values['subtitles']);
		if (subtitleLanguages.length > 0) {
			result.subtitleLanguages = subtitleLanguages;
		}

		return result;
	}

	/**
	 * Parse a possibly multi-valued language attribute ("English, Spanish",
	 * "en;es") into canonical tags. Unknown tokens are dropped, not guessed.
	 */
	private parseLanguageList(value: string | null | undefined): string[] {
		if (!value) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const token of value.split(/[,;|/]/)) {
			// Full ISO-aware normalizer: valid codes outside the curated list
			// (fil, ceb, ...) must not be silently dropped here while the title
			// parser and audio ranking accept them.
			const canonical = normalizeLanguageTag(token.trim());
			if (canonical === 'und' || seen.has(canonical)) continue;
			seen.add(canonical);
			out.push(canonical);
		}
		return out;
	}

	/**
	 * Parse categories from extracted values.
	 * Returns category IDs as numeric values (Category enum values).
	 * A single tracker category can map to multiple Newznab categories
	 * (e.g., Nyaa.si's "1_2" maps to both TV/Anime and Movies/Other).
	 */
	private parseCategories(values: Record<string, string | null>): Category[] {
		const categories: Category[] = [];
		const catValue = values['category'] || values['cat'] || values['categoryid'];

		if (!catValue) {
			// No category extracted - return empty to let filterByCategoryMatch allow it through
			return [];
		}

		// Support comma-separated IDs (e.g. "5000,5030" from Prowlarr JSON arrays
		// that were stringified before extraction).
		const parts = catValue.includes(',') ? catValue.split(',') : [catValue];

		for (const part of parts) {
			const trimmed = part.trim();
			const catId = parseInt(trimmed, 10);
			if (!isNaN(catId)) {
				// Check if this is a tracker-specific ID that needs mapping
				// (e.g., OldToons returns "1" which should map to "2000" for Movies)
				const mappedCats = this.findAllCategoryMappings(trimmed);
				if (mappedCats.length > 0) {
					categories.push(...mappedCats);
				} else {
					// It's already a Newznab category ID, use it directly
					categories.push(catId as Category);
				}
			} else {
				// Use category mapping from definition for string values
				const mappedCats = this.findAllCategoryMappings(trimmed);
				categories.push(...mappedCats);
			}
		}

		return categories;
	}

	/**
	 * Get default categories from definition.
	 */
	private getDefaultCategories(): Category[] {
		const caps = this.definition.caps;

		// Check categorymappings for defaults
		if (caps.categorymappings) {
			for (const mapping of caps.categorymappings) {
				if (mapping.default && mapping.cat) {
					const catId = resolveCategoryId(mapping.cat);
					return [catId as Category];
				}
			}
		}

		// Check simple categories
		if (caps.categories) {
			const first = Object.entries(caps.categories)[0];
			if (first) {
				const [id] = first;
				return [parseInt(id, 10) as Category];
			}
		}

		return [];
	}

	/**
	 * Find all category mappings by tracker-specific ID.
	 * Returns all matching Newznab category IDs as an array.
	 * A single tracker category can map to multiple Newznab categories
	 * (e.g., Nyaa.si's "1_2" maps to both TV/Anime and Movies/Other).
	 */
	private findAllCategoryMappings(trackerId: string): Category[] {
		const caps = this.definition.caps;
		const categories: Category[] = [];

		// Check categorymappings - collect ALL matches, not just the first
		if (caps.categorymappings) {
			for (const mapping of caps.categorymappings) {
				if (mapping.id === trackerId && mapping.cat) {
					const catId = resolveCategoryId(mapping.cat) as Category;
					if (!categories.includes(catId)) {
						categories.push(catId);
					}
				}
			}
		}

		// Check simple categories (only if no mappings found)
		if (categories.length === 0 && caps.categories && caps.categories[trackerId]) {
			const catId = parseInt(trackerId, 10) as Category;
			if (!isNaN(catId)) {
				categories.push(catId);
			}
		}

		return categories;
	}

	/**
	 * Parse size value to bytes.
	 */
	private parseSizeValue(sizeStr: string): number {
		// Remove commas
		sizeStr = sizeStr.replace(/,/g, '');

		// Check if it's already a number (bytes)
		const numOnly = parseFloat(sizeStr);
		if (!isNaN(numOnly) && sizeStr.match(/^\d+$/)) {
			return Math.round(numOnly);
		}

		// Parse with unit
		return parseSize(sizeStr);
	}

	/**
	 * Parse date string to Date object.
	 */
	private parseDate(dateStr: string): Date | null {
		// Already formatted as RFC 1123 from filters
		const parsed = new Date(dateStr);
		if (!isNaN(parsed.getTime())) {
			return parsed;
		}

		// Try parsing as Unix timestamp
		const timestamp = parseInt(dateStr, 10);
		if (!isNaN(timestamp)) {
			// Check if it's seconds or milliseconds
			if (timestamp > 1e12) {
				return new Date(timestamp);
			} else {
				return new Date(timestamp * 1000);
			}
		}

		return null;
	}

	/**
	 * Make URL absolute using base URL. Only http(s) and magnet survive
	 * verbatim; everything else is resolved against the indexer base, and the
	 * result is scheme-checked — scraped content is untrusted, and a
	 * `javascript:`/`data:` value that survives parsing would be rendered as a
	 * clickable link in the search UI.
	 */
	private makeAbsoluteUrl(url: string, baseUrl: string): string {
		if (!url) return url;
		if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('magnet:')) {
			return url;
		}

		try {
			const resolved = new URL(url, baseUrl);
			if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
				return '';
			}
			return resolved.toString();
		} catch {
			return '';
		}
	}
}

/**
 * Create a new ResponseParser instance.
 */
export function createResponseParser(
	definition: CardigannDefinition,
	templateEngine: TemplateEngine,
	filterEngine: FilterEngine,
	selectorEngine: SelectorEngine
): ResponseParser {
	return new ResponseParser(definition, templateEngine, filterEngine, selectorEngine);
}

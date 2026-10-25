/**
 * Go-style template engine for Cardigann definitions.
 * Supports variable substitution, logic functions, conditionals, and more.
 */

import type {
	SearchCriteria,
	MovieSearchCriteria,
	TvSearchCriteria,
	MusicSearchCriteria,
	BookSearchCriteria
} from '../types';
import { generateEpisodeFormat } from '../search/SearchFormatProvider';
import type { FilterBlock, SettingsField } from '../schema/yamlDefinition';
import { createSafeRegex, safeReplace } from './safeRegex';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

export type TemplateVariables = Map<string, unknown>;

export class TemplateEngine {
	private variables: TemplateVariables = new Map();
	/** Cache for compiled template functions */
	private templateCache: Map<string, { result: string; timestamp: number }> = new Map();
	/** Maximum cache size to prevent unbounded memory growth */
	private static readonly MAX_CACHE_SIZE = 1000;
	/** Cache TTL in milliseconds (5 minutes) */
	private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

	// Supported logic functions
	private static readonly LOGIC_FUNCTIONS = [
		'and',
		'or',
		'eq',
		'ne',
		'lt',
		'le',
		'gt',
		'ge',
		'not'
	];
	private static readonly STRING_LITERAL_FUNCTIONS = ['eq', 'ne'];

	// Regex patterns
	private static readonly RE_REPLACE_REGEX =
		/\{\{\s*re_replace\s+(\.[^\s]+)\s+"([^"]*)"\s+"([^"]*)"\s*\}\}/g;
	private static readonly JOIN_REGEX = /\{\{\s*join\s+(\.[^\s]+)\s+"([^"]*)"\s*\}\}/g;
	private static readonly IF_ELSE_REGEX =
		/\{\{\s*if\s+(.+?)\s*\}\}(.*?)\{\{\s*else\s*\}\}(.*?)\{\{\s*end\s*\}\}/gs;
	private static readonly IF_ONLY_REGEX = /\{\{\s*if\s+(.+?)\s*\}\}(.*?)\{\{\s*end\s*\}\}/gs;
	private static readonly RANGE_REGEX =
		/\{\{\s*range\s*(?:(?<index>\$[^\s,]+),\s*)?(?:(?<element>[^\s]+)\s*:=\s*)?(?<variable>\.[^\s]+)\s*\}\}(?<prefix>.*?)\{\{\s*\.\s*\}\}(?<postfix>.*?)\{\{\s*end\s*\}\}/gs;
	// Simple variable: {{ .Variable }}
	private static readonly SIMPLE_VARIABLE_REGEX = /\{\{\s*(\.[^\s}|]+)\s*\}\}/g;
	// Variable with pipe filters: {{ .Variable | filter "args" | filter2 }}
	private static readonly PIPE_VARIABLE_REGEX = /\{\{\s*(\.[^\s|]+)\s*\|([^}]+)\}\}/g;
	private static readonly LOGIC_FUNCTION_REGEX =
		/\b(and|or|eq|ne|lt|le|gt|ge|not)(?:\s+(\(?\.?[\w.]+\)?|"[^"]+"|[\d.]+))+/g;
	// Index function: {{ index .Array 0 }} or {{ index .Map "key" }}
	private static readonly INDEX_REGEX = /\{\{\s*index\s+(\.[^\s]+)\s+(\d+|"[^"]+")\s*\}\}/g;
	// Len function: {{ len .Array }}
	private static readonly LEN_REGEX = /\{\{\s*len\s+(\.[^\s}]+)\s*\}\}/g;
	// Printf function: {{ printf "%s-%s" .Var1 .Var2 }}
	private static readonly PRINTF_REGEX = /\{\{\s*printf\s+"([^"]+)"\s*([^}]*)\}\}/g;

	constructor() {
		this.initializeBaseVariables();
	}

	/**
	 * Initialize base template variables available to all templates.
	 */
	private initializeBaseVariables(): void {
		this.variables.set('.True', 'True');
		this.variables.set('.False', null);
		this.variables.set('.Today.Year', new Date().getFullYear().toString());
	}

	/**
	 * Set site link in variables.
	 */
	setSiteLink(url: string): void {
		this.variables.set('.Config.sitelink', url);
	}

	/**
	 * Set user configuration settings.
	 */
	setConfig(settings: Record<string, unknown>): void {
		for (const [key, value] of Object.entries(settings)) {
			const varName = `.Config.${key}`;
			if (typeof value === 'boolean') {
				this.variables.set(varName, value ? '.True' : null);
			} else {
				this.variables.set(varName, value);
			}
		}
	}

	/**
	 * Set user configuration settings with defaults from definition.
	 * This merges user-provided settings with definition defaults, handling
	 * type-specific conversions:
	 * - select: Converts index to option key
	 * - checkbox: Converts boolean to '.True' or null
	 * - text/password: Direct value assignment
	 *
	 * This matches Prowlarr's GetBaseTemplateVariables() behavior.
	 *
	 * @param userSettings - User-provided settings (from database)
	 * @param definitionSettings - Settings fields from YAML definition
	 */
	setConfigWithDefaults(
		userSettings: Record<string, unknown>,
		definitionSettings: SettingsField[]
	): void {
		for (const setting of definitionSettings) {
			const varName = `.Config.${setting.name}`;

			// Get default value based on type
			let defaultValue: unknown = setting.default;

			// For select type, default is the index (position) of the default option key
			if (setting.type === 'select' && setting.options) {
				const sortedKeys = Object.keys(setting.options).sort();
				if (typeof setting.default === 'string') {
					// Default is a key - find its index
					const defaultIndex = sortedKeys.indexOf(setting.default);
					defaultValue = defaultIndex >= 0 ? defaultIndex : 0;
				} else if (typeof setting.default === 'number') {
					// Default is already an index
					defaultValue = setting.default;
				} else {
					defaultValue = 0;
				}
			}

			// Get user value, falling back to default
			const value = userSettings[setting.name] ?? defaultValue;

			// Type-specific conversion
			switch (setting.type) {
				case 'checkbox': {
					// Convert to boolean if string
					let boolValue = value;
					if (typeof value === 'string') {
						boolValue = value.toLowerCase() === 'true' || value === '1';
					}
					this.variables.set(varName, boolValue ? '.True' : null);
					break;
				}

				case 'select': {
					if (!setting.options) {
						this.variables.set(varName, value);
						break;
					}

					// Sort options by key (Prowlarr behavior)
					const sortedKeys = Object.keys(setting.options).sort();

					// Value should be an index (number) - get the corresponding key
					let index = 0;
					if (typeof value === 'number') {
						index = value;
					} else if (typeof value === 'string') {
						// Try parsing as number first (index)
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed)) {
							index = parsed;
						} else {
							// Maybe it's already a key? Find its index
							const keyIndex = sortedKeys.indexOf(value);
							if (keyIndex >= 0) {
								index = keyIndex;
							}
						}
					}

					// Clamp to valid range
					index = Math.max(0, Math.min(index, sortedKeys.length - 1));
					const selectedKey = sortedKeys[index] ?? sortedKeys[0] ?? '';

					this.variables.set(varName, selectedKey);
					break;
				}

				case 'text':
				case 'password':
					// Direct value assignment
					this.variables.set(varName, value);
					break;

				case 'info':
				case 'info_cookie':
				case 'info_cloudflare':
				case 'info_flaresolverr':
				case 'info_useragent':
				case 'info_category_8000':
				case 'cardigannCaptcha':
					// No-op for info types
					break;

				default:
					// Unknown type - store directly
					this.variables.set(varName, value);
					break;
			}
		}

		// Also set any user settings that weren't in the definition
		// (backwards compatibility with old setConfig behavior)
		for (const [key, value] of Object.entries(userSettings)) {
			const varName = `.Config.${key}`;
			if (!this.variables.has(varName)) {
				if (typeof value === 'boolean') {
					this.variables.set(varName, value ? '.True' : null);
				} else {
					this.variables.set(varName, value);
				}
			}
		}
	}

	/**
	 * Set search query variables from search criteria.
	 */
	setQuery(criteria: SearchCriteria): void {
		// Reset all query variables to null first
		this.resetQueryVariables();

		// Set common variables
		this.variables.set('.Query.Type', criteria.searchType);
		this.variables.set('.Query.Q', criteria.query ?? null);
		this.variables.set('.Query.Categories', criteria.categories ?? []);
		this.variables.set('.Query.Limit', criteria.limit?.toString() ?? null);
		this.variables.set('.Query.Offset', criteria.offset?.toString() ?? null);

		// Build keywords
		const keywordParts: string[] = [];
		if (criteria.query) keywordParts.push(criteria.query);

		// Type-specific variables
		switch (criteria.searchType) {
			case 'movie':
				this.setMovieQueryVariables(criteria as MovieSearchCriteria, keywordParts);
				break;
			case 'tv':
				this.setTvQueryVariables(criteria as TvSearchCriteria, keywordParts);
				break;
			case 'music':
				this.setMusicQueryVariables(criteria as MusicSearchCriteria);
				break;
			case 'book':
				this.setBookQueryVariables(criteria as BookSearchCriteria);
				break;
		}

		this.variables.set('.Query.Keywords', keywordParts.join(' '));
		this.variables.set('.Keywords', keywordParts.join(' '));
	}

	private resetQueryVariables(): void {
		const queryVars = [
			'Q',
			'Keywords',
			'Type',
			'Categories',
			'Limit',
			'Offset',
			'Extended',
			'APIKey',
			'Genre',
			// Movie
			'Movie',
			'Year',
			'IMDBID',
			'IMDBIDShort',
			'TMDBID',
			'TraktID',
			'DoubanID',
			// TV
			'Series',
			'Ep',
			'Season',
			'TVDBID',
			'TVRageID',
			'TVMazeID',
			'Episode',
			'Episode.Standard',
			'Episode.European',
			'Episode.Compact',
			'Episode.Absolute',
			// Music
			'Album',
			'Artist',
			'Label',
			'Track',
			// Book
			'Author',
			'Title',
			'Publisher'
		];

		for (const v of queryVars) {
			this.variables.set(`.Query.${v}`, null);
		}
	}

	private setMovieQueryVariables(criteria: MovieSearchCriteria, keywords: string[]): void {
		if (criteria.year) {
			this.variables.set('.Query.Year', criteria.year.toString());
			keywords.push(criteria.year.toString());
		}

		if (criteria.imdbId) {
			// Full IMDB ID with 'tt' prefix
			const fullImdbId = criteria.imdbId.startsWith('tt')
				? criteria.imdbId
				: `tt${criteria.imdbId}`;
			this.variables.set('.Query.IMDBID', fullImdbId);
			// Short IMDB ID without 'tt' prefix
			this.variables.set('.Query.IMDBIDShort', criteria.imdbId.replace(/^tt/, ''));
		}

		if (criteria.tmdbId) {
			this.variables.set('.Query.TMDBID', criteria.tmdbId.toString());
		}

		if (criteria.traktId) {
			this.variables.set('.Query.TraktID', criteria.traktId.toString());
		}
	}

	private setTvQueryVariables(criteria: TvSearchCriteria, keywords: string[]): void {
		const season = criteria.season ?? 1;
		// Use preferred format if specified, otherwise default to 'standard'
		const preferredFormat = criteria.preferredEpisodeFormat ?? 'standard';

		if (criteria.season !== undefined) {
			this.variables.set('.Query.Season', criteria.season.toString());
		}

		if (criteria.episode !== undefined) {
			this.variables.set('.Query.Ep', criteria.episode.toString());

			// Generate all episode format variants using SearchFormatProvider
			const standardFormat = generateEpisodeFormat(season, criteria.episode, 'standard');
			const europeanFormat = generateEpisodeFormat(season, criteria.episode, 'european');
			const compactFormat = generateEpisodeFormat(season, criteria.episode, 'compact');
			// Absolute format: use the episode number directly (zero-padded) for anime
			const absoluteFormat = generateEpisodeFormat(
				season,
				criteria.episode,
				'absolute',
				criteria.episode
			);

			// Set format-specific variables for YAML templates
			this.variables.set('.Query.Episode.Standard', standardFormat);
			this.variables.set('.Query.Episode.European', europeanFormat);
			this.variables.set('.Query.Episode.Compact', compactFormat);
			this.variables.set('.Query.Episode.Absolute', absoluteFormat);

			// Get the preferred format value for .Query.Episode and keywords.
			// For 'absolute' format pass the episode as the absolute episode number.
			const preferredFormatValue =
				preferredFormat === 'absolute'
					? absoluteFormat
					: generateEpisodeFormat(season, criteria.episode, preferredFormat);

			// Default .Query.Episode uses the preferred format (or falls back to standard)
			this.variables.set('.Query.Episode', preferredFormatValue ?? standardFormat);

			// Add episode token to keywords using preferred format
			// No duplicate checking needed - SearchOrchestrator now passes clean queries
			const keywordFormat = preferredFormatValue ?? standardFormat;
			if (keywordFormat) {
				keywords.push(keywordFormat);
			}
		} else if (criteria.season !== undefined && criteria.season > 0) {
			// Season-only search (e.g., "S01")
			const seasonOnlyFormat = generateEpisodeFormat(season, undefined, 'standard');
			this.variables.set('.Query.Episode', seasonOnlyFormat);
			this.variables.set('.Query.Episode.Standard', seasonOnlyFormat);
			if (seasonOnlyFormat) {
				keywords.push(seasonOnlyFormat);
			}
		}

		if (criteria.year) {
			this.variables.set('.Query.Year', criteria.year.toString());
		}

		if (criteria.imdbId) {
			const fullImdbId = criteria.imdbId.startsWith('tt')
				? criteria.imdbId
				: `tt${criteria.imdbId}`;
			this.variables.set('.Query.IMDBID', fullImdbId);
			this.variables.set('.Query.IMDBIDShort', criteria.imdbId.replace(/^tt/, ''));
		}

		if (criteria.tmdbId) {
			this.variables.set('.Query.TMDBID', criteria.tmdbId.toString());
		}

		if (criteria.tvdbId) {
			this.variables.set('.Query.TVDBID', criteria.tvdbId.toString());
		}

		if (criteria.tvMazeId) {
			this.variables.set('.Query.TVMazeID', criteria.tvMazeId.toString());
		}

		if (criteria.traktId) {
			this.variables.set('.Query.TraktID', criteria.traktId.toString());
		}
	}

	private setMusicQueryVariables(criteria: MusicSearchCriteria): void {
		if (criteria.artist) {
			this.variables.set('.Query.Artist', criteria.artist);
		}
		if (criteria.album) {
			this.variables.set('.Query.Album', criteria.album);
		}
		if (criteria.year) {
			this.variables.set('.Query.Year', criteria.year.toString());
		}
	}

	private setBookQueryVariables(criteria: BookSearchCriteria): void {
		if (criteria.author) {
			this.variables.set('.Query.Author', criteria.author);
		}
		if (criteria.title) {
			this.variables.set('.Query.Title', criteria.title);
		}
	}

	/**
	 * Set categories for the search.
	 */
	setCategories(categories: string[]): void {
		this.variables.set('.Categories', categories);
	}

	/**
	 * Set a single variable.
	 */
	setVariable(name: string, value: unknown): void {
		this.variables.set(name, value);
	}

	/**
	 * Get a variable value.
	 */
	getVariable(name: string): unknown {
		return this.variables.get(name);
	}

	/**
	 * Check if a variable exists.
	 */
	hasVariable(name: string): boolean {
		return this.variables.has(name);
	}

	/**
	 * Set row context variables from a parsed search result row.
	 * Used during search result parsing to make row data available as .Result.xxx
	 */
	setRowContext(rowData: Record<string, unknown>): void {
		for (const [key, value] of Object.entries(rowData)) {
			this.variables.set(`.Result.${key}`, value);
		}
	}

	/**
	 * Clear row context variables.
	 */
	clearRowContext(): void {
		const keysToDelete: string[] = [];
		for (const key of this.variables.keys()) {
			if (key.startsWith('.Result.')) {
				keysToDelete.push(key);
			}
		}
		for (const key of keysToDelete) {
			this.variables.delete(key);
		}
	}

	/**
	 * Set multiple variables at once.
	 */
	setVariables(vars: Record<string, unknown>): void {
		for (const [key, value] of Object.entries(vars)) {
			const varName = key.startsWith('.') ? key : `.${key}`;
			this.variables.set(varName, value);
		}
	}

	/**
	 * Get all variables as a plain object.
	 */
	getVariables(): Record<string, unknown> {
		const obj: Record<string, unknown> = {};
		for (const [key, value] of this.variables.entries()) {
			obj[key] = value;
		}
		return obj;
	}

	/**
	 * Expand a template string with all variable substitutions and logic.
	 * @param template The template string to expand
	 * @param urlEncode Optional function to encode values for URLs
	 */
	expand(template: string, urlEncode?: (s: string) => string): string {
		if (!template || !template.includes('{{')) {
			return template;
		}

		let result = template;

		// Process in order:
		// 1. re_replace expressions
		result = this.processReReplace(result);

		// 2. join expressions
		result = this.processJoin(result, urlEncode);

		// 3. index expressions (array/map access)
		result = this.processIndex(result);

		// 4. len expressions (array length)
		result = this.processLen(result);

		// 5. printf expressions (string formatting)
		result = this.processPrintf(result, urlEncode);

		// 6. Logic functions (and, or, eq, ne, lt, gt, etc.)
		result = this.processLogicFunctions(result);

		// 7. if...else...end conditionals
		result = this.processIfElse(result);

		// 8. if...end (no else) conditionals
		result = this.processIfOnly(result);

		// 9. range loops
		result = this.processRange(result, urlEncode);

		// 10. Simple variable substitutions
		result = this.processVariables(result, urlEncode);

		return result;
	}

	/**
	 * Process {{ re_replace .Var "pattern" "replacement" }} expressions.
	 * Uses safe regex to prevent ReDoS attacks from malicious patterns.
	 */
	private processReReplace(template: string): string {
		return template.replace(
			TemplateEngine.RE_REPLACE_REGEX,
			(match, variable, pattern, replacement) => {
				const value = this.getVariableAsString(variable);
				if (value === null) return '';

				// Use safe regex creation to prevent ReDoS
				const regex = createSafeRegex(pattern, 'g');
				if (!regex) {
					// Pattern was invalid or dangerous, return original value
					return value;
				}

				return safeReplace(value, regex, replacement);
			}
		);
	}

	/**
	 * Process {{ join .Array "," }} expressions.
	 */
	private processJoin(template: string, urlEncode?: (s: string) => string): string {
		return template.replace(TemplateEngine.JOIN_REGEX, (match, variable, delimiter) => {
			const value = this.variables.get(variable);
			if (!Array.isArray(value)) return '';

			let items = value.map(String);
			if (urlEncode) {
				items = items.map(urlEncode);
			}
			return items.join(delimiter);
		});
	}

	/**
	 * Process {{ index .Array 0 }} or {{ index .Map "key" }} expressions.
	 */
	private processIndex(template: string): string {
		return template.replace(TemplateEngine.INDEX_REGEX, (match, variable, indexOrKey) => {
			const value = this.variables.get(variable);
			if (value === null || value === undefined) return '';

			// Handle array index (numeric)
			if (/^\d+$/.test(indexOrKey)) {
				const idx = parseInt(indexOrKey, 10);
				if (Array.isArray(value)) {
					return value[idx] !== undefined ? String(value[idx]) : '';
				}
				// String index (nth character)
				if (typeof value === 'string') {
					return value[idx] ?? '';
				}
			}

			// Handle map key (quoted string)
			if (indexOrKey.startsWith('"') && indexOrKey.endsWith('"')) {
				const key = indexOrKey.slice(1, -1);
				if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
					const mapValue = (value as Record<string, unknown>)[key];
					return mapValue !== undefined ? String(mapValue) : '';
				}
			}

			return '';
		});
	}

	/**
	 * Process {{ len .Array }} expressions.
	 */
	private processLen(template: string): string {
		return template.replace(TemplateEngine.LEN_REGEX, (match, variable) => {
			const value = this.variables.get(variable);
			if (Array.isArray(value)) {
				return value.length.toString();
			}
			if (typeof value === 'string') {
				return value.length.toString();
			}
			if (typeof value === 'object' && value !== null) {
				return Object.keys(value).length.toString();
			}
			return '0';
		});
	}

	/**
	 * Process {{ printf "%s-%s" .Var1 .Var2 }} expressions.
	 */
	private processPrintf(template: string, urlEncode?: (s: string) => string): string {
		return template.replace(TemplateEngine.PRINTF_REGEX, (match, format, argsStr) => {
			// Parse arguments from the string
			const argParts = argsStr.trim().split(/\s+/).filter(Boolean);
			const values: string[] = [];

			for (const arg of argParts) {
				if (arg.startsWith('.')) {
					let value = this.getVariableAsString(arg);
					if (value === null) value = '';
					if (urlEncode) value = urlEncode(value);
					values.push(value);
				} else if (arg.startsWith('"') && arg.endsWith('"')) {
					values.push(arg.slice(1, -1));
				} else {
					values.push(arg);
				}
			}

			// Simple printf implementation supporting %s, %d, %v
			let result = format;
			let valueIndex = 0;
			result = result.replace(/%[sdvq]/g, (specifier: string) => {
				const val = values[valueIndex++] ?? '';
				switch (specifier) {
					case '%d':
						return String(parseInt(val, 10) || 0);
					case '%q':
						return JSON.stringify(val);
					case '%s':
					case '%v':
					default:
						return val;
				}
			});

			return result;
		});
	}

	/**
	 * Maximum iterations for logic function processing to prevent ReDoS attacks.
	 */
	private static readonly MAX_LOGIC_ITERATIONS = 1000;

	/**
	 * Process logic functions: and, or, eq, ne, lt, le, gt, ge, not.
	 */
	private processLogicFunctions(template: string): string {
		let result = template;
		let match;
		let iterations = 0;

		// Keep processing until no more matches (handles nested functions)
		// Limit iterations to prevent ReDoS attacks from malicious templates
		while ((match = TemplateEngine.LOGIC_FUNCTION_REGEX.exec(result)) !== null) {
			if (++iterations > TemplateEngine.MAX_LOGIC_ITERATIONS) {
				logger.warn(
					{
						iterations,
						templateLength: template.length
					},
					'Template logic processing exceeded max iterations'
				);
				break;
			}

			const fullMatch = match[0];
			const functionName = match[1];
			const startIndex = match.index;

			// Extract parameters (variables, string literals, or numbers)
			const paramRegex = /(\(?\.?[\w.]+\)?|"[^"]+"|[\d.]+)/g;
			const params: string[] = [];
			let paramMatch;
			const restOfMatch = fullMatch.substring(functionName.length);

			while ((paramMatch = paramRegex.exec(restOfMatch)) !== null) {
				params.push(paramMatch[1].replace(/^\(|\)$/g, '')); // Remove optional parens
			}

			let functionResult = '';

			switch (functionName) {
				case 'and': {
					// Returns first null/empty, else last value
					for (const param of params) {
						const value = this.resolveParamValue(param);
						if (!value || (typeof value === 'string' && value.trim() === '')) {
							functionResult = String(value ?? '');
							break;
						}
						functionResult = String(value);
					}
					break;
				}
				case 'or': {
					// Returns first not null/empty, else last value
					for (const param of params) {
						const value = this.resolveParamValue(param);
						if (value && (typeof value !== 'string' || value.trim() !== '')) {
							functionResult = String(value);
							break;
						}
						functionResult = String(value ?? '');
					}
					break;
				}
				case 'not': {
					// Negation: returns .True if value is falsy, .False otherwise
					const param = params[0];
					const value = this.resolveParamValue(param);
					const isFalsy = !value || (typeof value === 'string' && value.trim() === '');
					functionResult = isFalsy ? '.True' : '.False';
					break;
				}
				case 'eq':
				case 'ne': {
					// Compare first two params
					const [param1, param2] = params.slice(0, 2);
					const value1 = this.resolveParamValue(param1);
					const value2 = this.resolveParamValue(param2);
					const isEqual = String(value1 ?? '') === String(value2 ?? '');
					functionResult = (functionName === 'eq' ? isEqual : !isEqual) ? '.True' : '.False';
					break;
				}
				case 'lt':
				case 'le':
				case 'gt':
				case 'ge': {
					// Numeric comparisons
					const [param1, param2] = params.slice(0, 2);
					const num1 = parseFloat(String(this.resolveParamValue(param1) ?? '0'));
					const num2 = parseFloat(String(this.resolveParamValue(param2) ?? '0'));
					let compResult = false;
					switch (functionName) {
						case 'lt':
							compResult = num1 < num2;
							break;
						case 'le':
							compResult = num1 <= num2;
							break;
						case 'gt':
							compResult = num1 > num2;
							break;
						case 'ge':
							compResult = num1 >= num2;
							break;
					}
					functionResult = compResult ? '.True' : '.False';
					break;
				}
			}

			result =
				result.substring(0, startIndex) +
				functionResult +
				result.substring(startIndex + fullMatch.length);
			TemplateEngine.LOGIC_FUNCTION_REGEX.lastIndex = 0; // Reset for next iteration
		}

		return result;
	}

	/**
	 * Resolve a parameter value (variable or string literal).
	 */
	private resolveParamValue(param: string): unknown {
		if (param.startsWith('"') && param.endsWith('"')) {
			return param.slice(1, -1); // String literal
		}
		return this.variables.get(param);
	}

	/**
	 * Process {{ if .Condition }}...{{ else }}...{{ end }} conditionals.
	 */
	private processIfElse(template: string): string {
		return template.replace(TemplateEngine.IF_ELSE_REGEX, (match, condition, onTrue, onFalse) => {
			const conditionValue = this.evaluateCondition(condition.trim());
			return conditionValue ? onTrue : onFalse;
		});
	}

	/**
	 * Process {{ if .Condition }}...{{ end }} (no else) conditionals.
	 */
	private processIfOnly(template: string): string {
		return template.replace(TemplateEngine.IF_ONLY_REGEX, (match, condition, content) => {
			const conditionValue = this.evaluateCondition(condition.trim());
			return conditionValue ? content : '';
		});
	}

	/**
	 * Evaluate a condition (variable name starting with dot, or resolved logic value).
	 */
	private evaluateCondition(condition: string): boolean {
		// Handle already-resolved boolean markers
		if (condition === '.True' || condition === 'True') {
			return true;
		}
		if (condition === '.False' || condition === 'False' || condition === '') {
			return false;
		}

		// Handle negation: not .Variable
		if (condition.startsWith('not ')) {
			const inner = condition.substring(4).trim();
			return !this.evaluateCondition(inner);
		}

		// Variable lookup
		if (!condition.startsWith('.')) {
			// Could be a literal or already evaluated
			return condition.trim() !== '';
		}

		const value = this.variables.get(condition);

		if (value === null || value === undefined) {
			return false;
		}

		if (typeof value === 'string') {
			// Check for boolean-like strings
			if (value === '.True' || value === 'True' || value === 'true') return true;
			if (value === '.False' || value === 'False' || value === 'false') return false;
			return value.trim() !== '';
		}

		if (Array.isArray(value)) {
			return value.length > 0;
		}

		if (typeof value === 'boolean') {
			return value;
		}

		if (typeof value === 'number') {
			return value !== 0;
		}

		return true;
	}

	/**
	 * Process {{ range .Array }}...{{ . }}...{{ end }} loops.
	 */
	private processRange(template: string, urlEncode?: (s: string) => string): string {
		return template.replace(TemplateEngine.RANGE_REGEX, (match) => {
			// Extract named groups manually since JS regex named groups can be tricky
			const rangeMatch = TemplateEngine.RANGE_REGEX.exec(match);
			if (!rangeMatch?.groups) return '';

			const { variable, prefix = '', postfix = '' } = rangeMatch.groups;
			const index = rangeMatch.groups.index;

			const arrayValue = this.variables.get(variable);
			if (!Array.isArray(arrayValue)) return '';

			const results: string[] = [];
			arrayValue.forEach((item, i) => {
				let value = String(item);
				if (urlEncode) {
					value = urlEncode(value);
				}

				let prefixStr = prefix;
				let postfixStr = postfix;

				if (index) {
					const indexPlaceholder = `{{${index}}}`;
					prefixStr = prefixStr.replace(indexPlaceholder, i.toString());
					postfixStr = postfixStr.replace(indexPlaceholder, i.toString());
				}

				results.push(prefixStr + value + postfixStr);
			});

			return results.join('');
		});
	}

	/**
	 * Process {{ .Variable }} and {{ .Variable | filter "args" }} substitutions.
	 */
	private processVariables(template: string, urlEncode?: (s: string) => string): string {
		// First process piped variables (more specific pattern)
		let result = template.replace(
			TemplateEngine.PIPE_VARIABLE_REGEX,
			(match, variable, pipePart) => {
				let value = this.getVariableAsString(variable.trim());
				if (value === null) return '';

				// Parse and apply filters
				const filters = this.parsePipeFilters(pipePart);
				for (const filter of filters) {
					value = this.applyInlineFilter(value, filter);
				}

				if (urlEncode) {
					value = urlEncode(value);
				}

				return value;
			}
		);

		// Then process simple variables
		result = result.replace(TemplateEngine.SIMPLE_VARIABLE_REGEX, (match, variable) => {
			let value = this.getVariableAsString(variable);
			if (value === null) return '';

			if (urlEncode) {
				value = urlEncode(value);
			}

			return value;
		});

		return result;
	}

	/**
	 * Parse pipe filters from a string like `| filter "args" | filter2`.
	 * Supports multiple arguments: `| replace "old" "new"` or `| slice 0 1`
	 */
	private parsePipeFilters(pipePart: string): FilterBlock[] {
		const filters: FilterBlock[] = [];
		// Split by pipe, but be careful with quoted strings
		const filterParts = pipePart.split(/\s*\|\s*/);

		for (const part of filterParts) {
			const trimmed = part.trim();
			if (!trimmed) continue;

			// Extract filter name (first word)
			const spaceIdx = trimmed.indexOf(' ');
			if (spaceIdx === -1) {
				// No arguments
				filters.push({ name: trimmed });
				continue;
			}

			const name = trimmed.substring(0, spaceIdx);
			const argsStr = trimmed.substring(spaceIdx + 1).trim();

			// Parse all arguments (quoted strings or unquoted tokens)
			const args: string[] = [];
			let remaining = argsStr;

			while (remaining.length > 0) {
				remaining = remaining.trimStart();
				if (remaining.length === 0) break;

				if (remaining.startsWith('"')) {
					// Quoted string
					const endQuote = remaining.indexOf('"', 1);
					if (endQuote !== -1) {
						args.push(remaining.substring(1, endQuote));
						remaining = remaining.substring(endQuote + 1);
					} else {
						// Unterminated quote, take the rest
						args.push(remaining.substring(1));
						break;
					}
				} else if (remaining.startsWith("'")) {
					// Single-quoted string
					const endQuote = remaining.indexOf("'", 1);
					if (endQuote !== -1) {
						args.push(remaining.substring(1, endQuote));
						remaining = remaining.substring(endQuote + 1);
					} else {
						args.push(remaining.substring(1));
						break;
					}
				} else {
					// Unquoted token (until space or end)
					const nextSpace = remaining.search(/\s/);
					if (nextSpace !== -1) {
						args.push(remaining.substring(0, nextSpace));
						remaining = remaining.substring(nextSpace);
					} else {
						args.push(remaining);
						break;
					}
				}
			}

			// Store args: single arg as string, multiple args as array
			if (args.length === 0) {
				filters.push({ name });
			} else if (args.length === 1) {
				filters.push({ name, args: args[0] });
			} else {
				filters.push({ name, args });
			}
		}

		return filters;
	}

	/**
	 * Apply an inline filter to a value.
	 * Implements common Cardigann/Go template filters.
	 */
	private applyInlineFilter(value: string, filter: FilterBlock): string {
		const name = filter.name.toLowerCase();
		const args = filter.args;

		switch (name) {
			case 'trimprefix':
				if (typeof args === 'string' && value.startsWith(args)) {
					return value.substring(args.length);
				}
				return value;

			case 'trimsuffix':
				if (typeof args === 'string' && value.endsWith(args)) {
					return value.substring(0, value.length - args.length);
				}
				return value;

			case 'tolower':
			case 'lower':
				return value.toLowerCase();

			case 'toupper':
			case 'upper':
				return value.toUpperCase();

			case 'trim':
				return value.trim();

			case 'urlencode':
				return encodeURIComponent(value);

			case 'urldecode':
				try {
					return decodeURIComponent(value);
				} catch {
					return value;
				}

			case 'replace': {
				// replace "old" "new" - args is array of [old, new]
				if (Array.isArray(args) && args.length >= 2) {
					const [oldStr, newStr] = args;
					return value.split(String(oldStr)).join(String(newStr));
				}
				return value;
			}

			case 'slice': {
				// slice startIndex endIndex (optional) - Go-style slice
				// slice 0 1 -> first character
				// slice 1 -> from index 1 to end
				if (Array.isArray(args)) {
					const start = parseInt(String(args[0]), 10) || 0;
					const end = args.length > 1 ? parseInt(String(args[1]), 10) : undefined;
					return value.slice(start, end);
				}
				if (typeof args === 'string') {
					const start = parseInt(args, 10) || 0;
					return value.slice(start);
				}
				return value;
			}

			case 'join': {
				// join separator - joins array-like value with separator
				// If value is a single string, just return it
				const separator = typeof args === 'string' ? args : ',';
				// If the value looks like an array (comma-separated), split and rejoin
				if (value.includes(',')) {
					return value
						.split(',')
						.map((s) => s.trim())
						.join(separator);
				}
				return value;
			}

			case 'printf': {
				// printf format - apply C-style format string
				// %s = string, %d = integer, %v = value
				if (typeof args === 'string') {
					return args.replace(/%[sdvq]/g, () => value);
				}
				return value;
			}

			case 'split': {
				// split separator index - split by separator and take index
				if (Array.isArray(args) && args.length >= 2) {
					const [separator, indexStr] = args;
					let index = parseInt(String(indexStr), 10);
					const parts = value.split(String(separator));
					if (index < 0) index = parts.length + index;
					return parts[index] ?? '';
				}
				return value;
			}

			case 'prepend': {
				// prepend "prefix"
				const prefix = typeof args === 'string' ? args : '';
				return prefix + value;
			}

			case 'append': {
				// append "suffix"
				const suffix = typeof args === 'string' ? args : '';
				return value + suffix;
			}

			case 'first': {
				// first n - get first n characters
				const n = parseInt(typeof args === 'string' ? args : '1', 10);
				return value.substring(0, n);
			}

			case 'last': {
				// last n - get last n characters
				const n = parseInt(typeof args === 'string' ? args : '1', 10);
				return value.substring(Math.max(0, value.length - n));
			}

			case 'default': {
				// default "value" - use default if empty
				if (!value || value.trim() === '') {
					return typeof args === 'string' ? args : '';
				}
				return value;
			}

			case 'substring': {
				// substring start length
				if (Array.isArray(args)) {
					const start = parseInt(String(args[0]), 10) || 0;
					const length = args.length > 1 ? parseInt(String(args[1]), 10) : undefined;
					return length !== undefined ? value.slice(start, start + length) : value.slice(start);
				}
				if (typeof args === 'string') {
					const start = parseInt(args, 10) || 0;
					return value.slice(start);
				}
				return value;
			}

			default:
				// Unknown filter, return as-is
				logger.warn({ name }, 'Unknown inline filter');
				return value;
		}
	}

	/**
	 * Get a variable as a string value.
	 */
	private getVariableAsString(name: string): string | null {
		const value = this.variables.get(name);

		if (value === null || value === undefined) {
			return null;
		}

		if (typeof value === 'string') {
			return value;
		}

		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}

		if (Array.isArray(value)) {
			return value.join(',');
		}

		return String(value);
	}

	/**
	 * Clone the template engine with all current variables.
	 */
	clone(): TemplateEngine {
		const cloned = new TemplateEngine();
		cloned.variables = new Map(this.variables);
		return cloned;
	}

	/**
	 * Clear all variables and reinitialize.
	 */
	reset(): void {
		this.variables.clear();
		this.initializeBaseVariables();
	}
}

/**
 * Create a new TemplateEngine instance.
 */
export function createTemplateEngine(): TemplateEngine {
	return new TemplateEngine();
}

/**
 * Filter engine for Cardigann definitions.
 * Implements all Prowlarr/Cardigann data transformation filters.
 */

import { createHash } from 'node:crypto';
import type { FilterBlock } from '../schema/yamlDefinition';
import type { TemplateEngine } from './TemplateEngine';
import { createSafeRegex, safeMatch, safeReplace } from './safeRegex';
import { createChildLogger } from '#lib/logging/index.js';
import { parse as dateParse } from 'date-format-parse';

const logger = createChildLogger({ logDomain: 'indexers' as const });

export type FilterFunction = (
	data: string,
	args: unknown,
	templateEngine?: TemplateEngine
) => string;

/**
 * Parse ISO token-based date layout to JavaScript Date.
 * Available tokens: https://www.npmjs.com/package/date-format-parse#tokens
 */
function parseDateWithLayout(dateStr: string, layout: string): Date | null {
	if (!dateStr || !layout) return null;

	// date-format-parse matches literal whitespace in the layout exactly, so
	// incidental leading/trailing whitespace or doubled spaces (common in
	// pretty-printed RSS/XML pubDate text nodes) fails to parse even though
	// the date is perfectly well-formed.
	dateStr = dateStr.trim().replace(/[ \t]+/g, ' ');

	// Handle special unix layouts
	if (layout === 'unix' || layout === 'Unix') {
		const timestamp = parseInt(dateStr, 10);
		if (isNaN(timestamp)) return null;
		return new Date(timestamp * 1000);
	}

	if (layout === 'unixms' || layout === 'UnixMs') {
		const timestamp = parseInt(dateStr, 10);
		if (isNaN(timestamp)) return null;
		return new Date(timestamp);
	}

	let parsedDate: Date = dateParse(dateStr, layout);
	if (isNaN(parsedDate.getTime()) && dateStr.endsWith('Z') && /Z\s*$/.test(layout)) {
		const normalised = dateStr.replace(/Z$/, '+00:00');
		parsedDate = dateParse(normalised, layout);
	}
	if (isNaN(parsedDate.getTime())) {
		logger.error({ dateStr, layout }, `Parsing date failed`);
		return null;
	}

	return parsedDate;
}

/**
 * Parse relative time strings like "2 hours ago", "yesterday", "3 days ago".
 */
function parseRelativeTime(str: string): Date | null {
	if (!str) return null;

	const now = new Date();
	const lower = str.toLowerCase().trim();

	// Handle "just now", "now"
	if (lower === 'just now' || lower === 'now') {
		return now;
	}

	// Handle "yesterday"
	if (lower === 'yesterday') {
		return new Date(now.getTime() - 24 * 60 * 60 * 1000);
	}

	// Handle "today"
	if (lower === 'today') {
		return now;
	}

	// Handle "X unit(s) ago" patterns
	const agoMatch = lower.match(/^(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago$/);
	if (agoMatch) {
		const amount = parseInt(agoMatch[1], 10);
		const unit = agoMatch[2];
		const ms = getTimeUnitMs(unit, amount);
		return new Date(now.getTime() - ms);
	}

	// Handle "an hour ago", "a minute ago", etc.
	const singleAgoMatch = lower.match(
		/^(?:an?|one)\s*(second|minute|hour|day|week|month|year)\s*ago$/
	);
	if (singleAgoMatch) {
		const unit = singleAgoMatch[1];
		const ms = getTimeUnitMs(unit, 1);
		return new Date(now.getTime() - ms);
	}

	return null;
}

function getTimeUnitMs(unit: string, amount: number): number {
	const second = 1000;
	const minute = 60 * second;
	const hour = 60 * minute;
	const day = 24 * hour;
	const week = 7 * day;
	const month = 30 * day;
	const year = 365 * day;

	switch (unit) {
		case 'second':
			return amount * second;
		case 'minute':
			return amount * minute;
		case 'hour':
			return amount * hour;
		case 'day':
			return amount * day;
		case 'week':
			return amount * week;
		case 'month':
			return amount * month;
		case 'year':
			return amount * year;
		default:
			return 0;
	}
}

/**
 * Parse fuzzy/unknown time formats.
 */
function parseFuzzyTime(str: string): Date | null {
	if (!str) return null;

	// Try relative time first
	const relative = parseRelativeTime(str);
	if (relative) return relative;

	// Try common date formats
	const formats = [
		// ISO
		/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/,
		// European
		/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{1,2})?:?(\d{2})?:?(\d{2})?/,
		// US
		/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*(\d{1,2})?:?(\d{2})?/
	];

	for (const format of formats) {
		const match = str.match(format);
		if (match) {
			try {
				return new Date(str);
			} catch {
				continue;
			}
		}
	}

	// Last resort: try Date.parse
	const parsed = Date.parse(str);
	if (!isNaN(parsed)) {
		return new Date(parsed);
	}

	return null;
}

/**
 * Format date to RFC 1123 pattern used by Prowlarr.
 */
function formatRfc1123(date: Date): string {
	return date.toUTCString();
}

/**
 * Sanitize filename by removing invalid characters.
 */
function sanitizeFilename(str: string): string {
	// eslint-disable-next-line no-control-regex
	return str.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

/**
 * Normalize diacritics (accented characters) to base characters.
 */
function normalizeDiacritics(str: string): string {
	return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Extract query string parameter value.
 */
function extractQueryParam(url: string, param: string): string {
	try {
		const urlObj = new URL(url, 'http://dummy');
		return urlObj.searchParams.get(param) ?? '';
	} catch {
		// Try manual extraction - escape param to prevent ReDoS
		const escapedParam = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = createSafeRegex(`[?&]${escapedParam}=([^&]*)`);
		if (!regex) return '';
		const match = safeMatch(url, regex);
		return match ? decodeURIComponent(match[1]) : '';
	}
}

/**
 * Join JSON array values at a path.
 */
function joinJsonArray(jsonStr: string, path: string, separator: string): string {
	try {
		const obj = JSON.parse(jsonStr);
		const parts = path.split('.');
		let current = obj;

		for (const part of parts) {
			if (current === null || current === undefined) return '';
			current = current[part];
		}

		if (Array.isArray(current)) {
			return current.map(String).join(separator);
		}

		return String(current ?? '');
	} catch {
		return '';
	}
}

/**
 * HTML decode string.
 */
function htmlDecode(str: string): string {
	const entities: Record<string, string> = {
		'&amp;': '&',
		'&lt;': '<',
		'&gt;': '>',
		'&quot;': '"',
		'&#39;': "'",
		'&apos;': "'",
		'&nbsp;': ' ',
		'&#160;': ' '
	};

	// Named entities
	let result = str;
	for (const [entity, char] of Object.entries(entities)) {
		result = result.replace(new RegExp(entity, 'g'), char);
	}

	// Numeric entities
	result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
	result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
		String.fromCharCode(parseInt(code, 16))
	);

	return result;
}

/**
 * HTML encode string.
 */
function htmlEncode(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Trim specific characters from string.
 */
function trimChars(str: string, chars: string): string {
	const escaped = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(`^[${escaped}]+|[${escaped}]+$`, 'g');
	return str.replace(regex, '');
}

// ============================================================================
// Filter Registry
// ============================================================================

const FILTERS: Record<string, FilterFunction> = {
	// Text processing
	querystring: (data, args) => {
		const param = String(args);
		return extractQueryParam(data, param);
	},

	regexp: (data, args) => {
		const pattern = String(args);
		// Use safe regex to prevent ReDoS attacks
		const regex = createSafeRegex(pattern);
		if (!regex) return data;
		const match = safeMatch(data, regex);
		return match?.[1] ?? match?.[0] ?? '';
	},

	re_replace: (data, args, templateEngine) => {
		if (!Array.isArray(args) || args.length < 2) return data;
		const [pattern, replacementArg] = args.map(String);
		let replacement = replacementArg;

		// Apply template to replacement if templateEngine provided
		if (templateEngine) {
			replacement = templateEngine.expand(replacement);
		}

		// Use safe regex to prevent ReDoS attacks
		const regex = createSafeRegex(pattern, 'g');
		if (!regex) return data;
		return safeReplace(data, regex, replacement);
	},

	split: (data, args) => {
		if (!Array.isArray(args) || args.length < 2) return data;
		const [separator, posStr] = args.map(String);
		let pos = parseInt(posStr, 10);

		const parts = data.split(separator);
		if (pos < 0) pos = parts.length + pos;

		return parts[pos] ?? '';
	},

	replace: (data, args, templateEngine) => {
		if (!Array.isArray(args) || args.length < 2) return data;
		const [from, toArg] = args.map(String);
		let to = toArg;

		// Apply template to replacement if templateEngine provided
		if (templateEngine) {
			to = templateEngine.expand(to);
		}

		return data.split(from).join(to);
	},

	trim: (data, args) => {
		if (args && typeof args === 'string') {
			return trimChars(data, args);
		}
		return data.trim();
	},

	trimprefix: (data, args) => {
		const prefix = String(args ?? '');
		if (prefix && data.startsWith(prefix)) {
			return data.substring(prefix.length);
		}
		return data;
	},

	trimsuffix: (data, args) => {
		const suffix = String(args ?? '');
		if (suffix && data.endsWith(suffix)) {
			return data.substring(0, data.length - suffix.length);
		}
		return data;
	},

	prepend: (data, args, templateEngine) => {
		let prefix = String(args ?? '');
		if (templateEngine) {
			prefix = templateEngine.expand(prefix);
		}
		return prefix + data;
	},

	append: (data, args, templateEngine) => {
		let suffix = String(args ?? '');
		if (templateEngine) {
			suffix = templateEngine.expand(suffix);
		}
		return data + suffix;
	},

	tolower: (data) => data.toLowerCase(),

	toupper: (data) => data.toUpperCase(),

	// Encoding
	urldecode: (data) => {
		try {
			return decodeURIComponent(data);
		} catch {
			return data;
		}
	},

	urlencode: (data) => {
		try {
			return encodeURIComponent(data);
		} catch {
			return data;
		}
	},

	htmldecode: (data) => htmlDecode(data),

	htmlencode: (data) => htmlEncode(data),

	// Date/time
	dateparse: (data, args) => {
		const layout = String(args ?? '');
		const date = parseDateWithLayout(data, layout);
		return date ? formatRfc1123(date) : data;
	},

	timeparse: (data, args) => {
		// Alias for dateparse
		return FILTERS.dateparse(data, args);
	},

	timeago: (data) => {
		const date = parseRelativeTime(data);
		return date ? formatRfc1123(date) : data;
	},

	reltime: (data, args) => {
		// Alias for timeago
		return FILTERS.timeago(data, args);
	},

	fuzzytime: (data) => {
		const date = parseFuzzyTime(data);
		return date ? formatRfc1123(date) : data;
	},

	// Special
	validfilename: (data) => sanitizeFilename(data),

	diacritics: (data, args) => {
		const op = String(args ?? 'replace');
		if (op === 'replace') {
			return normalizeDiacritics(data);
		}
		return data;
	},

	jsonjoinarray: (data, args) => {
		if (!Array.isArray(args) || args.length < 2) return data;
		const [path, separator] = args.map(String);
		return joinJsonArray(data, path, separator);
	},

	// Numeric
	parseint: (data) => {
		const num = parseInt(data.replace(/[^\d-]/g, ''), 10);
		return isNaN(num) ? '0' : num.toString();
	},

	parsefloat: (data) => {
		const num = parseFloat(data.replace(/[^\d.-]/g, ''));
		return isNaN(num) ? '0' : num.toString();
	},

	// Size parsing
	parsesize: (data) => {
		const match = data.match(/^([\d.,]+)\s*([KMGT]?i?B)?$/i);
		if (!match) return '0';

		const num = parseFloat(match[1].replace(',', '.'));
		const unit = (match[2] || 'B').toUpperCase();

		const multipliers: Record<string, number> = {
			B: 1,
			KB: 1024,
			KIB: 1024,
			MB: 1024 * 1024,
			MIB: 1024 * 1024,
			GB: 1024 * 1024 * 1024,
			GIB: 1024 * 1024 * 1024,
			TB: 1024 * 1024 * 1024 * 1024,
			TIB: 1024 * 1024 * 1024 * 1024
		};

		const bytes = Math.round(num * (multipliers[unit] ?? 1));
		return bytes.toString();
	},

	// Debug
	hexdump: (data) => {
		logger.debug(
			{
				data: Array.from(data)
					.map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
					.join(' ')
			},
			'[hexdump]'
		);
		return data;
	},

	strdump: (data, args) => {
		const tag = args ? ` (${args})` : '';
		logger.debug({ data: JSON.stringify(data) }, `[strdump${tag}]`);
		return data;
	},

	// Validation
	validate: (data, args) => {
		if (!args) return data;
		const validList = String(args)
			.toLowerCase()
			.split(/[,\s/)(.[\]"|:;]+/)
			.filter(Boolean);

		const dataTokens = data
			.toLowerCase()
			.split(/[,\s/)(.[\]"|:;]+/)
			.filter(Boolean);

		const intersection = dataTokens.filter((t) => validList.includes(t));
		return intersection.join(', ');
	},

	// Title validation: ensures title isn't empty or only quality tags after filtering
	// Usage: validate_title (returns data if valid, empty if invalid)
	// Or: validate_title 5 (returns data if at least 5 chars, empty otherwise)
	validate_title: (data, args) => {
		const minLength =
			typeof args === 'number' ? args : typeof args === 'string' ? parseInt(args, 10) || 5 : 5;
		const trimmed = data.trim();

		// Check if title is empty or too short
		if (!trimmed || trimmed.length < minLength) {
			logger.warn(
				{
					title: data,
					length: trimmed.length,
					minLength
				},
				'[FilterEngine] Title validation failed: too short or empty'
			);
			return ''; // Return empty to signal validation failure
		}

		// Check if title is only quality tags (common issue with RuTracker)
		const qualityOnlyPattern =
			/^(?:\s*(?:WEB|WEB-DL|WEBRip|HDTV|HDRip|BDRip|BluRay|DVD|DVDRip|1080p|720p|2160p|4K|x264|x265|HEVC|AVC|AAC|AC3|DTS|MP3|MKV|MP4|AVI)\s*)+$/i;
		if (qualityOnlyPattern.test(trimmed)) {
			logger.warn({ title: data }, '[FilterEngine] Title validation failed: only quality tags');
			return ''; // Return empty to signal validation failure
		}

		// Check if title is only brackets/punctuation
		const punctuationOnlyPattern = /^[\s[\](){}<>/\\|.,:;!?#@$%^&*+=_-]*$/;
		if (punctuationOnlyPattern.test(trimmed)) {
			logger.warn({ title: data }, '[FilterEngine] Title validation failed: only punctuation');
			return ''; // Return empty to signal validation failure
		}

		// Title is valid
		return data;
	},

	// Absolute URL
	absoluteurl: (data, args, templateEngine) => {
		if (!data) return data;
		if (data.startsWith('http://') || data.startsWith('https://') || data.startsWith('magnet:')) {
			return data;
		}

		const baseUrl = templateEngine?.getVariable('.Config.sitelink') as string;
		if (!baseUrl) return data;

		try {
			return new URL(data, baseUrl).toString();
		} catch {
			return data;
		}
	},

	// Base URL extraction (returns protocol + host from URL)
	baseurl: (data) => {
		try {
			const url = new URL(data);
			return `${url.protocol}//${url.host}`;
		} catch {
			// Try to extract manually
			const match = data.match(/^(https?:\/\/[^/]+)/i);
			return match ? match[1] : data;
		}
	},

	// Size parse alias (same as parsesize)
	sizeparse: (data, args) => {
		return FILTERS.parsesize(data, args);
	},

	// Map replace with raw string matching (no regex)
	mapreplaceraw: (data, args) => {
		if (!Array.isArray(args) || args.length < 2) return data;
		// Args come as [find1, replace1, find2, replace2, ...]
		let result = data;
		for (let i = 0; i < args.length - 1; i += 2) {
			const find = String(args[i]);
			const replace = String(args[i + 1]);
			result = result.split(find).join(replace);
		}
		return result;
	},

	// Map replace with regex patterns
	mapreplace: (data, args) => {
		if (!Array.isArray(args) || args.length < 2) return data;
		let result = data;
		for (let i = 0; i < args.length - 1; i += 2) {
			const pattern = String(args[i]);
			const replacement = String(args[i + 1]);
			const regex = createSafeRegex(pattern, 'g');
			if (regex) {
				result = safeReplace(result, regex, replacement);
			}
		}
		return result;
	},

	// Convert string to unicode escape sequences
	tounicode: (data) => {
		return Array.from(data)
			.map((char) => {
				const code = char.charCodeAt(0);
				if (code > 127) {
					return '\\u' + code.toString(16).padStart(4, '0');
				}
				return char;
			})
			.join('');
	},

	// Convert unicode escape sequences back to characters
	fromunicode: (data) => {
		return data.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
	},

	// If/then/else filter: if data matches condition, return then value, else return else value
	// Usage: | if "condition" "then" "else"
	ifthenelse: (data, args) => {
		if (!Array.isArray(args) || args.length < 2) return data;
		const [condition, thenValue, elseValue = ''] = args.map(String);

		// Check if data matches condition (can be regex or exact match)
		let matches = false;
		if (condition.startsWith('/') && condition.endsWith('/')) {
			// Regex pattern
			const pattern = condition.slice(1, -1);
			const regex = createSafeRegex(pattern);
			if (regex) {
				matches = safeMatch(data, regex) !== null;
			}
		} else {
			// Exact match or truthy check
			if (condition === 'true' || condition === '1') {
				matches = data.trim() !== '' && data !== '0' && data.toLowerCase() !== 'false';
			} else if (condition === 'false' || condition === '0') {
				matches = data.trim() === '' || data === '0' || data.toLowerCase() === 'false';
			} else {
				matches = data === condition;
			}
		}

		return matches ? thenValue : elseValue;
	},

	// Andmatch: Returns data if ALL patterns match, empty string otherwise
	andmatch: (data, args) => {
		if (!Array.isArray(args)) {
			const pattern = String(args);
			const regex = createSafeRegex(pattern);
			return regex && safeMatch(data, regex) ? data : '';
		}

		for (const pattern of args) {
			const regex = createSafeRegex(String(pattern));
			if (!regex || !safeMatch(data, regex)) {
				return '';
			}
		}
		return data;
	},

	// Ormatch: Returns data if ANY pattern matches, empty string otherwise
	ormatch: (data, args) => {
		if (!Array.isArray(args)) {
			const pattern = String(args);
			const regex = createSafeRegex(pattern);
			return regex && safeMatch(data, regex) ? data : '';
		}

		for (const pattern of args) {
			const regex = createSafeRegex(String(pattern));
			if (regex && safeMatch(data, regex)) {
				return data;
			}
		}
		return '';
	},

	// Path combine (joins path segments)
	pathcombine: (data, args) => {
		const segments = [data];
		if (Array.isArray(args)) {
			segments.push(...args.map(String));
		} else if (args) {
			segments.push(String(args));
		}
		// Join with / and normalize double slashes
		return segments
			.map((s) => s.replace(/^\/+|\/+$/g, ''))
			.filter(Boolean)
			.join('/');
	},

	// Get first non-empty value
	coalesce: (data, args) => {
		if (data && data.trim() !== '') return data;
		if (Array.isArray(args)) {
			for (const arg of args) {
				const val = String(arg);
				if (val && val.trim() !== '') return val;
			}
		} else if (args) {
			return String(args);
		}
		return data;
	},

	// Format number with locale
	formatnumber: (data, args) => {
		const num = parseFloat(data);
		if (isNaN(num)) return data;
		const locale = String(args ?? 'en-US');
		try {
			return num.toLocaleString(locale);
		} catch {
			return num.toString();
		}
	},

	// Pad left with character
	padleft: (data, args) => {
		if (!Array.isArray(args) || args.length < 2) return data;
		const [lengthStr, char] = args.map(String);
		const length = parseInt(lengthStr, 10);
		return data.padStart(length, char || ' ');
	},

	// Pad right with character
	padright: (data, args) => {
		if (!Array.isArray(args) || args.length < 2) return data;
		const [lengthStr, char] = args.map(String);
		const length = parseInt(lengthStr, 10);
		return data.padEnd(length, char || ' ');
	},

	// Substring
	substring: (data, args) => {
		if (!Array.isArray(args) || args.length < 1) return data;
		const start = parseInt(String(args[0]), 10);
		const length = args[1] !== undefined ? parseInt(String(args[1]), 10) : undefined;
		return length !== undefined ? data.slice(start, start + length) : data.slice(start);
	},

	// Contains check - returns data if contains substring, empty otherwise
	contains: (data, args) => {
		const needle = String(args ?? '');
		return data.includes(needle) ? data : '';
	},

	// Not contains - returns data if doesn't contain substring, empty otherwise
	notcontains: (data, args) => {
		const needle = String(args ?? '');
		return !data.includes(needle) ? data : '';
	},

	// Starts with check
	startswith: (data, args) => {
		const prefix = String(args ?? '');
		return data.startsWith(prefix) ? data : '';
	},

	// Ends with check
	endswith: (data, args) => {
		const suffix = String(args ?? '');
		return data.endsWith(suffix) ? data : '';
	},

	// Reverse string
	reverse: (data) => {
		return Array.from(data).reverse().join('');
	},

	// Word count
	wordcount: (data) => {
		return data.trim().split(/\s+/).filter(Boolean).length.toString();
	},

	// Line count
	linecount: (data) => {
		return data.split('\n').length.toString();
	},

	// Get first N characters
	first: (data, args) => {
		const count = parseInt(String(args ?? '1'), 10);
		return data.substring(0, count);
	},

	// Get last N characters
	last: (data, args) => {
		const count = parseInt(String(args ?? '1'), 10);
		return data.substring(Math.max(0, data.length - count));
	},

	// Default value if empty
	default: (data, args) => {
		return data && data.trim() !== '' ? data : String(args ?? '');
	},

	// JSON parse and extract path
	jsonpath: (data, args) => {
		const path = String(args ?? '');
		try {
			const obj = JSON.parse(data);
			const parts = path.split('.').filter(Boolean);
			let current: unknown = obj;
			for (const part of parts) {
				if (current === null || current === undefined) return '';
				if (typeof current === 'object') {
					current = (current as Record<string, unknown>)[part];
				} else {
					return '';
				}
			}
			return typeof current === 'object' ? JSON.stringify(current) : String(current ?? '');
		} catch {
			return '';
		}
	},

	// Base64 encode
	base64encode: (data) => {
		try {
			return Buffer.from(data, 'utf-8').toString('base64');
		} catch {
			return data;
		}
	},

	// Base64 decode
	base64decode: (data) => {
		try {
			return Buffer.from(data, 'base64').toString('utf-8');
		} catch {
			return data;
		}
	},

	// MD5 hash
	md5: (data) => {
		try {
			return createHash('md5').update(data).digest('hex');
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'MD5 hash failed'
			);
			return data;
		}
	},

	// SHA1 hash
	sha1: (data) => {
		try {
			return createHash('sha1').update(data).digest('hex');
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'SHA1 hash failed'
			);
			return data;
		}
	}
};

// ============================================================================
// FilterEngine Class
// ============================================================================

export class FilterEngine {
	private templateEngine?: TemplateEngine;

	constructor(templateEngine?: TemplateEngine) {
		this.templateEngine = templateEngine;
	}

	/**
	 * Set the template engine for variable expansion in filters.
	 */
	setTemplateEngine(templateEngine: TemplateEngine): void {
		this.templateEngine = templateEngine;
	}

	/**
	 * Apply a single filter to data.
	 */
	applyFilter(data: string, filter: FilterBlock): string {
		const filterFn = FILTERS[filter.name.toLowerCase()];
		if (!filterFn) {
			logger.warn({ filter: filter.name }, `Unknown filter: ${filter.name}`);
			return data;
		}

		try {
			return filterFn(data, filter.args, this.templateEngine);
		} catch (error) {
			logger.error({ err: error, ...{ filter: filter.name } }, `Filter ${filter.name} failed`);
			return data;
		}
	}

	/**
	 * Apply multiple filters in sequence.
	 */
	applyFilters(data: string, filters: FilterBlock[] | undefined): string {
		if (!filters || filters.length === 0) return data;

		let result = data;
		for (const filter of filters) {
			result = this.applyFilter(result, filter);
		}
		return result;
	}

	/**
	 * Check if a filter is registered.
	 */
	hasFilter(name: string): boolean {
		return name.toLowerCase() in FILTERS;
	}

	/**
	 * Register a custom filter.
	 */
	static registerFilter(name: string, fn: FilterFunction): void {
		FILTERS[name.toLowerCase()] = fn;
	}
}

/**
 * Create a new FilterEngine instance.
 */
export function createFilterEngine(templateEngine?: TemplateEngine): FilterEngine {
	return new FilterEngine(templateEngine);
}

// Export utility functions for direct use
export {
	parseDateWithLayout,
	parseRelativeTime,
	parseFuzzyTime,
	formatRfc1123,
	sanitizeFilename,
	normalizeDiacritics,
	htmlDecode,
	htmlEncode,
	extractQueryParam
};

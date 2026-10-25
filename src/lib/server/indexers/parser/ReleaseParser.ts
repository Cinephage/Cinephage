/**
 * Release Parser
 *
 * Parses release titles to extract structured metadata including:
 * - Quality attributes (resolution, source, codec, canonical audio, HDR)
 * - TV episode information (season, episode, packs)
 * - Language information
 * - Release group
 * - Edition and special flags (PROPER, REPACK, REMUX, 3D)
 */

import type { ParsedRelease } from './types.js';
import { extractResolution } from './patterns/resolution.js';
import { extractSource } from './patterns/source.js';
import { extractBitDepth, extractCodec } from './patterns/codec.js';
import { extractEnhancedAudio, extractHdr } from './patterns/audio.js';
import { extractLanguages } from './patterns/language.js';
import { extractEpisode, extractTitleBeforeEpisode } from './patterns/episode.js';
import { extractReleaseGroup } from './patterns/releaseGroup.js';

/**
 * Patterns for extracting year from title
 */

/**
 * Patterns for edition detection
 */
const EDITION_PATTERNS: Array<{ pattern: RegExp; edition: string }> = [
	{ pattern: /\bdirector'?s?[\s._-]?cut\b/i, edition: "Director's Cut" },
	{ pattern: /\bfinal[\s._-]?cut\b/i, edition: 'Final Cut' },
	{ pattern: /\bextended[\s._-]?(?:cut|edition)?\b/i, edition: 'Extended' },
	{ pattern: /\bunrated\b/i, edition: 'Unrated' },
	{ pattern: /\btheatrical\b/i, edition: 'Theatrical' },
	{ pattern: /\bremastered\b/i, edition: 'Remastered' },
	{ pattern: /\bimax[\s._-]?enhanced\b/i, edition: 'IMAX Enhanced' },
	{ pattern: /\bimax\b/i, edition: 'IMAX' },
	{ pattern: /\bhybrid\b/i, edition: 'Hybrid' },
	{ pattern: /\bcriterion\b/i, edition: 'Criterion' },
	{ pattern: /\bspecial[\s._-]?edition\b/i, edition: 'Special Edition' },
	{ pattern: /\banniversary[\s._-]?edition\b/i, edition: 'Anniversary Edition' },
	{ pattern: /\bcollector'?s?[\s._-]?edition\b/i, edition: "Collector's Edition" },
	{ pattern: /\bultimate[\s._-]?edition\b/i, edition: 'Ultimate Edition' },
	{ pattern: /\bopen[\s._-]?matte\b/i, edition: 'Open Matte' }
];

/**
 * Special flag patterns
 */
const FLAG_PATTERNS = {
	proper: /\bproper\b/i,
	repack: /\brepack\b/i,
	remux: /\bremux\b/i,
	is3d: /\b3d\b/i,
	hardcodedSubs: /\bhc\b|\bhardcoded\b|\bkorsub\b/i
};

const STREAMING_SERVICE_PATTERNS: Array<{ service: string; pattern: RegExp }> = [
	{ service: 'AMZN', pattern: /\b(AMZN|Amazon)\b/i },
	{ service: 'NF', pattern: /\b(NF|Netflix)\b/i },
	{ service: 'ATVP', pattern: /\b(ATVP|AppleTV\+?|Apple[ .]?TV)\b/i },
	{ service: 'DSNP', pattern: /\b(DSNP|Disney\+?|DisneyPlus)\b/i },
	{ service: 'HMAX', pattern: /\b(HMAX|HBO[ .]?Max)\b/i },
	{ service: 'MAX', pattern: /\bMAX\b/i },
	{ service: 'PCOK', pattern: /\b(PCOK|Peacock)\b/i },
	{ service: 'PMTP', pattern: /\b(PMTP|Paramount\+?)\b/i },
	{ service: 'HULU', pattern: /\bHULU\b/i },
	{ service: 'iT', pattern: /\b(iT|iTunes)\b/i },
	{ service: 'STAN', pattern: /\bSTAN\b/i },
	{ service: 'CRAV', pattern: /\b(CRAV|Crave)\b/i },
	{ service: 'NOW', pattern: /\bNOW\b/i },
	{ service: 'SHO', pattern: /\b(SHO|Showtime)\b/i },
	{ service: 'ROKU', pattern: /\bROKU\b/i },
	{ service: 'MUBI', pattern: /\bMUBI\b/i },
	{ service: 'CRIT', pattern: /\b(CRIT|Criterion)\b/i },
	{ service: 'DS4K', pattern: /\bDS4K\b/i },
	{ service: 'iQIYI', pattern: /\b(iQIYI|IQIYI)\b/i },
	{ service: 'TVING', pattern: /\bTVING\b/i },
	{ service: 'VIKI', pattern: /\bVIKI\b/i },
	{ service: 'VIU', pattern: /\bVIU\b/i },
	{ service: 'WAVVE', pattern: /\bWAVVE\b/i },
	{ service: 'WeTV', pattern: /\bWeTV\b/i },
	{ service: 'KOCOWA', pattern: /\b(KOCOWA|KCW)\b/i },
	{ service: 'BCORE', pattern: /\b(BCORE|Bravia[. ]?Core)\b/i },
	// Keep MA strict so DTS-HD MA is not misclassified as Movies Anywhere.
	{ service: 'MA', pattern: /\bMA(?=[ ._-]WEB(?:[ ._-]?(DL|Rip))?\b)/i }
];

export interface ParseOptions {
	/**
	 * Source indexer language (ISO 639-1 code). Recorded verbatim on the
	 * parsed release as source metadata (where the release came from) — it is
	 * NOT merged into `languages`, which reflects only what the title asserts.
	 */
	sourceLanguage?: string;
	/**
	 * Content context of the search that produced this title. In 'movie' mode,
	 * ambiguous word-based "Season N" markers are not extracted, so movie titles
	 * like "Open Season 3" keep their full title and are not mistaken for TV
	 * season packs. Unambiguous TV notation (SxxExx) is still detected.
	 * Default: 'auto' (all patterns, existing behavior).
	 */
	mode?: 'movie' | 'auto';
}

/**
 * ReleaseParser - Main parser class for release titles
 */
export class ReleaseParser {
	/**
	 * Parse a release title into structured metadata
	 *
	 * @param title - The release title to parse
	 * @param options - Optional parsing options
	 * @returns Parsed release information
	 */
	parse(title: string, options?: ParseOptions): ParsedRelease {
		const originalTitle = title;

		// Normalize the title for parsing
		const normalized = this.normalizeTitle(title);

		// Extract quality attributes
		const resolutionMatch = extractResolution(normalized);
		const sourceMatch = extractSource(normalized);
		const codecMatch = extractCodec(normalized);
		const bitDepthMatch = extractBitDepth(normalized);
		const enhancedAudio = extractEnhancedAudio(normalized);
		const hdrMatch = extractHdr(normalized);
		const streamingService = this.extractStreamingService(normalized);

		// Extract episode info (determines if TV release)
		const episodeMatch = extractEpisode(normalized, {
			movieMode: options?.mode === 'movie'
		});

		// Extract other metadata
		const languageMatch = extractLanguages(normalized);
		const groupMatch = extractReleaseGroup(normalized);
		const releaseGroup = this.resolveReleaseGroup(normalized, groupMatch, episodeMatch, [
			resolutionMatch?.index,
			sourceMatch?.index,
			codecMatch?.index,
			bitDepthMatch?.index,
			enhancedAudio.index,
			hdrMatch?.index
		]);
		const year = this.extractYear(normalized);
		const edition = this.extractEdition(normalized);

		// Title-detected languages only: the indexer definition language is
		// source metadata (where the release came from), not audio evidence,
		// and stays available separately via `sourceLanguage`.
		const languages = languageMatch.languages;

		// Extract special flags
		const isProper = FLAG_PATTERNS.proper.test(normalized);
		const isRepack = FLAG_PATTERNS.repack.test(normalized);
		const isRemux = FLAG_PATTERNS.remux.test(normalized) || sourceMatch?.source === 'remux';
		const is3d = FLAG_PATTERNS.is3d.test(normalized);
		const hasHardcodedSubs = FLAG_PATTERNS.hardcodedSubs.test(normalized);

		// Extract clean title
		const cleanTitle = this.extractCleanTitle(normalized, {
			isTv: episodeMatch !== null,
			year,
			resolutionIndex: resolutionMatch?.index,
			sourceIndex: sourceMatch?.index
		});

		// Calculate confidence score
		const confidence = this.calculateConfidence({
			hasResolution: resolutionMatch !== null,
			hasSource: sourceMatch !== null,
			hasCodec: codecMatch !== null,
			hasYear: year !== undefined,
			hasGroup: releaseGroup !== undefined,
			titleLength: cleanTitle.length
		});

		return {
			originalTitle,
			cleanTitle,
			year,
			resolution: resolutionMatch?.resolution ?? 'unknown',
			source: sourceMatch?.source ?? 'unknown',
			codec: codecMatch?.codec ?? 'unknown',
			hdr: hdrMatch?.hdr ?? null,
			bitDepth: bitDepthMatch?.bitDepth ?? 'unknown',
			audioCodec: enhancedAudio.codec,
			audioChannels: enhancedAudio.channels,
			hasAtmos: enhancedAudio.hasAtmos,
			episode: episodeMatch?.info,
			languages,
			sourceLanguage: options?.sourceLanguage,
			streamingService,
			releaseGroup,
			edition,
			isProper,
			isRepack,
			isRemux,
			is3d,
			hasHardcodedSubs,
			confidence
		};
	}

	/**
	 * Discard a release group that is actually the tail of the episode title.
	 *
	 * Stream sources expose release titles like "Show - S01E01 - In My Time of
	 * Dying" (no scene naming), where the trailing capitalized word belongs to
	 * the episode title, not a release group. To stay conservative, a group is
	 * only rejected when an episode was matched AND the candidate is the last
	 * word of the text after the SxxEyy marker, cut at the earliest quality
	 * token that follows it (only tokens after the marker matter — earlier
	 * ones don't bound the span): real groups almost always follow quality
	 * tokens or sit in brackets, which keeps them.
	 */
	private resolveReleaseGroup(
		normalized: string,
		groupMatch: ReturnType<typeof extractReleaseGroup>,
		episodeMatch: ReturnType<typeof extractEpisode>,
		qualityIndices: Array<number | undefined>
	): string | undefined {
		if (!groupMatch) {
			return undefined;
		}

		const group = groupMatch.group;

		// YTS/YIFY are indexer suffixes handled by dedicated normalization
		// patterns, never episode-title tail words.
		if (!episodeMatch || group === 'YTS') {
			return group;
		}

		// Drop a trailing file extension so the string end aligns with where
		// extractReleaseGroup matched (it strips extensions itself). Note:
		// normalizeTitle already turned dots into spaces, so extensions arrive
		// in their space-separated form (" ... mkv"), matching the space form
		// that extractReleaseGroup strips.
		const stripped = normalized.replace(/\s*(?:mkv|mp4|avi|m4v|webm|strm)$/i, '');

		// Episode-title span: text after the episode marker, cut at the
		// earliest quality token that follows it. Only quality tokens after
		// the SxxEyy marker bound the span; earlier ones are irrelevant.
		const spanStart = episodeMatch.index + episodeMatch.matchedText.length;
		let spanEnd = stripped.length;
		for (const index of qualityIndices) {
			if (index !== undefined && index > spanStart && index < spanEnd) {
				spanEnd = index;
			}
		}

		const span = stripped.slice(spanStart, spanEnd).trim();
		// Tokenize ignoring bracket-wrapped quality blocks and punctuation so
		// bracketed audio (e.g. "[AAC 2 0]" — dots were normalized to spaces)
		// does not mask the title tail when no quality matcher registered.
		const spanTokens = span
			.replace(/\[[^\]]*\]/g, ' ')
			.split(/[^A-Za-z0-9]+/)
			.filter(Boolean);
		const lastWord = spanTokens[spanTokens.length - 1];

		if (lastWord && lastWord.toLowerCase() === group.toLowerCase()) {
			return undefined;
		}
		return group;
	}

	private extractStreamingService(title: string): string | undefined {
		for (const { service, pattern } of STREAMING_SERVICE_PATTERNS) {
			if (pattern.test(title)) {
				return service;
			}
		}

		return undefined;
	}

	/**
	 * Normalize a release title for consistent parsing
	 * - Replace dots, underscores with spaces
	 * - Normalize multiple spaces
	 * - Trim whitespace
	 */
	private normalizeTitle(title: string): string {
		return (
			title
				// Replace common separators with spaces
				.replace(/[._]/g, ' ')
				// Normalize multiple spaces
				.replace(/\s+/g, ' ')
				// Trim
				.trim()
		);
	}

	/**
	 * Extract year from title
	 */
	private extractYear(title: string): number | undefined {
		// Prefer an explicitly parenthesized year ("Movie (2010) 1080p") and
		// otherwise take the LAST plausible 4-digit year: release names append
		// the release year at the end, while number-titled movies ("1917 2019",
		// "2001 A Space Odyssey (1968)", "Blade Runner 2049 (2017)") put their
		// own numbers earlier in the title. First-match extraction regularly
		// grabbed the title number instead of the release year.
		const parenMatches = Array.from(title.matchAll(/\((19|20)\d{2}\)/g));
		const anyMatches = Array.from(title.matchAll(/\b(?:19|20)\d{2}\b/g));
		const pool = parenMatches.length > 0 ? parenMatches : anyMatches;
		if (pool.length === 0) {
			return undefined;
		}
		const last = pool[pool.length - 1];
		const year = parseInt(last[0].replace(/[()]/g, ''), 10);
		// Sanity check: year should be reasonable (cinema begins ~1888)
		if (year >= 1888 && year <= new Date().getFullYear() + 2) {
			return year;
		}
		return undefined;
	}

	/**
	 * Extract edition from title
	 */
	private extractEdition(title: string): string | undefined {
		for (const { pattern, edition } of EDITION_PATTERNS) {
			if (pattern.test(title)) {
				return edition;
			}
		}
		return undefined;
	}

	/**
	 * Extract clean title (movie/show name only)
	 */
	private extractCleanTitle(
		normalized: string,
		context: {
			isTv: boolean;
			year?: number;
			resolutionIndex?: number;
			sourceIndex?: number;
		}
	): string {
		let title = normalized;

		// For TV shows, use the title before episode info
		if (context.isTv) {
			title = extractTitleBeforeEpisode(title);
		}

		// Find the earliest quality indicator to truncate at
		let cutoffIndex = title.length;

		// Resolution/source typically marks quality section
		if (context.resolutionIndex !== undefined) {
			cutoffIndex = Math.min(cutoffIndex, context.resolutionIndex);
		}
		if (context.sourceIndex !== undefined) {
			cutoffIndex = Math.min(cutoffIndex, context.sourceIndex);
		}

		// For movies with year: cut BEFORE the year (year is extracted separately to parsedYear)
		// This ensures cleanTitle contains just the title for better TMDB search matching
		// Also apply to TV shows to avoid duplicate years
		if (context.year) {
			const yearStr = String(context.year);
			// Match year with optional edition: "(2025)", "(2025-Director's Cut)",
			// "(2025 Director's Cut)", or "2025"
			const yearPatterns = [
				new RegExp(`\\s*\\(${yearStr}(?:[- ][^)]*)?\\)\\s*`), // (2025), (2025-Edition), (2025 Edition)
				new RegExp(`\\s+${yearStr}(?:\\s|$)`) // 2025 at word boundary
			];
			for (const pattern of yearPatterns) {
				const match = title.match(pattern);
				if (match && match.index !== undefined) {
					// Cut at year start, keeping everything before
					cutoffIndex = Math.min(cutoffIndex, match.index);
					break;
				}
			}
		}

		// Cut at the earliest indicator
		title = title.slice(0, cutoffIndex);

		// Clean up common artifacts
		title = title
			// Remove trailing bracketed metadata that can survive before quality cutoff
			.replace(/\s*[[(]][^\])]*(?:$)/g, '')
			// Remove trailing/leading separators and spaces
			.replace(/^[\s\-._]+|[\s\-._]+$/g, '')
			// Remove common prefix artifacts
			.replace(/^\[.*?\]\s*/g, '')
			// Normalize spaces
			.replace(/\s+/g, ' ')
			.trim();

		// Title case for nicer output
		return this.toTitleCase(title);
	}

	/**
	 * Convert string to title case
	 * Preserves roman numerals (I, II, III, IV, V, VI, VII, VIII, IX, X, etc.)
	 */
	private toTitleCase(str: string): string {
		const smallWords = new Set([
			'a',
			'an',
			'and',
			'as',
			'at',
			'but',
			'by',
			'for',
			'in',
			'nor',
			'of',
			'on',
			'or',
			'so',
			'the',
			'to',
			'up',
			'yet'
		]);

		// Roman numeral pattern (standalone words only)
		const romanNumeralPattern = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i;

		return str
			.split(' ')
			.map((word, index) => {
				// Preserve roman numerals in uppercase
				if (romanNumeralPattern.test(word) && word.length > 0) {
					return word.toUpperCase();
				}
				// Convert to lowercase for processing
				const lowerWord = word.toLowerCase();
				// Always capitalize first word
				if (index === 0) {
					return lowerWord.charAt(0).toUpperCase() + lowerWord.slice(1);
				}
				// Keep small words lowercase
				if (smallWords.has(lowerWord)) {
					return lowerWord;
				}
				// Capitalize other words
				return lowerWord.charAt(0).toUpperCase() + lowerWord.slice(1);
			})
			.join(' ');
	}

	/**
	 * Calculate parsing confidence score
	 */
	private calculateConfidence(indicators: {
		hasResolution: boolean;
		hasSource: boolean;
		hasCodec: boolean;
		hasYear: boolean;
		hasGroup: boolean;
		titleLength: number;
	}): number {
		let score = 0;

		// Each quality indicator adds to confidence
		if (indicators.hasResolution) score += 0.2;
		if (indicators.hasSource) score += 0.2;
		if (indicators.hasCodec) score += 0.15;
		if (indicators.hasYear) score += 0.15;
		if (indicators.hasGroup) score += 0.1;

		// Reasonable title length adds confidence
		if (indicators.titleLength >= 2 && indicators.titleLength <= 100) {
			score += 0.1;
		}

		// Base confidence for any parse
		score += 0.1;

		return Math.min(1, score);
	}
}

/**
 * Singleton instance for convenience
 */
export const releaseParser = new ReleaseParser();

/**
 * Convenience function to parse a release title
 */
export function parseRelease(title: string, options?: ParseOptions): ParsedRelease {
	return releaseParser.parse(title, options);
}

/**
 * Extracted external IDs from folder/file names
 */
export interface ExtractedIds {
	tmdbId?: number;
	tvdbId?: number;
	imdbId?: string;
}

/**
 * Patterns for detecting external IDs in folder/file names
 * Supports common naming conventions from Sonarr, Radarr, Plex, and scene releases
 */
const EXTERNAL_ID_PATTERNS = {
	// TVDB patterns (common in Sonarr/Plex TV libraries)
	tvdb: [
		/\{tvdb-(\d+)\}/i, // {tvdb-12345}
		/\[tvdb-(\d+)\]/i, // [tvdb-12345]
		/\[tvdbid[-=](\d+)\]/i, // [tvdbid-12345] or [tvdbid=12345]
		/\.tvdbid-(\d+)\./i, // .tvdbid-12345.
		/\btvdb[-_]?id[-_=]?(\d+)\b/i, // tvdbid12345, tvdb-id-12345, tvdb_id=12345
		/\btvdb-(\d+)\b/i // tvdb-12345 (simple format without braces)
	],
	// TMDB patterns (common in Radarr libraries)
	tmdb: [
		/\{tmdb-(\d+)\}/i, // {tmdb-12345}
		/\[tmdb-(\d+)\]/i, // [tmdb-12345]
		/\[tmdbid[-=](\d+)\]/i, // [tmdbid-12345] or [tmdbid=12345]
		/\.tmdbid-(\d+)\./i, // .tmdbid-12345.
		/\btmdb[-_]?id[-_=]?(\d+)\b/i, // tmdbid12345, tmdb-id-12345, tmdb_id=12345
		/\btmdb-(\d+)\b/i // tmdb-12345 (simple format without braces)
	],
	// IMDB patterns (common in scene releases and various tools)
	imdb: [
		/\{imdb-(tt\d+)\}/i, // {imdb-tt1234567}
		/\[imdb-(tt\d+)\]/i, // [imdb-tt1234567]
		/\[imdbid[-=](tt\d+)\]/i, // [imdbid-tt1234567] or [imdbid=tt1234567]
		/\.(tt\d{7,})\./i, // .tt1234567. (standalone in filename)
		/\b(tt\d{7,})\b/i // tt1234567 (IMDB IDs are at least 7 digits)
	]
} as const;

/**
 * Extract external IDs (TMDB, TVDB, IMDB) from a file path or release title
 *
 * Used for matching content from libraries that include external IDs in folder names,
 * such as Sonarr (TVDB), Radarr (TMDB), or scene releases (IMDB).
 *
 * @param input - The file path or release title to extract IDs from
 * @returns Object containing any extracted IDs
 *
 * @example
 * extractExternalIds('Breaking Bad {tvdb-81189}/Season 01/')
 * // => { tvdbId: 81189 }
 *
 * @example
 * extractExternalIds('Inception {tmdb-27205} (2010)')
 * // => { tmdbId: 27205 }
 *
 * @example
 * extractExternalIds('The.Godfather.1972.tt0068646.1080p.BluRay.mkv')
 * // => { imdbId: 'tt0068646' }
 */
export function extractExternalIds(input: string): ExtractedIds {
	const ids: ExtractedIds = {};

	// Extract TVDB ID
	for (const pattern of EXTERNAL_ID_PATTERNS.tvdb) {
		const match = input.match(pattern);
		if (match) {
			ids.tvdbId = parseInt(match[1], 10);
			break;
		}
	}

	// Extract TMDB ID
	for (const pattern of EXTERNAL_ID_PATTERNS.tmdb) {
		const match = input.match(pattern);
		if (match) {
			ids.tmdbId = parseInt(match[1], 10);
			break;
		}
	}

	// Extract IMDB ID
	for (const pattern of EXTERNAL_ID_PATTERNS.imdb) {
		const match = input.match(pattern);
		if (match) {
			ids.imdbId = match[1];
			break;
		}
	}

	return ids;
}

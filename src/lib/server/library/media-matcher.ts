/**
 * Media Matcher Service
 *
 * Matches unmatched files to TMDB entries using parsed filename info.
 * Auto-matches high-confidence results and flags low-confidence for manual review.
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { db } from '#lib/server/db/index.js';
import { todayDateString } from '#lib/utils/format.js';
import {
	unmatchedFiles,
	movies,
	movieFiles,
	series,
	seasons,
	episodes,
	episodeFiles,
	librarySettings,
	rootFolders,
	downloadQueue,
	downloadHistory,
	requests
} from '#lib/server/db/schema.js';
import { eq, and, gt, asc, inArray } from 'drizzle-orm';
import { tmdb, type SearchResult } from '#lib/server/tmdb.js';
import { mediaInfoService } from './media-info.js';
import { basename, dirname, extname, isAbsolute, join, relative } from 'path';
import { RootFolderConflictError } from '#lib/errors/index.js';
import { searchSubtitlesForNewMedia } from '#lib/server/subtitles/services/SubtitleImportService.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { logger, createChildLogger } from '#lib/logging/index.js';
import { parseRelease, extractExternalIds } from '#lib/server/indexers/parser/ReleaseParser.js';
import { getMediaParseStem } from './media-utils.js';
import {
	resolveTvEpisodeIdentifier,
	extractSeasonFromPath,
	matchEpisodesByIdentifier
} from './tv-episode-resolver.js';
import { matchSpecialEpisodeByTitle } from './episode-title-matcher.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
import { canonicalizeArticleTitle, calculateMatchConfidence } from './title-matching.js';
import { deleteAllSeasonsAndEpisodes } from '#lib/server/metadata/EpisodeGroupService.js';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';
import { RenamePreviewService } from './naming/RenamePreviewService.js';
import { getSidecarSettings } from '#lib/server/library/sidecar/sidecarSettings.js';
import { resolveMovieMultiQuality } from '#lib/server/quality/movie-buckets.js';
import {
	computeMovieReplacement,
	computeEpisodeReplacement
} from '#lib/server/downloadClients/import/replacement.js';
import { deletePhysicalFile } from '#lib/server/downloadClients/import/FileTransfer.js';
import { getFileManagementSettings } from '#lib/server/settings/file-management.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';
import {
	buildMovieNfo,
	buildSeriesNfo,
	buildSeasonNfo,
	buildEpisodeNfo,
	nfoPathFor
} from '#lib/server/library/sidecar/NfoGenerator.js';
import {
	downloadSidecarImage,
	shouldWriteSidecar,
	tmdbImageUrl,
	movieArtworkPaths,
	seriesArtworkPaths,
	seasonArtworkPath,
	folderOf
} from '#lib/server/library/sidecar/SidecarImageService.js';

/**
 * Default match confidence threshold (0.0 - 1.0)
 * Matches above this are auto-accepted
 */
const DEFAULT_MATCH_THRESHOLD = 0.8;

/**
 * Match result for a single file
 */
export interface MatchResult {
	fileId: string;
	filePath: string;
	matched: boolean;
	tmdbId?: number;
	title?: string;
	confidence: number;
	reason?: string;
}

/**
 * Suggested match from TMDB search
 */
interface SuggestedMatch {
	tmdbId: number;
	title: string;
	year?: number;
	confidence: number;
}

/**
 * MediaMatcherService - Match files to TMDB entries
 */
export class MediaMatcherService {
	private static instance: MediaMatcherService;

	private constructor() {}

	static getInstance(): MediaMatcherService {
		if (!MediaMatcherService.instance) {
			MediaMatcherService.instance = new MediaMatcherService();
		}
		return MediaMatcherService.instance;
	}

	/**
	 * Upsert episode file by (seriesId, relativePath) to avoid duplicate rows.
	 */
	private async upsertEpisodeFileByPath(
		record: Omit<typeof episodeFiles.$inferInsert, 'id'>
	): Promise<string> {
		const existing = await db
			.select({ id: episodeFiles.id })
			.from(episodeFiles)
			.where(
				and(
					eq(episodeFiles.seriesId, record.seriesId),
					eq(episodeFiles.relativePath, record.relativePath)
				)
			)
			.limit(1);

		if (existing.length > 0) {
			await db.update(episodeFiles).set(record).where(eq(episodeFiles.id, existing[0].id));
			return existing[0].id;
		}

		const [inserted] = await db
			.insert(episodeFiles)
			.values(record)
			.onConflictDoNothing()
			.returning({ id: episodeFiles.id });
		if (inserted) return inserted.id;
		const [raced] = await db
			.select({ id: episodeFiles.id })
			.from(episodeFiles)
			.where(
				and(
					eq(episodeFiles.seriesId, record.seriesId),
					eq(episodeFiles.relativePath, record.relativePath)
				)
			)
			.limit(1);
		return raced.id;
	}

	/**
	 * Get the configured match threshold
	 */
	private async getMatchThreshold(): Promise<number> {
		const setting = await db
			.select()
			.from(librarySettings)
			.where(eq(librarySettings.key, 'auto_match_threshold'))
			.limit(1);

		if (setting.length > 0) {
			const value = parseFloat(setting[0].value);
			if (!isNaN(value) && value >= 0 && value <= 1) {
				return value;
			}
		}

		return DEFAULT_MATCH_THRESHOLD;
	}

	/**
	 * Calculate match confidence between parsed info and TMDB result.
	 * Delegates to the shared title-matching primitives (kept in sync with
	 * ManualImportService).
	 */
	private calculateMatchConfidence(
		parsedTitle: string,
		parsedYear: number | undefined,
		tmdbTitle: string,
		tmdbYear: number | undefined,
		tmdbOriginalTitle?: string
	): number {
		return calculateMatchConfidence(
			parsedTitle,
			parsedYear,
			tmdbTitle,
			tmdbYear,
			tmdbOriginalTitle
		);
	}

	/**
	 * Search TMDB and find best matches for a file
	 *
	 * Matching priority:
	 * 1. TMDB ID embedded in path (100% confidence)
	 * 2. TVDB ID embedded in path → cross-reference via TMDB (100% confidence)
	 * 3. IMDB ID embedded in path → cross-reference via TMDB (100% confidence)
	 * 4. Title search with fuzzy matching (variable confidence)
	 */
	/**
	 * Derive candidate series names from the file's path segments relative to
	 * its root folder. For TV layouts (<root>/<Series>/Season NN/<file>), the
	 * first segment is the series directory — the most reliable title signal
	 * available when the filename itself is polluted with episode identifiers.
	 */
	private async getPathSeriesCandidates(
		file: typeof unmatchedFiles.$inferSelect
	): Promise<string[]> {
		if (file.mediaType !== 'tv' || !file.rootFolderId) return [];

		const [root] = await db.select().from(rootFolders).where(eq(rootFolders.id, file.rootFolderId));
		if (!root) return [];

		const rel = relative(root.path, file.path);
		const segments = rel.split(/[\\/]/).filter((s) => s.length > 0);
		if (segments.length <= 1) return []; // file sits directly under the root

		const candidates: string[] = [];
		for (const segment of segments.slice(0, 2)) {
			const parsedSegment = parseRelease(segment);
			const cleaned = (parsedSegment.cleanTitle || '').trim();
			if (!cleaned) continue;
			// Skip structural folders ("Season 03", "Specials", "Extras", ...)
			if (/^(season|s\d|specials?|extras?|featurettes?)/i.test(cleaned)) continue;
			if (!candidates.some((c) => c.toLowerCase() === cleaned.toLowerCase())) {
				candidates.push(cleaned);
			}
			if (candidates.length >= 2) break;
		}
		return candidates;
	}

	private async findMatches(
		title: string,
		year: number | undefined,
		mediaType: 'movie' | 'tv',
		filePath: string,
		seriesCandidates: string[] = []
	): Promise<SuggestedMatch[]> {
		try {
			// Extract external IDs from folder/file path
			const extractedIds = extractExternalIds(filePath);

			// Priority 1: Direct TMDB ID lookup (highest confidence)
			if (extractedIds.tmdbId) {
				const match = await this.lookupByTmdbId(extractedIds.tmdbId, mediaType);
				if (match) {
					logger.info(
						{
							tmdbId: extractedIds.tmdbId,
							title: match.title,
							filePath
						},
						'[MediaMatcher] Matched via TMDB ID in path'
					);
					return [match];
				}
			}

			// Priority 2: TVDB ID → TMDB cross-reference
			if (extractedIds.tvdbId) {
				const match = await this.lookupByTvdbId(extractedIds.tvdbId);
				if (match) {
					logger.info(
						{
							tvdbId: extractedIds.tvdbId,
							tmdbId: match.tmdbId,
							title: match.title,
							filePath
						},
						'[MediaMatcher] Matched via TVDB ID in path'
					);
					return [match];
				}
			}

			// Priority 3: IMDB ID → TMDB cross-reference
			if (extractedIds.imdbId) {
				const match = await this.lookupByImdbId(extractedIds.imdbId, mediaType);
				if (match) {
					logger.info(
						{
							imdbId: extractedIds.imdbId,
							tmdbId: match.tmdbId,
							title: match.title,
							filePath
						},
						'[MediaMatcher] Matched via IMDB ID in path'
					);
					return [match];
				} else {
					logger.warn(
						{
							imdbId: extractedIds.imdbId,
							filePath
						},
						'[MediaMatcher] IMDB ID found in path but not in TMDB, falling back to title search'
					);
				}
			}

			// Search result shared by the remaining priorities
			let results: SearchResult;

			// Priority 4 (TV): series-directory context. For files organized as
			// <root>/<Series>/Season NN/<file>, the folder name is the series
			// title — far more reliable than the filename, which is often
			// dominated by episode identifiers TMDB cannot match (#513).
			if (mediaType === 'tv' && seriesCandidates.length > 0) {
				for (const candidate of seriesCandidates) {
					// Canonicalize inverted-article folder names ("Lion King, The")
					// before both the TMDB query and confidence scoring.
					const canonicalCandidate = canonicalizeArticleTitle(candidate);
					results = await tmdb.searchTv(canonicalCandidate, undefined, true);
					if (!results.results || results.results.length === 0) continue;

					const matches: SuggestedMatch[] = results.results.slice(0, 5).map((result) => {
						const resultTitle = result.title || result.name || '';
						const resultDate = result.first_air_date || result.release_date;
						const resultYear = resultDate ? parseInt(resultDate.split('-')[0]) : undefined;

						return {
							tmdbId: result.id,
							title: resultTitle,
							year: resultYear,
							confidence: this.calculateMatchConfidence(
								canonicalCandidate,
								year,
								resultTitle,
								resultYear,
								result.original_title ?? result.original_name
							)
						};
					});
					matches.sort((a, b) => b.confidence - a.confidence);

					logger.info(
						{ filePath, seriesCandidate: canonicalCandidate, candidates: matches.length },
						'[MediaMatcher] Matched via series directory name'
					);
					return matches;
				}
			}

			// Priority 5: Fall back to filename-title search
			// Use skipFilters=true to bypass global filters (min rating, vote count)
			// so that all TMDB results are visible for matching
			// Canonicalize inverted-article titles ("Lion King, The" → "The Lion
			// King") before both the TMDB query and confidence scoring.
			const canonicalTitle = canonicalizeArticleTitle(title);
			if (mediaType === 'movie') {
				results = await tmdb.searchMovies(canonicalTitle, year, true);
			} else {
				results = await tmdb.searchTv(canonicalTitle, year, true);
			}

			if (!results.results || results.results.length === 0) {
				return [];
			}

			// Calculate confidence for each result
			const matches: SuggestedMatch[] = results.results.slice(0, 5).map((result) => {
				const resultTitle = result.title || result.name || '';
				const resultDate = result.release_date || result.first_air_date;
				const resultYear = resultDate ? parseInt(resultDate.split('-')[0]) : undefined;

				return {
					tmdbId: result.id,
					title: resultTitle,
					year: resultYear,
					confidence: this.calculateMatchConfidence(
						canonicalTitle,
						year,
						resultTitle,
						resultYear,
						result.original_title ?? result.original_name
					)
				};
			});

			// Sort by confidence descending
			matches.sort((a, b) => b.confidence - a.confidence);

			return matches;
		} catch (error) {
			logger.error(
				{ err: error instanceof Error ? error : undefined, ...{ title } },
				'[MediaMatcher] TMDB search failed'
			);
			return [];
		}
	}

	/**
	 * Lookup by direct TMDB ID
	 */
	private async lookupByTmdbId(
		tmdbId: number,
		mediaType: 'movie' | 'tv'
	): Promise<SuggestedMatch | null> {
		try {
			if (mediaType === 'movie') {
				const movie = await tmdb.getMovie(tmdbId);
				return {
					tmdbId: movie.id,
					title: movie.title,
					year: movie.release_date ? parseInt(movie.release_date.split('-')[0]) : undefined,
					confidence: 1.0
				};
			} else {
				const show = await tmdb.getTVShow(tmdbId);
				return {
					tmdbId: show.id,
					title: show.name,
					year: show.first_air_date ? parseInt(show.first_air_date.split('-')[0]) : undefined,
					confidence: 1.0
				};
			}
		} catch (error) {
			logger.warn(
				{
					tmdbId,
					mediaType,
					error: error instanceof Error ? error.message : String(error)
				},
				'[MediaMatcher] TMDB ID lookup failed'
			);
			return null;
		}
	}

	/**
	 * Lookup by TVDB ID using TMDB's cross-reference API
	 */
	private async lookupByTvdbId(tvdbId: number): Promise<SuggestedMatch | null> {
		try {
			const result = await tmdb.findByExternalId(String(tvdbId), 'tvdb_id');

			// TVDB IDs are primarily for TV shows
			if (result.tv_results.length > 0) {
				const show = result.tv_results[0];
				return {
					tmdbId: show.id,
					title: show.name,
					year: show.first_air_date ? parseInt(show.first_air_date.split('-')[0]) : undefined,
					confidence: 1.0
				};
			}

			return null;
		} catch (error) {
			logger.warn(
				{
					tvdbId,
					error: error instanceof Error ? error.message : String(error)
				},
				'[MediaMatcher] TVDB ID lookup failed'
			);
			return null;
		}
	}

	/**
	 * Lookup by IMDB ID using TMDB's cross-reference API
	 */
	private async lookupByImdbId(
		imdbId: string,
		mediaType: 'movie' | 'tv'
	): Promise<SuggestedMatch | null> {
		try {
			const result = await tmdb.findByExternalId(imdbId, 'imdb_id');

			// Prefer the expected media type, but accept either
			if (mediaType === 'movie' && result.movie_results.length > 0) {
				const movie = result.movie_results[0];
				return {
					tmdbId: movie.id,
					title: movie.title,
					year: movie.release_date ? parseInt(movie.release_date.split('-')[0]) : undefined,
					confidence: 1.0
				};
			}

			if (mediaType === 'tv' && result.tv_results.length > 0) {
				const show = result.tv_results[0];
				return {
					tmdbId: show.id,
					title: show.name,
					year: show.first_air_date ? parseInt(show.first_air_date.split('-')[0]) : undefined,
					confidence: 1.0
				};
			}

			// Fall back to any result type
			if (result.movie_results.length > 0) {
				const movie = result.movie_results[0];
				return {
					tmdbId: movie.id,
					title: movie.title,
					year: movie.release_date ? parseInt(movie.release_date.split('-')[0]) : undefined,
					confidence: 1.0
				};
			}

			if (result.tv_results.length > 0) {
				const show = result.tv_results[0];
				return {
					tmdbId: show.id,
					title: show.name,
					year: show.first_air_date ? parseInt(show.first_air_date.split('-')[0]) : undefined,
					confidence: 1.0
				};
			}

			return null;
		} catch (error) {
			logger.warn(
				{
					imdbId,
					error: error instanceof Error ? error.message : String(error)
				},
				'[MediaMatcher] IMDB ID lookup failed'
			);
			return null;
		}
	}

	/**
	 * Process an unmatched file and try to match it
	 */
	async processUnmatchedFile(fileId: string): Promise<MatchResult> {
		const [file] = await db.select().from(unmatchedFiles).where(eq(unmatchedFiles.id, fileId));

		if (!file) {
			return {
				fileId,
				filePath: '',
				matched: false,
				confidence: 0,
				reason: 'File not found'
			};
		}

		const correlationId = randomUUID();
		const matchLogger = createChildLogger({ logDomain: 'scans' as const, correlationId });
		const threshold = await this.getMatchThreshold();

		// Re-parse the filename to get the correct clean title
		// This ensures we use the updated parser logic even for existing records
		const filename = basename(file.path, extname(file.path));
		const parsed = parseRelease(filename);
		const searchTitle = parsed.cleanTitle || file.parsedTitle || filename;
		const searchYear = parsed.year || file.parsedYear || undefined;

		matchLogger.info(
			{ fileId, filePath: file.path, parsedTitle: searchTitle, mediaType: file.mediaType },
			'[MediaMatcher] Processing unmatched file'
		);

		// Find matches (checks for embedded IDs first, then series-directory
		// context, then falls back to title search)
		const seriesCandidates = await this.getPathSeriesCandidates(file);
		const matches = await this.findMatches(
			searchTitle,
			searchYear,
			file.mediaType as 'movie' | 'tv',
			file.path,
			seriesCandidates
		);

		if (matches.length === 0) {
			matchLogger.info({ fileId, filePath: file.path }, '[MediaMatcher] No TMDB matches found');
			// Update file with no match reason
			await db
				.update(unmatchedFiles)
				.set({
					reason: 'no_match',
					suggestedMatches: [],
					correlationId
				})
				.where(eq(unmatchedFiles.id, fileId));

			return {
				fileId,
				filePath: file.path,
				matched: false,
				confidence: 0,
				reason: 'No matches found in TMDB'
			};
		}

		const bestMatch = matches[0];

		matchLogger.info(
			{
				fileId,
				candidates: matches.length,
				topCandidate: bestMatch.title,
				topTmdbId: bestMatch.tmdbId,
				topConfidence: bestMatch.confidence,
				threshold
			},
			'[MediaMatcher] TMDB search results'
		);

		// Store all suggested matches
		await db
			.update(unmatchedFiles)
			.set({
				suggestedMatches: matches.slice(0, 5),
				correlationId
			})
			.where(eq(unmatchedFiles.id, fileId));

		// Check if best match exceeds threshold
		if (bestMatch.confidence >= threshold) {
			// Auto-match
			try {
				matchLogger.info(
					{
						fileId,
						tmdbId: bestMatch.tmdbId,
						title: bestMatch.title,
						confidence: bestMatch.confidence
					},
					'[MediaMatcher] Auto-matching above threshold'
				);
				await this.acceptMatch(fileId, bestMatch.tmdbId, file.mediaType as 'movie' | 'tv');
			} catch (error) {
				if (error instanceof RootFolderConflictError) {
					// Keep the file unmatched with a clear reason instead of
					// writing an unresolvable file link (bug #488).
					matchLogger.warn(
						{ fileId, tmdbId: bestMatch.tmdbId, error: error.message },
						'[MediaMatcher] Root folder conflict - keeping unmatched'
					);
					await db
						.update(unmatchedFiles)
						.set({ reason: 'root_folder_conflict', correlationId })
						.where(eq(unmatchedFiles.id, fileId));

					return {
						fileId,
						filePath: file.path,
						matched: false,
						tmdbId: bestMatch.tmdbId,
						title: bestMatch.title,
						confidence: bestMatch.confidence,
						reason: error.message
					};
				}
				matchLogger.error(
					{ fileId, tmdbId: bestMatch.tmdbId, err: error },
					'[MediaMatcher] acceptMatch failed'
				);
				throw error;
			}

			matchLogger.info(
				{ fileId, tmdbId: bestMatch.tmdbId, title: bestMatch.title },
				'[MediaMatcher] Auto-match successful'
			);
			return {
				fileId,
				filePath: file.path,
				matched: true,
				tmdbId: bestMatch.tmdbId,
				title: bestMatch.title,
				confidence: bestMatch.confidence
			};
		} else {
			// Below threshold - assign a reason code that reflects why.
			// multiple_matches: 2+ candidates with a clear leader (safe to force)
			// ambiguous:        2+ candidates where top two are within 10pp of each other
			// low_confidence:   single candidate or very low absolute score
			let reason: string;
			let ambiguityMargin: number | null = null;
			if (matches.length >= 2) {
				const margin = matches[0].confidence - matches[1].confidence;
				ambiguityMargin = Math.round(margin * 100) / 100;
				reason = margin < 0.1 ? 'ambiguous' : 'multiple_matches';
			} else {
				reason = 'low_confidence';
			}

			matchLogger.info(
				{ fileId, reason, confidence: bestMatch.confidence, threshold, ambiguityMargin },
				'[MediaMatcher] Match below threshold'
			);
			await db
				.update(unmatchedFiles)
				.set({ reason, correlationId, ambiguityMargin })
				.where(eq(unmatchedFiles.id, fileId));

			return {
				fileId,
				filePath: file.path,
				matched: false,
				tmdbId: bestMatch.tmdbId,
				title: bestMatch.title,
				confidence: bestMatch.confidence,
				reason: `Confidence ${Math.round(bestMatch.confidence * 100)}% below threshold ${Math.round(threshold * 100)}%`
			};
		}
	}

	/**
	 * Process all unmatched files
	 */
	async processAllUnmatched(): Promise<MatchResult[]> {
		const files = await db.select().from(unmatchedFiles);
		const results: MatchResult[] = [];

		for (const file of files) {
			try {
				const result = await this.processUnmatchedFile(file.id);
				results.push(result);
			} catch (error) {
				const reason = error instanceof Error ? error.message : 'Unknown matching error';
				logger.error(
					{
						fileId: file.id,
						filePath: file.path,
						reason
					},
					'[MediaMatcher] Failed to process unmatched file'
				);
				results.push({
					fileId: file.id,
					filePath: file.path,
					matched: false,
					confidence: 0,
					reason
				});
			}

			// Small delay to avoid rate limiting
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		return results;
	}

	/**
	 * Process unmatched files scoped to a root folder, in bounded pages.
	 * Avoids loading all unmatched rows at once. Returns after processing
	 * one page so callers can chain multiple calls or let the worker loop.
	 */
	async processUnmatchedByRootFolder(
		rootFolderId: string,
		limit = 50,
		afterId: string | null = null
	): Promise<{ results: MatchResult[]; hasMore: boolean; nextCursor: string | null }> {
		// Keyset pagination (WHERE id > cursor ORDER BY id): rows deleted by a
		// successful match must not shift the window. Absolute OFFSET skips
		// half the remaining files when matches remove rows mid-pass (#513).
		const rows = await db
			.select()
			.from(unmatchedFiles)
			.where(
				afterId
					? and(eq(unmatchedFiles.rootFolderId, rootFolderId), gt(unmatchedFiles.id, afterId))
					: eq(unmatchedFiles.rootFolderId, rootFolderId)
			)
			.orderBy(asc(unmatchedFiles.id))
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const page = rows.slice(0, limit);
		const nextCursor = page.length > 0 ? page[page.length - 1].id : afterId;
		const results: MatchResult[] = [];

		for (const file of page) {
			try {
				const result = await this.processUnmatchedFile(file.id);
				results.push(result);
			} catch (error) {
				const reason = error instanceof Error ? error.message : 'Unknown matching error';
				logger.error(
					{ fileId: file.id, filePath: file.path, reason },
					'[MediaMatcher] Failed to process unmatched file'
				);
				results.push({
					fileId: file.id,
					filePath: file.path,
					matched: false,
					confidence: 0,
					reason
				});
			}
			// Small delay between files; matches processAllUnmatched and keeps the event loop
			// responsive on systems where ffprobe I/O can saturate a NAS-backed volume.
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
		}

		return { results, hasMore, nextCursor };
	}

	/**
	 * Accept a match and create the library entry
	 */
	async acceptMatch(
		unmatchedFileId: string,
		tmdbId: number,
		mediaType: 'movie' | 'tv',
		options?: { allowReplace?: boolean }
	): Promise<void> {
		const allowReplace = options?.allowReplace ?? false;
		const [file] = await db
			.select()
			.from(unmatchedFiles)
			.where(eq(unmatchedFiles.id, unmatchedFileId));

		if (!file) {
			throw new Error(`Unmatched file not found: ${unmatchedFileId}`);
		}

		if (!file.rootFolderId) {
			throw new Error(`File has no root folder assigned: ${file.path}`);
		}

		// Get root folder
		const [rootFolder] = await db
			.select()
			.from(rootFolders)
			.where(eq(rootFolders.id, file.rootFolderId));

		if (!rootFolder) {
			throw new Error(`Root folder not found: ${file.rootFolderId}`);
		}

		// Guard: if this file is already present in the library, the unmatchedFiles record
		// is stale (e.g. retry after a prior partial failure). Remove it and return early
		// rather than re-running the full create path and hitting UNIQUE constraints.
		{
			const relPath = file.path.replace(rootFolder.path, '').replace(/^\//, '');
			let alreadyMatched = false;

			if (mediaType === 'movie') {
				const [existingMovie] = await db
					.select({ id: movies.id })
					.from(movies)
					.where(eq(movies.tmdbId, tmdbId))
					.limit(1);
				if (existingMovie) {
					const [existingFile] = await db
						.select({ id: movieFiles.id })
						.from(movieFiles)
						.where(
							and(
								eq(movieFiles.movieId, existingMovie.id),
								eq(movieFiles.relativePath, basename(relPath))
							)
						)
						.limit(1);
					alreadyMatched = !!existingFile;
				}
			} else {
				const pathParts = relPath.split('/');
				const seriesFolder = pathParts[0] || relPath;
				const epRelPath = relPath.replace(seriesFolder + '/', '');
				const [existingSeries] = await db
					.select({ id: series.id })
					.from(series)
					.where(eq(series.tmdbId, tmdbId))
					.limit(1);
				if (existingSeries) {
					const [existingFile] = await db
						.select({ id: episodeFiles.id })
						.from(episodeFiles)
						.where(
							and(
								eq(episodeFiles.seriesId, existingSeries.id),
								eq(episodeFiles.relativePath, epRelPath)
							)
						)
						.limit(1);
					alreadyMatched = !!existingFile;
				}
			}

			if (alreadyMatched) {
				logger.debug(
					{ unmatchedFileId, filePath: file.path },
					'[MediaMatcher] File already in library; removing stale unmatched record'
				);
				await db.delete(unmatchedFiles).where(eq(unmatchedFiles.id, unmatchedFileId));
				return;
			}
		}

		// Refuse matches that would produce unresolvable file links: if the
		// target movie/series already exists, every consumer resolves file
		// rows through the existing entry's root folder + path. Linking a file
		// that lives outside that scope (different root folder, or a different
		// folder layout) writes a row whose resolved path does not exist on
		// disk - ENOENT on rename/delete/playback plus a false "complete"
		// state. This mirrors the linkage rule disk-scan enforces.
		await this.assertNoRootFolderConflict(file, tmdbId, mediaType);

		// Skip .strm probing for existing items using the Streamer profile
		let allowStrmProbe: boolean;
		if (mediaType === 'movie') {
			const [existingMovie] = await db
				.select({ scoringProfileId: movies.scoringProfileId })
				.from(movies)
				.where(eq(movies.tmdbId, tmdbId));
			allowStrmProbe = existingMovie?.scoringProfileId !== 'streamer';
		} else {
			const [existingSeries] = await db
				.select({ scoringProfileId: series.scoringProfileId })
				.from(series)
				.where(eq(series.tmdbId, tmdbId));
			allowStrmProbe = existingSeries?.scoringProfileId !== 'streamer';
		}

		// Extract media info
		const mediaInfo = await mediaInfoService.extractMediaInfo(file.path, { allowStrmProbe });

		if (mediaType === 'movie') {
			await this.createMovieEntry(file, tmdbId, rootFolder, mediaInfo, allowReplace);
		} else {
			await this.createSeriesEntry(file, tmdbId, rootFolder, mediaInfo, allowReplace);
		}

		// Remove from unmatched
		await db.delete(unmatchedFiles).where(eq(unmatchedFiles.id, unmatchedFileId));
	}

	/**
	 * Refuse a match when the target movie/series already exists under a
	 * different root folder or folder layout than the file being matched.
	 *
	 * Consumers (import/rename/playback, disk-scan) resolve file rows through
	 * the existing entry's root folder + path, so a file outside that scope
	 * can never be linked honestly. The disk-scan auto-link path enforces the
	 * same rule; this keeps the accept-match path consistent with it.
	 */
	private async assertNoRootFolderConflict(
		file: typeof unmatchedFiles.$inferSelect,
		tmdbId: number,
		mediaType: 'movie' | 'tv'
	): Promise<void> {
		if (mediaType === 'movie') {
			const [existing] = await db
				.select({
					rootFolderId: movies.rootFolderId,
					path: movies.path,
					title: movies.title
				})
				.from(movies)
				.where(eq(movies.tmdbId, tmdbId));
			if (!existing?.rootFolderId) return;
			await this.assertFileInsideEntryScope(
				file,
				existing.rootFolderId,
				existing.path,
				existing.title
			);
		} else {
			const [existing] = await db
				.select({
					rootFolderId: series.rootFolderId,
					path: series.path,
					title: series.title
				})
				.from(series)
				.where(eq(series.tmdbId, tmdbId));
			if (!existing?.rootFolderId) return;
			await this.assertFileInsideEntryScope(
				file,
				existing.rootFolderId,
				existing.path,
				existing.title
			);
		}
	}

	private async assertFileInsideEntryScope(
		file: typeof unmatchedFiles.$inferSelect,
		existingRootFolderId: string,
		existingPath: string,
		title: string
	): Promise<void> {
		const [existingRoot] = await db
			.select({ name: rootFolders.name, path: rootFolders.path })
			.from(rootFolders)
			.where(eq(rootFolders.id, existingRootFolderId));

		if (!existingRoot) return;

		const expectedDir = join(existingRoot.path, existingPath);
		// path.relative() normalizes both sides (collapses redundant separators,
		// trailing slashes, '.'/'..' segments) before comparing, a plain
		// String.startsWith on raw paths falsely conflicted whenever the two
		// path strings differed only cosmetically (e.g. a root folder path
		// re-saved with/without a trailing slash), which is exactly what NFS
		// mounts plus a "reapply root folder" troubleshooting step can produce
		// (GitHub Issue #595). A relative path that starts with '..' or is itself
		// absolute means file.path falls outside expectedDir.
		const rel = relative(expectedDir, file.path);
		const isInside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
		if (!isInside) {
			throw new RootFolderConflictError(
				`Refusing to link "${file.path}" to "${title}": the file is not inside "${expectedDir}", where "${title}" is registered under the "${existingRoot.name}" root folder. Linking it would create an unresolvable file path.`
			);
		}
	}

	/**
	 * Create a movie entry from an unmatched file
	 */
	private async createMovieEntry(
		file: typeof unmatchedFiles.$inferSelect,
		tmdbId: number,
		rootFolder: typeof rootFolders.$inferSelect,
		mediaInfo: Awaited<ReturnType<typeof mediaInfoService.extractMediaInfo>>,
		allowReplace: boolean
	): Promise<void> {
		// Fetch movie details and external IDs from TMDB
		const [tmdbMovie, externalIds] = await Promise.all([
			tmdb.getMovie(tmdbId),
			tmdb.getMovieExternalIds(tmdbId).catch((err) => {
				logger.warn(
					{
						tmdbId,
						error: err instanceof Error ? err.message : String(err)
					},
					'[MediaMatcher] Failed to fetch movie external IDs'
				);
				return { imdb_id: null, tvdb_id: null };
			})
		]);

		// Calculate relative path from root folder
		const relativePath = file.path.replace(rootFolder.path, '').replace(/^\//, '');
		const movieFolder = dirname(relativePath);
		const fileName = basename(relativePath);

		// Check if movie already exists
		const [existingMovie] = await db.select().from(movies).where(eq(movies.tmdbId, tmdbId));

		let movieId: string;

		if (existingMovie) {
			movieId = existingMovie.id;
			// Update hasFile flag
			await db.update(movies).set({ hasFile: true }).where(eq(movies.id, movieId));
		} else {
			// Writers never persist the resolved default profile: the item-level
			// language_profile_id stays NULL and the effective profile is resolved
			// read-only at query time (item → library → instance default).
			const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
				rootFolder.id,
				'movie'
			);
			const wantsSubtitles = owningLibrary.defaultWantsSubtitles;
			const _animeSignal = isLikelyAnimeMedia({
				genres: tmdbMovie.genres,
				originalLanguage: tmdbMovie.original_language,
				productionCountries: tmdbMovie.production_countries,
				originCountries: tmdbMovie.production_countries
					?.map((country) => country.iso_3166_1)
					.filter((country): country is string => Boolean(country)),
				title: tmdbMovie.title,
				originalTitle: tmdbMovie.original_title
			});
			const [newMovie] = await db
				.insert(movies)
				.values({
					tmdbId,
					imdbId: externalIds.imdb_id,
					title: tmdbMovie.title,
					originalTitle: tmdbMovie.original_title,
					originalLanguage: tmdbMovie.original_language,
					year: tmdbMovie.release_date ? parseInt(tmdbMovie.release_date.split('-')[0]) : undefined,
					overview: tmdbMovie.overview,
					posterPath: tmdbMovie.poster_path,
					backdropPath: tmdbMovie.backdrop_path,
					runtime: tmdbMovie.runtime,
					genres: tmdbMovie.genres?.map((g) => g.name),
					tmdbCollectionId: tmdbMovie.belongs_to_collection?.id ?? null,
					collectionName: tmdbMovie.belongs_to_collection?.name ?? null,
					path: movieFolder || fileName,
					libraryId: owningLibrary.id,
					rootFolderId: rootFolder.id,
					hasFile: true,
					monitored: rootFolder.defaultMonitored ?? true,
					scoringProfileId: owningLibrary.qualityProfileId,
					wantsSubtitles
				})
				.onConflictDoNothing()
				.returning();

			if (newMovie) {
				movieId = newMovie.id;
				logger.debug({ movieId, title: tmdbMovie.title }, '[MediaMatcher] Created new movie');
			} else {
				const [concurrentMovie] = await db
					.select({ id: movies.id })
					.from(movies)
					.where(eq(movies.tmdbId, tmdbId))
					.limit(1);
				if (!concurrentMovie) throw new Error(`Movie insert failed and row not found: ${tmdbId}`);
				movieId = concurrentMovie.id;
				await db.update(movies).set({ hasFile: true }).where(eq(movies.id, movieId));
			}
		}

		// Check if movie file with same path already exists (prevent duplicates)
		const [existingFile] = await db
			.select()
			.from(movieFiles)
			.where(and(eq(movieFiles.movieId, movieId), eq(movieFiles.relativePath, fileName)));

		if (existingFile) {
			logger.debug(
				{
					movieId,
					relativePath: fileName,
					existingFileId: existingFile.id
				},
				'[MediaMatcher] Movie file already exists, skipping insert'
			);
			return;
		}

		// Parse quality from the original filename (preserves quality markers)
		const originalFilename = basename(file.path, extname(file.path));
		// Strip trailing brackets containing non-ASCII chars (e.g. OriginalTitle suffix) before
		// parsing so the release group immediately preceding them is detected correctly
		const parseableFilename = originalFilename
			.replace(/(\s*\[[^\]]*\P{ASCII}[^\]]*\])+$/u, '')
			.trim();
		const parsedQuality = parseRelease(parseableFilename || originalFilename);

		// Create movie file entry with proper sceneName, releaseGroup, and quality data
		const [insertedFile] = await db
			.insert(movieFiles)
			.values({
				movieId,
				relativePath: fileName,
				size: file.size,
				mediaInfo,
				sceneName: originalFilename,
				releaseGroup: parsedQuality.releaseGroup ?? undefined,
				edition: parsedQuality.edition ?? undefined,
				quality: {
					resolution: parsedQuality.resolution ?? undefined,
					source: parsedQuality.source ?? undefined,
					codec: parsedQuality.codec ?? undefined,
					hdr: parsedQuality.hdr ?? undefined
				}
			})
			.onConflictDoNothing()
			.returning({ id: movieFiles.id });

		let newFileId = insertedFile?.id;
		if (!newFileId) {
			const [raced] = await db
				.select({ id: movieFiles.id })
				.from(movieFiles)
				.where(and(eq(movieFiles.movieId, movieId), eq(movieFiles.relativePath, fileName)))
				.limit(1);
			newFileId = raced?.id;
		}

		// Deliberate (manual-match) links apply the shared replacement policy:
		// a re-match whose generated filename differs from the existing file's
		// no longer leaves both on disk (issue #627). Scan auto-match passes
		// allowReplace=false and stays purely additive.
		if (newFileId) {
			await this.retireReplacedMovieFiles(
				movieId,
				newFileId,
				parsedQuality.resolution,
				allowReplace
			);
		}

		// Optional sidecar files (.nfo + poster/fanart) - mirrors the
		// automatic download-client import path in ImportService.ts.
		// Never let a write failure here fail an otherwise-successful match.
		const sidecarSettings = getSidecarSettings();
		if (sidecarSettings.enabled) {
			try {
				const [movieRow] = await db.select().from(movies).where(eq(movies.id, movieId));
				if (movieRow) {
					const destPath = file.path;
					const nfoPath = nfoPathFor(destPath);
					if (await shouldWriteSidecar(nfoPath, sidecarSettings.overwriteExisting)) {
						await writeFile(
							nfoPath,
							buildMovieNfo(
								movieRow,
								{ mediaInfo, quality: { codec: parsedQuality.codec ?? undefined } },
								sidecarSettings.includeArtwork
							),
							'utf-8'
						);
					}

					if (sidecarSettings.includeArtwork) {
						const movieFolder = folderOf(destPath);
						const { poster, fanart } = movieArtworkPaths(movieFolder);
						await Promise.all([
							downloadSidecarImage(
								tmdbImageUrl(movieRow.posterPath),
								poster,
								sidecarSettings.overwriteExisting
							),
							downloadSidecarImage(
								tmdbImageUrl(movieRow.backdropPath),
								fanart,
								sidecarSettings.overwriteExisting
							)
						]);
					}
				}
			} catch (err) {
				logger.warn(
					{ movieId, err: err instanceof Error ? err.message : String(err) },
					'[MediaMatcher] Failed to write sidecar files'
				);
			}
		}

		// Trigger subtitle search if enabled (after metadata is fetched)
		this.triggerSubtitleSearch('movie', movieId).catch((err) => {
			logger.warn(
				{
					movieId,
					error: err instanceof Error ? err.message : String(err)
				},
				'[MediaMatcher] Failed to trigger subtitle search for movie'
			);
		});
	}

	/**
	 * Retire movie files displaced by a deliberate (re-)match (issue #627).
	 * `retire: allowReplace` makes computeMovieReplacement a no-op when the
	 * match wasn't deliberate (scan auto-match), so this is always safe to call.
	 */
	private async retireReplacedMovieFiles(
		movieId: string,
		keepFileId: string,
		newResolution: Resolution | null | undefined,
		allowReplace: boolean
	): Promise<void> {
		const currentFiles = await db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId));
		const [movieRow] = await db
			.select({
				path: movies.path,
				desiredQualities: movies.desiredQualities,
				scoringProfileId: movies.scoringProfileId
			})
			.from(movies)
			.where(eq(movies.id, movieId));
		if (!movieRow) return;

		const { multiQuality } = await resolveMovieMultiQuality(
			movieRow.desiredQualities,
			movieRow.scoringProfileId
		);
		const replaceIds = new Set(
			computeMovieReplacement({
				existingFiles: currentFiles,
				newResolution: newResolution ?? undefined,
				multiQuality,
				retire: allowReplace,
				keepFileIds: [keepFileId]
			})
		);
		if (replaceIds.size === 0) return;

		const rootFolder = await this.getRootFolderForMovie(movieId);
		if (!rootFolder) return;
		const { recycleEnabled } = await getFileManagementSettings();

		for (const oldFile of currentFiles) {
			if (!replaceIds.has(oldFile.id)) continue;
			const oldFilePath = join(rootFolder.path, movieRow.path, oldFile.relativePath);
			try {
				await deletePhysicalFile(oldFilePath, recycleEnabled, rootFolder.path);
			} catch (err) {
				logger.warn(
					{ movieId, fileId: oldFile.id, err: err instanceof Error ? err.message : String(err) },
					'[MediaMatcher] Failed to delete displaced movie file (issue #627)'
				);
				continue;
			}
			await db.delete(movieFiles).where(eq(movieFiles.id, oldFile.id));
			logger.info(
				{ movieId, fileId: oldFile.id, relativePath: oldFile.relativePath },
				'[MediaMatcher] Retired displaced movie file after manual (re-)match'
			);
		}
	}

	/**
	 * Retire episode files displaced by a deliberate (re-)match (issue #627),
	 * following the same coverage rule ImportService uses: a multi-episode
	 * pack only retires when the incoming file covers every episode it held.
	 * No-op when `allowReplace` is false (scan auto-match stays additive -
	 * computeEpisodeReplacement has no retire flag of its own to delegate to).
	 */
	private async retireReplacedEpisodeFiles(
		seriesId: string,
		incomingEpisodeIds: string[],
		keepFileId: string | undefined,
		rootFolder: typeof rootFolders.$inferSelect,
		allowReplace: boolean
	): Promise<void> {
		if (!allowReplace || !keepFileId) return;

		const currentFiles = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, seriesId));
		const [seriesRow] = await db
			.select({ path: series.path })
			.from(series)
			.where(eq(series.id, seriesId));
		if (!seriesRow) return;

		const replaceIds = new Set(
			computeEpisodeReplacement({
				existingFiles: currentFiles,
				incomingEpisodeIds,
				keepFileIds: [keepFileId],
				retireStrmPlaceholders: true
			})
		);
		if (replaceIds.size === 0) return;

		const { recycleEnabled } = await getFileManagementSettings();
		for (const oldFile of currentFiles) {
			if (!replaceIds.has(oldFile.id)) continue;
			const oldFilePath = join(rootFolder.path, seriesRow.path, oldFile.relativePath);
			try {
				await deletePhysicalFile(oldFilePath, recycleEnabled, rootFolder.path);
			} catch (err) {
				logger.warn(
					{ seriesId, fileId: oldFile.id, err: err instanceof Error ? err.message : String(err) },
					'[MediaMatcher] Failed to delete displaced episode file (issue #627)'
				);
				continue;
			}
			await db.delete(episodeFiles).where(eq(episodeFiles.id, oldFile.id));
			logger.info(
				{ seriesId, fileId: oldFile.id, relativePath: oldFile.relativePath },
				'[MediaMatcher] Retired displaced episode file after manual (re-)match'
			);
		}
	}

	private async getRootFolderForMovie(
		movieId: string
	): Promise<typeof rootFolders.$inferSelect | undefined> {
		const [movieRow] = await db
			.select({ rootFolderId: movies.rootFolderId })
			.from(movies)
			.where(eq(movies.id, movieId));
		if (!movieRow?.rootFolderId) return undefined;
		const [rootFolder] = await db
			.select()
			.from(rootFolders)
			.where(eq(rootFolders.id, movieRow.rootFolderId));
		return rootFolder;
	}

	/**
	 * Create a series/episode entry from an unmatched file
	 */
	private async createSeriesEntry(
		file: typeof unmatchedFiles.$inferSelect,
		tmdbId: number,
		rootFolder: typeof rootFolders.$inferSelect,
		mediaInfo: Awaited<ReturnType<typeof mediaInfoService.extractMediaInfo>>,
		allowReplace: boolean
	): Promise<void> {
		// Fetch series details and external IDs from TMDB
		const [tmdbSeries, externalIds] = await Promise.all([
			tmdb.getTVShow(tmdbId),
			tmdb.getTvExternalIds(tmdbId).catch((err) => {
				logger.warn(
					{
						tmdbId,
						error: err instanceof Error ? err.message : String(err)
					},
					'[MediaMatcher] Failed to fetch series external IDs'
				);
				return { imdb_id: null, tvdb_id: null };
			})
		]);

		// Calculate relative path from root folder
		const relativePath = file.path.replace(rootFolder.path, '').replace(/^\//, '');
		const pathParts = relativePath.split('/');
		const seriesFolder = pathParts[0] || relativePath;

		// Check if series already exists
		const [existingSeries] = await db.select().from(series).where(eq(series.tmdbId, tmdbId));

		let seriesId: string;

		if (existingSeries) {
			seriesId = existingSeries.id;
		} else {
			// Writers never persist the resolved default profile (see movie path).
			const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
				rootFolder.id,
				'tv'
			);
			const wantsSubtitles = owningLibrary.defaultWantsSubtitles;
			const animeSignal = isLikelyAnimeMedia({
				genres: tmdbSeries.genres,
				originalLanguage: tmdbSeries.original_language,
				originCountries: tmdbSeries.origin_country,
				productionCountries: tmdbSeries.production_countries,
				title: tmdbSeries.name,
				originalTitle: tmdbSeries.original_name
			});
			let createdSeries = false;

			const [newSeries] = await db
				.insert(series)
				.values({
					tmdbId,
					imdbId: externalIds.imdb_id,
					tvdbId: externalIds.tvdb_id,
					title: tmdbSeries.name,
					originalTitle: tmdbSeries.original_name,
					originalLanguage: tmdbSeries.original_language,
					year: tmdbSeries.first_air_date
						? parseInt(tmdbSeries.first_air_date.split('-')[0])
						: undefined,
					overview: tmdbSeries.overview,
					posterPath: tmdbSeries.poster_path,
					backdropPath: tmdbSeries.backdrop_path,
					status: tmdbSeries.status,
					network: tmdbSeries.networks?.[0]?.name,
					genres: tmdbSeries.genres?.map((g) => g.name),
					path: seriesFolder,
					libraryId: owningLibrary.id,
					rootFolderId: rootFolder.id,
					seriesType: rootFolder.mediaSubType === 'anime' || animeSignal ? 'anime' : 'standard',
					monitored: rootFolder.defaultMonitored ?? true,
					scoringProfileId: owningLibrary.qualityProfileId,
					wantsSubtitles
				})
				.onConflictDoNothing()
				.returning();

			if (newSeries) {
				seriesId = newSeries.id;
				createdSeries = true;
				logger.debug({ seriesId, title: tmdbSeries.name }, '[MediaMatcher] Created new series');
			} else {
				const [concurrentSeries] = await db
					.select({ id: series.id })
					.from(series)
					.where(eq(series.tmdbId, tmdbId))
					.limit(1);
				if (!concurrentSeries) throw new Error(`Series insert failed and row not found: ${tmdbId}`);
				seriesId = concurrentSeries.id;
			}

			if (createdSeries) {
				// Populate all seasons and episodes from TMDB
				// This ensures consistent behavior with "Add to Library" flow
				await this.populateSeriesEpisodes(
					seriesId,
					tmdbId,
					tmdbSeries,
					rootFolder.defaultMonitored ?? true
				);
			}
		}

		// Determine season and episode - fall back to re-parsing when DB values are incomplete
		let resolvedSeason = file.parsedSeason;
		let resolvedEpisode = file.parsedEpisode;

		if (resolvedSeason === null || resolvedEpisode === null) {
			const stem = getMediaParseStem(file.path);
			const reparsed = parseRelease(stem);
			const tvId = resolveTvEpisodeIdentifier({
				filePath: file.path,
				parsed: reparsed,
				seasonHint: extractSeasonFromPath(file.path)
			});

			if (tvId?.numbering === 'standard') {
				resolvedSeason = resolvedSeason ?? tvId.seasonNumber;
				resolvedEpisode = resolvedEpisode ?? tvId.episodeNumbers[0];
			} else if (tvId?.numbering === 'absolute') {
				// Absolute episode - resolve to season/episode via DB (populated above)
				const seriesEpisodes = await db
					.select({
						seasonNumber: episodes.seasonNumber,
						episodeNumber: episodes.episodeNumber,
						absoluteEpisodeNumber: episodes.absoluteEpisodeNumber
					})
					.from(episodes)
					.where(eq(episodes.seriesId, seriesId));
				const [match] = matchEpisodesByIdentifier(seriesEpisodes, tvId);
				if (match) {
					resolvedSeason = match.seasonNumber;
					resolvedEpisode = match.episodeNumber;
				}
			}
		}

		if (resolvedSeason === null || resolvedEpisode === null) {
			// Sonarr-style fallback: title-only files match season 0 specials by
			// contained episode title ("Razor (2007)" → the BSG special "Razor").
			const stem = getMediaParseStem(file.path);
			const reparsed = parseRelease(stem);
			const seriesEpisodes = await db
				.select()
				.from(episodes)
				.where(eq(episodes.seriesId, seriesId));
			const parentFolder = basename(dirname(file.path));
			const candidates = parentFolder !== seriesFolder ? [stem, parentFolder] : [stem];
			const titleMatch = matchSpecialEpisodeByTitle(
				seriesEpisodes,
				candidates,
				file.parsedYear ?? reparsed.year,
				existingSeries?.title ?? tmdbSeries.name
			);

			if (titleMatch) {
				resolvedSeason = titleMatch.episode.seasonNumber;
				resolvedEpisode = titleMatch.episode.episodeNumber;
				logger.info(
					{
						fileId: file.id,
						filePath: file.path,
						tmdbId,
						season: resolvedSeason,
						episode: resolvedEpisode,
						method: titleMatch.method,
						position: titleMatch.position,
						coverage: titleMatch.coverage,
						candidate: titleMatch.candidate
					},
					'[MediaMatcher] Resolved special episode by title'
				);
			}
		}

		if (resolvedSeason === null || resolvedEpisode === null) {
			throw new Error('Could not determine season/episode from filename');
		}

		const seasonNumber = resolvedSeason;
		const episodeNumber = resolvedEpisode;

		// Re-parse the filename to detect all episodes for multi-episode files (e.g. S01E01-E02).
		// parsedEpisode only stores the first episode number, so we always re-derive the full set.
		const allEpisodeNumbers = (() => {
			const stem = getMediaParseStem(file.path);
			const reparsed = parseRelease(stem);
			const tvId = resolveTvEpisodeIdentifier({
				filePath: file.path,
				parsed: reparsed,
				seasonHint: seasonNumber
			});
			if (
				tvId?.numbering === 'standard' &&
				tvId.seasonNumber === seasonNumber &&
				tvId.episodeNumbers.length > 1 &&
				tvId.episodeNumbers.includes(episodeNumber)
			) {
				return tvId.episodeNumbers;
			}
			return [episodeNumber];
		})();

		// Fetch season details from TMDB (needed for both season and episode metadata)
		let tmdbSeason: Awaited<ReturnType<typeof tmdb.getSeason>> | null = null;
		try {
			tmdbSeason = await tmdb.getSeason(tmdbId, seasonNumber);
		} catch {
			// Season might not exist in TMDB
			logger.debug(
				{
					tmdbId,
					seasonNumber
				},
				'[MediaMatcher] Could not fetch TMDB season data'
			);
		}

		// Ensure season exists
		let [season] = await db
			.select()
			.from(seasons)
			.where(and(eq(seasons.seriesId, seriesId), eq(seasons.seasonNumber, seasonNumber)));

		if (!season) {
			const defaultMon = rootFolder.defaultMonitored ?? true;
			if (tmdbSeason) {
				[season] = await db
					.insert(seasons)
					.values({
						seriesId,
						seasonNumber,
						name: tmdbSeason.name,
						overview: tmdbSeason.overview,
						posterPath: tmdbSeason.poster_path,
						airDate: tmdbSeason.air_date,
						monitored: defaultMon && seasonNumber !== 0
					})
					.onConflictDoNothing()
					.returning();
			} else {
				// Create basic entry without TMDB data
				[season] = await db
					.insert(seasons)
					.values({
						seriesId,
						seasonNumber,
						monitored: defaultMon && seasonNumber !== 0
					})
					.onConflictDoNothing()
					.returning();
			}
			// Concurrent insert; re-fetch if returning() came back empty.
			season ??= await db
				.select()
				.from(seasons)
				.where(and(eq(seasons.seriesId, seriesId), eq(seasons.seasonNumber, seasonNumber)))
				.then((rows) => rows[0]);
		}

		// Ensure all episodes covered by this file exist and have hasFile: true.
		// For multi-episode files (e.g. S03E21-E22) allEpisodeNumbers has all numbers;
		// single-episode files have only one entry.
		const episodeMonitored = (rootFolder.defaultMonitored ?? true) && seasonNumber !== 0;
		const allEpisodeIds: string[] = [];
		const matchingEpisodeRows: (typeof episodes.$inferSelect)[] = [];
		let primaryEpisode: typeof episodes.$inferSelect | undefined;

		for (const epNum of allEpisodeNumbers) {
			const tmdbEp = tmdbSeason?.episodes?.find((e) => e.episode_number === epNum);

			let [ep] = await db
				.select()
				.from(episodes)
				.where(
					and(
						eq(episodes.seriesId, seriesId),
						eq(episodes.seasonNumber, seasonNumber),
						eq(episodes.episodeNumber, epNum)
					)
				);

			if (!ep) {
				[ep] = await db
					.insert(episodes)
					.values({
						seriesId,
						seasonId: season.id,
						seasonNumber,
						episodeNumber: epNum,
						title: tmdbEp?.name ?? undefined,
						overview: tmdbEp?.overview ?? undefined,
						airDate: tmdbEp?.air_date ?? undefined,
						runtime: tmdbEp?.runtime ?? undefined,
						hasFile: true,
						monitored: episodeMonitored
					})
					.onConflictDoNothing()
					.returning();
				ep ??= await db
					.select()
					.from(episodes)
					.where(
						and(
							eq(episodes.seriesId, seriesId),
							eq(episodes.seasonNumber, seasonNumber),
							eq(episodes.episodeNumber, epNum)
						)
					)
					.then((rows) => rows[0]);
			} else {
				const updates: Record<string, unknown> = { hasFile: true };
				if (tmdbEp && !ep.title) {
					updates.title = tmdbEp.name;
					updates.overview = tmdbEp.overview;
					updates.airDate = tmdbEp.air_date;
					updates.runtime = tmdbEp.runtime;
				}
				await db.update(episodes).set(updates).where(eq(episodes.id, ep.id));
			}

			allEpisodeIds.push(ep.id);
			matchingEpisodeRows.push(ep);
			if (epNum === episodeNumber) {
				primaryEpisode = ep;
			}
		}

		// Fallback: if primary episode wasn't matched by number (shouldn't happen), use first
		const episode =
			primaryEpisode ??
			(await db
				.select()
				.from(episodes)
				.where(
					and(
						eq(episodes.seriesId, seriesId),
						eq(episodes.seasonNumber, seasonNumber),
						eq(episodes.episodeNumber, episodeNumber)
					)
				)
				.then((rows) => rows[0]));

		// Parse quality from the original filename (preserves quality markers)
		const originalFilename = basename(file.path, extname(file.path));
		// Strip trailing brackets containing non-ASCII chars (e.g. OriginalTitle suffix) before
		// parsing so the release group immediately preceding them is detected correctly
		const parseableFilename = originalFilename
			.replace(/(\s*\[[^\]]*\P{ASCII}[^\]]*\])+$/u, '')
			.trim();
		const parsedQuality = parseRelease(parseableFilename || originalFilename);

		// Create/update episode file entry with proper sceneName, releaseGroup, and quality data
		const newEpisodeFileId = await this.upsertEpisodeFileByPath({
			seriesId,
			seasonNumber,
			episodeIds: allEpisodeIds,
			relativePath: relativePath.replace(seriesFolder + '/', ''),
			size: file.size,
			mediaInfo,
			sceneName: originalFilename,
			releaseGroup: parsedQuality.releaseGroup ?? undefined,
			edition: parsedQuality.edition ?? undefined,
			quality: {
				resolution: parsedQuality.resolution ?? undefined,
				source: parsedQuality.source ?? undefined,
				codec: parsedQuality.codec ?? undefined,
				hdr: parsedQuality.hdr ?? undefined
			}
		});

		// Deliberate (manual-match) links retire files displaced by the
		// coverage rule (issue #627). Scan auto-match passes allowReplace=false.
		await this.retireReplacedEpisodeFiles(
			seriesId,
			allEpisodeIds,
			newEpisodeFileId,
			rootFolder,
			allowReplace
		);

		// Optional sidecar files - mirrors the automatic download-client
		// import path in ImportService.ts. TV has three independent levels (episode .nfo,
		// show-level tvshow.nfo + artwork, season poster) - see the comment
		// on the equivalent block in ImportService.ts for why.
		const sidecarSettings = getSidecarSettings();
		if (sidecarSettings.enabled) {
			const seriesFolderAbsolute = join(rootFolder.path, seriesFolder);
			const destPath = file.path;
			const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));

			if (sidecarSettings.tvEpisodeLevel && seriesRow) {
				try {
					const nfoPath = nfoPathFor(destPath);
					if (await shouldWriteSidecar(nfoPath, sidecarSettings.overwriteExisting)) {
						await writeFile(
							nfoPath,
							buildEpisodeNfo(seriesRow, matchingEpisodeRows, {
								mediaInfo,
								quality: { codec: parsedQuality.codec ?? undefined }
							}),
							'utf-8'
						);
					}
				} catch (err) {
					logger.warn(
						{ seriesId, err: err instanceof Error ? err.message : String(err) },
						'[MediaMatcher] Failed to write episode NFO sidecar'
					);
				}
			}

			if (sidecarSettings.tvSeriesLevel && seriesRow) {
				try {
					const tvshowNfoPath = join(seriesFolderAbsolute, 'tvshow.nfo');
					if (await shouldWriteSidecar(tvshowNfoPath, sidecarSettings.overwriteExisting)) {
						await writeFile(
							tvshowNfoPath,
							buildSeriesNfo(seriesRow, sidecarSettings.includeArtwork),
							'utf-8'
						);
					}

					if (sidecarSettings.includeArtwork) {
						const { poster, fanart } = seriesArtworkPaths(seriesFolderAbsolute);
						await Promise.all([
							downloadSidecarImage(
								tmdbImageUrl(seriesRow.posterPath),
								poster,
								sidecarSettings.overwriteExisting
							),
							downloadSidecarImage(
								tmdbImageUrl(seriesRow.backdropPath),
								fanart,
								sidecarSettings.overwriteExisting
							)
						]);
					}
				} catch (err) {
					logger.warn(
						{ seriesId, err: err instanceof Error ? err.message : String(err) },
						'[MediaMatcher] Failed to write series-level sidecar files'
					);
				}
			}

			if (sidecarSettings.tvSeasonLevel) {
				try {
					if (season) {
						const seasonNfoPath = join(folderOf(destPath), 'season.nfo');
						if (await shouldWriteSidecar(seasonNfoPath, sidecarSettings.overwriteExisting)) {
							await writeFile(seasonNfoPath, buildSeasonNfo(season), 'utf-8');
						}

						if (sidecarSettings.includeArtwork && season.posterPath) {
							await downloadSidecarImage(
								tmdbImageUrl(season.posterPath),
								seasonArtworkPath(seriesFolderAbsolute, seasonNumber),
								sidecarSettings.overwriteExisting
							);
						}
					}
				} catch (err) {
					logger.warn(
						{
							seriesId,
							seasonNumber,
							err: err instanceof Error ? err.message : String(err)
						},
						'[MediaMatcher] Failed to write season-level sidecar files'
					);
				}
			}
		}

		// Update series stats
		await this.updateSeriesStats(seriesId);

		// Trigger subtitle search for the primary episode if enabled
		if (episode) {
			this.triggerSubtitleSearch('episode', episode.id).catch((err) => {
				logger.warn(
					{
						episodeId: episode!.id,
						error: err instanceof Error ? err.message : String(err)
					},
					'[MediaMatcher] Failed to trigger subtitle search for episode'
				);
			});
		}
	}

	/**
	 * Populate all seasons and episodes from TMDB for a newly created series
	 * This ensures consistent behavior with "Add to Library" flow
	 */
	private async populateSeriesEpisodes(
		seriesId: string,
		tmdbId: number,
		tmdbSeries: Awaited<ReturnType<typeof tmdb.getTVShow>>,
		defaultMonitored: boolean = true
	): Promise<void> {
		if (!tmdbSeries.seasons || tmdbSeries.seasons.length === 0) {
			logger.debug({ tmdbId }, '[MediaMatcher] No seasons found for series');
			return;
		}

		for (const seasonInfo of tmdbSeries.seasons) {
			// Skip season 0 (specials) by default - can be added later
			const isSpecials = seasonInfo.season_number === 0;

			// Check if season already exists
			const [existingSeason] = await db
				.select()
				.from(seasons)
				.where(
					and(eq(seasons.seriesId, seriesId), eq(seasons.seasonNumber, seasonInfo.season_number))
				);

			let seasonId: string;

			if (existingSeason) {
				seasonId = existingSeason.id;
			} else {
				// Create season record
				const [newSeason] = await db
					.insert(seasons)
					.values({
						seriesId,
						seasonNumber: seasonInfo.season_number,
						name: seasonInfo.name,
						overview: seasonInfo.overview,
						posterPath: seasonInfo.poster_path,
						airDate: seasonInfo.air_date,
						episodeCount: seasonInfo.episode_count ?? 0,
						episodeFileCount: 0,
						monitored: defaultMonitored && !isSpecials
					})
					.onConflictDoNothing()
					.returning();
				seasonId =
					newSeason?.id ??
					(await db
						.select({ id: seasons.id })
						.from(seasons)
						.where(
							and(
								eq(seasons.seriesId, seriesId),
								eq(seasons.seasonNumber, seasonInfo.season_number)
							)
						)
						.then((rows) => rows[0]?.id ?? ''));
			}

			// Fetch full season details to get episodes
			try {
				const fullSeason = await tmdb.getSeason(tmdbId, seasonInfo.season_number);

				if (fullSeason.episodes && fullSeason.episodes.length > 0) {
					for (const ep of fullSeason.episodes) {
						// Check if episode already exists
						const [existingEpisode] = await db
							.select()
							.from(episodes)
							.where(
								and(
									eq(episodes.seriesId, seriesId),
									eq(episodes.seasonNumber, ep.season_number),
									eq(episodes.episodeNumber, ep.episode_number)
								)
							);

						if (!existingEpisode) {
							// Create episode with TMDB metadata
							await db
								.insert(episodes)
								.values({
									seriesId,
									seasonId,
									tmdbId: ep.id,
									seasonNumber: ep.season_number,
									episodeNumber: ep.episode_number,
									title: ep.name,
									overview: ep.overview,
									airDate: ep.air_date,
									runtime: ep.runtime,
									monitored: defaultMonitored && !isSpecials,
									hasFile: false
								})
								.onConflictDoNothing();
						}
					}
				}

				// Small delay to avoid TMDB rate limiting
				await new Promise((resolve) => setTimeout(resolve, 50));
			} catch (err) {
				logger.warn(
					{
						seasonNumber: seasonInfo.season_number,
						error: err instanceof Error ? err.message : String(err)
					},
					'[MediaMatcher] Failed to fetch episodes for season'
				);
			}
		}

		logger.info(
			{
				seriesId,
				tmdbId,
				title: tmdbSeries.name
			},
			'[MediaMatcher] Populated all episodes from TMDB for series'
		);
	}

	/**
	 * Update episode counts for a series (excluding specials/season 0 and unaired episodes)
	 */
	private async updateSeriesStats(seriesId: string): Promise<void> {
		const allEpisodes = await db.select().from(episodes).where(eq(episodes.seriesId, seriesId));
		const today = todayDateString();
		const isAired = (ep: typeof episodes.$inferSelect) =>
			Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

		const regularEpisodes = allEpisodes.filter((e) => e.seasonNumber !== 0 && isAired(e));
		const episodeCount = regularEpisodes.length;
		const episodeFileCount = regularEpisodes.filter((e) => e.hasFile).length;

		await db.update(series).set({ episodeCount, episodeFileCount }).where(eq(series.id, seriesId));
	}

	/**
	 * Reject a suggested match (keep as unmatched with different reason)
	 */
	async rejectMatch(unmatchedFileId: string): Promise<void> {
		await db
			.update(unmatchedFiles)
			.set({
				reason: 'rejected',
				suggestedMatches: []
			})
			.where(eq(unmatchedFiles.id, unmatchedFileId));
	}

	/**
	 * Cancel and remove any active downloads for a library item before a
	 * rematch regenerates its episode rows (which in-flight downloads may
	 * reference by UUID) or replaces its identity outright.
	 *
	 * Mirrors the cancel-on-delete behavior in the series/movie DELETE
	 * handlers so a rematch has the same "stop anything in flight" guarantee.
	 */
	private async cancelActiveDownloads(
		mediaType: 'movie' | 'series',
		mediaId: string
	): Promise<void> {
		const queueFilter =
			mediaType === 'movie'
				? eq(downloadQueue.movieId, mediaId)
				: eq(downloadQueue.seriesId, mediaId);
		const activeQueueItems = await db.select().from(downloadQueue).where(queueFilter);

		for (const queueItem of activeQueueItems) {
			if (queueItem.downloadClientId) {
				try {
					const isTorrent = queueItem.protocol === 'torrent';
					const clientDownloadId = isTorrent
						? queueItem.infoHash || queueItem.downloadId
						: queueItem.downloadId || queueItem.infoHash;
					if (clientDownloadId) {
						const clientInstance = await getDownloadClientManager().getClientInstance(
							queueItem.downloadClientId
						);
						if (clientInstance) {
							await clientInstance.removeDownload(clientDownloadId, true);
						}
					}
				} catch (err) {
					logger.warn(
						{
							queueItemId: queueItem.id,
							error: err instanceof Error ? err.message : 'Unknown'
						},
						'[MediaMatcher] Failed to remove download from client during rematch'
					);
				}
			}
			acquisitionService.cancelByQueueId(queueItem.id, 'media rematched to a different title');
			await db.delete(downloadQueue).where(eq(downloadQueue.id, queueItem.id));
		}

		const historyFilter =
			mediaType === 'movie'
				? eq(downloadHistory.movieId, mediaId)
				: eq(downloadHistory.seriesId, mediaId);
		await db
			.update(downloadHistory)
			.set({ status: 'removed', statusReason: 'media rematched to a different title' })
			.where(historyFilter);
	}

	/**
	 * Reorganize the item's folder and rename its files to match the new
	 * title/year/tmdbId already written to the row. Runs after the DB row is
	 * updated since RenamePreviewService reads title/year/tmdbId live from it.
	 */
	private async reorganizeAndRename(mediaId: string, mediaType: 'movie' | 'series'): Promise<void> {
		const renameService = new RenamePreviewService();
		await renameService.reorganizeFolder(mediaId, mediaType);

		const preview =
			mediaType === 'movie'
				? await renameService.previewMovie(mediaId)
				: await renameService.previewSeries(mediaId);
		const fileIds = preview.willChange.map((item) => item.fileId);
		if (fileIds.length > 0) {
			await renameService.executeRenames(fileIds, mediaType === 'movie' ? 'movie' : 'episode');
		}
	}

	/**
	 * Change an already-added movie's TMDB match in place: re-fetches
	 * metadata for `newTmdbId`, cancels active downloads, backfills linked
	 * requests, and renames the folder/file to match. Reuses the same row
	 * (and therefore every FK into it), so this is NOT a delete+re-add.
	 */
	async rematchMovie(
		movieId: string,
		newTmdbId: number
	): Promise<{ title: string; year?: number | null }> {
		const [movie] = await db.select().from(movies).where(eq(movies.id, movieId));
		if (!movie) {
			throw new Error(`Movie not found: ${movieId}`);
		}
		if (movie.tmdbId === newTmdbId) {
			throw new Error('This movie is already matched to that title');
		}

		const [conflict] = await db
			.select({ id: movies.id, title: movies.title })
			.from(movies)
			.where(eq(movies.tmdbId, newTmdbId))
			.limit(1);
		if (conflict) {
			throw new Error(`"${conflict.title}" is already matched to that TMDB title`);
		}

		await this.cancelActiveDownloads('movie', movieId);

		const [tmdbMovie, externalIds] = await Promise.all([
			tmdb.getMovie(newTmdbId),
			tmdb.getMovieExternalIds(newTmdbId).catch(() => ({ imdb_id: null }))
		]);

		await db
			.update(movies)
			.set({
				tmdbId: newTmdbId,
				imdbId: externalIds.imdb_id,
				title: tmdbMovie.title,
				originalTitle: tmdbMovie.original_title,
				originalLanguage: tmdbMovie.original_language,
				year: tmdbMovie.release_date ? parseInt(tmdbMovie.release_date.split('-')[0]) : movie.year,
				overview: tmdbMovie.overview,
				posterPath: tmdbMovie.poster_path,
				backdropPath: tmdbMovie.backdrop_path,
				runtime: tmdbMovie.runtime,
				genres: tmdbMovie.genres?.map((g) => g.name),
				releaseDate: tmdbMovie.release_date,
				providerRefs: null
			})
			.where(eq(movies.id, movieId));

		await db.update(requests).set({ tmdbId: newTmdbId }).where(eq(requests.movieId, movieId));

		await this.reorganizeAndRename(movieId, 'movie');

		logger.info(
			{
				movieId,
				oldTmdbId: movie.tmdbId,
				newTmdbId,
				oldTitle: movie.title,
				newTitle: tmdbMovie.title
			},
			'[MediaMatcher] Rematched movie'
		);

		return {
			title: tmdbMovie.title,
			year: tmdbMovie.release_date ? parseInt(tmdbMovie.release_date.split('-')[0]) : movie.year
		};
	}

	/**
	 * Change an already-added series's TMDB match in place: re-fetches
	 * metadata for `newTmdbId`, cancels active downloads, regenerates every
	 * season/episode row from the new show, re-links existing episode files
	 * by season/episode number, backfills linked requests, and renames the
	 * folder/files to match. Files whose season/episode number doesn't exist
	 * on the new show become unmatched again, which is expected, since the
	 * new show may have a different structure.
	 */
	async rematchSeries(
		seriesId: string,
		newTmdbId: number
	): Promise<{ title: string; year?: number | null }> {
		const [existingSeries] = await db.select().from(series).where(eq(series.id, seriesId));
		if (!existingSeries) {
			throw new Error(`Series not found: ${seriesId}`);
		}
		if (existingSeries.tmdbId === newTmdbId) {
			throw new Error('This series is already matched to that title');
		}

		const [conflict] = await db
			.select({ id: series.id, title: series.title })
			.from(series)
			.where(eq(series.tmdbId, newTmdbId))
			.limit(1);
		if (conflict) {
			throw new Error(`"${conflict.title}" is already matched to that TMDB title`);
		}

		await this.cancelActiveDownloads('series', seriesId);

		const [tmdbSeries, externalIds] = await Promise.all([
			tmdb.getTVShow(newTmdbId),
			tmdb.getTvExternalIds(newTmdbId).catch(() => null)
		]);

		await db
			.update(series)
			.set({
				tmdbId: newTmdbId,
				tvdbId: externalIds?.tvdb_id ?? null,
				imdbId: externalIds?.imdb_id ?? null,
				title: tmdbSeries.name,
				originalTitle: tmdbSeries.original_name,
				originalLanguage: tmdbSeries.original_language,
				year: tmdbSeries.first_air_date
					? parseInt(tmdbSeries.first_air_date.split('-')[0])
					: existingSeries.year,
				overview: tmdbSeries.overview,
				posterPath: tmdbSeries.poster_path,
				backdropPath: tmdbSeries.backdrop_path,
				status: tmdbSeries.status,
				network: tmdbSeries.networks?.[0]?.name,
				genres: tmdbSeries.genres?.map((g) => g.name),
				firstAirDate: tmdbSeries.first_air_date,
				episodeGroupId: null,
				providerRefs: null
			})
			.where(eq(series.id, seriesId));

		// Capture (fileId -> episode numbers) before wiping episodes so the
		// files can be re-linked to the new show's episode rows afterward.
		const existingEpFiles = await db
			.select({ id: episodeFiles.id, episodeIds: episodeFiles.episodeIds })
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, seriesId));
		const existingEpisodeRows = await db
			.select({
				id: episodes.id,
				seasonNumber: episodes.seasonNumber,
				episodeNumber: episodes.episodeNumber,
				monitored: episodes.monitored
			})
			.from(episodes)
			.where(eq(episodes.seriesId, seriesId));
		const epNumByOldId = new Map(
			existingEpisodeRows.map((e) => [e.id, { s: e.seasonNumber, e: e.episodeNumber }])
		);
		const fileEpNumbers = new Map(
			existingEpFiles.map((f) => [
				f.id,
				(f.episodeIds ?? []).flatMap((eid) => {
					const ep = epNumByOldId.get(eid);
					return ep ? [ep] : [];
				})
			])
		);

		// Preserve per-season/per-episode monitored choices across the rebuild
		// below, populateSeriesEpisodes has no prior state to consult once the
		// old rows are gone, so without this every season/episode would reset
		// to its computed default (silently re-monitoring anything the user
		// had explicitly turned off; see the refresh endpoint's identical fix).
		const priorSeasonMonitored = new Map(
			(
				await db
					.select({ seasonNumber: seasons.seasonNumber, monitored: seasons.monitored })
					.from(seasons)
					.where(eq(seasons.seriesId, seriesId))
			).map((s) => [s.seasonNumber, s.monitored])
		);
		const priorEpisodeMonitored = new Map(
			existingEpisodeRows.map((e) => [`${e.seasonNumber}-${e.episodeNumber}`, e.monitored])
		);

		await deleteAllSeasonsAndEpisodes(seriesId);
		await this.populateSeriesEpisodes(
			seriesId,
			newTmdbId,
			tmdbSeries,
			existingSeries.monitored ?? true
		);

		if (priorSeasonMonitored.size > 0) {
			const newSeasonRows = await db
				.select({ id: seasons.id, seasonNumber: seasons.seasonNumber })
				.from(seasons)
				.where(eq(seasons.seriesId, seriesId));
			for (const row of newSeasonRows) {
				const prior = priorSeasonMonitored.get(row.seasonNumber);
				if (prior !== undefined) {
					await db.update(seasons).set({ monitored: prior }).where(eq(seasons.id, row.id));
				}
			}
		}
		if (priorEpisodeMonitored.size > 0) {
			const newEpisodeRowsForMonitoring = await db
				.select({
					id: episodes.id,
					seasonNumber: episodes.seasonNumber,
					episodeNumber: episodes.episodeNumber
				})
				.from(episodes)
				.where(eq(episodes.seriesId, seriesId));
			for (const row of newEpisodeRowsForMonitoring) {
				const prior = priorEpisodeMonitored.get(`${row.seasonNumber}-${row.episodeNumber}`);
				if (prior !== undefined) {
					await db.update(episodes).set({ monitored: prior }).where(eq(episodes.id, row.id));
				}
			}
		}

		if (fileEpNumbers.size > 0) {
			const newEpisodeRows = await db
				.select({
					id: episodes.id,
					seasonNumber: episodes.seasonNumber,
					episodeNumber: episodes.episodeNumber
				})
				.from(episodes)
				.where(eq(episodes.seriesId, seriesId));
			const newIdByKey = new Map(
				newEpisodeRows.map((e) => [`${e.seasonNumber}-${e.episodeNumber}`, e.id])
			);

			const linkedEpisodeIds = new Set<string>();
			for (const [fileId, epNums] of fileEpNumbers) {
				const newIds = epNums
					.map(({ s, e }) => newIdByKey.get(`${s}-${e}`))
					.filter((eid): eid is string => eid !== undefined);

				await db
					.update(episodeFiles)
					.set({ episodeIds: newIds.length > 0 ? newIds : null })
					.where(eq(episodeFiles.id, fileId));

				newIds.forEach((eid) => linkedEpisodeIds.add(eid));
			}

			if (linkedEpisodeIds.size > 0) {
				await db
					.update(episodes)
					.set({ hasFile: true })
					.where(inArray(episodes.id, [...linkedEpisodeIds]));
			}
		}

		await this.updateSeriesStats(seriesId);

		await db.update(requests).set({ tmdbId: newTmdbId }).where(eq(requests.seriesId, seriesId));

		await this.reorganizeAndRename(seriesId, 'series');

		logger.info(
			{
				seriesId,
				oldTmdbId: existingSeries.tmdbId,
				newTmdbId,
				oldTitle: existingSeries.title,
				newTitle: tmdbSeries.name
			},
			'[MediaMatcher] Rematched series'
		);

		return {
			title: tmdbSeries.name,
			year: tmdbSeries.first_air_date
				? parseInt(tmdbSeries.first_air_date.split('-')[0])
				: existingSeries.year
		};
	}

	/**
	 * Trigger subtitle search for newly imported media
	 * Checks settings to determine if search should run
	 */
	private async triggerSubtitleSearch(
		mediaType: 'movie' | 'episode',
		mediaId: string
	): Promise<void> {
		// Use consolidated settings from MonitoringScheduler
		const settings = await monitoringScheduler.getSettings();

		// Check if subtitle search on import is enabled
		if (!settings.subtitleSearchOnImportEnabled) {
			return;
		}

		// Check if trigger timing matches 'after_metadata' (called after TMDB fetch)
		const trigger = settings.subtitleSearchTrigger;
		if (trigger !== 'after_metadata' && trigger !== 'both') {
			return;
		}

		logger.info({ mediaType, mediaId }, '[MediaMatcher] Triggering subtitle search for new media');

		await searchSubtitlesForNewMedia(mediaType, mediaId);
	}
}

export const mediaMatcherService = MediaMatcherService.getInstance();

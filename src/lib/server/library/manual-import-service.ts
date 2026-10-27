import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { readdir, stat, unlink } from 'node:fs/promises';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { episodes, movies, rootFolders, series, unmatchedFiles } from '#lib/server/db/schema.js';
import { tmdb } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });
import { parseRelease } from '#lib/server/indexers/parser/ReleaseParser.js';
import { hdrFormatsFromLabel } from '#lib/server/indexers/parser/types.js';
import { isVideoFile, mediaInfoService, MediaInfoService } from '#lib/server/library/media-info.js';
import { unmatchedFileService } from '#lib/server/library/unmatched-file-service.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import { resolveLocalizedTitlesForFormats } from '#lib/server/library/naming/localization.js';
import {
	NamingService,
	releaseToNamingInfo,
	type MediaNamingInfo
} from '#lib/server/library/naming/NamingService.js';
import {
	applyFilePermissions,
	ensureDirectory,
	ImportMode,
	transferFileWithMode,
	hasSufficientDiskSpace,
	removeEmptyDirectories
} from '#lib/server/downloadClients/import/FileTransfer.js';
import { getFileManagementSettings } from '#lib/server/settings/file-management.js';
import {
	validateRootFolder,
	getAnimeSubtypeEnforcement,
	type MediaType
} from '#lib/server/library/LibraryAddService.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
import { getMediaParseStem } from '#lib/server/library/media-utils.js';
import { normalizeTitleForMatch } from './title-matching.js';
import { findSuggestedMatches, type SuggestedMatch } from './suggested-matches.js';
import {
	extractSeasonFromPath,
	resolveTvEpisodeIdentifier
} from '#lib/server/library/tv-episode-resolver.js';

interface SourceMediaFile {
	path: string;
	size: number;
}

export interface ManualImportMatch extends SuggestedMatch {
	inLibrary: boolean;
	libraryId?: string;
	rootFolderId?: string | null;
	rootFolderPath?: string | null;
}

interface ManualImportDetectionData {
	sourcePath: string;
	selectedFilePath: string;
	fileName: string;
	detectedFileCount: number;
	detectedSeasons?: number[];
	suggestedSeason?: number;
	parsedTitle: string;
	parsedYear?: number;
	parsedSeason?: number;
	parsedEpisode?: number;
	parsedEpisodes?: number[];
	inferredMediaType: MediaType;
	matches: ManualImportMatch[];
}

export interface ManualImportDetectionGroup extends ManualImportDetectionData {
	id: string;
	displayName: string;
	sourceType: 'file' | 'folder';
}

export interface ManualImportDetectionResult extends ManualImportDetectionData {
	grouped: boolean;
	totalGroups: number;
	selectedGroupId: string;
	groups: ManualImportDetectionGroup[];
}

export interface ExecuteManualImportRequest {
	sourcePath?: string;
	selectedFilePath?: string;
	mediaType: MediaType;
	tmdbId: number;
	importTarget: 'new' | 'existing';
	rootFolderId?: string;
	libraryId?: string;
	seasonNumber?: number;
	episodeNumber?: number;
	/** Override the global file management import mode for this specific import */
	importMode?: 'move' | 'copy' | 'symlink';
	/** Override the global "use hardlinks when possible" setting for this import */
	preferHardlink?: boolean;
	/** When set, the import was requested as a background library job (#530) */
	background?: boolean;
}

export interface ExecuteManualImportResult {
	success: boolean;
	mediaType: MediaType;
	tmdbId: number;
	libraryId: string;
	importedPath: string;
	importedPaths: string[];
	importedCount: number;
	transferMode: string;
}

/**
 * ManualImportService
 *
 * Supports:
 * - Detecting media from a user-selected local path
 * - Suggesting TMDB matches with confidence
 * - Importing files into managed root folders
 * - Reusing unmatched matcher flow for DB linking + media info + subtitle trigger
 */
export class ManualImportService {
	private static instance: ManualImportService;
	private namingService: NamingService;

	private constructor() {
		this.namingService = new NamingService(namingSettingsService.getConfigSync());
	}

	static getInstance(): ManualImportService {
		if (!ManualImportService.instance) {
			ManualImportService.instance = new ManualImportService();
		}
		return ManualImportService.instance;
	}

	async detectFromPath(
		sourcePath: string,
		preferredMediaType?: MediaType
	): Promise<ManualImportDetectionResult> {
		const normalizedSourcePath = resolve(sourcePath);
		const detectionGroupPaths = await this.resolveDetectionGroupPaths(normalizedSourcePath);
		const groups: ManualImportDetectionGroup[] = [];
		const matchCache = new Map<string, SuggestedMatch[]>();

		for (const groupPath of detectionGroupPaths) {
			try {
				groups.push(
					await this.detectGroupFromPath(
						groupPath,
						preferredMediaType,
						normalizedSourcePath,
						matchCache
					)
				);
			} catch (error) {
				logger.warn(
					{
						groupPath,
						error: error instanceof Error ? error.message : String(error)
					},
					'[ManualImport] Skipping group that failed detection'
				);
			}
		}

		if (groups.length === 0) {
			throw new Error('No media files found in selected directory');
		}

		this.applySeriesConsensusMatches(groups);

		const selectedGroup = groups[0];
		return {
			...selectedGroup,
			grouped: groups.length > 1,
			totalGroups: groups.length,
			selectedGroupId: selectedGroup.id,
			groups
		};
	}

	private async detectGroupFromPath(
		groupPath: string,
		preferredMediaType: MediaType | undefined,
		sourceRootPath: string,
		matchCache: Map<string, SuggestedMatch[]>
	): Promise<ManualImportDetectionGroup> {
		const normalizedGroupPath = resolve(groupPath);
		const sourceFiles = await this.resolveSourceFiles(normalizedGroupPath);
		const selectedFile = this.selectPrimarySourceFile(sourceFiles);
		const isStrmFile = extname(selectedFile.path).toLowerCase() === '.strm';

		const fileStem = getMediaParseStem(selectedFile.path);
		const fileParsed = parseRelease(fileStem);
		const fileTvIdentifier = resolveTvEpisodeIdentifier({
			filePath: selectedFile.path,
			parsed: fileParsed
		});

		// When the selected file is a .strm placeholder (e.g. nzbdav) or has no
		// recognisable title, the release info lives in the parent folder name instead.
		// Use dirname(selectedFile.path) so this works whether the group was resolved
		// as a file path or a folder path.
		let parsed = fileParsed;
		let tvIdentifier = fileTvIdentifier;
		if (isStrmFile || !fileParsed.cleanTitle) {
			const parentFolderName = basename(dirname(selectedFile.path));
			const folderStem = getMediaParseStem(parentFolderName);
			const folderParsed = parseRelease(folderStem);
			if (
				folderParsed.cleanTitle &&
				this.isMeaningfulTitleCandidate(folderParsed.cleanTitle) &&
				(!fileParsed.cleanTitle || isStrmFile)
			) {
				parsed = folderParsed;
				tvIdentifier = resolveTvEpisodeIdentifier({
					filePath: selectedFile.path,
					fileName: parentFolderName,
					parsed: folderParsed
				});
			}
		}

		const parsedTitle = parsed.cleanTitle || fileStem;
		const inferredMediaType: MediaType = preferredMediaType || (tvIdentifier ? 'tv' : 'movie');
		const titleCandidates = this.buildTitleCandidatesForMatching({
			parsedTitle,
			groupPath: normalizedGroupPath,
			selectedFilePath: selectedFile.path,
			sourceRootPath
		});
		const detectedSeasons = this.extractDetectedSeasons(sourceFiles);
		const suggestedSeason = extractSeasonFromPath(selectedFile.path);
		const matches = await findSuggestedMatches(
			titleCandidates,
			parsed.year,
			inferredMediaType,
			selectedFile.path,
			matchCache
		);
		const enrichedMatches = await this.enrichMatchesWithLibraryStatus(matches);
		const sourceStats = await stat(normalizedGroupPath);
		const sourceType: 'file' | 'folder' = sourceStats.isDirectory() ? 'folder' : 'file';
		const displayName =
			sourceType === 'folder' ? basename(normalizedGroupPath) : basename(normalizedGroupPath);

		return {
			id: normalizedGroupPath,
			displayName,
			sourceType,
			sourcePath: normalizedGroupPath,
			selectedFilePath: selectedFile.path,
			fileName: basename(selectedFile.path),
			detectedFileCount: sourceFiles.length,
			detectedSeasons:
				inferredMediaType === 'tv' && detectedSeasons.length > 0 ? detectedSeasons : undefined,
			suggestedSeason: inferredMediaType === 'tv' ? suggestedSeason : undefined,
			parsedTitle,
			parsedYear: parsed.year,
			parsedSeason: tvIdentifier?.numbering === 'standard' ? tvIdentifier.seasonNumber : undefined,
			parsedEpisode:
				tvIdentifier?.numbering === 'standard'
					? tvIdentifier.episodeNumbers[0]
					: tvIdentifier?.numbering === 'absolute'
						? tvIdentifier.absoluteEpisode
						: undefined,
			parsedEpisodes:
				tvIdentifier?.numbering === 'standard' && tvIdentifier.episodeNumbers.length > 1
					? tvIdentifier.episodeNumbers
					: undefined,
			inferredMediaType,
			matches: enrichedMatches
		};
	}

	private buildTitleCandidatesForMatching(input: {
		parsedTitle: string;
		groupPath: string;
		selectedFilePath: string;
		sourceRootPath: string;
	}): string[] {
		const candidates: string[] = [];
		this.pushTitleCandidate(candidates, input.parsedTitle);

		const pathCandidates = new Set<string>();
		const selectedFileParent = dirname(input.selectedFilePath);
		pathCandidates.add(selectedFileParent);
		pathCandidates.add(dirname(selectedFileParent));
		pathCandidates.add(dirname(input.groupPath));
		pathCandidates.add(input.groupPath);

		const relativeToRoot = relative(input.sourceRootPath, input.selectedFilePath);
		if (!relativeToRoot.startsWith('..')) {
			const segments = relativeToRoot.split(/[\\/]/).filter(Boolean).slice(0, -1);
			for (const segment of segments) {
				pathCandidates.add(segment);
			}
		}

		for (const candidatePath of pathCandidates) {
			const segment = basename(candidatePath);
			const fromSegment = this.extractTitleCandidateFromSegment(segment);
			if (fromSegment) {
				this.pushTitleCandidate(candidates, fromSegment);
			}
		}

		if (candidates.length === 0) {
			this.pushTitleCandidate(candidates, input.parsedTitle);
		}

		return candidates.slice(0, 5);
	}

	private extractTitleCandidateFromSegment(segment: string): string | null {
		const stem = getMediaParseStem(segment);
		const parsed = parseRelease(stem);
		const parsedTitle = parsed.cleanTitle?.trim();
		if (parsedTitle && this.isMeaningfulTitleCandidate(parsedTitle)) {
			return parsedTitle;
		}

		const sanitized = stem
			.replace(/[._]+/g, ' ')
			.replace(/\b(?:s\d{1,3}|season\s*\d{1,3})\b/gi, ' ')
			.replace(/\s+/g, ' ')
			.trim();

		if (!this.isMeaningfulTitleCandidate(sanitized)) {
			return null;
		}

		return sanitized;
	}

	// Generic container/library folder names that should never be used as TMDB search terms.
	// These match common download client, media server, and root library folder conventions.
	private static readonly GENERIC_FOLDER_NAMES = new Set([
		'movies',
		'movie',
		'films',
		'film',
		'tv',
		'tvshows',
		'tv shows',
		'shows',
		'series',
		'episodes',
		'anime',
		'animation',
		'cartoons',
		'downloads',
		'download',
		'completed',
		'complete',
		'completed-downloads',
		'incomplete',
		'downloading',
		'seeding',
		'media',
		'videos',
		'video',
		'content',
		'incoming',
		'unsorted',
		'import',
		'imports',
		'manual',
		'nzb',
		'nzbdav',
		'usenet',
		'torrents',
		'torrent',
		'blackhole',
		'watch',
		'auto',
		'mnt',
		'mount',
		'data',
		'storage',
		'external',
		'volume',
		'plex',
		'jellyfin',
		'emby',
		'kodi',
		'library'
	]);

	private isMeaningfulTitleCandidate(candidate: string): boolean {
		const trimmed = candidate.trim();
		if (trimmed.length < 2) return false;
		if (/^\d+$/.test(trimmed)) return false;
		if (/^(?:s\d{1,3}|season\s*\d{1,3})$/i.test(trimmed)) return false;
		if (ManualImportService.GENERIC_FOLDER_NAMES.has(trimmed.toLowerCase())) return false;
		return true;
	}

	private pushTitleCandidate(target: string[], candidate: string | undefined | null): void {
		if (!candidate) return;
		const trimmed = candidate.trim();
		if (!this.isMeaningfulTitleCandidate(trimmed)) {
			return;
		}

		const normalizedCandidate = normalizeTitleForMatch(trimmed);
		if (!normalizedCandidate) return;
		const alreadyIncluded = target.some(
			(existing) => normalizeTitleForMatch(existing) === normalizedCandidate
		);
		if (alreadyIncluded) return;
		target.push(trimmed);
	}

	private applySeriesConsensusMatches(groups: ManualImportDetectionGroup[]): void {
		const buckets = new Map<string, ManualImportDetectionGroup[]>();

		for (const group of groups) {
			if (group.inferredMediaType !== 'tv' || group.matches.length === 0) {
				continue;
			}
			const bucketKey = this.getTvSeriesConsensusBucketKey(group);
			const bucket = buckets.get(bucketKey) ?? [];
			bucket.push(group);
			buckets.set(bucketKey, bucket);
		}

		for (const bucketGroups of buckets.values()) {
			if (bucketGroups.length < 2) {
				continue;
			}

			const consensus = new Map<
				number,
				{ match: ManualImportMatch; score: number; support: number; topSupport: number }
			>();
			for (const group of bucketGroups) {
				group.matches.slice(0, 5).forEach((match, index) => {
					const existing = consensus.get(match.tmdbId);
					const rankWeight = index === 0 ? 1 : index === 1 ? 0.7 : index === 2 ? 0.5 : 0.35;
					const weightedScore = rankWeight * (match.confidence || 0);

					if (existing) {
						existing.score += weightedScore;
						existing.support += 1;
						if (index === 0) {
							existing.topSupport += 1;
						}
						return;
					}

					consensus.set(match.tmdbId, {
						match,
						score: weightedScore,
						support: 1,
						topSupport: index === 0 ? 1 : 0
					});
				});
			}

			const bestConsensus = [...consensus.values()].sort(
				(a, b) => b.topSupport - a.topSupport || b.support - a.support || b.score - a.score
			)[0];

			if (!bestConsensus) {
				continue;
			}
			if (
				bestConsensus.topSupport < 2 &&
				bestConsensus.support < Math.ceil(bucketGroups.length * 0.6)
			) {
				continue;
			}

			for (const group of bucketGroups) {
				const topMatch = group.matches[0];
				if (!topMatch) continue;
				if (topMatch.tmdbId === bestConsensus.match.tmdbId) continue;

				const existingConsensusMatch = group.matches.find(
					(match) => match.tmdbId === bestConsensus.match.tmdbId
				);
				const shouldApply =
					Boolean(existingConsensusMatch) ||
					topMatch.confidence < 0.9 ||
					bestConsensus.match.confidence - topMatch.confidence > 0.15;

				if (!shouldApply) {
					continue;
				}

				const mergedMatches = [
					existingConsensusMatch ?? bestConsensus.match,
					...group.matches.filter((match) => match.tmdbId !== bestConsensus.match.tmdbId)
				];
				group.matches = mergedMatches.slice(0, 5);
			}
		}
	}

	private getTvSeriesConsensusBucketKey(group: ManualImportDetectionGroup): string {
		let bucketPath = group.sourceType === 'file' ? dirname(group.sourcePath) : group.sourcePath;
		const folderName = basename(bucketPath);
		if (this.isSeasonLikeFolderName(folderName)) {
			bucketPath = dirname(bucketPath);
		}
		return resolve(bucketPath);
	}

	async executeImport(request: ExecuteManualImportRequest): Promise<ExecuteManualImportResult> {
		const importSourcePath = request.sourcePath ?? request.selectedFilePath;
		if (!importSourcePath) {
			throw new Error('A source path is required for import');
		}
		const sourcePath = resolve(importSourcePath);
		const sourceFiles = await this.resolveSourceFiles(sourcePath);
		if (sourceFiles.length === 0) {
			throw new Error('No importable media files found');
		}

		this.namingService.updateConfig(namingSettingsService.getConfigSync());

		let rootFolder: typeof rootFolders.$inferSelect;
		const importedPaths: string[] = [];
		const unmatchedIds: string[] = [];
		const episodeMapping: Record<string, { season: number; episode: number }> = {};
		let primaryTransferMode: string | undefined;

		if (request.mediaType === 'movie') {
			const movieContext = await this.resolveMovieContext(request);
			rootFolder = movieContext.rootFolder;
			if (rootFolder.readOnly) {
				throw new Error('Cannot import to read-only root folder');
			}

			const sourceFile = this.selectPrimarySourceFile(sourceFiles);
			const sourceBaseName = getMediaParseStem(sourceFile.path);
			const parsed = parseRelease(sourceBaseName);
			const namingInfo = await this.buildMovieNamingInfo(
				sourceFile.path,
				parsed,
				movieContext.namingInfoBase
			);
			const destinationPath = this.buildMovieDestinationPath(
				rootFolder.path,
				movieContext.folderName,
				namingInfo,
				extname(sourceFile.path)
			);

			const movieTransfer = await this.transferSourceFile(
				sourceFile.path,
				destinationPath,
				rootFolder.preserveSymlinks ?? false,
				request.importMode,
				request.preferHardlink
			);
			primaryTransferMode ??= movieTransfer.transferMode;
			const unmatchedId = await this.insertUnmatchedImportRecord({
				destinationPath,
				rootFolderId: rootFolder.id,
				mediaType: 'movie',
				parsedTitle: parsed.cleanTitle || sourceBaseName,
				parsedYear: parsed.year,
				tmdbId: request.tmdbId
			});
			importedPaths.push(destinationPath);
			unmatchedIds.push(unmatchedId);
		} else {
			const tvContext = await this.resolveTvContext(request);
			rootFolder = tvContext.rootFolder;
			if (rootFolder.readOnly) {
				throw new Error('Cannot import to read-only root folder');
			}

			const episodeMetaCache = new Map<
				number,
				Map<number, { title?: string; absoluteNumber?: number; airDate?: string }>
			>();
			const tvFiles = this.selectTvSourceFiles(sourceFiles);
			const destinationSet = new Set<string>();

			for (const sourceFile of tvFiles) {
				const sourceBaseName = getMediaParseStem(sourceFile.path);
				const parsed = parseRelease(sourceBaseName);
				const fileMapping = this.resolveTvEpisodeMapping(
					parsed,
					request,
					tvFiles.length,
					sourceFile.path
				);

				if (!fileMapping) {
					throw new Error(
						`Could not determine season/episode for "${basename(sourceFile.path)}". Add season/episode tags to the filename or import one file at a time with manual overrides.`
					);
				}

				const primaryEpisodeNumber = fileMapping.episodeNumbers[0];
				const episodeMeta = await this.getEpisodeMetaCached(
					request.tmdbId,
					fileMapping.seasonNumber,
					primaryEpisodeNumber,
					episodeMetaCache,
					tvContext.existingSeriesDbId,
					tvContext.tmdbSeriesSeasons
				);
				const namingInfo = await this.buildEpisodeNamingInfo(
					sourceFile.path,
					parsed,
					tvContext.namingInfoBase,
					fileMapping.seasonNumber,
					fileMapping.episodeNumbers,
					episodeMeta.title,
					episodeMeta.absoluteNumber,
					episodeMeta.airDate
				);
				const destinationPath = this.buildEpisodeDestinationPath(
					rootFolder.path,
					tvContext.seriesFolderName,
					tvContext.useSeasonFolders,
					fileMapping.seasonNumber,
					namingInfo,
					extname(sourceFile.path)
				);

				if (destinationSet.has(destinationPath)) {
					throw new Error(
						`Import naming collision detected for "${basename(sourceFile.path)}". Multiple files resolved to the same destination path.`
					);
				}
				destinationSet.add(destinationPath);

				const episodeTransfer = await this.transferSourceFile(
					sourceFile.path,
					destinationPath,
					rootFolder.preserveSymlinks ?? false,
					request.importMode,
					request.preferHardlink
				);
				primaryTransferMode ??= episodeTransfer.transferMode;
				const unmatchedId = await this.insertUnmatchedImportRecord({
					destinationPath,
					rootFolderId: rootFolder.id,
					mediaType: 'tv',
					parsedTitle: parsed.cleanTitle || sourceBaseName,
					parsedYear: parsed.year,
					parsedSeason: fileMapping.seasonNumber,
					parsedEpisode: primaryEpisodeNumber,
					tmdbId: request.tmdbId
				});

				importedPaths.push(destinationPath);
				unmatchedIds.push(unmatchedId);
				episodeMapping[unmatchedId] = {
					season: fileMapping.seasonNumber,
					episode: primaryEpisodeNumber
				};
			}
		}

		if (unmatchedIds.length === 0) {
			throw new Error('No files were queued for import');
		}

		try {
			const matchResult = await unmatchedFileService.matchFiles({
				fileIds: unmatchedIds,
				tmdbId: request.tmdbId,
				mediaType: request.mediaType,
				...(request.mediaType === 'tv'
					? {
							episodeMapping: {
								...episodeMapping
							}
						}
					: {})
			});

			if (!matchResult.success) {
				throw new Error(matchResult.errors[0] || 'Failed to link imported file');
			}
		} catch (error) {
			for (const unmatchedId of unmatchedIds) {
				await db
					.delete(unmatchedFiles)
					.where(eq(unmatchedFiles.id, unmatchedId))
					.catch(() => undefined);
			}
			for (const importedPath of importedPaths) {
				await unlink(importedPath).catch(() => undefined);
			}

			throw error;
		}

		if (request.mediaType === 'movie') {
			const [movie] = await db
				.select({ id: movies.id })
				.from(movies)
				.where(eq(movies.tmdbId, request.tmdbId))
				.limit(1);

			if (!movie) {
				throw new Error('Movie import completed but library item was not found');
			}

			return {
				success: true,
				mediaType: 'movie',
				tmdbId: request.tmdbId,
				libraryId: movie.id,
				importedPath: importedPaths[0],
				importedPaths,
				importedCount: importedPaths.length,
				transferMode: primaryTransferMode as string
			};
		}

		const [show] = await db
			.select({ id: series.id })
			.from(series)
			.where(eq(series.tmdbId, request.tmdbId))
			.limit(1);

		if (!show) {
			throw new Error('Series import completed but library item was not found');
		}

		return {
			success: true,
			mediaType: 'tv',
			tmdbId: request.tmdbId,
			libraryId: show.id,
			importedPath: importedPaths[0],
			importedPaths,
			importedCount: importedPaths.length,
			transferMode: primaryTransferMode as string
		};
	}

	private buildMovieDestinationPath(
		rootFolderPath: string,
		folderName: string,
		namingInfo: MediaNamingInfo,
		sourceExtension: string
	): string {
		const fileName = this.namingService.generateMovieFileName({
			...namingInfo,
			originalExtension: sourceExtension
		});
		return join(rootFolderPath, folderName, fileName);
	}

	private buildEpisodeDestinationPath(
		rootFolderPath: string,
		seriesFolderName: string,
		useSeasonFolders: boolean,
		seasonNumber: number,
		namingInfo: MediaNamingInfo,
		sourceExtension: string
	): string {
		const episodeFileName = this.namingService.generateEpisodeFileName({
			...namingInfo,
			originalExtension: sourceExtension
		});
		const seasonFolderName = this.namingService.generateSeasonFolderName(seasonNumber, namingInfo);
		return useSeasonFolders
			? join(rootFolderPath, seriesFolderName, seasonFolderName, episodeFileName)
			: join(rootFolderPath, seriesFolderName, episodeFileName);
	}

	private async resolveMovieContext(request: ExecuteManualImportRequest): Promise<{
		rootFolder: typeof rootFolders.$inferSelect;
		folderName: string;
		namingInfoBase: MediaNamingInfo;
	}> {
		if (request.importTarget === 'existing') {
			const [movie] = await db
				.select({
					id: movies.id,
					title: movies.title,
					originalTitle: movies.originalTitle,
					year: movies.year,
					path: movies.path,
					imdbId: movies.imdbId,
					collectionName: movies.collectionName,
					rootFolderId: movies.rootFolderId
				})
				.from(movies)
				.where(eq(movies.tmdbId, request.tmdbId))
				.limit(1);

			if (!movie) {
				throw new Error('Selected movie is not in the library');
			}

			if (!movie.rootFolderId) {
				throw new Error('Selected movie has no root folder configured');
			}

			const [rootFolder] = await db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, movie.rootFolderId))
				.limit(1);

			if (!rootFolder || rootFolder.mediaType !== 'movie') {
				throw new Error('Selected movie root folder is missing or invalid');
			}

			const localizedTitles = await resolveLocalizedTitlesForFormats('movie', request.tmdbId);
			return {
				rootFolder,
				folderName: movie.path,
				namingInfoBase: {
					title: movie.title,
					originalTitle: movie.originalTitle ?? undefined,
					year: movie.year ?? undefined,
					tmdbId: request.tmdbId,
					imdbId: movie.imdbId ?? undefined,
					collectionName: movie.collectionName ?? undefined,
					localizedTitles
				}
			};
		}

		const destinationRootFolderId = await this.resolveDestinationRootFolderId(request, 'movie');

		const tmdbMovie = await tmdb.getMovie(request.tmdbId);
		const enforceAnimeSubtype = await getAnimeSubtypeEnforcement();
		const isAnimeMedia = isLikelyAnimeMedia({
			genres: tmdbMovie.genres,
			originalLanguage: tmdbMovie.original_language,
			originCountries: tmdbMovie.production_countries?.map((country) => country.iso_3166_1),
			productionCountries: tmdbMovie.production_countries,
			title: tmdbMovie.title,
			originalTitle: tmdbMovie.original_title
		});

		await validateRootFolder(destinationRootFolderId, 'movie', {
			requireWritable: true,
			enforceAnimeSubtype,
			isAnimeMedia,
			mediaTitle: tmdbMovie.title
		});
		const [rootFolder] = await db
			.select()
			.from(rootFolders)
			.where(eq(rootFolders.id, destinationRootFolderId))
			.limit(1);

		if (!rootFolder) {
			throw new Error('Root folder not found');
		}

		const externalIds = await tmdb.getMovieExternalIds(request.tmdbId).catch(() => ({
			imdb_id: null
		}));
		const year = tmdbMovie.release_date
			? parseInt(tmdbMovie.release_date.split('-')[0], 10)
			: undefined;
		const localizedTitles = await resolveLocalizedTitlesForFormats('movie', request.tmdbId);
		const folderName = this.namingService.generateMovieFolderName({
			title: tmdbMovie.title,
			originalTitle: tmdbMovie.original_title || undefined,
			year,
			tmdbId: request.tmdbId,
			imdbId: externalIds.imdb_id ?? undefined,
			collectionName: tmdbMovie.belongs_to_collection?.name ?? undefined,
			localizedTitles
		});

		return {
			rootFolder,
			folderName,
			namingInfoBase: {
				title: tmdbMovie.title,
				originalTitle: tmdbMovie.original_title || undefined,
				year,
				tmdbId: request.tmdbId,
				imdbId: externalIds.imdb_id ?? undefined,
				collectionName: tmdbMovie.belongs_to_collection?.name ?? undefined,
				localizedTitles
			}
		};
	}

	private async resolveTvContext(request: ExecuteManualImportRequest): Promise<{
		rootFolder: typeof rootFolders.$inferSelect;
		seriesFolderName: string;
		useSeasonFolders: boolean;
		namingInfoBase: MediaNamingInfo;
		existingSeriesDbId?: string;
		tmdbSeriesSeasons?: Array<{ season_number: number; episode_count: number }>;
	}> {
		if (request.importTarget === 'existing') {
			const [show] = await db
				.select({
					id: series.id,
					title: series.title,
					originalTitle: series.originalTitle,
					year: series.year,
					path: series.path,
					imdbId: series.imdbId,
					tvdbId: series.tvdbId,
					seasonFolder: series.seasonFolder,
					rootFolderId: series.rootFolderId,
					seriesType: series.seriesType
				})
				.from(series)
				.where(eq(series.tmdbId, request.tmdbId))
				.limit(1);

			if (!show) {
				throw new Error('Selected series is not in the library');
			}

			if (!show.rootFolderId) {
				throw new Error('Selected series has no root folder configured');
			}

			const [rootFolder] = await db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, show.rootFolderId))
				.limit(1);

			if (!rootFolder || rootFolder.mediaType !== 'tv') {
				throw new Error('Selected series root folder is missing or invalid');
			}

			const localizedTitles = await resolveLocalizedTitlesForFormats('series', request.tmdbId);
			return {
				rootFolder,
				seriesFolderName: show.path,
				useSeasonFolders: show.seasonFolder ?? true,
				existingSeriesDbId: show.id,
				namingInfoBase: {
					title: show.title,
					originalTitle: show.originalTitle ?? undefined,
					year: show.year ?? undefined,
					tmdbId: request.tmdbId,
					tvdbId: show.tvdbId ?? undefined,
					imdbId: show.imdbId ?? undefined,
					isAnime: show.seriesType === 'anime',
					isDaily: show.seriesType === 'daily',
					localizedTitles
				}
			};
		}

		const destinationRootFolderId = await this.resolveDestinationRootFolderId(request, 'tv');

		const tvShow = await tmdb.getTVShow(request.tmdbId);
		const enforceAnimeSubtype = await getAnimeSubtypeEnforcement();
		const isAnimeMedia = isLikelyAnimeMedia({
			genres: tvShow.genres,
			originalLanguage: tvShow.original_language,
			originCountries: tvShow.origin_country,
			productionCountries: tvShow.production_countries,
			title: tvShow.name,
			originalTitle: tvShow.original_name
		});

		await validateRootFolder(destinationRootFolderId, 'tv', {
			requireWritable: true,
			enforceAnimeSubtype,
			isAnimeMedia,
			mediaTitle: tvShow.name
		});
		const [rootFolder] = await db
			.select()
			.from(rootFolders)
			.where(eq(rootFolders.id, destinationRootFolderId))
			.limit(1);

		if (!rootFolder) {
			throw new Error('Root folder not found');
		}

		const externalIds = await tmdb.getTvExternalIds(request.tmdbId).catch(() => ({
			tvdb_id: null,
			imdb_id: null
		}));
		const year = tvShow.first_air_date
			? parseInt(tvShow.first_air_date.split('-')[0], 10)
			: undefined;
		const localizedTitles = await resolveLocalizedTitlesForFormats('series', request.tmdbId);
		const seriesFolderName = this.namingService.generateSeriesFolderName({
			title: tvShow.name,
			originalTitle: tvShow.original_name || undefined,
			year,
			tmdbId: request.tmdbId,
			tvdbId: externalIds.tvdb_id ?? undefined,
			imdbId: externalIds.imdb_id ?? undefined,
			localizedTitles
		});

		return {
			rootFolder,
			seriesFolderName,
			useSeasonFolders: true,
			tmdbSeriesSeasons: tvShow.seasons,
			namingInfoBase: {
				title: tvShow.name,
				originalTitle: tvShow.original_name || undefined,
				year,
				tmdbId: request.tmdbId,
				tvdbId: externalIds.tvdb_id ?? undefined,
				imdbId: externalIds.imdb_id ?? undefined,
				isAnime: rootFolder.mediaSubType === 'anime' || isAnimeMedia,
				localizedTitles
			}
		};
	}

	private async resolveDestinationRootFolderId(
		request: ExecuteManualImportRequest,
		mediaType: MediaType
	): Promise<string> {
		if (request.libraryId) {
			const destination = await getLibraryEntityService().resolveDefaultRootFolderForLibrary(
				request.libraryId,
				mediaType
			);
			return destination.rootFolderId;
		}

		if (request.rootFolderId) {
			return request.rootFolderId;
		}

		throw new Error('Destination library is required for new imports');
	}

	private async getEpisodeMeta(
		tmdbId: number,
		seasonNumber: number,
		episodeNumber: number,
		existingSeriesDbId?: string,
		tmdbSeriesSeasons?: Array<{ season_number: number; episode_count: number }>
	): Promise<{ title?: string; absoluteNumber?: number; airDate?: string }> {
		let absoluteNumber: number | undefined;

		if (existingSeriesDbId) {
			// Walk all episodes in order (same algorithm as RenamePreviewService.buildAbsoluteEpisodeFallbackMap)
			// so null absolute numbers are filled in sequentially rather than dropped.
			const allEps = await db
				.select({
					seasonNumber: episodes.seasonNumber,
					episodeNumber: episodes.episodeNumber,
					absoluteEpisodeNumber: episodes.absoluteEpisodeNumber
				})
				.from(episodes)
				.where(and(eq(episodes.seriesId, existingSeriesDbId), gt(episodes.seasonNumber, 0)))
				.orderBy(asc(episodes.seasonNumber), asc(episodes.episodeNumber));

			let lastAbsolute = 0;
			for (const ep of allEps) {
				if (ep.absoluteEpisodeNumber != null && ep.absoluteEpisodeNumber > 0) {
					lastAbsolute = ep.absoluteEpisodeNumber;
				} else {
					lastAbsolute++;
				}
				if (ep.seasonNumber === seasonNumber && ep.episodeNumber === episodeNumber) {
					absoluteNumber = lastAbsolute;
					break;
				}
			}
		}

		try {
			const tmdbSeason = await tmdb.getSeason(tmdbId, seasonNumber);
			const ep = tmdbSeason.episodes?.find((e) => e.episode_number === episodeNumber);

			// For new series: TMDB absolute_episode_number is the primary source.
			// If absent, compute from the series season list (already fetched with the show).
			if (absoluteNumber === undefined) {
				absoluteNumber = ep?.absolute_episode_number ?? undefined;

				if (absoluteNumber === undefined && tmdbSeriesSeasons) {
					const priorEpisodeCount = tmdbSeriesSeasons
						.filter((s) => s.season_number > 0 && s.season_number < seasonNumber)
						.reduce((sum, s) => sum + s.episode_count, 0);
					absoluteNumber = priorEpisodeCount + episodeNumber;
				}
			}

			return {
				title: ep?.name,
				absoluteNumber,
				airDate: ep?.air_date || undefined
			};
		} catch {
			return { absoluteNumber };
		}
	}

	private async getEpisodeMetaCached(
		tmdbId: number,
		seasonNumber: number,
		episodeNumber: number,
		cache: Map<number, Map<number, { title?: string; absoluteNumber?: number; airDate?: string }>>,
		existingSeriesDbId?: string,
		tmdbSeriesSeasons?: Array<{ season_number: number; episode_count: number }>
	): Promise<{ title?: string; absoluteNumber?: number; airDate?: string }> {
		const cachedSeason = cache.get(seasonNumber);
		if (cachedSeason?.has(episodeNumber)) {
			return cachedSeason.get(episodeNumber)!;
		}

		const meta = await this.getEpisodeMeta(
			tmdbId,
			seasonNumber,
			episodeNumber,
			existingSeriesDbId,
			tmdbSeriesSeasons
		);
		const seasonCache =
			cache.get(seasonNumber) ??
			new Map<number, { title?: string; absoluteNumber?: number; airDate?: string }>();
		seasonCache.set(episodeNumber, meta);
		cache.set(seasonNumber, seasonCache);
		return meta;
	}

	private async resolveDetectionGroupPaths(pathValue: string): Promise<string[]> {
		return this.resolveDetectionGroupPathsInternal(resolve(pathValue), {
			allowSelfFallback: true
		});
	}

	private async resolveDetectionGroupPathsInternal(
		pathValue: string,
		options: { allowSelfFallback: boolean }
	): Promise<string[]> {
		const fullPath = resolve(pathValue);
		const fileStats = await stat(fullPath);

		if (fileStats.isFile()) {
			if (!isVideoFile(fullPath)) {
				throw new Error('Selected path is not a supported media file');
			}
			return [fullPath];
		}

		if (!fileStats.isDirectory()) {
			throw new Error('Selected path is not a file or directory');
		}

		const entries = (await readdir(fullPath, {
			withFileTypes: true,
			encoding: 'utf8'
		})) as Array<{
			name: string;
			isDirectory: () => boolean;
			isFile: () => boolean;
			isSymbolicLink: () => boolean;
		}>;

		const detectedFileGroups: string[] = [];
		const containerFolders: string[] = [];

		for (const entry of entries) {
			if (entry.name.startsWith('.')) {
				continue;
			}

			const entryPath = join(fullPath, entry.name);
			const normalizedEntryPath = resolve(entryPath);
			if (!this.isPathWithinRoot(normalizedEntryPath, fullPath)) {
				logger.warn(
					{
						rootPath: fullPath,
						fullPath: normalizedEntryPath
					},
					'[ManualImport] Skipping path outside requested import scope'
				);
				continue;
			}

			if (entry.isSymbolicLink()) {
				logger.debug(
					{
						entryPath: normalizedEntryPath
					},
					'[ManualImport] Skipping symlink while grouping import scan'
				);
				continue;
			}

			if (entry.isDirectory()) {
				const groupingType = await this.classifyDirectoryGroupingType(normalizedEntryPath);
				if (groupingType === 'none') {
					continue;
				}

				if (groupingType === 'group') {
					const nestedFiles: SourceMediaFile[] = [];
					await this.collectVideoFiles(normalizedEntryPath, nestedFiles, normalizedEntryPath);
					for (const nestedFile of nestedFiles) {
						detectedFileGroups.push(resolve(nestedFile.path));
					}
					continue;
				}

				containerFolders.push(normalizedEntryPath);
				continue;
			}

			if (entry.isFile() && isVideoFile(normalizedEntryPath)) {
				detectedFileGroups.push(normalizedEntryPath);
			}
		}

		const resolvedGroupSet = new Set(detectedFileGroups);

		if (containerFolders.length > 0) {
			const sortedContainers = [...containerFolders].sort((a, b) =>
				a.localeCompare(b, undefined, { numeric: true })
			);
			for (const containerPath of sortedContainers) {
				const nestedGroups = await this.resolveDetectionGroupPathsInternal(containerPath, {
					allowSelfFallback: false
				});
				for (const nestedGroup of nestedGroups) {
					resolvedGroupSet.add(nestedGroup);
				}
			}
		}

		if (resolvedGroupSet.size > 0) {
			return [...resolvedGroupSet].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		}

		if (!options.allowSelfFallback) {
			return [];
		}

		const fallbackFiles: SourceMediaFile[] = [];
		await this.collectVideoFiles(fullPath, fallbackFiles, fullPath);
		if (fallbackFiles.length === 0) {
			return [];
		}

		return [...new Set(fallbackFiles.map((file) => resolve(file.path)))].sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true })
		);
	}

	private async classifyDirectoryGroupingType(
		directoryPath: string
	): Promise<'group' | 'container' | 'none'> {
		const entries = (await readdir(directoryPath, {
			withFileTypes: true,
			encoding: 'utf8'
		})) as Array<{
			name: string;
			isDirectory: () => boolean;
			isFile: () => boolean;
			isSymbolicLink: () => boolean;
		}>;

		let hasDirectVideo = false;
		const childDirectories: Array<{ name: string; path: string }> = [];

		for (const entry of entries) {
			if (entry.name.startsWith('.')) {
				continue;
			}

			const entryPath = join(directoryPath, entry.name);
			const normalizedEntryPath = resolve(entryPath);
			if (!this.isPathWithinRoot(normalizedEntryPath, directoryPath)) {
				continue;
			}
			if (entry.isSymbolicLink()) {
				continue;
			}

			if (entry.isFile() && isVideoFile(normalizedEntryPath)) {
				hasDirectVideo = true;
				break;
			}

			if (entry.isDirectory()) {
				childDirectories.push({ name: entry.name, path: normalizedEntryPath });
			}
		}

		if (hasDirectVideo) {
			return 'group';
		}
		if (childDirectories.length === 0) {
			return 'none';
		}

		const allSeasonLike = childDirectories.every((dir) => this.isSeasonLikeFolderName(dir.name));
		if (allSeasonLike) {
			for (const childDirectory of childDirectories) {
				if (await this.directoryContainsVideoFiles(childDirectory.path, childDirectory.path)) {
					return 'group';
				}
			}
			return 'none';
		}

		for (const childDirectory of childDirectories) {
			if (await this.directoryContainsVideoFiles(childDirectory.path, childDirectory.path)) {
				return 'container';
			}
		}

		return 'none';
	}

	private async directoryContainsVideoFiles(
		directoryPath: string,
		rootPath: string
	): Promise<boolean> {
		let entries: Array<{
			name: string;
			isDirectory: () => boolean;
			isFile: () => boolean;
			isSymbolicLink: () => boolean;
		}>;
		try {
			entries = (await readdir(directoryPath, {
				withFileTypes: true,
				encoding: 'utf8'
			})) as unknown as typeof entries;
		} catch (error) {
			const fsError = error as NodeJS.ErrnoException;
			if (fsError?.code === 'ENOENT' || fsError?.code === 'EACCES' || fsError?.code === 'EPERM') {
				logger.debug(
					{
						directoryPath,
						code: fsError.code
					},
					'[ManualImport] Skipping inaccessible directory while checking for media'
				);
				return false;
			}
			throw error;
		}

		for (const entry of entries) {
			if (entry.name.startsWith('.')) {
				continue;
			}

			const entryPath = join(directoryPath, entry.name);
			const normalizedEntryPath = resolve(entryPath);
			if (!this.isPathWithinRoot(normalizedEntryPath, rootPath)) {
				continue;
			}
			if (entry.isSymbolicLink()) {
				continue;
			}

			if (entry.isFile() && isVideoFile(normalizedEntryPath)) {
				return true;
			}

			if (entry.isDirectory()) {
				if (await this.directoryContainsVideoFiles(normalizedEntryPath, rootPath)) {
					return true;
				}
			}
		}

		return false;
	}

	private isSeasonLikeFolderName(folderName: string): boolean {
		return /^(?:season[\s._-]*\d{1,3}|s\d{1,3})$/i.test(folderName.trim());
	}

	private async resolveSourceFiles(pathValue: string): Promise<SourceMediaFile[]> {
		const fullPath = resolve(pathValue);
		const fileStats = await stat(fullPath);

		if (fileStats.isFile()) {
			if (!isVideoFile(fullPath)) {
				throw new Error('Selected path is not a supported media file');
			}
			return [{ path: fullPath, size: fileStats.size }];
		}

		if (!fileStats.isDirectory()) {
			throw new Error('Selected path is not a file or directory');
		}

		const files: SourceMediaFile[] = [];
		await this.collectVideoFiles(fullPath, files, fullPath);

		if (files.length === 0) {
			throw new Error('No media files found in selected directory');
		}

		files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
		return files;
	}

	private selectPrimarySourceFile(files: SourceMediaFile[]): SourceMediaFile {
		const nonStrmFiles = files.filter((file) => extname(file.path).toLowerCase() !== '.strm');
		const candidates = nonStrmFiles.length > 0 ? nonStrmFiles : files;
		candidates.sort((a, b) => b.size - a.size);
		return candidates[0];
	}

	private selectTvSourceFiles(files: SourceMediaFile[]): SourceMediaFile[] {
		const nonStrmFiles = files.filter((file) => extname(file.path).toLowerCase() !== '.strm');
		const selected = nonStrmFiles.length > 0 ? nonStrmFiles : files;
		return [...selected].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
	}

	private extractDetectedSeasons(files: SourceMediaFile[]): number[] {
		const seasons = new Set<number>();
		for (const file of files) {
			const fileStem = getMediaParseStem(file.path);
			const parsed = parseRelease(fileStem);
			const tvIdentifier = resolveTvEpisodeIdentifier({
				filePath: file.path,
				parsed
			});
			if (tvIdentifier?.numbering === 'standard') {
				seasons.add(tvIdentifier.seasonNumber);
			}
		}

		return [...seasons].sort((a, b) => a - b);
	}

	private resolveTvEpisodeMapping(
		parsed: ReturnType<typeof parseRelease>,
		request: ExecuteManualImportRequest,
		totalFiles: number,
		sourceFilePath: string
	): { seasonNumber: number; episodeNumbers: number[] } | null {
		const resolved = resolveTvEpisodeIdentifier({
			filePath: sourceFilePath,
			parsed,
			seasonHint: request.seasonNumber
		});

		if (resolved?.numbering === 'standard') {
			return {
				seasonNumber: request.seasonNumber ?? resolved.seasonNumber,
				episodeNumbers:
					request.episodeNumber != null ? [request.episodeNumber] : resolved.episodeNumbers
			};
		}

		if (totalFiles > 1) {
			return null;
		}

		return {
			seasonNumber: request.seasonNumber ?? 1,
			episodeNumbers: request.episodeNumber != null ? [request.episodeNumber] : [1]
		};
	}

	private async transferSourceFile(
		sourcePath: string,
		destinationPath: string,
		preserveSymlinks: boolean,
		importModeOverride?: 'move' | 'copy' | 'symlink',
		preferHardlinkOverride?: boolean
	): Promise<{ transferMode: string }> {
		await ensureDirectory(dirname(destinationPath));

		const settings = await getFileManagementSettings();
		const effectiveMode = importModeOverride ?? settings.importMode;
		const canMoveFiles = effectiveMode === 'move';
		const importMode =
			effectiveMode === 'symlink'
				? ImportMode.Symlink
				: canMoveFiles
					? ImportMode.Auto
					: ImportMode.HardlinkOrCopy;

		if (settings.minimumFreeSpaceGb > 0) {
			const destDir = dirname(destinationPath);
			const hasSpace = await hasSufficientDiskSpace(destDir, settings.minimumFreeSpaceGb);
			if (!hasSpace) {
				throw new Error(
					`Insufficient disk space on destination: less than ${settings.minimumFreeSpaceGb} GB free`
				);
			}
		}

		const transferResult = await transferFileWithMode(sourcePath, destinationPath, {
			importMode,
			canMoveFiles,
			preserveSymlinks,
			preferHardlink: preferHardlinkOverride ?? settings.preferHardlink
		});

		if (!transferResult.success) {
			throw new Error(transferResult.error || 'Failed to transfer source file');
		}

		// Mirror the automatic import path (issue #617): a freshly copied or
		// moved file must not keep the container's umask-truncated 0600 mode.
		if (transferResult.mode !== 'symlink') {
			await applyFilePermissions(
				destinationPath,
				sourcePath,
				settings.preservePermissions,
				settings.chmodFile
			);
		}

		const action =
			transferResult.mode === 'hardlink'
				? 'Hardlinked'
				: transferResult.mode === 'move'
					? 'Moved'
					: transferResult.mode === 'symlink'
						? 'Symlinked'
						: 'Copied';
		logger.info(
			{ source: basename(sourcePath), dest: basename(destinationPath), mode: transferResult.mode },
			`[ManualImport] ${action}: ${basename(sourcePath)}`
		);

		if (settings.deleteEmptyFolders && transferResult.mode === 'move') {
			await removeEmptyDirectories(dirname(sourcePath), resolve(dirname(sourcePath), '..'));
		}

		return { transferMode: transferResult.mode };
	}

	private async insertUnmatchedImportRecord(input: {
		destinationPath: string;
		rootFolderId: string;
		mediaType: MediaType;
		parsedTitle: string;
		parsedYear?: number;
		parsedSeason?: number;
		parsedEpisode?: number;
		tmdbId: number;
	}): Promise<string> {
		const destinationStats = await stat(input.destinationPath);
		const unmatchedId = randomUUID();

		await db.insert(unmatchedFiles).values({
			id: unmatchedId,
			path: input.destinationPath,
			rootFolderId: input.rootFolderId,
			mediaType: input.mediaType,
			size: destinationStats.size,
			parsedTitle: input.parsedTitle,
			parsedYear: input.parsedYear,
			parsedSeason: input.mediaType === 'tv' ? (input.parsedSeason ?? null) : null,
			parsedEpisode: input.mediaType === 'tv' ? (input.parsedEpisode ?? null) : null,
			reason: 'manual_import',
			suggestedMatches: [
				{
					tmdbId: input.tmdbId,
					title: input.parsedTitle,
					year: input.parsedYear,
					confidence: 1
				}
			]
		});

		return unmatchedId;
	}

	private async buildMovieNamingInfo(
		sourceFilePath: string,
		parsed: ReturnType<typeof parseRelease>,
		namingInfoBase: MediaNamingInfo
	): Promise<MediaNamingInfo> {
		const probedInfo = await this.probeMediaInfoForNaming(sourceFilePath);
		return this.enrichNamingInfo(namingInfoBase, parsed, sourceFilePath, probedInfo);
	}

	private async buildEpisodeNamingInfo(
		sourceFilePath: string,
		parsed: ReturnType<typeof parseRelease>,
		namingInfoBase: MediaNamingInfo,
		seasonNumber: number,
		episodeNumbers: number[],
		episodeTitle?: string,
		absoluteNumber?: number,
		airDate?: string
	): Promise<MediaNamingInfo> {
		const probedInfo = await this.probeMediaInfoForNaming(sourceFilePath);
		return this.enrichNamingInfo(
			{
				...namingInfoBase,
				seasonNumber,
				episodeNumbers,
				episodeTitle,
				absoluteNumber,
				airDate
			},
			parsed,
			sourceFilePath,
			probedInfo
		);
	}

	private async probeMediaInfoForNaming(sourceFilePath: string): Promise<{
		width?: number;
		height?: number;
		videoCodec?: string;
		videoHdrFormat?: string;
		videoBitDepth?: number;
		audioCodec?: string;
		audioChannels?: number;
		audioLanguages?: string[];
	} | null> {
		try {
			return await mediaInfoService.extractMediaInfo(sourceFilePath, { allowStrmProbe: true });
		} catch (error) {
			logger.debug(
				{
					sourceFilePath,
					error: error instanceof Error ? error.message : String(error)
				},
				'[ManualImport] Probe failed while preparing naming metadata'
			);
			return null;
		}
	}

	private enrichNamingInfo(
		namingInfoBase: MediaNamingInfo,
		parsed: ReturnType<typeof parseRelease>,
		sourceFilePath: string,
		probedInfo: {
			width?: number;
			height?: number;
			videoCodec?: string;
			videoHdrFormat?: string;
			videoBitDepth?: number;
			audioCodec?: string;
			audioChannels?: number;
			audioLanguages?: string[];
		} | null
	): MediaNamingInfo {
		const parsedNamingInfo = releaseToNamingInfo(parsed, sourceFilePath);

		const parsedResolution = this.normalizeMetadataToken(parsedNamingInfo.resolution);
		const parsedCodec = this.normalizeMetadataToken(parsedNamingInfo.codec);
		const parsedHdr = this.normalizeMetadataToken(parsedNamingInfo.hdr);
		const parsedBitDepth = this.normalizeMetadataToken(parsedNamingInfo.bitDepth);
		const parsedAudioCodec = this.normalizeMetadataToken(parsedNamingInfo.audioCodec);
		const parsedAudioChannels = this.normalizeMetadataToken(parsedNamingInfo.audioChannels);
		const parsedReleaseGroup = this.normalizeMetadataToken(parsedNamingInfo.releaseGroup);

		return {
			...parsedNamingInfo,
			...namingInfoBase,
			resolution: parsedResolution ?? this.mapMediaInfoResolution(probedInfo),
			codec: parsedCodec ?? this.mapMediaInfoCodec(probedInfo?.videoCodec),
			hdr: parsedHdr ?? this.mapMediaInfoHdr(probedInfo?.videoHdrFormat),
			bitDepth: parsedBitDepth ?? this.mapMediaInfoBitDepth(probedInfo?.videoBitDepth),
			audioCodec: parsedAudioCodec ?? this.normalizeMetadataToken(probedInfo?.audioCodec),
			audioChannels:
				parsedAudioChannels ?? this.mapMediaInfoAudioChannels(probedInfo?.audioChannels),
			audioLanguages:
				probedInfo?.audioLanguages && probedInfo.audioLanguages.length > 0
					? probedInfo.audioLanguages
					: parsedNamingInfo.audioLanguages,
			releaseGroup: parsedReleaseGroup,
			originalExtension: extname(sourceFilePath)
		};
	}

	private mapMediaInfoBitDepth(bitDepth?: number): string | undefined {
		if (!bitDepth || bitDepth <= 0) return undefined;
		return `${bitDepth}`;
	}

	private normalizeMetadataToken(value?: string | null): string | undefined {
		if (!value) return undefined;
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		const normalized = trimmed.toLowerCase();
		if (normalized === 'unknown' || normalized === 'n/a' || normalized === '-') {
			return undefined;
		}
		return trimmed;
	}

	private mapMediaInfoResolution(
		mediaInfo?: {
			width?: number;
			height?: number;
		} | null
	): string | undefined {
		if (!mediaInfo) return undefined;
		const label = MediaInfoService.getResolutionLabel(
			mediaInfo.width,
			mediaInfo.height
		).toLowerCase();
		if (label === 'unknown') return undefined;
		if (label === '4k') return '2160p';
		return /^\d{3,4}p$/.test(label) ? label : undefined;
	}

	private mapMediaInfoCodec(codec?: string): string | undefined {
		const normalized = this.normalizeMetadataToken(codec)?.toLowerCase();
		if (!normalized) return undefined;
		const compact = normalized.replace(/[^a-z0-9+]/g, '');

		if (compact.includes('av1')) return 'av1';
		if (compact.includes('hevc') || compact.includes('h265') || compact.includes('x265'))
			return 'h265';
		if (compact.includes('avc') || compact.includes('h264') || compact.includes('x264'))
			return 'h264';
		if (compact.includes('vc1')) return 'vc1';
		if (compact.includes('mpeg2') || compact.includes('m2v')) return 'mpeg2';
		if (compact.includes('xvid')) return 'xvid';
		if (compact.includes('divx')) return 'divx';

		return undefined;
	}

	/**
	 * Headline HDR format from a probe label.
	 *
	 * Shares the canonical label parser with the import service so probe
	 * combos ("Dolby Vision HDR10+") are recognised identically in both paths.
	 */
	private mapMediaInfoHdr(hdr?: string): string | undefined {
		return hdrFormatsFromLabel(this.normalizeMetadataToken(hdr))[0];
	}

	private mapMediaInfoAudioChannels(channels?: number): string | undefined {
		if (!channels || channels <= 0) {
			return undefined;
		}

		if (channels === 1) return '1.0';
		if (channels === 2) return '2.0';
		if (channels === 6) return '5.1';
		if (channels === 8) return '7.1';
		return `${channels}.0`;
	}

	private async collectVideoFiles(
		dirPath: string,
		accumulator: SourceMediaFile[],
		rootPath: string
	): Promise<void> {
		let entries: Array<{
			name: string;
			isDirectory: () => boolean;
			isFile: () => boolean;
			isSymbolicLink: () => boolean;
		}>;
		try {
			entries = (await readdir(dirPath, {
				withFileTypes: true,
				encoding: 'utf8'
			})) as unknown as typeof entries;
		} catch (error) {
			const fsError = error as NodeJS.ErrnoException;
			if (fsError?.code === 'ENOENT' || fsError?.code === 'EACCES' || fsError?.code === 'EPERM') {
				logger.debug(
					{
						dirPath,
						code: fsError.code
					},
					'[ManualImport] Skipping inaccessible directory during scan'
				);
				return;
			}
			throw error;
		}

		for (const entry of entries) {
			const entryName = entry.name;
			if (entryName.startsWith('.')) {
				continue;
			}

			const fullPath = join(dirPath, entryName);
			const normalizedFullPath = resolve(fullPath);
			if (!this.isPathWithinRoot(normalizedFullPath, rootPath)) {
				logger.warn(
					{
						rootPath,
						fullPath: normalizedFullPath
					},
					'[ManualImport] Skipping path outside requested import scope'
				);
				continue;
			}

			if (entry.isSymbolicLink()) {
				logger.debug({ fullPath }, '[ManualImport] Skipping symlink during import scan');
				continue;
			}

			if (entry.isDirectory()) {
				try {
					await this.collectVideoFiles(fullPath, accumulator, rootPath);
				} catch (error) {
					const fsError = error as NodeJS.ErrnoException;
					if (
						fsError?.code === 'ENOENT' ||
						fsError?.code === 'EACCES' ||
						fsError?.code === 'EPERM'
					) {
						logger.debug(
							{
								fullPath,
								code: fsError.code
							},
							'[ManualImport] Skipping transient nested directory during scan'
						);
						continue;
					}
					throw error;
				}
				continue;
			}

			if (!entry.isFile() || !isVideoFile(fullPath)) {
				continue;
			}

			try {
				const itemStats = await stat(fullPath);
				accumulator.push({ path: fullPath, size: itemStats.size });
			} catch (error) {
				const fsError = error as NodeJS.ErrnoException;
				if (fsError?.code === 'ENOENT' || fsError?.code === 'EACCES' || fsError?.code === 'EPERM') {
					logger.debug(
						{
							fullPath,
							code: fsError.code
						},
						'[ManualImport] Skipping inaccessible file during scan'
					);
					continue;
				}
				throw error;
			}
		}
	}

	private isPathWithinRoot(pathToCheck: string, rootPath: string): boolean {
		const normalizedPath = resolve(pathToCheck);
		const normalizedRoot = resolve(rootPath);
		if (normalizedPath === normalizedRoot) {
			return true;
		}
		return normalizedPath.startsWith(normalizedRoot + '/');
	}

	private async enrichMatchesWithLibraryStatus(
		matches: SuggestedMatch[]
	): Promise<ManualImportMatch[]> {
		if (matches.length === 0) {
			return [];
		}

		const movieTmdbIds = matches.filter((m) => m.mediaType === 'movie').map((m) => m.tmdbId);
		const tvTmdbIds = matches.filter((m) => m.mediaType === 'tv').map((m) => m.tmdbId);
		const rootFolderIds = new Set<string>();

		const movieRows =
			movieTmdbIds.length > 0
				? await db
						.select({ id: movies.id, tmdbId: movies.tmdbId, rootFolderId: movies.rootFolderId })
						.from(movies)
						.where(inArray(movies.tmdbId, movieTmdbIds))
				: [];

		const seriesRows =
			tvTmdbIds.length > 0
				? await db
						.select({ id: series.id, tmdbId: series.tmdbId, rootFolderId: series.rootFolderId })
						.from(series)
						.where(inArray(series.tmdbId, tvTmdbIds))
				: [];

		for (const row of [...movieRows, ...seriesRows]) {
			if (row.rootFolderId) {
				rootFolderIds.add(row.rootFolderId);
			}
		}

		const folderRows =
			rootFolderIds.size > 0
				? await db
						.select({ id: rootFolders.id, path: rootFolders.path })
						.from(rootFolders)
						.where(inArray(rootFolders.id, [...rootFolderIds]))
				: [];
		const folderMap = new Map(folderRows.map((folder) => [folder.id, folder.path]));

		const movieMap = new Map(movieRows.map((row) => [row.tmdbId, row]));
		const seriesMap = new Map(seriesRows.map((row) => [row.tmdbId, row]));

		return matches.map((match) => {
			const existing =
				match.mediaType === 'movie' ? movieMap.get(match.tmdbId) : seriesMap.get(match.tmdbId);
			if (!existing) {
				return {
					...match,
					inLibrary: false
				};
			}
			return {
				...match,
				inLibrary: true,
				libraryId: existing.id,
				rootFolderId: existing.rootFolderId,
				rootFolderPath: existing.rootFolderId ? folderMap.get(existing.rootFolderId) : null
			};
		});
	}
}

export const manualImportService = ManualImportService.getInstance();

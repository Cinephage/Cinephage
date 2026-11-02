import { basename } from 'node:path';
import { DOWNLOAD, EXCLUDED_FILE_PATTERNS, isVideoFile } from '#lib/config/constants.js';
import { LibraryDestinationPlanner } from '#lib/server/downloadClients/import/LibraryDestinationPlanner.js';
import {
	matchEpisodesByIdentifier,
	matchEpisodesFromQueueContext,
	resolveEpisodeIdentifierWithFallback,
	type SeriesType
} from '#lib/server/library/tv-episode-resolver.js';
import type { ProviderFile, ProviderItem } from './debrid-adapter';
import { extractLanguagesFromFileName } from '#lib/server/indexers/parser/patterns/language.js';
import { languageMatches } from '#lib/server/languages/audio-preference.js';

interface ReadyProviderFileMapperOptions {
	naming: ConstructorParameters<typeof LibraryDestinationPlanner>[0];
}

interface QueueContext {
	title: string;
	movieId?: string;
	seriesId?: string;
	episodeIds?: string[];
	seasonNumber?: number;
}

interface MovieContext {
	type: 'movie';
	movie: {
		id: string;
		title: string;
		originalTitle?: string | null;
		year?: number | null;
		tmdbId: number;
		imdbId?: string | null;
		collectionName?: string | null;
		path: string;
	};
}

interface EpisodeContextRecord {
	id: string;
	seasonNumber: number;
	episodeNumber: number;
	title?: string | null;
	absoluteEpisodeNumber?: number | null;
	airDate?: string | null;
}

interface SeriesContext {
	type: 'series';
	series: {
		id: string;
		title: string;
		originalTitle?: string | null;
		year?: number | null;
		tmdbId?: number | null;
		tvdbId?: number | null;
		imdbId?: string | null;
		path: string;
		seriesType?: string | null;
		seasonFolder?: boolean | null;
	};
	episodes: EpisodeContextRecord[];
}

interface MapperInput {
	providerItem: ProviderItem;
	context: {
		queueItem: QueueContext;
		media: MovieContext | SeriesContext;
		library: { rootPath: string };
	};
	/**
	 * Ordered audio languages from the item's effective language profile
	 * (original first when preferOriginal). Drives the movie file-choice
	 * tiebreaker: among similarly-sized video files, prefer the one whose
	 * name evidences a wanted language (audio-language design, tier 3).
	 */
	preferredAudioLanguages?: string[];
}

export interface ReadyProviderFileMapping {
	providerFileRef: {
		providerItemId: string;
		providerFileId: string;
	};
	plan: {
		fileName: string;
		relativePath: string;
		finalPath: string;
	};
	media: {
		movieId?: string;
		seriesId?: string;
		episodeIds?: string[];
		seasonNumber?: number;
	};
	metadata?: Record<string, unknown>;
}

export interface ReadyProviderFileMapperResult {
	files: ReadyProviderFileMapping[];
}

export class ReadyProviderFileMapper {
	private readonly planner: LibraryDestinationPlanner;

	constructor(options: ReadyProviderFileMapperOptions) {
		this.planner = new LibraryDestinationPlanner(options.naming);
	}

	async map(input: MapperInput): Promise<ReadyProviderFileMapperResult> {
		if (input.providerItem.readiness !== 'ready') {
			throw new Error('Provider item is not ready for file mapping');
		}

		const eligibleFiles = input.providerItem.files.filter((file) => this.isEligibleVideo(file));
		if (eligibleFiles.length === 0) {
			throw new Error('Provider item has no playable eligible video files');
		}

		return input.context.media.type === 'movie'
			? await this.mapMovie(input, eligibleFiles)
			: await this.mapSeries(input, eligibleFiles);
	}

	/**
	 * Pick the movie file: largest eligible video wins, with a language
	 * tiebreaker among near-equal sizes — packs often carry per-language
	 * video variants of the same size, and file names are the only pre-download
	 * signal for which is which.
	 */
	private chooseMovieFile(
		eligibleFiles: ProviderFile[],
		preferredAudioLanguages?: string[]
	): ProviderFile {
		const bySize = [...eligibleFiles].sort((a, b) => b.sizeBytes - a.sizeBytes);
		const largest = bySize[0];
		if (!preferredAudioLanguages || preferredAudioLanguages.length === 0) return largest;

		const nearLargest = bySize.filter(
			(file) => file.sizeBytes >= largest.sizeBytes * 0.95 && file.sizeBytes > 0
		);
		for (const preferred of preferredAudioLanguages) {
			for (const file of nearLargest) {
				const tokens = extractLanguagesFromFileName(file.name).languages;
				if (
					tokens.some((tag) => tag !== 'multi' && tag !== 'orig' && languageMatches(tag, preferred))
				) {
					return file;
				}
			}
		}
		return largest;
	}

	private async mapMovie(
		input: MapperInput,
		eligibleFiles: ProviderFile[]
	): Promise<ReadyProviderFileMapperResult> {
		if (input.context.media.type !== 'movie') throw new Error('Movie context is required');
		const providerFile = this.chooseMovieFile(eligibleFiles, input.preferredAudioLanguages);
		const plan = await this.planner.planMovie({
			rootPath: input.context.library.rootPath,
			mediaPath: input.context.media.movie.path,
			media: input.context.media.movie,
			sourcePath: this.safeProviderParseReference(providerFile),
			releaseTitle: input.context.queueItem.title
		});

		return {
			files: [
				{
					providerFileRef: {
						providerItemId: input.providerItem.providerItemId,
						providerFileId: providerFile.providerFileId
					},
					plan,
					media: { movieId: input.context.media.movie.id },
					metadata: {
						sizeBytes: providerFile.sizeBytes
					}
				}
			]
		};
	}

	private async mapSeries(
		input: MapperInput,
		eligibleFiles: ProviderFile[]
	): Promise<ReadyProviderFileMapperResult> {
		if (input.context.media.type !== 'series') throw new Error('Series context is required');

		const queueEpisodeIds = input.context.queueItem.episodeIds ?? [];
		if (queueEpisodeIds.length === 0) {
			throw new Error('Series queue has no episodes to map');
		}
		const queuedEpisodes = input.context.media.episodes.filter((episode) =>
			queueEpisodeIds.includes(episode.id)
		);
		const allSeriesEpisodes = input.context.media.episodes;
		const normalizedSeriesType: SeriesType =
			input.context.media.series.seriesType === 'anime' ||
			input.context.media.series.seriesType === 'daily'
				? input.context.media.series.seriesType
				: 'standard';
		const mappings: ReadyProviderFileMapping[] = [];
		const mappedEpisodeIds = new Set<string>();

		for (const providerFile of eligibleFiles) {
			const resolved = resolveEpisodeIdentifierWithFallback(
				this.normalizedProviderPath(providerFile),
				{
					title: input.context.queueItem.title,
					seasonNumber: input.context.queueItem.seasonNumber,
					episodeIds: queueEpisodeIds
				},
				normalizedSeriesType
			);
			if (!resolved) {
				throw new Error('Eligible provider video cannot map to queued episodes');
			}
			const { identifier } = resolved;

			let matchedEpisodes = matchEpisodesByIdentifier(queuedEpisodes, identifier);
			if (matchedEpisodes.length === 0) {
				matchedEpisodes = matchEpisodesFromQueueContext(
					allSeriesEpisodes,
					{
						title: input.context.queueItem.title,
						seasonNumber: input.context.queueItem.seasonNumber,
						episodeIds: queueEpisodeIds
					},
					identifier
				);
			}

			if (matchedEpisodes.length === 0) {
				continue;
			}

			if (identifier.numbering === 'standard') {
				if (matchedEpisodes.length > identifier.episodeNumbers.length) {
					throw new Error('Eligible provider video maps ambiguously to queued episodes');
				}
				if (matchedEpisodes.length !== identifier.episodeNumbers.length) {
					throw new Error('Eligible provider video cannot map every referenced queued episode');
				}
			} else {
				// One absolute/airDate key must map to exactly one episode.
				if (matchedEpisodes.length > 1) {
					throw new Error('Eligible provider video maps ambiguously to queued episodes');
				}
			}

			const episodeIds = matchedEpisodes.map((episode) => episode.id);
			for (const episodeId of episodeIds) {
				if (mappedEpisodeIds.has(episodeId)) {
					throw new Error('Eligible provider videos map to the same episode');
				}
				mappedEpisodeIds.add(episodeId);
			}

			const seasonNumber = matchedEpisodes[0].seasonNumber;
			const episodeNumbers = matchedEpisodes
				.map((episode) => episode.episodeNumber)
				.sort((a, b) => a - b);
			const firstEpisode = matchedEpisodes[0];
			const plan = await this.planner.planEpisode({
				rootPath: input.context.library.rootPath,
				mediaPath: input.context.media.series.path,
				media: input.context.media.series,
				seasonNumber,
				episodeNumbers,
				episodeTitle:
					matchedEpisodes.length === 1 ? (matchedEpisodes[0].title ?? undefined) : undefined,
				absoluteNumber: firstEpisode.absoluteEpisodeNumber ?? undefined,
				airDate: firstEpisode.airDate ?? undefined,
				useSeasonFolders: input.context.media.series.seasonFolder !== false,
				sourcePath: this.safeProviderParseReference(providerFile),
				releaseTitle: input.context.queueItem.title
			});

			mappings.push({
				providerFileRef: {
					providerItemId: input.providerItem.providerItemId,
					providerFileId: providerFile.providerFileId
				},
				plan,
				media: {
					seriesId: input.context.media.series.id,
					seasonNumber,
					episodeIds
				},
				metadata: {
					sizeBytes: providerFile.sizeBytes
				}
			});
		}

		const omittedQueuedEpisodes = queueEpisodeIds.filter(
			(episodeId) => !mappedEpisodeIds.has(episodeId)
		);
		if (omittedQueuedEpisodes.length > 0) {
			const targetYear = input.context.media.series.year;
			const providerYear =
				mappings.length === 0 && targetYear
					? this.repeatedMismatchedYear(eligibleFiles, targetYear)
					: undefined;
			if (providerYear) {
				throw new Error(
					`Provider content year ${providerYear} does not match queued series ` +
						`${input.context.media.series.title} (${targetYear})`
				);
			}
			throw new Error('Provider file mapping omitted queued episodes');
		}

		return { files: mappings };
	}

	private isEligibleVideo(file: ProviderFile): boolean {
		if (file.selected === false) return false;
		const pathForFiltering = this.normalizedProviderPath(file);
		if (!isVideoFile(pathForFiltering)) return false;
		if (file.sizeBytes < DOWNLOAD.MIN_IMPORT_SIZE_BYTES) return false;
		// Mirror ImportService: excluded patterns are tested against the basename
		// only, never the provider folder path.
		const baseName = this.safeProviderParseReference(file);
		return !EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(baseName));
	}

	private safeProviderParseReference(file: ProviderFile): string {
		const normalizedName = this.normalizeSeparators(file.name || file.path);
		const baseName = basename(normalizedName) || basename(this.normalizedProviderPath(file));
		return baseName;
	}

	private normalizedProviderPath(file: ProviderFile): string {
		return this.normalizeSeparators(file.path || file.name);
	}

	private repeatedMismatchedYear(files: ProviderFile[], targetYear: number): number | undefined {
		const counts = new Map<number, number>();
		for (const file of files) {
			const years = new Set(
				[...this.normalizedProviderPath(file).matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) =>
					Number(match[0])
				)
			);
			if ([...years].some((year) => Math.abs(year - targetYear) <= 1)) return;
			for (const year of years) counts.set(year, (counts.get(year) ?? 0) + 1);
		}

		return [...counts].find(([, count]) => count >= 2)?.[0];
	}

	private normalizeSeparators(value: string): string {
		return value.replace(/\\/g, '/');
	}
}

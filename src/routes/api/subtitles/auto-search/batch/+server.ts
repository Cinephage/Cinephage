import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { episodes, series, movies } from '#lib/server/db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { subtitleBatchAutoSearchSchema } from '#lib/validation/schemas.js';
import type { SubtitleBatchAutoSearchRequest } from '#lib/validation/schemas.js';
import { parseBody } from '#lib/server/api/validate.js';
import { createSSEOperationStream } from '#lib/server/sse.js';
import { createChildLogger } from '#lib/logging/index.js';
import { LanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import {
	autoSearchEpisode,
	autoSearchMovie,
	summarizeAutoSearchReason,
	type AutoSearchItemResult,
	type AutoSearchReason
} from '#lib/server/subtitles/auto-search.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';

const logger = createChildLogger({ module: 'SubtitleAutoSearchBatchApi', logDomain: 'subtitles' });

/**
 * Hard cap on resolved batch items. Mirrors the `.max(500)` cap on the
 * `episodes` request array so a season/series/collection cannot expand into an
 * unbounded provider run.
 */
const MAX_BATCH_ITEMS = 500;

interface BatchProgressEvent {
	current: number;
	total: number;
	episodeId?: string;
	movieId?: string;
	title: string;
	status: AutoSearchReason | 'searching';
	reason?: AutoSearchReason | 'satisfied';
	seasonNumber?: number;
	episodeNumber?: number;
	bestRejectedScore?: number;
	bestRejectedReason?: string;
	outcomes?: AutoSearchItemResult['outcomes'];
	subtitle?: {
		language: string;
		matchScore: number;
		providerName: string;
	};
}

interface BatchCompletedEvent {
	success: boolean;
	total: number;
	downloaded: number;
	notFound: number;
	skipped: number;
	errors: number;
	reasons: Partial<Record<AutoSearchReason | 'satisfied', number>>;
	error?: string;
}

interface EpisodeBatchItem {
	id: string;
	title: string;
	seasonNumber: number;
	episodeNumber: number;
}

interface MovieBatchItem {
	id: string;
	title: string;
}

type BatchItem = EpisodeBatchItem | MovieBatchItem;

function isEpisodeItem(item: BatchItem): item is EpisodeBatchItem {
	return 'seasonNumber' in item;
}

async function resolveEpisodeItems(
	body: SubtitleBatchAutoSearchRequest
): Promise<EpisodeBatchItem[]> {
	switch (body.type) {
		case 'season': {
			const eps = await db
				.select()
				.from(episodes)
				.where(
					and(eq(episodes.seriesId, body.seriesId), eq(episodes.seasonNumber, body.seasonNumber))
				)
				.limit(MAX_BATCH_ITEMS);
			return eps.map((ep) => ({
				id: ep.id,
				title: ep.title || `Episode ${ep.episodeNumber}`,
				seasonNumber: ep.seasonNumber,
				episodeNumber: ep.episodeNumber
			}));
		}
		case 'series': {
			const profileService = LanguageProfileService.getInstance();
			const missingIds = await profileService.getSeriesEpisodesMissingSubtitles(body.seriesId);
			const eps = await db.select().from(episodes).where(eq(episodes.seriesId, body.seriesId));
			const missingSet = new Set(missingIds);
			return eps
				.filter((ep) => missingSet.has(ep.id))
				.slice(0, MAX_BATCH_ITEMS)
				.map((ep) => ({
					id: ep.id,
					title: ep.title || `Episode ${ep.episodeNumber}`,
					seasonNumber: ep.seasonNumber,
					episodeNumber: ep.episodeNumber
				}));
		}
		case 'episodes': {
			const eps = await db.select().from(episodes).where(inArray(episodes.id, body.episodeIds));
			const episodesById = new Map(eps.map((ep) => [ep.id, ep]));
			return body.episodeIds
				.map((id) => {
					const ep = episodesById.get(id);
					if (!ep) return null;
					return {
						id: ep.id,
						title: ep.title || `Episode ${ep.episodeNumber}`,
						seasonNumber: ep.seasonNumber,
						episodeNumber: ep.episodeNumber
					};
				})
				.filter((item): item is EpisodeBatchItem => item !== null);
		}
		default:
			return [];
	}
}

async function resolveMovieItems(body: SubtitleBatchAutoSearchRequest): Promise<MovieBatchItem[]> {
	if (body.type !== 'collection') return [];

	const collectionMovies = await db
		.select()
		.from(movies)
		.where(eq(movies.tmdbCollectionId, body.collectionId))
		.limit(MAX_BATCH_ITEMS);
	return collectionMovies.map((m) => ({
		id: m.id,
		title: m.title
	}));
}

/** Load the owned rows an episode batch item needs, then run the shared orchestration. */
async function autoSearchEpisodeItem(
	item: EpisodeBatchItem,
	requirement?: SubtitleRequirement
): Promise<AutoSearchItemResult> {
	const episode = await db.query.episodes.findFirst({ where: eq(episodes.id, item.id) });
	if (!episode) {
		return {
			ownerType: 'episode',
			ownerId: item.id,
			title: item.title,
			skipped: 'no_file',
			searched: false,
			outcomes: [],
			downloaded: 0
		};
	}
	const seriesData = await db.query.series.findFirst({ where: eq(series.id, episode.seriesId) });
	if (!seriesData) {
		return {
			ownerType: 'episode',
			ownerId: item.id,
			title: item.title,
			skipped: 'no_file',
			searched: false,
			outcomes: [],
			downloaded: 0
		};
	}
	return autoSearchEpisode(episode, seriesData, { requirement });
}

/** Load the movie row a batch item needs, then run the shared orchestration. */
async function autoSearchMovieItem(
	item: MovieBatchItem,
	requirement?: SubtitleRequirement
): Promise<AutoSearchItemResult> {
	const movie = await db.query.movies.findFirst({ where: eq(movies.id, item.id) });
	if (!movie) {
		return {
			ownerType: 'movie',
			ownerId: item.id,
			title: item.title,
			skipped: 'no_file',
			searched: false,
			outcomes: [],
			downloaded: 0
		};
	}
	return autoSearchMovie(movie, { requirement });
}

/** Map a result to the progress status the client renders. */
function resultStatus(result: AutoSearchItemResult): AutoSearchReason | 'satisfied' {
	return summarizeAutoSearchReason(result);
}

/**
 * POST /api/subtitles/auto-search/batch
 * Batch auto-search and download subtitles for seasons, series, collections, or selected episodes.
 * Returns SSE stream for real-time progress.
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await parseBody(request, subtitleBatchAutoSearchSchema);

		return createSSEOperationStream(
			request,
			async ({ send, close, isAborted }) => {
				const sendEvent = (event: string, data: unknown) => {
					if (isAborted()) return;
					send(event, data);
				};

				const isMovie = body.type === 'collection';
				const items: BatchItem[] = isMovie
					? await resolveMovieItems(body)
					: await resolveEpisodeItems(body);

				if (items.length === 0) {
					sendEvent('subtitle:completed', {
						success: true,
						total: 0,
						downloaded: 0,
						notFound: 0,
						skipped: 0,
						errors: 0,
						reasons: {}
					} satisfies BatchCompletedEvent);
					close();
					return;
				}

				sendEvent('subtitle:started', { total: items.length, type: body.type });

				let downloaded = 0;
				let notFound = 0;
				let skipped = 0;
				let errors = 0;
				const reasons: Partial<Record<AutoSearchReason | 'satisfied', number>> = {};

				for (let i = 0; i < items.length; i++) {
					if (isAborted()) return;

					const item = items[i];
					const isEpisode = isEpisodeItem(item);
					const base = {
						current: i + 1,
						total: items.length,
						episodeId: isEpisode ? item.id : undefined,
						movieId: !isEpisode ? item.id : undefined,
						title: item.title,
						seasonNumber: isEpisode ? item.seasonNumber : undefined,
						episodeNumber: isEpisode ? item.episodeNumber : undefined
					};

					sendEvent('subtitle:progress', {
						...base,
						status: 'searching'
					} satisfies BatchProgressEvent);

					try {
						const result = isEpisode
							? await autoSearchEpisodeItem(item, body.requirement)
							: await autoSearchMovieItem(item, body.requirement);
						const reason = resultStatus(result);
						reasons[reason] = (reasons[reason] ?? 0) + 1;

						if (result.downloaded > 0) {
							downloaded += result.downloaded;
							const downloadedOutcome = result.outcomes.find((o) => o.reason === 'downloaded');
							sendEvent('subtitle:progress', {
								...base,
								status: 'downloaded',
								reason,
								outcomes: result.outcomes,
								subtitle: downloadedOutcome
									? {
											language: downloadedOutcome.language ?? 'unknown',
											matchScore: downloadedOutcome.matchScore ?? 0,
											providerName: downloadedOutcome.providerName ?? 'unknown'
										}
									: undefined
							} satisfies BatchProgressEvent);
						} else if (result.skipped || result.outcomes.length === 0) {
							skipped++;
							sendEvent('subtitle:progress', {
								...base,
								status: (result.skipped ?? 'no_results') as AutoSearchReason,
								reason,
								outcomes: result.outcomes
							} satisfies BatchProgressEvent);
						} else {
							notFound++;
							const rejected = result.outcomes.find((o) => o.reason === 'below_threshold');
							sendEvent('subtitle:progress', {
								...base,
								status: reason as AutoSearchReason,
								reason,
								outcomes: result.outcomes,
								bestRejectedScore: rejected?.bestRejectedScore,
								bestRejectedReason: rejected?.bestRejectedReason
							} satisfies BatchProgressEvent);
						}
					} catch (error) {
						errors++;
						reasons.error = (reasons.error ?? 0) + 1;
						logger.error(
							{
								itemId: item.id,
								title: item.title,
								error: error instanceof Error ? error.message : String(error)
							},
							'[SubtitleBatch] Failed to auto-search subtitle'
						);
						sendEvent('subtitle:progress', {
							...base,
							status: 'error',
							reason: 'error'
						} satisfies BatchProgressEvent);
					}

					if (i < items.length - 1) {
						await new Promise((resolve) => setTimeout(resolve, 1000));
					}
				}

				sendEvent('subtitle:completed', {
					success: true,
					total: items.length,
					downloaded,
					notFound,
					skipped,
					errors,
					reasons
				} satisfies BatchCompletedEvent);
			},
			{ heartbeatInterval: 25000 }
		);
	} catch (error) {
		logger.error(
			'[SubtitleBatch] Batch auto-search error',
			error instanceof Error ? error : undefined
		);
		return new Response(
			JSON.stringify({
				success: false,
				error:
					error instanceof Error ? error.message : 'Failed to perform batch subtitle auto-search'
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
};

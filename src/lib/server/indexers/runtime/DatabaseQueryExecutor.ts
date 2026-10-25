/**
 * DatabaseQueryExecutor - Executes YAML-defined database queries for internal indexers.
 *
 * This is used by the internal streaming indexer (cinephage-stream) which queries
 * the local library database instead of making HTTP requests to external sites.
 *
 * The YAML definition specifies database queries using:
 * - search.movieQuery: Query for movie content
 * - search.tvQuery: Query for TV series/episodes
 *
 * Results are transformed into ReleaseResult format using output mappings.
 *
 * Release types generated:
 * - Movie: stream://movie/{tmdbId} - Single release per movie
 * - Episode: stream://tv/{tmdbId}/{season}/{episode} - Single episode
 * - Season: stream://tv/{tmdbId}/{season} - Season pack (all episodes)
 * - Series: stream://tv/{tmdbId}/all - Complete series (all seasons)
 *
 * Quality is determined at playback time by the streaming proxy.
 */

import type { YamlDefinition, DatabaseQuery, QueryCondition } from '../schema/yamlDefinition';
import type { TemplateEngine } from '../engine/TemplateEngine';
import type {
	SearchCriteria,
	ReleaseResult,
	IndexerProtocol,
	MovieSearchCriteria,
	TvSearchCriteria
} from '../types';
import { Category } from '../types/category';
import { db } from '#lib/server/db/index.js';
import { movies, series, episodes } from '#lib/server/db/schema.js';
import { eq, and, like, sql } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

/**
 * Context passed to the database query executor
 */
export interface DatabaseQueryContext {
	indexerId: string;
	indexerName: string;
	protocol: IndexerProtocol;
	baseUrl: string;
	settings: Record<string, string | boolean | number>;
}

/**
 * Executes YAML-defined database queries against the local library
 */
export class DatabaseQueryExecutor {
	private readonly definition: YamlDefinition;
	private readonly templateEngine: TemplateEngine;
	private readonly log: ReturnType<typeof createChildLogger>;

	constructor(definition: YamlDefinition, templateEngine: TemplateEngine) {
		this.definition = definition;
		this.templateEngine = templateEngine;
		this.log = createChildLogger({ component: 'DatabaseQueryExecutor' });
	}

	/**
	 * Execute a search against the local database
	 */
	async execute(criteria: SearchCriteria, context: DatabaseQueryContext): Promise<ReleaseResult[]> {
		const searchType = criteria.searchType;

		this.log.debug({ searchType, criteria }, 'Executing database query');

		// Set up template context
		this.setupTemplateContext(criteria, context);

		switch (searchType) {
			case 'movie':
				return this.executeMovieQuery(criteria as unknown as MovieSearchCriteria, context);
			case 'tv':
				return this.executeTvQuery(criteria as unknown as TvSearchCriteria, context);
			default: {
				// For basic search, try both movie and TV
				const movieResults = await this.executeMovieQuery(
					criteria as unknown as MovieSearchCriteria,
					context
				);
				const tvResults = await this.executeTvQuery(
					criteria as unknown as TvSearchCriteria,
					context
				);
				return [...movieResults, ...tvResults];
			}
		}
	}

	/**
	 * Set up template context with search criteria
	 */
	private setupTemplateContext(criteria: SearchCriteria, context: DatabaseQueryContext): void {
		// Pass criteria directly to template engine - it handles variable extraction
		this.templateEngine.setQuery(criteria);
		this.templateEngine.setConfig(context.settings);
	}

	/**
	 * Execute movie query
	 */
	private async executeMovieQuery(
		criteria: MovieSearchCriteria,
		context: DatabaseQueryContext
	): Promise<ReleaseResult[]> {
		const queryDef = this.definition.search.movieQuery;
		if (!queryDef) {
			// No movie query defined, use default
			return this.executeDefaultMovieQuery(criteria, context);
		}

		return this.executeDefinedQuery(queryDef, criteria, context, 'movie');
	}

	/**
	 * Execute TV query
	 */
	private async executeTvQuery(
		criteria: TvSearchCriteria,
		context: DatabaseQueryContext
	): Promise<ReleaseResult[]> {
		const queryDef = this.definition.search.tvQuery;
		if (!queryDef) {
			return this.executeDefaultTvQuery(criteria, context);
		}

		return this.executeDefinedQuery(queryDef, criteria, context, 'tv');
	}

	/**
	 * Execute a YAML-defined database query
	 */
	private async executeDefinedQuery(
		queryDef: DatabaseQuery,
		criteria: SearchCriteria,
		context: DatabaseQueryContext,
		contentType: 'movie' | 'tv'
	): Promise<ReleaseResult[]> {
		// Get the table reference
		const tableRef = this.getTableRef(queryDef.table);
		if (!tableRef) {
			this.log.error({ table: queryDef.table }, 'Unknown table in query definition');
			return [];
		}

		// Build WHERE conditions
		const conditions = this.buildConditions(queryDef.conditions || [], criteria);

		// Execute query
		let results: unknown[];
		try {
			if (conditions.length > 0) {
				results = await db
					.select()
					.from(tableRef)
					.where(and(...conditions));
			} else {
				results = await db.select().from(tableRef);
			}
		} catch (error) {
			this.log.error({ error, queryDef }, 'Database query failed');
			return [];
		}

		// Map results to ReleaseResult using output mapping
		return this.mapResults(results, queryDef, context, contentType);
	}

	/**
	 * Execute default movie query when no YAML query is defined.
	 * Generates ONE release per movie - quality is determined at playback time.
	 */
	private async executeDefaultMovieQuery(
		criteria: MovieSearchCriteria,
		context: DatabaseQueryContext
	): Promise<ReleaseResult[]> {
		const conditions = [];
		const isInteractive = criteria.searchSource === 'interactive';

		if (criteria.tmdbId) {
			conditions.push(eq(movies.tmdbId, criteria.tmdbId));
		}
		if (criteria.imdbId) {
			conditions.push(eq(movies.imdbId, criteria.imdbId));
		}
		if (criteria.query) {
			conditions.push(like(movies.title, `%${criteria.query}%`));
		}

		// Only query monitored movies for automatic searches
		if (!isInteractive) {
			conditions.push(eq(movies.monitored, true));
		}

		this.log.info(
			{
				indexer: context.indexerName,
				tmdbId: criteria.tmdbId,
				imdbId: criteria.imdbId,
				query: criteria.query,
				searchSource: criteria.searchSource,
				conditionsCount: conditions.length
			},
			'[DatabaseQueryExecutor] Executing movie query'
		);

		let results: (typeof movies.$inferSelect)[];
		if (conditions.length > 0) {
			results = await db
				.select()
				.from(movies)
				.where(and(...conditions))
				.limit(100);
		} else if (!isInteractive) {
			results = await db.select().from(movies).where(eq(movies.monitored, true)).limit(100);
		} else {
			results = await db.select().from(movies).limit(100);
		}

		this.log.info(
			{
				indexer: context.indexerName,
				resultsCount: results.length,
				movies: results.slice(0, 5).map((m) => ({ id: m.id, title: m.title, tmdbId: m.tmdbId }))
			},
			'[DatabaseQueryExecutor] Movie query results'
		);

		const releaseResults: ReleaseResult[] = [];

		for (const movie of results) {
			// Generate ONE release per movie (quality determined at playback time)
			releaseResults.push({
				guid: `stream-movie-${movie.tmdbId}`,
				title: `${movie.title} (${movie.year || 'N/A'}) [Streaming]`,
				downloadUrl: `stream://movie/${movie.tmdbId}`,
				size: this.STREAMING_FILE_SIZE,
				publishDate: movie.added ? new Date(movie.added) : new Date(),
				indexerId: context.indexerId,
				indexerName: context.indexerName,
				protocol: 'streaming',
				categories: [Category.MOVIES],
				tmdbId: movie.tmdbId,
				imdbId: movie.imdbId ?? undefined,
				streaming: {
					providerName: 'Cinephage',
					verified: true
				}
			});
		}

		return releaseResults;
	}

	/**
	 * Execute default TV query when no YAML query is defined.
	 * Generates releases based on search criteria:
	 * - Episode specified → single episode release
	 * - Season specified (no episode) → season pack only
	 * - Neither specified → complete series + season packs
	 *
	 * Quality is determined at playback time by the streaming proxy.
	 */
	private async executeDefaultTvQuery(
		criteria: TvSearchCriteria,
		context: DatabaseQueryContext
	): Promise<ReleaseResult[]> {
		// First get the series
		const seriesConditions = [];
		const isInteractive = criteria.searchSource === 'interactive';

		if (criteria.tmdbId) {
			seriesConditions.push(eq(series.tmdbId, criteria.tmdbId));
		}
		if (criteria.tvdbId) {
			seriesConditions.push(eq(series.tvdbId, criteria.tvdbId));
		}
		if (criteria.imdbId) {
			seriesConditions.push(eq(series.imdbId, criteria.imdbId));
		}
		if (criteria.query) {
			seriesConditions.push(like(series.title, `%${criteria.query}%`));
		}

		if (!isInteractive) {
			seriesConditions.push(eq(series.monitored, true));
		}

		let seriesResults: (typeof series.$inferSelect)[];
		if (seriesConditions.length > 0) {
			seriesResults = await db
				.select()
				.from(series)
				.where(and(...seriesConditions))
				.limit(50);
		} else if (!isInteractive) {
			seriesResults = await db.select().from(series).where(eq(series.monitored, true)).limit(50);
		} else {
			seriesResults = await db.select().from(series).limit(50);
		}

		if (seriesResults.length === 0) {
			return [];
		}

		const releaseResults: ReleaseResult[] = [];

		for (const show of seriesResults) {
			// Get all episodes for this series (including specials if monitorSpecials is enabled)
			const allEpisodes = await db
				.select()
				.from(episodes)
				.where(and(eq(episodes.seriesId, show.id)))
				.orderBy(episodes.seasonNumber, episodes.episodeNumber);

			if (allEpisodes.length === 0) {
				continue;
			}

			// Group episodes by season
			const seasonMap = new Map<number, (typeof episodes.$inferSelect)[]>();
			for (const ep of allEpisodes) {
				const seasonEps = seasonMap.get(ep.seasonNumber) || [];
				seasonEps.push(ep);
				seasonMap.set(ep.seasonNumber, seasonEps);
			}

			const hasSeasonFilter = criteria.season !== undefined;
			const hasEpisodeFilter = criteria.episode !== undefined;

			if (hasEpisodeFilter && hasSeasonFilter) {
				// Specific episode requested → single episode release
				const targetEps = allEpisodes.filter(
					(ep) => ep.seasonNumber === criteria.season && ep.episodeNumber === criteria.episode
				);
				for (const episode of targetEps) {
					releaseResults.push(this.createEpisodeRelease(show, episode, context));
				}
			} else if (hasSeasonFilter) {
				// Specific season requested → season pack only.
				// Episode-level selection is handled by explicit episode searches.
				const seasonNum = criteria.season!;
				const seasonEps = seasonMap.get(seasonNum) || [];

				if (seasonEps.length > 0) {
					// Add season pack release
					releaseResults.push(this.createSeasonPackRelease(show, seasonNum, seasonEps, context));
				}
			} else {
				// No season/episode filter → complete series + season packs + episodes
				const seasons = Array.from(seasonMap.keys()).sort((a, b) => a - b);

				// Add complete series release
				releaseResults.push(this.createCompleteSeriesRelease(show, allEpisodes, seasons, context));

				// Add season pack releases for each season
				for (const seasonNum of seasons) {
					const seasonEps = seasonMap.get(seasonNum) || [];
					if (seasonEps.length > 0) {
						releaseResults.push(this.createSeasonPackRelease(show, seasonNum, seasonEps, context));
					}
				}

				// Also add individual episode releases
				for (const episode of allEpisodes) {
					releaseResults.push(this.createEpisodeRelease(show, episode, context));
				}
			}
		}

		return releaseResults;
	}

	/**
	 * Create a single episode release
	 */
	private createEpisodeRelease(
		show: typeof series.$inferSelect,
		episode: typeof episodes.$inferSelect,
		context: DatabaseQueryContext
	): ReleaseResult {
		const seasonStr = String(episode.seasonNumber).padStart(2, '0');
		const episodeStr = String(episode.episodeNumber).padStart(2, '0');

		return {
			guid: `stream-tv-${show.tmdbId}-s${seasonStr}e${episodeStr}`,
			title: `${show.title} S${seasonStr}E${episodeStr} - ${episode.title || 'Episode'} [Streaming]`,
			downloadUrl: `stream://tv/${show.tmdbId}/${episode.seasonNumber}/${episode.episodeNumber}`,
			size: this.STREAMING_FILE_SIZE,
			publishDate: episode.airDate ? new Date(episode.airDate) : new Date(),
			indexerId: context.indexerId,
			indexerName: context.indexerName,
			protocol: 'streaming',
			categories: [Category.TV],
			tmdbId: show.tmdbId,
			tvdbId: show.tvdbId ?? undefined,
			imdbId: show.imdbId ?? undefined,
			season: episode.seasonNumber,
			episode: episode.episodeNumber,
			streaming: {
				providerName: 'Cinephage',
				verified: true
			}
		};
	}

	/**
	 * Create a season pack release
	 */
	private createSeasonPackRelease(
		show: typeof series.$inferSelect,
		seasonNumber: number,
		seasonEpisodes: (typeof episodes.$inferSelect)[],
		context: DatabaseQueryContext
	): ReleaseResult {
		const seasonStr = String(seasonNumber).padStart(2, '0');
		const episodeCount = seasonEpisodes.length;
		const episodeNumbers = seasonEpisodes.map((ep) => ep.episodeNumber);

		// Get the latest air date from season episodes for publish date
		const latestAirDate = seasonEpisodes.reduce((latest, ep) => {
			if (!ep.airDate) return latest;
			const epDate = new Date(ep.airDate);
			return epDate > latest ? epDate : latest;
		}, new Date(0));

		return {
			guid: `stream-tv-${show.tmdbId}-s${seasonStr}`,
			title: `${show.title} Season ${seasonNumber} [Streaming]`,
			downloadUrl: `stream://tv/${show.tmdbId}/${seasonNumber}`,
			size: this.STREAMING_FILE_SIZE,
			publishDate: latestAirDate.getTime() > 0 ? latestAirDate : new Date(),
			indexerId: context.indexerId,
			indexerName: context.indexerName,
			protocol: 'streaming',
			categories: [Category.TV],
			tmdbId: show.tmdbId,
			tvdbId: show.tvdbId ?? undefined,
			imdbId: show.imdbId ?? undefined,
			season: seasonNumber,
			streaming: {
				providerName: 'Cinephage',
				verified: true,
				isSeasonPack: true,
				episodeCount,
				episodeNumbers
			}
		};
	}

	/**
	 * Create a complete series release
	 */
	private createCompleteSeriesRelease(
		show: typeof series.$inferSelect,
		allEpisodes: (typeof episodes.$inferSelect)[],
		seasons: number[],
		context: DatabaseQueryContext
	): ReleaseResult {
		const totalEpisodes = allEpisodes.length;
		const seasonCount = seasons.length;

		// Get the latest air date for publish date
		const latestAirDate = allEpisodes.reduce((latest, ep) => {
			if (!ep.airDate) return latest;
			const epDate = new Date(ep.airDate);
			return epDate > latest ? epDate : latest;
		}, new Date(0));

		// Build seasons string (e.g., "S01-S05" or "Seasons 1-5")
		const firstSeason = Math.min(...seasons);
		const lastSeason = Math.max(...seasons);
		const seasonsStr =
			firstSeason === lastSeason
				? `Season ${firstSeason}`
				: `S${String(firstSeason).padStart(2, '0')}-S${String(lastSeason).padStart(2, '0')}`;

		return {
			guid: `stream-tv-${show.tmdbId}-complete`,
			title: `${show.title} ${seasonsStr} Complete Series [Streaming]`,
			downloadUrl: `stream://tv/${show.tmdbId}/all`,
			size: this.STREAMING_FILE_SIZE,
			publishDate: latestAirDate.getTime() > 0 ? latestAirDate : new Date(),
			indexerId: context.indexerId,
			indexerName: context.indexerName,
			protocol: 'streaming',
			categories: [Category.TV],
			tmdbId: show.tmdbId,
			tvdbId: show.tvdbId ?? undefined,
			imdbId: show.imdbId ?? undefined,
			streaming: {
				providerName: 'Cinephage',
				verified: true,
				isCompleteSeries: true,
				seasonCount,
				totalEpisodes,
				seasons
			}
		};
	}

	/**
	 * Get table reference from name
	 */
	private getTableRef(tableName: string): typeof movies | typeof series | typeof episodes | null {
		switch (tableName.toLowerCase()) {
			case 'movies':
				return movies;
			case 'series':
				return series;
			case 'episodes':
				return episodes;
			default:
				return null;
		}
	}

	/**
	 * Build Drizzle conditions from YAML condition definitions
	 */
	private buildConditions(
		conditionDefs: QueryCondition[],
		_criteria: SearchCriteria
	): ReturnType<typeof eq>[] {
		const conditions: ReturnType<typeof eq>[] = [];

		for (const condDef of conditionDefs) {
			// Expand template value
			let value = condDef.value;
			if (typeof value === 'string') {
				value = this.templateEngine.expand(value);
			}

			// Skip optional conditions with empty values
			if (condDef.optional && (!value || value === '')) {
				continue;
			}

			// Build the condition based on operator
			const condition = this.buildSingleCondition(condDef.field, condDef.operator || 'eq', value);
			if (condition) {
				conditions.push(condition);
			}
		}

		return conditions;
	}

	/**
	 * Allowed column names for database query conditions.
	 * Only these columns can be referenced in YAML definition conditions
	 * to prevent SQL injection via sql.raw().
	 */
	private static readonly ALLOWED_COLUMNS = new Set([
		// movies table
		'id',
		'tmdb_id',
		'imdb_id',
		'title',
		'original_title',
		'year',
		'overview',
		'runtime',
		'genres',
		'path',
		'monitored',
		'minimum_availability',
		'added',
		'has_file',
		'wants_subtitles',
		'last_search_time',
		// series table
		'tvdb_id',
		'status',
		'network',
		'monitor_new_items',
		'monitor_specials',
		'season_folder',
		'series_type',
		'episode_count',
		'episode_file_count',
		// episodes table
		'series_id',
		'season_id',
		'season_number',
		'episode_number',
		'absolute_episode_number',
		'air_date',
		'wants_subtitles_override',
		// episode_files table
		'relative_path',
		'size',
		'date_added',
		'scene_name',
		'release_group',
		'release_type',
		'quality',
		'media_info',
		'languages',
		'info_hash',
		'episode_ids',
		// common
		'root_folder_id',
		'scoring_profile_id',
		'language_profile_id',
		'poster_path',
		'backdrop_path'
	]);

	/**
	 * Build a single SQL condition
	 */
	private buildSingleCondition(
		field: string,
		operator: string,
		value: unknown
	): ReturnType<typeof eq> | null {
		// Validate field against column allowlist to prevent SQL injection
		if (!DatabaseQueryExecutor.ALLOWED_COLUMNS.has(field)) {
			this.log.warn(
				{
					field,
					operator,
					logDomain: 'indexers'
				},
				'Rejected unknown column in database query condition'
			);
			return null;
		}
		const sqlField = sql.raw(field);

		switch (operator) {
			case 'eq':
				return sql`${sqlField} = ${value}`;
			case 'ne':
				return sql`${sqlField} != ${value}`;
			case 'gt':
				return sql`${sqlField} > ${value}`;
			case 'gte':
				return sql`${sqlField} >= ${value}`;
			case 'lt':
				return sql`${sqlField} < ${value}`;
			case 'lte':
				return sql`${sqlField} <= ${value}`;
			case 'like':
				return sql`${sqlField} LIKE ${value}`;
			case 'notnull':
				return sql`${sqlField} IS NOT NULL`;
			default:
				return null;
		}
	}

	/**
	 * Map database results to ReleaseResult format using output mapping.
	 * Generates ONE release per row (quality determined at playback time).
	 */
	private mapResults(
		results: unknown[],
		queryDef: DatabaseQuery,
		context: DatabaseQueryContext,
		contentType: 'movie' | 'tv'
	): ReleaseResult[] {
		const mapping = queryDef.outputMapping;
		const releaseResults: ReleaseResult[] = [];

		for (const row of results) {
			// Set up row context for templates
			this.templateEngine.setVariable('Row', row);

			try {
				const guid = this.templateEngine.expand(mapping.guid);
				const title = this.templateEngine.expand(mapping.title);
				const downloadUrl = this.templateEngine.expand(mapping.downloadUrl);

				let _size = 0;
				if (mapping.size) {
					if (typeof mapping.size === 'number') {
						_size = mapping.size;
					} else {
						const expandedSize = this.templateEngine.expand(mapping.size);
						_size = parseInt(expandedSize, 10) || 0;
					}
				}

				releaseResults.push({
					guid,
					title: `${title} [Streaming]`,
					downloadUrl,
					size: this.STREAMING_FILE_SIZE,
					publishDate: new Date(),
					indexerId: context.indexerId,
					indexerName: context.indexerName,
					protocol: 'streaming',
					categories: [contentType === 'movie' ? Category.MOVIES : Category.TV],
					streaming: {
						providerName: 'Cinephage',
						verified: true
					}
				});
			} catch (error) {
				this.log.warn({ error, row }, 'Failed to map result');
			}
		}

		return releaseResults;
	}

	/** Actual .strm file size (~100 bytes - just a text file with a URL) */
	private readonly STREAMING_FILE_SIZE = 100;
}

/**
 * Create a new DatabaseQueryExecutor instance
 */
export function createDatabaseQueryExecutor(
	definition: YamlDefinition,
	templateEngine: TemplateEngine
): DatabaseQueryExecutor {
	return new DatabaseQueryExecutor(definition, templateEngine);
}

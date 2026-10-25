import { db } from '#lib/server/db/index.js';
import { movies, series, episodes } from '#lib/server/db/schema.js';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { tmdb } from '#lib/server/tmdb.js';
import type { DiscoverItem } from '#lib/server/tmdb.js';
import { toDateString, todayDateString } from '#lib/utils/format.js';
import * as m from '#lib/paraglide/messages.js';

export interface CalendarMovieItem {
	tmdbId: number;
	title: string;
	posterPath: string | null;
	releaseDate: string;
	inLibrary: boolean;
	movieId?: string;
}

export interface CalendarEpisodeItem {
	episodeId: string;
	title: string | null;
	seasonNumber: number;
	episodeNumber: number;
	airDate: string | null;
	seriesId: string;
	seriesTitle: string;
	seriesPosterPath: string | null;
}

export interface CalendarDay {
	date: string;
	movies: CalendarMovieItem[];
	episodes: CalendarEpisodeItem[];
}

export interface UpcomingItem {
	type: 'movie' | 'episode';
	date: string;
	title: string;
	posterPath: string | null;
	subtitle?: string;
	tmdbId?: number;
	movieId?: string;
	seriesId?: string;
	episodeId?: string;
}

function getMonthRange(monthStr: string): { start: string; end: string } {
	const [year, month] = monthStr.split('-').map(Number);
	const monthStart = new Date(year, month - 1, 1);
	const monthEnd = new Date(year, month, 0);
	const start = new Date(monthStart);
	start.setDate(start.getDate() - 3);
	const end = new Date(monthEnd);
	end.setDate(end.getDate() + 3);
	return {
		start: toDateString(start),
		end: toDateString(end)
	};
}

async function fetchTmdbUpcoming(certifications: string[] = []): Promise<DiscoverItem[]> {
	try {
		if (certifications.length > 0) {
			const today = new Date();
			const past = new Date(today);
			past.setDate(today.getDate() - 30);
			const future = new Date(today);
			future.setDate(today.getDate() + 90);
			const dateGte = toDateString(past);
			const dateLte = toDateString(future);

			const responses = await Promise.all(
				certifications.map((cert) =>
					tmdb.discoverMovies({
						certification_country: 'US',
						certification: cert,
						with_release_type: '2|3',
						'primary_release_date.gte': dateGte,
						'primary_release_date.lte': dateLte,
						sort_by: 'popularity.desc'
					})
				)
			);

			const seen = new Set<number>();
			const merged: DiscoverItem[] = [];
			for (const res of responses) {
				for (const item of res.results) {
					if (!seen.has(item.id)) {
						seen.add(item.id);
						merged.push(item);
					}
				}
			}
			return merged;
		}

		const [nowPlaying, upcoming] = await Promise.all([tmdb.getNowPlaying(), tmdb.getUpcoming()]);
		const seen = new Set<number>();
		const merged: DiscoverItem[] = [];
		for (const item of [...nowPlaying.results, ...upcoming.results]) {
			if (!seen.has(item.id)) {
				seen.add(item.id);
				merged.push(item);
			}
		}
		return merged;
	} catch {
		return [];
	}
}

async function fetchTmdbAiringTv(): Promise<DiscoverItem[]> {
	try {
		const result = await tmdb.getOnTheAir();
		return result.results;
	} catch {
		return [];
	}
}

export async function getCalendarData(
	monthStr: string,
	type: 'all' | 'movies' | 'episodes',
	libraryOnly = false,
	minRating = 0,
	genreIds: number[] = [],
	excludeAdult = false,
	certifications: string[] = []
): Promise<CalendarDay[]> {
	const { start, end } = getMonthRange(monthStr);
	const dayMap = new Map<string, CalendarDay>();

	const allDates: string[] = [];
	const [startYear, startMonth, startDay] = start.split('-').map(Number);
	const current = new Date(startYear, startMonth - 1, startDay);
	const [endYear, endMonth, endDay] = end.split('-').map(Number);
	const endDate = new Date(endYear, endMonth - 1, endDay);
	while (current <= endDate) {
		const dateStr = toDateString(current);
		allDates.push(dateStr);
		dayMap.set(dateStr, { date: dateStr, movies: [], episodes: [] });
		current.setDate(current.getDate() + 1);
	}

	const includeMovies = type === 'all' || type === 'movies';
	const includeEpisodes = type === 'all' || type === 'episodes';

	if (includeMovies) {
		const tmdbItems = await fetchTmdbUpcoming(certifications);
		const tmdbIds = tmdbItems.map((item) => item.id);
		const libraryMovies =
			tmdbIds.length > 0
				? await db
						.select({ tmdbId: movies.tmdbId, id: movies.id })
						.from(movies)
						.where(inArray(movies.tmdbId, tmdbIds))
				: [];

		const libraryMovieMap = new Map(libraryMovies.map((m) => [m.tmdbId, m.id]));
		const libraryTmdbIds = new Set(libraryMovieMap.keys());

		for (const item of tmdbItems) {
			const releaseDate = item.release_date;
			if (!releaseDate || releaseDate < start || releaseDate > end) continue;
			const inLibrary = libraryTmdbIds.has(item.id);
			if (libraryOnly && !inLibrary) continue;
			if (!inLibrary) {
				if (minRating > 0 && item.vote_average < minRating) continue;
				if (genreIds.length > 0 && !genreIds.some((id) => item.genre_ids.includes(id))) continue;
				if (excludeAdult && item.adult === true) continue;
			}
			const day = dayMap.get(releaseDate);
			if (!day) continue;
			day.movies.push({
				tmdbId: item.id,
				title: item.title ?? item.original_title ?? 'Unknown',
				posterPath: item.poster_path,
				releaseDate,
				inLibrary,
				movieId: inLibrary ? libraryMovieMap.get(item.id) : undefined
			});
		}
	}

	if (includeEpisodes) {
		const episodeRows = await db
			.select({
				episodeId: episodes.id,
				episodeTitle: episodes.title,
				seasonNumber: episodes.seasonNumber,
				episodeNumber: episodes.episodeNumber,
				airDate: episodes.airDate,
				seriesId: episodes.seriesId,
				seriesTitle: series.title,
				seriesPosterPath: series.posterPath
			})
			.from(episodes)
			.innerJoin(series, eq(episodes.seriesId, series.id))
			.where(
				and(
					eq(episodes.monitored, true),
					eq(series.monitored, true),
					gte(episodes.airDate, start),
					lte(episodes.airDate, end)
				)
			);

		for (const ep of episodeRows) {
			if (!ep.airDate) continue;
			const day = dayMap.get(ep.airDate);
			if (!day) continue;
			day.episodes.push({
				episodeId: ep.episodeId,
				title: ep.episodeTitle,
				seasonNumber: ep.seasonNumber,
				episodeNumber: ep.episodeNumber,
				airDate: ep.airDate,
				seriesId: ep.seriesId,
				seriesTitle: ep.seriesTitle,
				seriesPosterPath: ep.seriesPosterPath
			});
		}
	}

	return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function getUpcomingItems(
	limit = 7,
	showNonLibraryMovies = true,
	excludeAdult = false,
	certifications: string[] = []
): Promise<UpcomingItem[]> {
	const today = todayDateString();

	const [episodeRows, tmdbItems, tmdbTvItems] = await Promise.all([
		db
			.select({
				episodeId: episodes.id,
				episodeTitle: episodes.title,
				seasonNumber: episodes.seasonNumber,
				episodeNumber: episodes.episodeNumber,
				airDate: episodes.airDate,
				seriesId: episodes.seriesId,
				seriesTitle: series.title,
				seriesPosterPath: series.posterPath
			})
			.from(episodes)
			.innerJoin(series, eq(episodes.seriesId, series.id))
			.where(
				and(eq(episodes.monitored, true), eq(series.monitored, true), gte(episodes.airDate, today))
			)
			.orderBy(episodes.airDate)
			.limit(limit),
		fetchTmdbUpcoming(certifications),
		fetchTmdbAiringTv()
	]);

	const items: UpcomingItem[] = [];

	for (const ep of episodeRows) {
		if (!ep.airDate) continue;
		items.push({
			type: 'episode',
			date: ep.airDate,
			title: ep.seriesTitle,
			posterPath: ep.seriesPosterPath,
			subtitle: `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}${ep.episodeTitle ? ` - ${ep.episodeTitle}` : ''}`,
			seriesId: ep.seriesId,
			episodeId: ep.episodeId
		});
	}

	if (items.length < limit) {
		const movieTmdbIds = tmdbItems.map((item) => item.id);
		const tvTmdbIds = tmdbTvItems.map((item) => item.id);
		const [libraryMovies, librarySeries] = await Promise.all([
			movieTmdbIds.length > 0
				? db
						.select({ tmdbId: movies.tmdbId, id: movies.id })
						.from(movies)
						.where(inArray(movies.tmdbId, movieTmdbIds))
				: Promise.resolve([]),
			tvTmdbIds.length > 0
				? db.select({ tmdbId: series.tmdbId }).from(series).where(inArray(series.tmdbId, tvTmdbIds))
				: Promise.resolve([])
		]);
		const libraryMovieMap = new Map(libraryMovies.map((m) => [m.tmdbId, m.id]));
		const libraryMovieTmdbIds = new Set(libraryMovieMap.keys());
		const librarySeriesTmdbIds = new Set(
			librarySeries.map((s) => s.tmdbId).filter(Boolean) as number[]
		);

		for (const item of tmdbItems) {
			if (items.length >= limit) break;
			const releaseDate = item.release_date;
			if (!releaseDate || releaseDate < today) continue;
			const inLibrary = libraryMovieTmdbIds.has(item.id);
			if (!showNonLibraryMovies && !inLibrary) continue;
			if (!inLibrary && excludeAdult && item.adult === true) continue;
			items.push({
				type: 'movie',
				date: releaseDate,
				title: item.title ?? item.original_title ?? 'Unknown',
				posterPath: item.poster_path,
				tmdbId: item.id,
				movieId: inLibrary ? libraryMovieMap.get(item.id) : undefined
			});
		}

		if (showNonLibraryMovies) {
			for (const item of tmdbTvItems) {
				if (items.length >= limit) break;
				if (librarySeriesTmdbIds.has(item.id)) continue;
				if (excludeAdult && item.adult === true) continue;
				items.push({
					type: 'episode',
					date: today,
					title: item.name ?? item.original_name ?? m.common_unknown(),
					posterPath: item.poster_path,
					tmdbId: item.id,
					subtitle: m.calendar_airingNow()
				});
			}
		}
	}

	items.sort((a, b) => a.date.localeCompare(b.date));

	return items.slice(0, limit);
}

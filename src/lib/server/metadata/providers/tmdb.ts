import { tmdb } from '#lib/server/tmdb.js';
import type {
	MetadataDetails,
	MetadataMediaType,
	MetadataProvider,
	MetadataSearchResult
} from './types.js';

export class TmdbMetadataProvider implements MetadataProvider {
	readonly id = 'tmdb' as const;
	readonly name = 'TMDB';
	readonly description = 'The Movie Database metadata source.';

	isConfigured(): boolean {
		return true;
	}

	async searchTitle(query: string, type: MetadataMediaType): Promise<MetadataSearchResult[]> {
		const trimmed = query.trim();
		if (!trimmed) return [];

		const endpoint = type === 'movie' ? '/search/movie' : '/search/tv';
		const response = (await tmdb.fetch(
			`${endpoint}?query=${encodeURIComponent(trimmed)}`,
			{},
			true
		)) as {
			results?: Array<{
				id: number;
				title?: string;
				name?: string;
				original_title?: string;
				original_name?: string;
				overview?: string;
				poster_path?: string | null;
				release_date?: string;
				first_air_date?: string;
			}>;
		};

		return (response.results ?? []).map((item) => ({
			id: String(item.id),
			title: item.title ?? item.name ?? 'Unknown',
			originalTitle: item.original_title ?? item.original_name ?? undefined,
			overview: item.overview ?? undefined,
			year:
				Number.parseInt((item.release_date ?? item.first_air_date ?? '').slice(0, 4), 10) || null,
			posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
			mediaType: type,
			provider: this.id
		}));
	}

	async getDetails(id: string, type: MetadataMediaType): Promise<MetadataDetails | null> {
		const parsedId = Number.parseInt(id, 10);
		if (!Number.isFinite(parsedId) || parsedId <= 0) return null;

		if (type === 'movie') {
			const movie = await tmdb.getMovie(parsedId);
			return {
				id: String(movie.id),
				title: movie.title,
				originalTitle: movie.original_title ?? undefined,
				overview: movie.overview ?? undefined,
				year: movie.release_date ? Number.parseInt(movie.release_date.slice(0, 4), 10) : null,
				posterUrl: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
				backdropUrl: movie.backdrop_path
					? `https://image.tmdb.org/t/p/w780${movie.backdrop_path}`
					: null,
				genres: movie.genres?.map((genre) => genre.name) ?? undefined,
				isAdult: movie.adult === true,
				mediaType: 'movie',
				provider: this.id
			};
		}

		const tv = await tmdb.getTVShow(parsedId);
		return {
			id: String(tv.id),
			title: tv.name,
			originalTitle: tv.original_name ?? undefined,
			overview: tv.overview ?? undefined,
			year: tv.first_air_date ? Number.parseInt(tv.first_air_date.slice(0, 4), 10) : null,
			posterUrl: tv.poster_path ? `https://image.tmdb.org/t/p/w500${tv.poster_path}` : null,
			backdropUrl: tv.backdrop_path ? `https://image.tmdb.org/t/p/w780${tv.backdrop_path}` : null,
			genres: tv.genres?.map((genre) => genre.name) ?? undefined,
			mediaType: type === 'anime' ? 'anime' : 'tv',
			provider: this.id
		};
	}
}

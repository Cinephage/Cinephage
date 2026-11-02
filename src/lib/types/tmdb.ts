export interface TmdbConfiguration {
	images: {
		base_url: string;
		secure_base_url: string;
		backdrop_sizes: string[];
		logo_sizes: string[];
		poster_sizes: string[];
		profile_sizes: string[];
		still_sizes: string[];
	};
	change_keys: string[];
}

export interface PaginatedResponse<T> {
	page: number;
	results: T[];
	total_pages: number;
	total_results: number;
}

export interface Genre {
	id: number;
	name: string;
}

export interface ProductionCompany {
	id: number;
	logo_path: string | null;
	name: string;
	origin_country: string;
}

/** TV network subset used by the discover network filter. */
export interface TmdbNetwork {
	id: number;
	name: string;
	logo_path: string | null;
}

export interface ProductionCountry {
	iso_3166_1: string;
	name: string;
}

export interface SpokenLanguage {
	english_name: string;
	iso_639_1: string;
	name: string;
}

export interface CastMember {
	adult: boolean;
	gender: number;
	id: number;
	known_for_department: string;
	name: string;
	original_name: string;
	popularity: number;
	profile_path: string | null;
	cast_id: number;
	character: string;
	credit_id: string;
	order: number;
}

export interface CrewMember {
	adult: boolean;
	gender: number;
	id: number;
	known_for_department: string;
	name: string;
	original_name: string;
	popularity: number;
	profile_path: string | null;
	credit_id: string;
	department: string;
	job: string;
}

export interface Credits {
	cast: CastMember[];
	crew: CrewMember[];
}

export interface Video {
	iso_639_1: string;
	iso_3166_1: string;
	name: string;
	key: string;
	site: string;
	size: number;
	type: string;
	official: boolean;
	published_at: string;
	id: string;
}

export interface Videos {
	results: Video[];
}

export interface Image {
	aspect_ratio: number;
	height: number;
	iso_639_1: string | null;
	file_path: string;
	vote_average: number;
	vote_count: number;
	width: number;
}

export interface Images {
	backdrops: Image[];
	logos: Image[];
	posters: Image[];
}

export interface Movie {
	id: number;
	title: string;
	original_title: string;
	overview: string;
	poster_path: string | null;
	backdrop_path: string | null;
	release_date: string;
	vote_average: number;
	vote_count: number;
	popularity: number;
	adult: boolean;
	genre_ids: number[];
	video: boolean;
	original_language: string;
	media_type?: 'movie';
}

export interface MovieDetails extends Omit<Movie, 'genre_ids'> {
	belongs_to_collection: Collection | null;
	budget: number;
	genres: Genre[];
	homepage: string | null;
	imdb_id: string | null;
	production_companies: ProductionCompany[];
	production_countries: ProductionCountry[];
	revenue: number;
	runtime: number | null;
	spoken_languages: SpokenLanguage[];
	status: string;
	tagline: string | null;
	credits: Credits;
	videos: Videos;
	images: Images;
	recommendations: PaginatedResponse<Movie>;
	similar: PaginatedResponse<Movie>;
	'watch/providers'?: WatchProvidersResponse;
	release_dates?: ReleaseDatesResponse;
	keywords?: {
		keywords: Array<{ id: number; name: string }>;
	};
}

export interface Episode {
	air_date: string;
	episode_number: number;
	absolute_episode_number?: number;
	id: number;
	name: string;
	overview: string;
	production_code: string;
	runtime: number | null;
	season_number: number;
	show_id: number;
	still_path: string | null;
	vote_average: number;
	vote_count: number;
	crew: CrewMember[];
	guest_stars: CastMember[];
}

export interface Season {
	air_date: string;
	episode_count: number;
	id: number;
	name: string;
	overview: string;
	poster_path: string | null;
	season_number: number;
	vote_average: number;
	episodes?: Episode[];
}

export interface GroupEpisode {
	air_date: string;
	episode_number: number;
	id: number;
	name: string;
	order: number;
	season_number: number;
	show_id: number;
}

export interface EpisodeGroupGroup {
	episodes: GroupEpisode[];
	locked: boolean;
	name: string;
}

export interface EpisodeGroup {
	description: string;
	episode_count: number;
	group_count: number;
	groups: EpisodeGroupGroup[];
	id: string;
	name: string;
	network: { id: number; logo_path: string; name: string; origin_country: string } | null;
	type: number;
}

export interface EpisodeGroupSummary {
	description: string;
	episode_count: number;
	group_count: number;
	id: string;
	name: string;
	network: {
		id: number;
		logo_path: string;
		name: string;
		origin_country: string;
	} | null;
	type: number;
}

export interface EpisodeGroupsResponse {
	id: number;
	results: EpisodeGroupSummary[];
}

export interface TVShow {
	id: number;
	name: string;
	original_name: string;
	overview: string;
	poster_path: string | null;
	backdrop_path: string | null;
	first_air_date: string;
	vote_average: number;
	vote_count: number;
	popularity: number;
	genre_ids: number[];
	original_language: string;
	origin_country: string[];
	media_type?: 'tv';
}

export interface Creator {
	id: number;
	credit_id: string;
	name: string;
	original_name: string;
	gender: number;
	profile_path: string | null;
}

export interface TVShowDetails extends Omit<TVShow, 'genre_ids'> {
	created_by: Creator[];
	episode_run_time: number[];
	genres: Genre[];
	homepage: string;
	in_production: boolean;
	languages: string[];
	last_air_date: string;
	last_episode_to_air: Episode;
	next_episode_to_air: Episode | null;
	networks: ProductionCompany[];
	number_of_episodes: number;
	number_of_seasons: number;
	production_companies: ProductionCompany[];
	production_countries: ProductionCountry[];
	seasons: Season[];
	spoken_languages: SpokenLanguage[];
	status: string;
	tagline: string;
	type: string;
	credits: Credits;
	videos: Videos;
	images: Images;
	recommendations: PaginatedResponse<TVShow>;
	similar: PaginatedResponse<TVShow>;
	'watch/providers'?: WatchProvidersResponse;
	content_ratings?: ContentRatingsResponse;
	keywords?: {
		results: Array<{ id: number; name: string }>;
	};
	episode_groups?: EpisodeGroupsResponse;
}

export interface Person {
	id: number;
	name: string;
	original_name: string;
	profile_path: string | null;
	adult: boolean;
	known_for_department: string;
	gender: number; // 0: Not specified, 1: Female, 2: Male, 3: Non-binary
	popularity: number;
	known_for?: (Movie | TVShow)[];
	media_type?: 'person';
}

// Person's cast credit in combined_credits (filmography as actor)
export interface PersonCastCredit {
	id: number;
	title?: string; // Movies
	name?: string; // TV shows
	original_title?: string;
	original_name?: string;
	poster_path: string | null;
	backdrop_path: string | null;
	release_date?: string; // Movies
	first_air_date?: string; // TV shows
	vote_average: number;
	vote_count: number;
	popularity: number;
	overview: string;
	media_type: 'movie' | 'tv';
	character: string;
	credit_id: string;
	order?: number;
	episode_count?: number; // TV only
}

// Person's crew credit in combined_credits (filmography as crew)
export interface PersonCrewCredit {
	id: number;
	title?: string;
	name?: string;
	original_title?: string;
	original_name?: string;
	poster_path: string | null;
	backdrop_path: string | null;
	release_date?: string;
	first_air_date?: string;
	vote_average: number;
	vote_count: number;
	popularity: number;
	overview: string;
	media_type: 'movie' | 'tv';
	department: string;
	job: string;
	credit_id: string;
	episode_count?: number;
}

export interface PersonCombinedCredits {
	cast: PersonCastCredit[];
	crew: PersonCrewCredit[];
}

export interface PersonExternalIds {
	imdb_id: string | null;
	facebook_id: string | null;
	instagram_id: string | null;
	twitter_id: string | null;
	tiktok_id: string | null;
	youtube_id: string | null;
	wikidata_id: string | null;
}

// Full person details from /person/{id} with append_to_response
export interface PersonDetails extends Person {
	birthday: string | null;
	deathday: string | null;
	biography: string;
	place_of_birth: string | null;
	homepage: string | null;
	also_known_as: string[];
	imdb_id: string | null;
	combined_credits: PersonCombinedCredits;
	external_ids: PersonExternalIds;
}

export interface Collection {
	id: number;
	name: string;
	poster_path: string | null;
	backdrop_path: string | null;
	parts?: Movie[];
}

export interface WatchProvider {
	provider_id: number;
	provider_name: string;
	logo_path: string | null;
	display_priority: number;
}

export interface WatchProviderCountry {
	link?: string;
	flatrate?: WatchProvider[];
	rent?: WatchProvider[];
	buy?: WatchProvider[];
	free?: WatchProvider[];
	ads?: WatchProvider[];
}

export interface WatchProvidersResponse {
	id: number;
	results: {
		[countryCode: string]: WatchProviderCountry;
	};
}

// Release dates types (for movies)
export interface ReleaseDate {
	certification: string;
	descriptors: string[];
	iso_639_1: string;
	note: string;
	release_date: string;
	type: number; // 1=Premiere, 2=Theatrical (limited), 3=Theatrical, 4=Digital, 5=Physical, 6=TV
}

export interface ReleaseDateCountry {
	iso_3166_1: string;
	release_dates: ReleaseDate[];
}

export interface ReleaseDatesResponse {
	id: number;
	results: ReleaseDateCountry[];
}

// Content ratings types (for TV shows)
export interface ContentRating {
	descriptors: string[];
	iso_3166_1: string;
	rating: string;
}

export interface ContentRatingsResponse {
	id: number;
	results: ContentRating[];
}

export interface GlobalTmdbFilters {
	include_adult: boolean;
	min_vote_average: number;
	min_vote_count: number;
	language: string;
	region: string;
	excluded_genre_ids: number[];
}

/**
 * Union type for items returned from TMDB search/discover endpoints.
 * Use type guards from '#lib/types/tmdb-guards.js' to narrow the type.
 */
export type TmdbMediaItem = Movie | TVShow | Person;

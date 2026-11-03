export type MetadataProviderId = 'tmdb' | 'anilist' | 'mal';
export type MetadataMediaType = 'movie' | 'tv' | 'anime';
export type MetadataProviderSelection = 'auto' | MetadataProviderId;

/**
 * A provider-supplied title variant (AniList romaji/english/native, MAL titles[]).
 * `language` is set ONLY when the provider itself supplies a language code -
 * the kind labels ('romaji', 'Japanese', …) are never mapped onto one.
 */
export interface MetadataTitleVariant {
	title: string;
	/** ISO 639-1 code when the provider supplies one; null otherwise (never guessed). */
	language?: string | null;
	/** ISO 3166-1 country when the provider identifies one (e.g. AniList countryOfOrigin). */
	country?: string | null;
}

export interface MetadataSearchResult {
	id: string;
	title: string;
	originalTitle?: string;
	overview?: string;
	year?: number | null;
	posterUrl?: string | null;
	mediaType: MetadataMediaType;
	provider: MetadataProviderId;
}

export interface MetadataDetails {
	id: string;
	title: string;
	originalTitle?: string;
	overview?: string;
	year?: number | null;
	posterUrl?: string | null;
	backdropUrl?: string | null;
	genres?: string[];
	status?: string;
	studios?: string[];
	/** Whether this title is flagged as adult/hentai by the provider. */
	isAdult?: boolean;
	/** All title variants the provider reports (display title/overview mapping stays unchanged). */
	alternateTitles?: MetadataTitleVariant[];
	mediaType: MetadataMediaType;
	provider: MetadataProviderId;
}

export interface MetadataProvider {
	id: MetadataProviderId;
	name: string;
	description: string;
	isConfigured(): boolean;
	searchTitle(query: string, type: MetadataMediaType): Promise<MetadataSearchResult[]>;
	getDetails(id: string, type: MetadataMediaType): Promise<MetadataDetails | null>;
}

export interface MetadataProviderConfig {
	/** When true, AniList and Jikan run automatically for anime titles to supply alt titles and adult flag. Default: true. */
	animeEnrichmentEnabled: boolean;
}

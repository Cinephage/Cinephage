/**
 * Media ID tokens - MediaId, TmdbId, TvdbId, ImdbId, SeriesId
 */

import type { TokenDefinition } from '../types';
import type { NamingConfig } from '../../NamingService';

/**
 * Format media ID based on configured media server format
 * Plex/Emby: {tmdb-12345} or {tvdb-12345}
 * Jellyfin: [tmdbid-12345] or [tvdbid-12345]
 */
function formatMediaId(
	id: number | undefined,
	type: 'tmdb' | 'tvdb',
	config: NamingConfig
): string {
	if (!id) return '';

	if (config.mediaServerIdFormat === 'jellyfin') {
		return `[${type}id-${id}]`;
	}
	// Plex/Emby format (default)
	return `{${type}-${id}}`;
}

export const mediaIdTokens: TokenDefinition[] = [
	{
		name: 'TmdbId',
		aliases: ['TMDB Id', 'TMDb Id'],
		category: 'mediaId',
		description: 'TMDB ID number',
		applicability: ['movie', 'series'],
		render: (info) => (info.tmdbId ? String(info.tmdbId) : '')
	},
	{
		name: 'TvdbId',
		aliases: ['TVDb Id', 'TVMDb Id'],
		category: 'mediaId',
		description: 'TVDB ID number',
		applicability: ['series'],
		render: (info) => (info.tvdbId ? String(info.tvdbId) : '')
	},
	{
		name: 'ImdbId',
		aliases: ['IMDb Id'],
		category: 'mediaId',
		description: 'IMDB ID (e.g., tt1234567)',
		applicability: ['movie', 'series'],
		render: (info) => info.imdbId || ''
	},
	{
		name: 'MediaId',
		aliases: ['MovieId'],
		category: 'mediaId',
		description:
			'Media server ID with braces included (Plex/Emby: {tmdb-12345}, Jellyfin: [tmdbid-12345]); use TmdbId for the bare number',
		applicability: ['movie'],
		render: (info, config) => formatMediaId(info.tmdbId, 'tmdb', config)
	},
	{
		name: 'SeriesId',
		category: 'mediaId',
		description:
			'Media server ID with braces included, TVDB preferred (Plex/Emby: {tvdb-12345}, Jellyfin: [tvdbid-12345]); use TvdbId for the bare number',
		applicability: ['series'],
		render: (info, config) => {
			// Prefer TVDB for series, fall back to TMDB
			if (info.tvdbId) {
				return formatMediaId(info.tvdbId, 'tvdb', config);
			}
			if (info.tmdbId) {
				return formatMediaId(info.tmdbId, 'tmdb', config);
			}
			return '';
		}
	}
];

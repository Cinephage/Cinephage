/**
 * Episode tokens - Season, Episode, EpisodeTitle, Absolute, AirDate
 */

import type { TokenDefinition } from '../types';
import type { NamingConfig } from '../../NamingService';

/**
 * Format a number with padding
 */
function formatNumber(num: number, format: string): string {
	const padLength = format.length;
	return String(num).padStart(padLength, '0');
}

/**
 * Format episode numbers based on multi-episode style
 */
function formatEpisodeNumbers(
	episodes: number[] | undefined,
	formatSpec: string | undefined,
	config: NamingConfig
): string {
	if (!episodes || episodes.length === 0) return '';

	const spec = formatSpec || '00';

	if (episodes.length === 1) {
		return formatNumber(episodes[0], spec);
	}

	const formatted = episodes.map((e) => formatNumber(e, spec));

	switch (config.multiEpisodeStyle) {
		case 'extend':
			// S01E01E02E03
			return formatted
				.map((e) => `E${e}`)
				.join('')
				.slice(1); // Remove first E

		case 'duplicate':
			// S01E01-E02-E03
			return formatted.join('-E');

		case 'repeat':
			return formatted.join(' - ');

		case 'scene':
			// S01E01E02 (no padding for extra episodes)
			return (
				formatted[0] +
				episodes
					.slice(1)
					.map((e) => `E${e}`)
					.join('')
			);

		case 'range':
		default:
			// S01E01-E03
			if (episodes.length === 2) {
				return `${formatted[0]}-E${formatted[1]}`;
			}
			return `${formatted[0]}-E${formatted[formatted.length - 1]}`;
	}
}

/**
 * Generate a clean title by removing special characters
 */
function generateCleanTitle(title: string): string {
	return title
		.replace(/[:/\\?*"<>|]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export const episodeTokens: TokenDefinition[] = [
	{
		name: 'Season',
		category: 'episode',
		description: 'Season number',
		example: '{Season:00}',
		applicability: ['episode'],
		supportsFormatSpec: true,
		render: (info, _config, formatSpec) => {
			if (info.seasonNumber === undefined) return '';
			if (formatSpec) {
				return formatNumber(info.seasonNumber, formatSpec);
			}
			return String(info.seasonNumber);
		}
	},
	{
		name: 'Episode',
		category: 'episode',
		description: 'Episode number',
		example: '{Episode:00}',
		applicability: ['episode'],
		supportsFormatSpec: true,
		render: (info, config, formatSpec) => {
			return formatEpisodeNumbers(info.episodeNumbers, formatSpec, config);
		}
	},
	{
		name: 'EpisodeTitle',
		aliases: ['Episode Title'],
		category: 'episode',
		description: 'Episode title as-is',
		applicability: ['episode'],
		render: (info) => info.episodeTitle || ''
	},
	{
		name: 'EpisodeCleanTitle',
		category: 'episode',
		description: 'Episode title with special chars removed',
		applicability: ['episode'],
		render: (info) => (info.episodeTitle ? generateCleanTitle(info.episodeTitle) : '')
	},
	{
		name: 'Absolute',
		aliases: ['Absolute Episode'],
		category: 'episode',
		description: 'Absolute episode number (anime)',
		example: '{Absolute:000}',
		applicability: ['episode'],
		supportsFormatSpec: true,
		render: (info, _config, formatSpec) => {
			if (info.absoluteNumber === undefined) return '';
			if (formatSpec) {
				return formatNumber(info.absoluteNumber, formatSpec);
			}
			return String(info.absoluteNumber);
		}
	},
	{
		name: 'SeasonYear',
		category: 'episode',
		description: 'Year the season first aired (season premiere year, not the series year)',
		applicability: ['series', 'episode'],
		render: (info) => (info.seasonYear ? String(info.seasonYear) : '')
	},
	{
		name: 'AirDate',
		aliases: ['Air Date'],
		category: 'episode',
		description: 'Air date (YYYY-MM-DD, for daily shows)',
		applicability: ['episode'],
		render: (info) => info.airDate || ''
	}
];

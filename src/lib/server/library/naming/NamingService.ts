/**
 * Media Naming Service
 *
 * Handles generating consistent folder and file names for movies and TV shows.
 * Follows TRaSH Guides naming conventions for compatibility with media servers.
 *
 * @see https://trash-guides.info/Radarr/Radarr-recommended-naming-scheme/
 * @see https://trash-guides.info/Sonarr/Sonarr-recommended-naming-scheme/
 */

import { extname } from 'path';
import { tokenRegistry } from './tokens';
import { TemplateEngine } from './template';

/**
 * Parsed media info for naming
 */
export interface MediaNamingInfo {
	// Core info
	title: string;
	originalTitle?: string;
	year?: number;
	tmdbId?: number;
	tvdbId?: number;
	imdbId?: string;
	collectionName?: string;
	localizedTitles?: Record<string, string>;

	// Edition/version
	edition?: string;

	// Quality info
	resolution?: string;
	source?: string;
	codec?: string;
	hdr?: string;
	bitDepth?: string;
	is3D?: boolean;

	// Audio info
	audioCodec?: string;
	audioChannels?: string;
	audioLanguages?: string[];

	// Release info
	releaseGroup?: string;
	proper?: boolean;
	repack?: boolean;

	// TV specific
	seasonNumber?: number;
	episodeNumbers?: number[];
	absoluteNumber?: number;
	episodeTitle?: string;
	airDate?: string;
	isDaily?: boolean;
	isAnime?: boolean;

	// Original file extension
	originalExtension?: string;
}

/**
 * Naming format configuration
 */
export interface NamingConfig {
	// Movie formats
	movieFolderFormat: string;
	movieFileFormat: string;

	// TV formats
	seriesFolderFormat: string;
	seasonFolderFormat: string;
	episodeFileFormat: string;
	dailyEpisodeFormat: string;
	animeEpisodeFormat: string;
	multiEpisodeStyle: 'extend' | 'duplicate' | 'repeat' | 'scene' | 'range';

	// Options
	replaceSpacesWith?: string;
	colonReplacement: 'delete' | 'dash' | 'spaceDash' | 'spaceDashSpace' | 'smart';
	mediaServerIdFormat: 'plex' | 'jellyfin';
	includeQuality: boolean;
	includeMediaInfo: boolean;
	includeReleaseGroup: boolean;
	useSpecialsFolder: boolean;
}

/**
 * Default naming configuration (TRaSH Guides aligned)
 * @see https://trash-guides.info/Radarr/Radarr-recommended-naming-scheme/
 * @see https://trash-guides.info/Sonarr/Sonarr-recommended-naming-scheme/
 */
export const DEFAULT_NAMING_CONFIG: NamingConfig = {
	// Movie folder: "Movie Title (2024) {tmdb-12345}" (Plex) or "[tmdbid-12345]" (Jellyfin)
	movieFolderFormat: '{CleanTitle} ({Year}) {MediaId}',
	// Movie file: "Movie Title (2024) {edition-Extended} [Bluray-1080p][DV][DTS-HD MA 7.1][x265]-GROUP"
	movieFileFormat:
		'{CleanTitle} ({Year}) {edition-{Edition}} [{QualityFull}]{[{HDR}]}{[{AudioCodec} {AudioChannels}]}{[{VideoCodec}]}{-{ReleaseGroup}}',

	// Series folder: "Series Title (2024) {tvdb-12345}" (Plex) or "[tvdbid-12345]" (Jellyfin)
	seriesFolderFormat: '{CleanTitle} ({Year}) {SeriesId}',
	// Season: "Season 01"
	seasonFolderFormat: 'Season {Season:00}',
	// Episode: "Series Title (2024) - S01E01 - Episode Title [Bluray-1080p][DTS-HD MA 5.1][x265]-GROUP"
	episodeFileFormat:
		'{SeriesCleanTitle} ({Year}) - S{Season:00}E{Episode:00} - {EpisodeCleanTitle} [{QualityFull}]{[{HDR}]}{[{AudioCodec} {AudioChannels}]}{[{VideoCodec}]}{-{ReleaseGroup}}',
	// Daily: "Series Title (2024) - 2024-01-15 - Episode Title [Quality]"
	dailyEpisodeFormat:
		'{SeriesCleanTitle} ({Year}) - {AirDate} - {EpisodeCleanTitle} [{QualityFull}]{[{VideoCodec}]}{-{ReleaseGroup}}',
	// Anime: "Series Title (2024) - S01E01 - 001 - Episode Title [Quality][10bit][x265]-GROUP"
	animeEpisodeFormat:
		'{SeriesCleanTitle} ({Year}) - S{Season:00}E{Episode:00} - {Absolute:000} - {EpisodeCleanTitle} [{QualityFull}]{[{HDR}]}{[{BitDepth}bit]}{[{VideoCodec}]}{[{AudioCodec} {AudioChannels}]}{-{ReleaseGroup}}',
	multiEpisodeStyle: 'range',

	colonReplacement: 'smart',
	mediaServerIdFormat: 'plex',
	includeQuality: true,
	includeMediaInfo: true,
	includeReleaseGroup: true,
	useSpecialsFolder: false
};

/**
 * Characters that are illegal in file/folder names. Includes '/' so token
 * values (TMDB titles, release names) can never inject path separators into a
 * generated name — format strings split on '/' deliberately, token output
 * must not.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = new RegExp('[<>"\\\\|?*/\x00-\x1f]', 'g');

/**
 * Smart colon replacement patterns
 * Handles cases like "Movie: Subtitle" -> "Movie - Subtitle"
 */
const COLON_PATTERNS = [
	{ pattern: /:\s+/g, replacement: ' - ' }, // ": " -> " - "
	{ pattern: /\s+:/g, replacement: ' -' }, // " :" -> " -"
	{ pattern: /:/g, replacement: '' } // Standalone ":" -> ""
];

/**
 * Media Naming Service
 */
export class NamingService {
	private config: NamingConfig;
	private templateEngine: TemplateEngine;

	constructor(config: Partial<NamingConfig> = {}) {
		this.config = { ...DEFAULT_NAMING_CONFIG, ...config };
		this.templateEngine = new TemplateEngine(tokenRegistry);
	}

	/**
	 * Get the current naming configuration
	 */
	getConfig(): NamingConfig {
		return { ...this.config };
	}

	/**
	 * Update the naming configuration
	 */
	updateConfig(config: Partial<NamingConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Generate a movie folder name
	 */
	generateMovieFolderName(info: MediaNamingInfo): string {
		return this.formatName(this.config.movieFolderFormat, info);
	}

	/**
	 * Generate a movie file name (without extension)
	 */
	generateMovieFileName(info: MediaNamingInfo): string {
		const name = this.formatName(this.config.movieFileFormat, info);
		const ext = info.originalExtension || '';
		return name + ext;
	}

	/**
	 * Generate a series folder name
	 */
	generateSeriesFolderName(info: MediaNamingInfo): string {
		return this.formatName(this.config.seriesFolderFormat, info);
	}

	/**
	 * Generate a season folder name. The optional series context lets season
	 * folder formats that reference series-level tokens ({Year}, {Title},
	 * media IDs) render instead of collapsing to empty; without it only
	 * season tokens resolve.
	 */
	generateSeasonFolderName(seasonNumber: number, series?: Partial<MediaNamingInfo>): string {
		if (seasonNumber === 0 && this.config.useSpecialsFolder) {
			return 'Specials';
		}
		return this.formatName(this.config.seasonFolderFormat, {
			title: '',
			...series,
			seasonNumber
		});
	}

	/**
	 * Generate an episode file name
	 */
	generateEpisodeFileName(info: MediaNamingInfo): string {
		let format = this.config.episodeFileFormat;

		// Select appropriate format based on content type
		if (info.isDaily && info.airDate) {
			format = this.config.dailyEpisodeFormat;
		} else if (info.isAnime) {
			format = this.config.animeEpisodeFormat;
		}

		if (this.config.multiEpisodeStyle === 'repeat' && (info.episodeNumbers?.length ?? 0) > 1) {
			format = this.expandRepeatEpisodeFormat(format, info);
		}

		const name = this.formatName(format, info);
		const ext = info.originalExtension || '';
		return name + ext;
	}

	private expandRepeatEpisodeFormat(format: string, info: MediaNamingInfo): string {
		const repeatedSeasonEpisodePattern = /S\{Season(?::[^}]+)?\}E\{Episode(?::[^}]+)?\}/g;
		const expandSegment = (segment: string) =>
			(info.episodeNumbers ?? [])
				.map((episodeNumber) =>
					this.templateEngine.render(
						segment,
						{ ...info, episodeNumbers: [episodeNumber] },
						this.config
					)
				)
				.join(' - ');

		const expandedFormat = format.replace(repeatedSeasonEpisodePattern, (segment) =>
			expandSegment(segment)
		);

		if (expandedFormat !== format) {
			return expandedFormat;
		}

		return format.replace(/\{Episode(?::[^}]+)?\}/g, (segment) => expandSegment(segment));
	}

	/**
	 * Format a name using the given format string and info
	 */
	private formatName(format: string, info: MediaNamingInfo): string {
		const segments = format.split('/').map((segment) => {
			const result = this.templateEngine.render(segment, info, this.config);
			return this.cleanName(result);
		});
		// A '.'/'..' segment (e.g. a token rendering to exactly "..") would
		// escape the library root once joined — drop it rather than trust
		// external metadata.
		return segments.filter((s) => s.length > 0 && s !== '.' && s !== '..').join('/');
	}

	/**
	 * Clean the final name - remove illegal characters, handle colons, etc.
	 */
	private cleanName(name: string): string {
		let result = name;

		// Handle colons based on config
		result = this.replaceColons(result);

		// Remove illegal characters
		result = result.replace(ILLEGAL_CHARS, '');

		// Clean up empty brackets (including surrounding spaces)
		result = result.replace(/\s*\[\s*\]\s*/g, ' ');
		result = result.replace(/\s*\(\s*\)\s*/g, ' ');
		result = result.replace(/\s*\{\s*\}\s*/g, ' ');

		// Clean up multiple spaces (after bracket removal)
		result = result.replace(/\s+/g, ' ');

		// Clean up multiple dashes
		result = result.replace(/-{2,}/g, '-');
		result = result.replace(/\s+-\s+-/g, ' -');

		// Clean up trailing/leading dashes and spaces. Leading dots too - a
		// segment starting with "." (e.g. a title literally beginning with an
		// ellipsis, "...And Justice for All") makes that folder/file hidden on
		// Linux/macOS, so media servers never see it (GitHub issue #616).
		result = result.replace(/^[\s.-]+|[\s-]+$/g, '');

		// Replace spaces if configured
		if (this.config.replaceSpacesWith) {
			result = result.replace(/\s/g, this.config.replaceSpacesWith);
		}

		return result.trim();
	}

	/**
	 * Replace colons based on configuration
	 */
	private replaceColons(name: string): string {
		switch (this.config.colonReplacement) {
			case 'delete':
				return name.replace(/:/g, '');

			case 'dash':
				return name.replace(/:/g, '-');

			case 'spaceDash':
				return name.replace(/:/g, ' -');

			case 'spaceDashSpace':
				return name.replace(/:/g, ' - ');

			case 'smart':
			default: {
				let result = name;
				for (const { pattern, replacement } of COLON_PATTERNS) {
					result = result.replace(pattern, replacement);
				}
				return result;
			}
		}
	}
}

/**
 * Default naming service instance
 */
export const namingService = new NamingService();

/**
 * Helper to extract naming info from a parsed release
 */
export function releaseToNamingInfo(
	parsed: {
		title?: string;
		year?: number;
		resolution?: string | null;
		source?: string | null;
		codec?: string | null;
		hdr?: string | null;
		bitDepth?: string | null;
		audioCodec?: string;
		audioChannels?: string;
		releaseGroup?: string;
		isProper?: boolean;
		isRepack?: boolean;
		is3d?: boolean;
		edition?: string;
		languages?: string[];
		episode?: { season?: number; episodes?: number[]; absoluteEpisode?: number };
	},
	originalPath?: string
): Partial<MediaNamingInfo> {
	return {
		resolution: parsed.resolution ?? undefined,
		source: parsed.source ?? undefined,
		codec: parsed.codec ?? undefined,
		hdr: parsed.hdr ?? undefined,
		bitDepth: parsed.bitDepth !== 'unknown' ? (parsed.bitDepth ?? undefined) : undefined,
		audioCodec: parsed.audioCodec ?? undefined,
		audioChannels: parsed.audioChannels !== 'unknown' ? parsed.audioChannels : undefined,
		audioLanguages: parsed.languages && parsed.languages.length > 0 ? parsed.languages : undefined,
		releaseGroup: parsed.releaseGroup,
		proper: parsed.isProper,
		repack: parsed.isRepack,
		is3D: parsed.is3d,
		edition: parsed.edition,
		seasonNumber: parsed.episode?.season,
		episodeNumbers: parsed.episode?.episodes,
		absoluteNumber: parsed.episode?.absoluteEpisode,
		originalExtension: originalPath ? extname(originalPath) : undefined
	};
}

/**
 * Library types for movies and TV series in the local library
 */

import { pickBestMovieFile } from '#lib/shared/best-file.js';
import { displayTitle as sharedDisplayTitle } from '#lib/shared/title-display.js';

/** Desired quality tiers selectable for multi-quality mode. */
export type DesiredQuality = '2160p' | '1080p' | '720p' | '480p';

export interface Subtitle {
	id: string;
	language: string;
	isForced?: boolean;
	isHearingImpaired?: boolean;
	format?: string;
	matchScore?: number | null;
	providerId?: string | null;
	dateAdded?: string | null;
	wasSynced?: boolean;
	syncOffset?: number | null;
	isEmbedded?: boolean;
}

export interface MovieFile {
	id: string;
	relativePath: string;
	size: number | null;
	dateAdded: string | null;
	quality: QualityInfo | null;
	mediaInfo: MediaInfo | null;
	releaseGroup: string | null;
	edition: string | null;
}

export interface EpisodeFile {
	id: string;
	seriesId: string;
	seasonNumber: number;
	episodeIds: number[];
	relativePath: string;
	size: number | null;
	dateAdded: string | null;
	sceneName: string | null;
	releaseGroup: string | null;
	releaseType: string | null;
	quality: QualityInfo | null;
	mediaInfo: MediaInfo | null;
	edition: string | null;
	languages: string[] | null;
}

export interface QualityInfo {
	resolution?: string;
	source?: string;
	modifier?: string;
	revision?: number;
}

export interface MediaInfo {
	container?: string;
	videoCodec?: string;
	videoProfile?: string;
	videoBitrate?: number;
	videoBitDepth?: number;
	videoResolution?: { width: number; height: number };
	videoFps?: number;
	audioCodec?: string;
	audioChannels?: number;
	audioBitrate?: number;
	audioLanguages?: string[];
	subtitleLanguages?: string[];
	hdrFormat?: string | null;
	runtime?: number;
}

export interface LibraryMovie {
	id: string;
	tmdbId: number;
	imdbId: string | null;
	providerRefs?: Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null;
	title: string;
	originalTitle: string | null;
	year: number | null;
	overview: string | null;
	posterPath: string | null;
	backdropPath: string | null;
	runtime: number | null;
	genres: string[] | null;
	studios?: string[] | null;
	path: string | null;
	rootFolderId: string | null;
	rootFolderPath: string | null;
	missingRootFolder?: boolean;
	scoringProfileId: string | null;
	/** Desired qualities for multi-quality mode (null/empty = single-quality). */
	desiredQualities?: DesiredQuality[] | null;
	monitored: boolean | null;
	minimumAvailability: string | null;
	wantsSubtitles: boolean | null;
	/** Subtitle language profile override; null = inherit (library/instance default). */
	languageProfileId?: string | null;
	tmdbStatus?: string | null;
	releaseDate?: string | null;
	downloadReleaseDate?: string | null;
	downloadReleaseType?: string | null;
	digitalReleaseDate?: string | null;
	physicalReleaseDate?: string | null;
	availabilityDelay?: number;
	added: string;
	hasFile: boolean | null;
	/** Probed audio languages contradict the effective audio preference
	 * (import verifier; marks the item upgrade-eligible for language). */
	languageShortfall?: boolean | null;
	tmdbCollectionId?: number | null;
	collectionName?: string | null;
	/** Per-item metadata language override mode ('inherit' | 'original' | 'explicit') */
	metadataLanguageMode?: 'inherit' | 'original' | 'explicit' | null;
	/** Explicit TMDB locale when metadataLanguageMode is 'explicit' */
	metadataLanguageValue?: string | null;
	/** @deprecated Legacy single-string view derived from the pair (kept one release) */
	metadataLanguage?: string | null;
	preferOriginalTitle?: boolean | null;
	files: MovieFile[];
	subtitles?: Subtitle[];
}

export interface LibrarySeries {
	id: string;
	tmdbId: number;
	tvdbId: number | null;
	imdbId: string | null;
	providerRefs?: Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null;
	title: string;
	originalTitle: string | null;
	year: number | null;
	overview: string | null;
	posterPath: string | null;
	backdropPath: string | null;
	status: string | null;
	network: string | null;
	genres: string[] | null;
	path: string | null;
	rootFolderId: string | null;
	rootFolderPath: string | null;
	missingRootFolder?: boolean;
	scoringProfileId: string | null;
	monitored: boolean | null;
	partiallyMonitored?: boolean;
	seasonFolder: boolean | null;
	wantsSubtitles: boolean | null;
	/** Subtitle language profile override; null = inherit (library/instance default). */
	languageProfileId?: string | null;
	/** Probed audio languages contradict the effective audio preference
	 * (import verifier; marks the item upgrade-eligible for language). */
	languageShortfall?: boolean | null;
	added: string;
	episodeCount: number | null;
	episodeFileCount: number | null;
	/** Aired episodes without a tracked file (derived at list load). */
	missingCount?: number;
	percentComplete: number;
	totalSize?: number;
	/** Per-item metadata language override mode ('inherit' | 'original' | 'explicit') */
	metadataLanguageMode?: 'inherit' | 'original' | 'explicit' | null;
	/** Explicit TMDB locale when metadataLanguageMode is 'explicit' */
	metadataLanguageValue?: string | null;
	/** @deprecated Legacy single-string view derived from the pair (kept one release) */
	metadataLanguage?: string | null;
	preferOriginalTitle?: boolean | null;
}

export type LibraryItem = LibraryMovie | LibrarySeries;

// Type guards
export function isLibraryMovie(item: LibraryItem): item is LibraryMovie {
	return 'hasFile' in item && 'files' in item;
}

// Helper to get quality display string
export function getQualityDisplay(quality: QualityInfo | null): string | null {
	if (!quality) return null;

	const parts: string[] = [];

	if (quality.resolution) {
		parts.push(quality.resolution);
	}

	return parts.length > 0 ? parts.join(' ') : null;
}

// Helper to get HDR format from media info
export function getHdrDisplay(mediaInfo: MediaInfo | null): string | null {
	if (!mediaInfo?.hdrFormat) return null;

	const format = mediaInfo.hdrFormat.toLowerCase();
	if (format.includes('dolby vision') || format.includes('dv')) return 'DV';
	if (format.includes('hdr10+')) return 'HDR10+';
	if (format.includes('hdr10') || format.includes('hdr')) return 'HDR10';
	if (format.includes('hlg')) return 'HLG';

	return mediaInfo.hdrFormat;
}

// Helper to get best quality from movie files
export function getBestQualityFromFiles(files: MovieFile[]): {
	quality: string | null;
	hdr: string | null;
} {
	if (!files || files.length === 0) {
		return { quality: null, hdr: null };
	}

	// Pick the best file (downloaded > strm, then higher resolution, then size)
	const file = pickBestMovieFile(files);
	if (!file) {
		return { quality: null, hdr: null };
	}
	return {
		quality: getQualityDisplay(file.quality),
		hdr: getHdrDisplay(file.mediaInfo)
	};
}

export interface QualityProfileSummary {
	id: string;
	name: string;
	description: string;
	isBuiltIn: boolean;
	isDefault: boolean;
	minResolution?: string | null;
	maxResolution?: string | null;
}

export function displayTitle(
	item: {
		title: string;
		originalTitle?: string | null;
		preferOriginalTitle?: boolean | null;
	},
	instanceDefault?: boolean | null
): string {
	// Delegates to the shared resolver: per-item flag wins, the instance
	// default (language_settings.prefer_original_title) only fills the unset
	// case, so existing per-item behavior is unchanged.
	return sharedDisplayTitle(item, instanceDefault);
}

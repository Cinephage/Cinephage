/**
 * Application-wide configuration constants.
 * Centralizes magic numbers and hardcoded values for maintainability.
 */

/**
 * TMDB API configuration.
 */
export const TMDB = {
	/** Base URL for TMDB API v3 */
	BASE_URL: 'https://api.themoviedb.org/3',

	/** Default region for watch providers */
	DEFAULT_REGION: 'US'
} as const;

/**
 * Movie release-date / availability configuration.
 */
export const RELEASE = {
	/** Days after theatrical release to treat a movie as "released" when no home-media date is known. */
	THEATRICAL_TO_RELEASED_DAYS: 90,

	/**
	 * Days after a theatrical-only release (no digital/physical/TV date ever recorded)
	 * after which the title is presumed generally released rather than still "In Theaters".
	 * ~3 years — covers older catalog titles TMDB never gave granular home dates.
	 */
	THEATRICAL_ONLY_TO_RELEASED_DAYS: 1095,

	/** Current-year in-library age (days) after which a movie is presumed released (legacy heuristic). */
	CURRENT_YEAR_LIBRARY_DAYS: 120
} as const;

/**
 * Search and indexer configuration.
 */
export const SEARCH = {
	/** Default page size for search results */
	PAGE_SIZE: 20,

	/** Maximum results to fetch per indexer */
	MAX_INDEXER_RESULTS: 50,

	/** Minimum vote count for quality filtering on discover */
	MIN_VOTE_COUNT: 50
} as const;

/**
 * UI configuration.
 */
export const UI = {
	/** Scroll threshold (px) for triggering infinite scroll */
	INFINITE_SCROLL_THRESHOLD: 200,

	/** IntersectionObserver root margin for infinite scroll */
	INFINITE_SCROLL_ROOT_MARGIN: '200px',

	/** Maximum items to display before applying limits (prevents memory issues) */
	MAX_DISPLAY_ITEMS: 500
} as const;

/**
 * Download and import configuration.
 */
export const DOWNLOAD = {
	/** Minimum file size to consider for import (50MB) */
	MIN_IMPORT_SIZE_BYTES: 50 * 1024 * 1024,

	/** Minimum file size for library scanning (10MB) */
	MIN_SCAN_SIZE_BYTES: 10 * 1024 * 1024,

	/** Download monitor poll interval when downloads are active (5 seconds) */
	POLL_INTERVAL_ACTIVE_MS: 5_000,

	/** Download monitor poll interval when idle (30 seconds) */
	POLL_INTERVAL_IDLE_MS: 30_000,

	/** Grace period after queueing before considering download missing (30 seconds) */
	GRACE_PERIOD_MS: 30_000
} as const;

/**
 * Video file extensions for media library.
 */
export const VIDEO_EXTENSIONS = [
	'.mkv',
	'.mp4',
	'.avi',
	'.m4v',
	'.mov',
	'.wmv',
	'.mpg',
	'.mpeg',
	'.m2ts',
	'.ts',
	'.webm',
	'.flv',
	'.vob'
] as const;

export const VIDEO_EXTENSIONS_SET = new Set<string>(VIDEO_EXTENSIONS);

export function isVideoFile(filePath: string, extraExtensions?: readonly string[]): boolean {
	const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
	if (VIDEO_EXTENSIONS_SET.has(ext)) return true;
	if (extraExtensions) {
		for (const extra of extraExtensions) {
			if (ext === extra) return true;
		}
	}
	return false;
}

/**
 * Sample/extra file patterns to exclude from import.
 */
export const EXCLUDED_FILE_PATTERNS = [
	/\bsample\b/i,
	/\btrailer\b/i,
	/\bteaser\b/i,
	/\bpromo\b/i,
	/\bfeaturette\b/i,
	/\bbehind[\s._-]?the[\s._-]?scenes?\b/i,
	/\bdeleted[\s._-]?scenes?\b/i,
	/\bextras?\b/i,
	/\bbonus\b/i
] as const;

/**
 * Dangerous file extensions that indicate malware or unwanted content.
 * If a download folder contains files with these extensions, the import should be rejected.
 * @see https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/MediaFiles/MediaFileExtensions.cs
 */
export const DANGEROUS_EXTENSIONS = [
	'.arj',
	'.lnk',
	'.lzh',
	'.ps1',
	'.scr',
	'.vbs',
	'.zipx'
] as const;

/**
 * Executable file extensions.
 * Downloads containing executables are suspicious and likely malware.
 * @see https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/MediaFiles/MediaFileExtensions.cs
 */
export const EXECUTABLE_EXTENSIONS = ['.bat', '.cmd', '.exe', '.sh'] as const;

/**
 * Genre ID mappings between Movie and TV APIs.
 *
 * TMDB uses different genre IDs for movies vs TV shows.
 * This mapping allows unified filtering across both content types.
 *
 * @see https://developers.themoviedb.org/3/genres/get-movie-list
 * @see https://developers.themoviedb.org/3/genres/get-tv-list
 */
/**
 * Curated TMDB TV networks for the discover network filter (`with_networks`).
 *
 * TMDB exposes no network list or network search endpoint, so the picker is a
 * curated ID set (each verified against /network/{id} on live data); names and
 * logos are still fetched live at page load. Discover queries pipe-join
 * selections, so multiple picks mean "aired on any of these networks".
 */
export const DISCOVER_NETWORKS = [
	{ id: 213, name: 'Netflix' },
	{ id: 1024, name: 'Prime Video' },
	{ id: 2552, name: 'Apple TV+' },
	{ id: 2739, name: 'Disney+' },
	{ id: 453, name: 'Hulu' },
	{ id: 6783, name: 'Max' },
	{ id: 3353, name: 'Peacock' },
	{ id: 4330, name: 'Paramount+' },
	{ id: 4353, name: 'discovery+' },
	{ id: 56, name: 'Cartoon Network' },
	{ id: 13, name: 'Nickelodeon' },
	{ id: 54, name: 'Disney Channel' },
	{ id: 44, name: 'Disney XD' },
	{ id: 80, name: 'Adult Swim' },
	{ id: 49, name: 'HBO' },
	{ id: 67, name: 'Showtime' },
	{ id: 318, name: 'Starz' },
	{ id: 174, name: 'AMC' },
	{ id: 88, name: 'FX' },
	{ id: 47, name: 'Comedy Central' },
	{ id: 33, name: 'MTV' },
	{ id: 6, name: 'NBC' },
	{ id: 2, name: 'ABC' },
	{ id: 19, name: 'FOX' },
	{ id: 16, name: 'CBS' },
	{ id: 71, name: 'The CW' },
	{ id: 68, name: 'TBS' },
	{ id: 4, name: 'BBC One' }
] as const;

export const GENRE_MAPPINGS = {
	/**
	 * Maps movie genre IDs to their TV equivalents.
	 */
	MOVIE_TO_TV: {
		'28': '10759', // Action -> Action & Adventure
		'12': '10759', // Adventure -> Action & Adventure
		'14': '10765', // Fantasy -> Sci-Fi & Fantasy
		'878': '10765', // Sci-Fi -> Sci-Fi & Fantasy
		'10752': '10768' // War -> War & Politics
	} as const,

	/**
	 * Maps TV genre IDs to their movie equivalents.
	 */
	TV_TO_MOVIE: {
		'10759': '28', // Action & Adventure -> Action
		'10765': '14', // Sci-Fi & Fantasy -> Fantasy
		'10768': '10752' // War & Politics -> War
	} as const
} as const;

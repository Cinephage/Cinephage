/**
 * Category Types
 *
 * Newznab-compatible category definitions and utilities.
 * Used for filtering search results and mapping indexer categories.
 */

// =============================================================================
// CATEGORY ENUM
// =============================================================================

/**
 * Newznab-compatible category codes.
 * Based on the Newznab standard with common extensions.
 */
export enum Category {
	// Console/Gaming (1xxx)
	CONSOLE = 1000,
	CONSOLE_NDS = 1010,
	CONSOLE_PSP = 1020,
	CONSOLE_WII = 1030,
	CONSOLE_XBOX = 1040,
	CONSOLE_XBOX360 = 1050,
	CONSOLE_WIIWARE = 1060,
	CONSOLE_XBOX360_DLC = 1070,
	CONSOLE_PS3 = 1080,
	CONSOLE_OTHER = 1090,
	CONSOLE_3DS = 1110,
	CONSOLE_PS_VITA = 1120,
	CONSOLE_WIIU = 1130,
	CONSOLE_XBOXONE = 1140,
	CONSOLE_PS4 = 1180,

	// Movies (2xxx)
	MOVIES = 2000,
	MOVIES_FOREIGN = 2010,
	MOVIES_OTHER = 2020,
	MOVIES_SD = 2030,
	MOVIES_HD = 2040,
	MOVIES_UHD = 2045,
	MOVIES_BLURAY = 2050,
	MOVIES_3D = 2060,
	MOVIES_WEBDL = 2070,
	// Backwards-compatible aliases (singular form) - these point to same values
	// eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
	MOVIE = 2000,
	// eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
	MOVIE_FOREIGN = 2010,
	// eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
	MOVIE_OTHER = 2020,
	// eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
	MOVIE_SD = 2030,
	// eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
	MOVIE_HD = 2040,
	// eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
	MOVIE_UHD = 2045,
	// eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
	MOVIE_BLURAY = 2050,
	// eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
	MOVIE_3D = 2060,
	// eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
	MOVIE_WEBDL = 2070,

	// Audio (3xxx)
	AUDIO = 3000,
	AUDIO_MP3 = 3010,
	AUDIO_VIDEO = 3020,
	AUDIO_AUDIOBOOK = 3030,
	AUDIO_LOSSLESS = 3040,
	AUDIO_OTHER = 3050,
	AUDIO_FOREIGN = 3060,

	// PC (4xxx)
	PC = 4000,
	PC_0DAY = 4010,
	PC_ISO = 4020,
	PC_MAC = 4030,
	PC_MOBILE_OTHER = 4040,
	PC_GAMES = 4050,
	PC_MOBILE_IOS = 4060,
	PC_MOBILE_ANDROID = 4070,

	// TV (5xxx)
	TV = 5000,
	TV_WEBDL = 5010,
	TV_FOREIGN = 5020,
	TV_SD = 5030,
	TV_HD = 5040,
	TV_UHD = 5045,
	TV_OTHER = 5050,
	TV_SPORT = 5060,
	TV_ANIME = 5070,
	TV_DOCUMENTARY = 5080,

	// XXX (6xxx)
	XXX = 6000,
	XXX_DVD = 6010,
	XXX_WMV = 6020,
	XXX_XVID = 6030,
	XXX_X264 = 6040,
	XXX_UHD = 6045,
	XXX_PACK = 6050,
	XXX_IMAGESET = 6060,
	XXX_OTHER = 6070,

	// Books (7xxx)
	BOOKS = 7000,
	BOOKS_MAGAZINES = 7010,
	BOOKS_EBOOK = 7020,
	BOOKS_COMICS = 7030,
	BOOKS_TECHNICAL = 7040,
	BOOKS_OTHER = 7050,
	BOOKS_FOREIGN = 7060,

	// Other (8xxx)
	OTHER = 8000,
	OTHER_MISC = 8010,
	OTHER_HASHED = 8020
}

// =============================================================================
// CATEGORY GROUPS
// =============================================================================

/**
 * All movie categories
 */
export const MOVIE_CATEGORIES = [
	Category.MOVIES,
	Category.MOVIES_FOREIGN,
	Category.MOVIES_OTHER,
	Category.MOVIES_SD,
	Category.MOVIES_HD,
	Category.MOVIES_UHD,
	Category.MOVIES_BLURAY,
	Category.MOVIES_3D,
	Category.MOVIES_WEBDL
] as const;

/**
 * All TV categories
 */
export const TV_CATEGORIES = [
	Category.TV,
	Category.TV_WEBDL,
	Category.TV_FOREIGN,
	Category.TV_SD,
	Category.TV_HD,
	Category.TV_UHD,
	Category.TV_OTHER,
	Category.TV_SPORT,
	Category.TV_ANIME,
	Category.TV_DOCUMENTARY
] as const;

/**
 * All audio categories
 */
export const AUDIO_CATEGORIES = [
	Category.AUDIO,
	Category.AUDIO_MP3,
	Category.AUDIO_VIDEO,
	Category.AUDIO_AUDIOBOOK,
	Category.AUDIO_LOSSLESS,
	Category.AUDIO_OTHER,
	Category.AUDIO_FOREIGN
] as const;

/**
 * All book categories
 */
export const BOOK_CATEGORIES = [
	Category.BOOKS,
	Category.BOOKS_MAGAZINES,
	Category.BOOKS_EBOOK,
	Category.BOOKS_COMICS,
	Category.BOOKS_TECHNICAL,
	Category.BOOKS_OTHER,
	Category.BOOKS_FOREIGN
] as const;

/**
 * All PC/software categories
 */
export const PC_CATEGORIES = [
	Category.PC,
	Category.PC_0DAY,
	Category.PC_ISO,
	Category.PC_MAC,
	Category.PC_MOBILE_OTHER,
	Category.PC_GAMES,
	Category.PC_MOBILE_IOS,
	Category.PC_MOBILE_ANDROID
] as const;

/**
 * All console/gaming categories
 */
export const CONSOLE_CATEGORIES = [
	Category.CONSOLE,
	Category.CONSOLE_NDS,
	Category.CONSOLE_PSP,
	Category.CONSOLE_WII,
	Category.CONSOLE_XBOX,
	Category.CONSOLE_XBOX360,
	Category.CONSOLE_WIIWARE,
	Category.CONSOLE_XBOX360_DLC,
	Category.CONSOLE_PS3,
	Category.CONSOLE_OTHER,
	Category.CONSOLE_3DS,
	Category.CONSOLE_PS_VITA,
	Category.CONSOLE_WIIU,
	Category.CONSOLE_XBOXONE,
	Category.CONSOLE_PS4
] as const;

/**
 * All XXX/adult categories
 */
export const XXX_CATEGORIES = [
	Category.XXX,
	Category.XXX_DVD,
	Category.XXX_WMV,
	Category.XXX_XVID,
	Category.XXX_X264,
	Category.XXX_UHD,
	Category.XXX_PACK,
	Category.XXX_IMAGESET,
	Category.XXX_OTHER
] as const;

// =============================================================================
// CATEGORY UTILITIES
// =============================================================================

/**
 * Content types for searching
 */
export type ContentType = 'movie' | 'tv' | 'music' | 'book' | 'software' | 'xxx' | 'other';

/**
 * Check if a category is a movie category
 */
export function isMovieCategory(category: number): boolean {
	return category >= 2000 && category < 3000;
}

/**
 * Check if a category is a TV category
 */
export function isTvCategory(category: number): boolean {
	return category >= 5000 && category < 6000;
}

/**
 * Check if a category is an audio category
 */
export function isAudioCategory(category: number): boolean {
	return category >= 3000 && category < 4000;
}

/**
 * Check if a category is a book category
 */
export function isBookCategory(category: number): boolean {
	return category >= 7000 && category < 8000;
}

/**
 * Check if a category is a PC/software category
 */
export function isPcCategory(category: number): boolean {
	return category >= 4000 && category < 5000;
}

/**
 * Check if a category is a console/gaming category
 */
export function isConsoleCategory(category: number): boolean {
	return category >= 1000 && category < 2000;
}

/**
 * Check if a category is an XXX category
 */
export function isXxxCategory(category: number): boolean {
	return category >= 6000 && category < 7000;
}

/**
 * Get the content type for a category
 */
export function getCategoryContentType(category: number): ContentType {
	if (isMovieCategory(category)) return 'movie';
	if (isTvCategory(category)) return 'tv';
	if (isAudioCategory(category)) return 'music';
	if (isBookCategory(category)) return 'book';
	if (isPcCategory(category)) return 'software';
	if (isConsoleCategory(category)) return 'software';
	if (isXxxCategory(category)) return 'xxx';
	return 'other';
}

/**
 * Get default categories for a content type
 */
export function getCategoriesForContentType(contentType: ContentType): Category[] {
	switch (contentType) {
		case 'movie':
			return [...MOVIE_CATEGORIES];
		case 'tv':
			return [...TV_CATEGORIES];
		case 'music':
			return [...AUDIO_CATEGORIES];
		case 'book':
			return [...BOOK_CATEGORIES];
		case 'software':
			return [...PC_CATEGORIES, ...CONSOLE_CATEGORIES];
		case 'xxx':
			return [...XXX_CATEGORIES];
		default:
			return [];
	}
}

/**
 * Expand a base category list based on content classification flags.
 * - isAnime: ensures Category.TV_ANIME (5070) is present when the base contains any TV category
 * - isAdult: appends all XXX categories (6xxx)
 * Returns a deduped, order-stable array.
 */
export function expandCategoriesForClassification(
	base: number[],
	flags: { isAnime?: boolean; isAdult?: boolean }
): number[] {
	const result = [...base];
	if (flags.isAnime && base.some(isTvCategory) && !result.includes(Category.TV_ANIME)) {
		result.push(Category.TV_ANIME);
	}
	if (flags.isAdult) {
		for (const cat of XXX_CATEGORIES) {
			if (!result.includes(cat)) {
				result.push(cat);
			}
		}
	}
	return result;
}

/**
 * Get a display name for a category
 */
export function getCategoryName(category: Category): string {
	return Category[category]?.replace(/_/g, ' ') ?? `Unknown (${category})`;
}

/**
 * Category mapping entry (indexer-specific ID to standard category)
 */
export interface CategoryMapping {
	/** Indexer's internal category ID */
	indexerCategoryId: string | number;
	/** Standard Newznab category */
	category: Category;
	/** Indexer's name for this category */
	name?: string;
}

/**
 * Build a category map from mappings
 */
export function buildCategoryMap(mappings: CategoryMapping[]): Map<number, string> {
	const map = new Map<number, string>();
	for (const mapping of mappings) {
		map.set(mapping.category, mapping.name ?? getCategoryName(mapping.category));
	}
	return map;
}

/**
 * Check if an indexer's categories include any matching a content type
 */
export function hasCategoriesForContentType(
	indexerCategories: Map<number, string> | number[],
	contentType: ContentType
): boolean {
	const categoryIds = Array.isArray(indexerCategories)
		? indexerCategories
		: Array.from(indexerCategories.keys());

	const targetCategories = getCategoriesForContentType(contentType);
	return categoryIds.some((cat) => targetCategories.includes(cat as Category));
}

// =============================================================================
// SEARCH TYPE COMPATIBILITY (Legacy API support)
// =============================================================================

/** Search type alias for backwards compatibility */
export type SearchTypeCategory = 'movie' | 'tv' | 'music' | 'book' | 'basic';

/**
 * Get default categories for a search type
 * @deprecated Use getCategoriesForContentType instead
 */
export function getCategoriesForSearchType(searchType: SearchTypeCategory): number[] {
	switch (searchType) {
		case 'movie':
			return [...MOVIE_CATEGORIES];
		case 'tv':
			return [...TV_CATEGORIES];
		case 'music':
			return [...AUDIO_CATEGORIES];
		case 'book':
			return [...BOOK_CATEGORIES];
		case 'basic':
			return []; // No category filter for basic search
	}
}

/**
 * Check if a category matches a search type
 * @deprecated Use getCategoryContentType instead
 */
export function categoryMatchesSearchType(
	category: number,
	searchType: SearchTypeCategory
): boolean {
	switch (searchType) {
		case 'movie':
			return isMovieCategory(category);
		case 'tv':
			return isTvCategory(category);
		case 'music':
			return isAudioCategory(category);
		case 'book':
			return isBookCategory(category);
		case 'basic':
			return true; // Basic search matches all categories
	}
}

/**
 * Check if an indexer's categories include any matching the search type
 * @deprecated Use hasCategoriesForContentType instead
 */
export function indexerHasCategoriesForSearchType(
	indexerCategories: Map<number, string> | number[],
	searchType: SearchTypeCategory
): boolean {
	if (searchType === 'basic') {
		return true; // Basic search doesn't filter by category
	}

	const categoryIds = Array.isArray(indexerCategories)
		? indexerCategories
		: Array.from(indexerCategories.keys());

	return categoryIds.some((cat) => categoryMatchesSearchType(cat, searchType));
}

/**
 * Check whether a user's per-indexer category restriction (the
 * "restrict searches to only these categories" picker - configured via
 * `additionalCategories`) allows a given search type.
 *
 * `undefined` means the restriction isn't configured at all (no opinion,
 * eligible). An empty array is the explicit "open search, no category
 * filter" choice - also eligible for everything, since the user picked
 * "no restriction" rather than "restrict to nothing". Only a *non-empty*
 * restriction that shares no category range with the search type makes
 * the indexer ineligible.
 */
export function restrictionAllowsSearchType(
	restriction: number[] | undefined,
	searchType: SearchTypeCategory
): boolean {
	if (!restriction || restriction.length === 0) return true;
	if (searchType === 'basic') return true;
	return restriction.some((cat) => categoryMatchesSearchType(cat, searchType));
}

/**
 * TMDB release-date `type` numbers and shared helpers.
 *
 * TMDB release_dates entries carry a numeric `type`:
 * 1=Premiere, 2=Theatrical (limited), 3=Theatrical, 4=Digital, 5=Physical, 6=TV.
 *
 * This module is intentionally free of any Paraglide/`#lib/paraglide` import so it
 * stays usable from pure unit-tested utilities. Localized labels live in
 * `releaseTypeLabel.ts`.
 */
export const RELEASE_TYPE = {
	PREMIERE: 1,
	THEATRICAL_LIMITED: 2,
	THEATRICAL: 3,
	DIGITAL: 4,
	PHYSICAL: 5,
	TV: 6
} as const;

/** Release types that represent a downloadable/streamable home release. */
export const DOWNLOADABLE_TYPES = new Set<number>([
	RELEASE_TYPE.DIGITAL,
	RELEASE_TYPE.PHYSICAL,
	RELEASE_TYPE.TV
]);

/** Human-readable names for the downloadable release types. */
export const TYPE_NAME: Record<number, 'digital' | 'physical' | 'tv'> = {
	[RELEASE_TYPE.DIGITAL]: 'digital',
	[RELEASE_TYPE.PHYSICAL]: 'physical',
	[RELEASE_TYPE.TV]: 'tv'
};

/**
 * Release/availability domain types.
 *
 * A `ReleaseEvent` is the primitive: one observable release moment for a piece
 * of media in one region. Everything else in the app (availability level,
 * calendar, search gating, UI copy) is a projection over these rows.
 *
 * Do not add release-date columns to feature modules; write an event instead.
 */

export type ReleaseMediaType = 'movie' | 'series' | 'episode';

export type ReleaseKind = 'premiere' | 'theatrical' | 'digital' | 'physical' | 'tv' | 'broadcast';

export type ReleaseSource = 'tmdb' | 'tvdb' | 'manual';

export type ReleaseConfidence = 'confirmed' | 'predicted';

/** The three levels the UI and the arr API speak. */
export type AvailabilityLevel = 'announced' | 'inCinemas' | 'released';

export interface ReleaseEvent {
	id: string;
	mediaType: ReleaseMediaType;
	mediaId: string;
	kind: ReleaseKind;
	region: string;
	platform: string | null;
	releaseDate: string;
	releaseTime: string | null;
	timezone: string | null;
	source: ReleaseSource;
	sourceId: string | null;
	confidence: ReleaseConfidence;
	createdAt: string;
	updatedAt: string;
}

export type NewReleaseEvent = Omit<ReleaseEvent, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Kinds that make media acquirable. `theatrical` is deliberately excluded:
 * a cinema date does not mean a file exists anywhere.
 */
export const DOWNLOADABLE_KINDS: readonly ReleaseKind[] = [
	'digital',
	'physical',
	'tv',
	'broadcast'
];

export function isDownloadable(kind: ReleaseKind): boolean {
	return DOWNLOADABLE_KINDS.includes(kind);
}

/**
 * The earliest date per release window, as a convenience projection for
 * callers that still need the flat shape (arr API, column cache).
 */
export interface ReleaseWindows {
	theatrical: string | null;
	digital: string | null;
	physical: string | null;
	tv: string | null;
}

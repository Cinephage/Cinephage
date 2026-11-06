import type { AvailabilityLevel, ReleaseEvent, ReleaseKind, ReleaseWindows } from './types.js';
import { isDownloadable } from './types.js';

/**
 * The single derivation of "can I get this yet?".
 *
 * Everything that used to answer this question independently — the dashboard
 * badge, the search gate, the Radarr status, the UI release line — must call
 * into here. If a new caller needs a slightly different answer, add an option
 * rather than a second copy of the rules.
 */

export interface AvailabilityInput {
	events: readonly ReleaseEvent[];
	hasFile: boolean;
	/** `movies.minimum_availability`: announced | inCinemas | released */
	minimumAvailability: AvailabilityLevel;
	/** Injectable clock for tests; ISO `YYYY-MM-DD`. */
	today?: string;
	/**
	 * Grace period after a theatrical premiere during which a title with no
	 * home-release events is still considered obtainable. Mirrors the 90-day
	 * rule the old `movieAvailability` helper applied; 0 disables it.
	 */
	theatricalGraceDays?: number;
}

export interface Availability {
	level: AvailabilityLevel;
	/** First downloadable moment at or after today, else null. */
	nextActionableAt: string | null;
	nextEvent: ReleaseEvent | null;
	firstDownloadable: ReleaseEvent | null;
	theatricalPassed: boolean;
}

const THEATRICAL: readonly ReleaseKind[] = ['premiere', 'theatrical'];

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

function earliestOf(
	events: readonly ReleaseEvent[],
	kinds: readonly ReleaseKind[]
): ReleaseEvent | null {
	let winner: ReleaseEvent | null = null;
	for (const event of events) {
		if (!kinds.includes(event.kind)) continue;
		if (!winner || event.releaseDate < winner.releaseDate) winner = event;
	}
	return winner;
}

function earliestDownloadable(events: readonly ReleaseEvent[]): ReleaseEvent | null {
	let winner: ReleaseEvent | null = null;
	for (const event of events) {
		if (!isDownloadable(event.kind)) continue;
		if (!winner || event.releaseDate < winner.releaseDate) winner = event;
	}
	return winner;
}

/** Whole days from `from` to `to`; negative when `from` is in the future. */
function daysBetween(from: string, to: string): number {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	if (Number.isNaN(a) || Number.isNaN(b)) return 0;
	return Math.floor((b - a) / 86_400_000);
}

export function deriveAvailability(input: AvailabilityInput): Availability {
	const today = input.today ?? todayIso();
	const { events, hasFile } = input;

	const theatrical = earliestOf(events, THEATRICAL);
	const downloadable = earliestDownloadable(events);

	const theatricalPassed = Boolean(theatrical && theatrical.releaseDate <= today);
	const downloadablePassed = Boolean(downloadable && downloadable.releaseDate <= today);

	const graceDays = input.theatricalGraceDays ?? 0;
	const theatricalGraceElapsed = Boolean(
		graceDays > 0 &&
			theatrical &&
			!downloadable &&
			daysBetween(theatrical.releaseDate, today) >= graceDays
	);

	let level: AvailabilityLevel;
	if (hasFile || downloadablePassed || theatricalGraceElapsed) level = 'released';
	else if (theatricalPassed) level = 'inCinemas';
	else level = 'announced';

	const upcoming = events
		.filter((event) => isDownloadable(event.kind) && event.releaseDate > today)
		.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));

	return {
		level,
		nextActionableAt: upcoming[0]?.releaseDate ?? null,
		nextEvent: upcoming[0] ?? null,
		firstDownloadable: downloadable,
		theatricalPassed
	};
}

/**
 * Whether automatic search may run. Mirrors the level derivation: a title below
 * its configured minimum availability is not searchable, and an unknown release
 * state is only searchable when the user opted into `announced`.
 */
export function isSearchable(input: AvailabilityInput): boolean {
	const availability = deriveAvailability(input);

	switch (input.minimumAvailability) {
		case 'announced':
			return true;
		case 'inCinemas':
			return availability.theatricalPassed || availability.level === 'released';
		case 'released':
		default:
			return availability.level === 'released';
	}
}

/** Flat projection for callers that still speak in columns (arr API, cache). */
export function windowsFrom(events: readonly ReleaseEvent[]): ReleaseWindows {
	return {
		theatrical: earliestOf(events, ['theatrical'])?.releaseDate ?? earliestOf(events, ['premiere'])?.releaseDate ?? null,
		digital: earliestOf(events, ['digital'])?.releaseDate ?? null,
		physical: earliestOf(events, ['physical'])?.releaseDate ?? null,
		tv: earliestOf(events, ['tv'])?.releaseDate ?? null
	};
}

/**
 * Earliest downloadable date across digital/physical/tv — the value that
 * replaces the legacy `movies.download_release_date` column.
 */
export function firstDownloadableDate(events: readonly ReleaseEvent[]): string | null {
	return earliestDownloadable(events)?.releaseDate ?? null;
}

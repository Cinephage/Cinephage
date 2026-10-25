import { RELEASE } from '#lib/config/constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReleaseStageKind =
	| 'availableDigital'
	| 'availablePhysical'
	| 'availableStreaming'
	| 'digitalUpcoming'
	| 'physicalUpcoming'
	| 'streamingUpcoming'
	| 'inTheaters'
	| 'released'
	| 'comingToTheaters'
	| 'announced';

export interface ReleaseStage {
	kind: ReleaseStageKind;
	days?: number;
}

export interface ReleaseStageFacts {
	theatricalMs: number | null;
	digitalMs: number | null;
	physicalMs: number | null;
	tvMs?: number | null;
}

function isValid(ms: number | null | undefined): ms is number {
	return ms !== null && ms !== undefined && !Number.isNaN(ms);
}

function daysUntil(ms: number, nowMs: number): number {
	return Math.ceil((ms - nowMs) / (1000 * 60 * 60 * 24));
}

type HomeMedium = 'digital' | 'physical' | 'streaming';

function earliestFutureHome(
	digitalMs: number | null,
	physicalMs: number | null,
	tvMs: number | null | undefined,
	nowMs: number
): { ms: number; type: HomeMedium } | null {
	const candidates: { ms: number; type: HomeMedium }[] = [];
	if (isValid(digitalMs) && digitalMs > nowMs) candidates.push({ ms: digitalMs, type: 'digital' });
	if (isValid(physicalMs) && physicalMs > nowMs)
		candidates.push({ ms: physicalMs, type: 'physical' });
	if (isValid(tvMs) && tvMs > nowMs) candidates.push({ ms: tvMs, type: 'streaming' });

	if (candidates.length === 0) return null;
	candidates.sort((a, b) => a.ms - b.ms);
	return candidates[0];
}

const UPCOMING_KIND: Record<HomeMedium, ReleaseStageKind> = {
	digital: 'digitalUpcoming',
	physical: 'physicalUpcoming',
	streaming: 'streamingUpcoming'
};

/**
 * The single source of truth for "what release stage is a movie in?".
 *
 * Classification is driven purely by the release DATES, never by TMDB's
 * `status` field. TMDB reports `status: "Released"` as soon as a film opens in
 * theaters, which says nothing about home/digital availability — so a movie is
 * only "Available" when it has a past digital, physical, or TV/streaming
 * release date. A movie whose theatrical date is past but has no home-release
 * date is "In Theaters" — until enough time has passed
 * ({@link RELEASE.THEATRICAL_ONLY_TO_RELEASED_DAYS}, ~3 years), after which it
 * is presumed generally "Released" (covers older catalog titles TMDB never gave
 * granular digital/physical dates).
 *
 * Both the display layer (`getSmartReleaseLine`) and the availability layer
 * (`getMovieAvailabilityLevel`) derive from this so they can never contradict.
 */
export function resolveReleaseStage(
	facts: ReleaseStageFacts,
	now: Date = new Date()
): ReleaseStage {
	const nowMs = now.getTime();
	const { theatricalMs, digitalMs, physicalMs, tvMs } = facts;

	const digitalPast = isValid(digitalMs) && digitalMs <= nowMs;
	const physicalPast = isValid(physicalMs) && physicalMs <= nowMs;
	const tvPast = isValid(tvMs) && tvMs <= nowMs;

	if (digitalPast) return { kind: 'availableDigital' };
	if (physicalPast) return { kind: 'availablePhysical' };
	if (tvPast) return { kind: 'availableStreaming' };

	const theatricalPast = isValid(theatricalMs) && theatricalMs <= nowMs;

	if (theatricalPast) {
		const next = earliestFutureHome(digitalMs, physicalMs, tvMs, nowMs);
		if (next) {
			return { kind: UPCOMING_KIND[next.type], days: daysUntil(next.ms, nowMs) };
		}
		const ageDays = isValid(theatricalMs) ? (nowMs - theatricalMs) / DAY_MS : 0;
		if (ageDays > RELEASE.THEATRICAL_ONLY_TO_RELEASED_DAYS) {
			return { kind: 'released' };
		}
		return { kind: 'inTheaters' };
	}

	if (isValid(theatricalMs)) {
		return { kind: 'comingToTheaters', days: daysUntil(theatricalMs, nowMs) };
	}

	return { kind: 'announced' };
}

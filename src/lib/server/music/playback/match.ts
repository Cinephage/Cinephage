/**
 * Picking the right YouTube result for a track.
 *
 * ytsearch's first hit is not "the song": it mixes official uploads, covers,
 * live versions and hour-long loops. The match is decided by the track title
 * first, then by duration — a live cut of a studio track is a different
 * recording, and playing it silently is worse than not playing at all.
 */

export interface YoutubeCandidate {
	id: string;
	title: string;
	duration: number | null;
	channel: string | null;
}

export interface TrackIdentity {
	title: string;
	artist: string;
	duration?: number | null;
}

/** Lowercase, diacritics stripped, bracketed noise removed. */
export function normalizeTitle(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function tokenSet(text: string): Set<string> {
	return new Set(normalizeTitle(text).split(' ').filter(Boolean));
}

function overlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0) return 0;
	let hits = 0;
	for (const token of a) if (b.has(token)) hits += 1;
	return hits / a.size;
}

/** Title coverage below this is a different song, not a sloppy match. */
const MIN_TITLE_COVERAGE = 0.6;
/** Longer than this and it is a different recording (live cut, extended mix). */
const MAX_DURATION_DRIFT_SECONDS = 30;

export function pickBestCandidate(
	candidates: YoutubeCandidate[],
	target: TrackIdentity
): YoutubeCandidate | null {
	const targetTitle = tokenSet(target.title);
	if (targetTitle.size === 0) return null;

	const artistTokens = tokenSet(target.artist);
	let best: YoutubeCandidate | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;

	for (const candidate of candidates) {
		const candidateTokens = tokenSet(candidate.title);
		const titleCoverage = overlap(targetTitle, candidateTokens);
		if (titleCoverage < MIN_TITLE_COVERAGE) continue;

		let score = titleCoverage * 10;

		if (target.duration && candidate.duration) {
			const drift = Math.abs(candidate.duration - target.duration);
			if (drift > MAX_DURATION_DRIFT_SECONDS) continue;
			if (drift <= 3) score += 6;
			else if (drift <= 10) score += 2;
		}

		score += overlap(artistTokens, candidateTokens) * 4;

		if (candidate.channel) {
			const channelTokens = tokenSet(candidate.channel);
			if (overlap(artistTokens, channelTokens) >= 0.5) score += 3;
			// Auto-generated label channels are named "<Artist> - Topic".
			if (/ topic$/.test(normalizeTitle(candidate.channel))) score += 2;
		}

		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}

	return best;
}

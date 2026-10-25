/**
 * Special-episode (season 0) title matching for TV files with no episode
 * numbers in the name — e.g. "Razor (2007)/Razor (2007).mp4" inside a
 * Battlestar Galactica series folder.
 *
 * Mirrors Sonarr's ParseSpecialEpisodeTitle → FindEpisodeByTitle semantics:
 * only season 0 episodes are considered, and an episode matches when its
 * normalized title is CONTAINED IN the normalized file/folder title
 * (ranked by earliest position, then longest title) — deliberately
 * conservative, no fuzzy similarity.
 *
 * Two extensions beyond Sonarr, both forced by TMDB (Sonarr's TVDB titles
 * specials without the series prefix):
 * - when the series title is provided, episode titles are also tried with
 *   that leading prefix stripped ("Pokémon: The First Movie - Mewtwo
 *   Strikes Back" → "The First Movie - Mewtwo Strikes Back");
 * - a token-subset pass accepts candidates whose tokens (minus
 *   stopwords/years) all appear in the episode title with >= 80% coverage
 *   and an agreeing air year, for files that omit the franchise prefix
 *   entirely.
 */

import { foldAccents, normalizeForEpisodeTitle } from './title-matching.js';

export interface SpecialEpisodeLike {
	seasonNumber: number;
	episodeNumber: number;
	title: string | null | undefined;
	airDate?: string | null;
}

export interface SpecialEpisodeTitleMatch<T> {
	episode: T;
	method: 'containment' | 'tokenSubset';
	/** Character index of the episode title inside the normalized candidate (containment matches only). */
	position: number;
	/** Fraction of the candidate's tokens present in the episode title (token-subset matches; 1 for containment). */
	coverage: number;
	/** The candidate string (file stem or folder name) that produced the match. */
	candidate: string;
}

// Sonarr has no length floor; we require 3 normalized chars so that
// 1-2 letter titles ("Oz", "M*A*S*H"-style fragments) can't match anywhere.
const MIN_CONTAINMENT_TITLE_LENGTH = 3;
const MIN_TOKENS = 2;
const MIN_TOKEN_COVERAGE = 0.8;
const MAX_YEAR_DIFFERENCE = 2;

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'of']);

interface SpecialCandidate<T> {
	episode: T;
	/** Normalized title variants for containment: series-prefix-stripped first (when applicable), then full. */
	normalizedVariants: string[];
	/** Raw title for tokenization (the token pass tolerates a series prefix via coverage). */
	rawTitle: string;
}

function tokenize(value: string): string[] {
	return foldAccents(value)
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0 && !STOP_WORDS.has(token) && !/^(19|20)\d{2}$/.test(token));
}

function airYear(airDate: string | null | undefined): number | undefined {
	if (!airDate) return undefined;
	const year = parseInt(airDate.slice(0, 4), 10);
	return Number.isNaN(year) ? undefined : year;
}

function yearAgrees(parsedYear: number | undefined, episode: SpecialEpisodeLike): boolean {
	const episodeYear = airYear(episode.airDate);
	if (parsedYear === undefined || episodeYear === undefined) return true;
	return Math.abs(parsedYear - episodeYear) <= MAX_YEAR_DIFFERENCE;
}

function prepareSpecials<T extends SpecialEpisodeLike>(
	episodes: readonly T[],
	seriesTitle: string | null | undefined
): SpecialCandidate<T>[] {
	const seriesNormalized = seriesTitle ? normalizeForEpisodeTitle(seriesTitle) : '';
	const specials: SpecialCandidate<T>[] = [];

	for (const episode of episodes) {
		if (episode.seasonNumber !== 0) continue;

		const full = normalizeForEpisodeTitle(episode.title ?? '');
		if (full.length < MIN_CONTAINMENT_TITLE_LENGTH) continue;

		const variants = [full];
		if (
			seriesNormalized.length >= MIN_CONTAINMENT_TITLE_LENGTH &&
			full.startsWith(seriesNormalized)
		) {
			const stripped = full.slice(seriesNormalized.length);
			if (stripped.length >= MIN_CONTAINMENT_TITLE_LENGTH) {
				variants.unshift(stripped);
			}
		}

		specials.push({ episode, normalizedVariants: variants, rawTitle: episode.title ?? '' });
	}

	return specials;
}

function matchByContainment<T extends SpecialEpisodeLike>(
	specials: SpecialCandidate<T>[],
	candidates: readonly string[]
): SpecialEpisodeTitleMatch<T> | null {
	let best: (SpecialEpisodeTitleMatch<T> & { titleLength: number }) | null = null;

	for (const candidate of candidates) {
		const normalizedCandidate = normalizeForEpisodeTitle(candidate);
		if (normalizedCandidate.length === 0) continue;

		for (const { episode, normalizedVariants } of specials) {
			for (const variant of normalizedVariants) {
				const position = normalizedCandidate.indexOf(variant);
				if (position < 0) continue;

				if (
					!best ||
					position < best.position ||
					(position === best.position && variant.length > best.titleLength)
				) {
					best = {
						episode,
						method: 'containment',
						position,
						coverage: 1,
						candidate,
						titleLength: variant.length
					};
				}
			}
		}
	}

	if (!best) return null;
	const { titleLength: _titleLength, ...match } = best;
	return match;
}

function matchByTokenSubset<T extends SpecialEpisodeLike>(
	specials: SpecialCandidate<T>[],
	candidates: readonly string[],
	parsedYear: number | undefined
): SpecialEpisodeTitleMatch<T> | null {
	let best: SpecialEpisodeTitleMatch<T> | null = null;

	for (const candidate of candidates) {
		const candidateTokens = tokenize(candidate);
		if (candidateTokens.length < MIN_TOKENS) continue;

		for (const { episode, rawTitle } of specials) {
			const episodeTokens = tokenize(rawTitle);
			if (episodeTokens.length < MIN_TOKENS) continue;

			if (!candidateTokens.every((token) => episodeTokens.includes(token))) continue;

			const coverage = candidateTokens.length / episodeTokens.length;
			if (coverage < MIN_TOKEN_COVERAGE) continue;
			if (!yearAgrees(parsedYear, episode)) continue;

			if (!best || coverage > best.coverage) {
				best = {
					episode,
					method: 'tokenSubset',
					position: -1,
					coverage: Math.round(coverage * 100) / 100,
					candidate
				};
			}
		}
	}

	return best;
}

/**
 * Match a title-only TV file against a series' season 0 specials.
 *
 * `candidates` should be the file stem and (when it differs from the series
 * folder) the parent folder name. `parsedYear` (from the release parser) is
 * only used by the token-subset pass to reject stale matches. `seriesTitle`
 * enables the series-prefix strip on episode titles.
 */
export function matchSpecialEpisodeByTitle<T extends SpecialEpisodeLike>(
	episodes: readonly T[],
	candidates: readonly string[],
	parsedYear?: number | null,
	seriesTitle?: string | null
): SpecialEpisodeTitleMatch<T> | null {
	const specials = prepareSpecials(episodes, seriesTitle);
	if (specials.length === 0) return null;

	return (
		matchByContainment(specials, candidates) ??
		matchByTokenSubset(specials, candidates, parsedYear ?? undefined)
	);
}

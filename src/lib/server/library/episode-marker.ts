import { parseRelease } from '#lib/server/indexers/parser/ReleaseParser.js';

/**
 * How a file name identifies its episode.
 *
 * One definition for every caller that needs to know whether a name names an
 * episode: the import filter uses the presence of a marker, the episode
 * resolver uses the parsed numbers.
 */
export type EpisodeMarker =
	| { numbering: 'standard'; seasonNumber: number; episodeNumbers: number[] }
	| { numbering: 'daily'; airDate: string }
	| { numbering: 'absolute'; absoluteEpisode: number };

/**
 * Compact air date (`20261117`), which the release parser documents as daily but
 * only reads when the date is separated (`2026.11.17`, `2026-11-17`).
 */
export function extractCompactAirDate(fileStem: string): string | undefined {
	const match = fileStem.match(/\b(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
	if (!match) {
		return undefined;
	}

	return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Read the episode a file name names, without help from the release title.
 *
 * The release parser is the source of truth: it already knows `SxxExx`, `1x05`,
 * separated daily dates and absolute numbers (`Show - 05`). Two gaps are filled
 * here, both of which used to be private copies in a caller:
 *
 * - pack wording ("Complete Series", "S01-S05") makes the parser report a
 *   season pack before it looks for `SxxExx`, so a single file inside the pack
 *   still names its episode and must be read as one;
 * - compact air dates carry no separator for the parser to anchor on.
 */
export function parseEpisodeMarker(fileStem: string): EpisodeMarker | null {
	const episode = parseRelease(fileStem).episode;

	if (episode?.season !== undefined && episode.episodes && episode.episodes.length > 0) {
		return {
			numbering: 'standard',
			seasonNumber: episode.season,
			episodeNumbers: episode.episodes
		};
	}

	if (episode?.isDaily && episode.airDate) {
		return { numbering: 'daily', airDate: episode.airDate };
	}

	if (episode?.absoluteEpisode !== undefined && episode.absoluteEpisode > 0) {
		return { numbering: 'absolute', absoluteEpisode: episode.absoluteEpisode };
	}

	const standard = extractStandardMarker(fileStem);
	if (standard) {
		return standard;
	}

	const compactAirDate = extractCompactAirDate(fileStem);
	if (compactAirDate) {
		return { numbering: 'daily', airDate: compactAirDate };
	}

	return null;
}

/**
 * `SxxExx` and multi-episode forms (`S01E01E02`, `S01E03-E05`), read directly so
 * pack wording elsewhere in the name cannot hide them.
 */
function extractStandardMarker(fileStem: string): EpisodeMarker | undefined {
	// Two separate SxxExx markers describe a range ("S01E01-S08E99"), not one episode
	const markers = fileStem.match(/\bS\d{1,2}[\s._-]?E\d{1,3}/gi) ?? [];
	if (markers.length !== 1) {
		return undefined;
	}

	const match = fileStem.match(/\bS(\d{1,2})[\s._-]?E(\d{1,3})((?:[\s._-]?E\d{1,3})*)(?!\d)/i);
	if (!match) {
		return undefined;
	}

	let episodeNumbers = [
		parseInt(match[2], 10),
		...[...match[3].matchAll(/E(\d{1,3})/gi)].map((extra) => parseInt(extra[1], 10))
	].filter((episode) => episode > 0);
	if (episodeNumbers.length === 0) {
		return undefined;
	}

	// "S01E03-E05" is a range, same rule as the release parser (up to 20 episodes)
	const [first, last] = episodeNumbers;
	if (
		episodeNumbers.length === 2 &&
		match[3].trimStart().startsWith('-') &&
		last > first &&
		last < first + 20
	) {
		episodeNumbers = Array.from({ length: last - first + 1 }, (_, index) => first + index);
	}

	return {
		numbering: 'standard',
		seasonNumber: parseInt(match[1], 10),
		episodeNumbers: [...new Set(episodeNumbers)]
	};
}

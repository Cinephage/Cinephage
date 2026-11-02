/**
 * Radarr/Sonarr-compatible `parse` response - parses a release title using
 * Cinephage's own ReleaseParser (the same parser used for real grabs), not
 * a separate implementation. Field set confirmed against ParseResource /
 * ParsedMovieInfo in Radarr's actual openapi.json.
 */

import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';

const parser = new ReleaseParser();

export function buildParseResult(title: string): Record<string, unknown> {
	const parsed = parser.parse(title);

	return {
		title,
		parsedMovieInfo: {
			movieTitles: [parsed.cleanTitle],
			originalTitle: parsed.originalTitle,
			releaseTitle: parsed.originalTitle,
			simpleReleaseTitle: parsed.cleanTitle,
			quality: {
				quality: { id: 1, name: parsed.resolution, resolution: 0 },
				revision: { version: 1, real: 0, isRepack: false }
			},
			languages: parsed.languages.map((name, i) => ({ id: i + 1, name })),
			releaseGroup: parsed.releaseGroup ?? null,
			year: parsed.year ?? 0,
			movieTitle: parsed.cleanTitle,
			primaryMovieTitle: parsed.cleanTitle
		},
		languages: parsed.languages.map((name, i) => ({ id: i + 1, name })),
		customFormats: [],
		customFormatScore: 0
	};
}

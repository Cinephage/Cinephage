/**
 * Which MusicBrainz release group a folder is.
 *
 * Kept away from the scanner so the rule can be tested without a database, a
 * filesystem or the MusicBrainz client — and so there is one answer to "is this
 * folder that album?" rather than a scoring heuristic that drifts per call site.
 */

import { normalizeMusicName } from './audio-folder.js';
import type { MusicReleaseGroup } from './types.js';

export interface AlbumCandidate {
	album: string | null;
	artist: string | null;
	year: number | null;
}

/**
 * The one release group a folder may be adopted as, or null.
 *
 * Exact title (accent- and case-insensitive) is the floor: a fuzzy title match
 * is how "Greatest Hits" becomes another artist's compilation. The artist
 * decides between same-titled releases, except for compilations, where the
 * folder says Various Artists and MusicBrainz says the same thing. A tie on
 * year means the folder does not identify one release group, so it is left
 * unmatched rather than guessed at.
 */
export function pickReleaseGroup(
	candidate: AlbumCandidate,
	results: MusicReleaseGroup[]
): MusicReleaseGroup | null {
	const title = normalizeMusicName(candidate.album);
	if (!title) return null;

	const sameTitle = results.filter((group) => normalizeMusicName(group.title) === title);
	if (sameTitle.length === 0) return null;

	const artist = normalizeMusicName(candidate.artist);
	const compilation =
		!artist || artist === 'various artists' || artist === 'va' || artist === 'v a';

	const pool = compilation
		? sameTitle
		: sameTitle.filter((group) => {
				const name = normalizeMusicName(group.artist.name);
				return name === artist || name.includes(artist) || artist.includes(name);
			});
	if (pool.length === 0) return null;

	const ranked = pool
		.map((group) => ({
			group,
			yearDelta:
				candidate.year && group.year
					? Math.abs(candidate.year - group.year)
					: Number.MAX_SAFE_INTEGER
		}))
		.sort((a, b) => a.yearDelta - b.yearDelta);

	// Two different release groups with equally good evidence: refuse the guess.
	if (ranked.length > 1 && ranked[0].yearDelta === ranked[1].yearDelta) return null;

	return ranked[0].group;
}

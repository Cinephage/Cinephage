/**
 * Taking a release for one album, unattended.
 *
 * Extracted from the artist sweep so the album row, the album page and a
 * discography search all apply the same guard. Album search ranks by artist,
 * so a blind "best release" takes whatever else that artist released — the
 * function refuses any release whose title does not carry the album's title
 * tokens. Interactive search may still list those rows; automation may not.
 */

import { createChildLogger } from '#lib/logging/index.js';
import type { AlbumSummary } from '#lib/server/music/MusicAlbumService.js';
import { musicGrabService } from '#lib/server/music/MusicGrabService.js';
import { musicSearchService } from '#lib/server/music/MusicSearchService.js';

const logger = createChildLogger({ module: 'MusicAutoSearch', logDomain: 'system' });

export interface AlbumAutoSearchResult {
	albumId: string;
	title: string;
	grabbed: boolean;
	release?: string;
	size?: number | null;
	error?: string;
}

/** Letters and digits only, lowercased — release titles are punctuation soup. */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** True when every meaningful album-title token appears in the release title. */
export function releaseMatchesAlbum(albumTitle: string, releaseTitle: string): boolean {
	const tokens = normalize(albumTitle)
		.split(' ')
		.filter((token) => token.length > 2);
	if (tokens.length === 0) return false;
	const haystack = normalize(releaseTitle);
	return tokens.every((token) => haystack.includes(token));
}

/** Search the indexers for one album and grab its best accepted release. */
export async function autoSearchAlbum(album: Pick<AlbumSummary, 'id' | 'title'>): Promise<AlbumAutoSearchResult> {
	try {
		const search = await musicSearchService.searchForAlbum(album.id);
		const best = search.candidates.find(
			(candidate) =>
				candidate.accepted !== false &&
				Boolean(candidate.guid) &&
				releaseMatchesAlbum(album.title, candidate.title)
		);
		if (!best?.guid) {
			return { albumId: album.id, title: album.title, grabbed: false, error: 'no accepted release' };
		}
		const grab = await musicGrabService.grabAlbum(album.id, { releaseGuid: best.guid });
		return {
			albumId: album.id,
			title: album.title,
			grabbed: true,
			release: grab.title,
			size: grab.size
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn({ albumId: album.id, err: message }, '[MusicAutoSearch] album search failed');
		return { albumId: album.id, title: album.title, grabbed: false, error: message };
	}
}

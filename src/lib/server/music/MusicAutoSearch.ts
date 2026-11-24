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
	/** Candidates the release search returned, for the Searches tab. */
	releasesFound?: number;
	error?: string;
	/** `no-results` is a normal empty search; `error` is a failed run. */
	errorKind?: 'no-results' | 'error';
}

/** Letters and digits only, lowercased — release titles are punctuation soup. */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** True when every meaningful album-title token appears in the release title. */
export function releaseMatchesAlbum(
	albumTitle: string,
	releaseTitle: string,
	artistName?: string
): boolean {
	const tokens = normalize(albumTitle)
		.split(' ')
		.filter((token) => token.length >= 2);
	if (tokens.length === 0) return false;
	const haystack = new Set(normalize(releaseTitle).split(' '));
	if (!tokens.every((token) => haystack.has(token))) return false;
	if (artistName) {
		const artistTokens = normalize(artistName)
			.split(' ')
			.filter((token) => token.length >= 3);
		if (artistTokens.length > 0 && !artistTokens.some((token) => haystack.has(token))) return false;
	}
	return true;
}

/** Search the indexers for one album and grab its best accepted release. */
export async function autoSearchAlbum(
	album: Pick<AlbumSummary, 'id' | 'title' | 'artistName'>
): Promise<AlbumAutoSearchResult> {
	try {
		const search = await musicSearchService.searchForAlbum(album.id);
		const best = search.candidates.find(
			(candidate) =>
				candidate.accepted !== false &&
				Boolean(candidate.guid) &&
				releaseMatchesAlbum(album.title, candidate.title, album.artistName)
		);
		if (!best?.guid) {
			return {
				albumId: album.id,
				title: album.title,
				grabbed: false,
				releasesFound: search.candidates.length,
				error: 'no accepted release',
				errorKind: 'no-results'
			};
		}
		const grab = await musicGrabService.grabAlbum(album.id, { candidate: best });
		return {
			albumId: album.id,
			title: album.title,
			grabbed: true,
			release: grab.title,
			size: grab.size,
			releasesFound: search.candidates.length
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn({ albumId: album.id, err: message }, '[MusicAutoSearch] album search failed');
		return {
			albumId: album.id,
			title: album.title,
			grabbed: false,
			releasesFound: 0,
			error: message,
			errorKind: 'error'
		};
	}
}

/**
 * Search a batch of just-added albums, one at a time.
 *
 * A discography add writes up to 25 albums per call and must not hold the
 * request open while indexers answer, so callers fire this and forget. One
 * album's failure is logged and the batch continues — a dead indexer should
 * not leave the rest of a discography unsearched.
 */
export async function searchAddedAlbums(
	albums: Array<Pick<AlbumSummary, 'id' | 'title' | 'artistName'>>
): Promise<void> {
	for (const album of albums) {
		try {
			const result = await autoSearchAlbum(album);
			logger.info(
				{
					albumId: album.id,
					title: album.title,
					grabbed: result.grabbed,
					release: result.release,
					releasesFound: result.releasesFound,
					error: result.error
				},
				'[MusicAutoSearch] search on add'
			);
		} catch (err) {
			logger.warn(
				{ albumId: album.id, err: err instanceof Error ? err.message : String(err) },
				'[MusicAutoSearch] search on add failed'
			);
		}
	}
}

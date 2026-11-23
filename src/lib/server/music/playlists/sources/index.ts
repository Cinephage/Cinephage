/**
 * The playlist provider registry.
 *
 * Adding a provider is one adapter file and one entry here; nothing above this
 * module knows provider names. Order matters only for the error message when
 * no adapter claims a URL.
 */
import { PlaylistError } from '../errors.js';
import type { PlaylistProviderId, PlaylistSource } from '../types.js';
import { deezerSource } from './deezer.js';
import { spotifySource } from './spotify.js';
import { youtubeSource } from './youtube.js';

export const PLAYLIST_SOURCES: readonly PlaylistSource[] = [
	youtubeSource,
	spotifySource,
	deezerSource
];

export function sourceForProvider(id: PlaylistProviderId): PlaylistSource | null {
	return PLAYLIST_SOURCES.find((source) => source.id === id) ?? null;
}

/**
 * Parse pasted input into a URL. People paste `open.spotify.com/playlist/…`
 * as often as the full URL, and a bare string is not a URL constructor input.
 */
export function normalizePlaylistInput(input: string): URL {
	const trimmed = input.trim();
	if (!trimmed) throw new PlaylistError('Paste a playlist URL', 400);
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new PlaylistError('That is not a URL', 400);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new PlaylistError('Only http(s) playlist URLs are supported', 400);
	}
	return url;
}

/**
 * Which adapter owns this URL, and the provider's playlist id.
 * A URL no adapter claims is a user mistake, not a server fault, so it is a 400.
 */
export function resolveSource(input: string): { source: PlaylistSource; id: string; url: URL } {
	const url = normalizePlaylistInput(input);
	for (const source of PLAYLIST_SOURCES) {
		const id = source.parseUrl(url);
		if (id) return { source, id, url };
	}
	throw new PlaylistError(
		'Unsupported playlist link — paste a YouTube, Spotify, or Deezer playlist URL',
		400
	);
}

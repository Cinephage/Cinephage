/**
 * Spotify playlists, read from the public embed page.
 *
 * The official Web API needs a client id/secret that a self-hosted install
 * would have to be given; the embed page publishes the same track list for any
 * public playlist with no credentials at all. It is a page shape, not an API,
 * so it lives behind this one adapter: if Spotify changes it, only this file
 * changes, and `parseUrl` already refuses anything that is not a playlist.
 */
import { PlaylistError } from '../errors.js';
import type { PlaylistPage, PlaylistSource, PlaylistTrack } from '../types.js';

const EMBED_URL = 'https://open.spotify.com/embed/playlist';
const TIMEOUT_MS = 20_000;
/** What a desktop browser sends; Spotify's edge answers 403 to a bare fetch. */
const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

interface EmbedTrack {
	title?: string;
	subtitle?: string;
	duration?: number;
	uri?: string;
}

interface EmbedEntity {
	title?: string;
	subtitle?: string;
	trackList?: EmbedTrack[];
	coverArt?: { sources?: Array<{ url?: string }> };
}

export function spotifyPlaylistId(url: URL): string | null {
	const host = url.hostname.replace(/^www\./, '');
	if (host !== 'open.spotify.com') return null;
	// Localised paths (/intl-de/playlist/<id>) are the same playlist.
	const match = url.pathname.match(/\/playlist\/([A-Za-z0-9]{16,})/);
	return match ? match[1] : null;
}

function readNextData(html: string): EmbedEntity | null {
	const match = html.match(
		/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
	);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[1]) as {
			props?: { pageProps?: { state?: { data?: { entity?: EmbedEntity } } } };
		};
		return parsed.props?.pageProps?.state?.data?.entity ?? null;
	} catch {
		return null;
	}
}

/** The embed's subtitle is a comma-joined artist credit. */
function splitArtists(subtitle: string | undefined): string[] {
	if (!subtitle) return [];
	return subtitle
		.split(/\s*,\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
}

export const spotifySource: PlaylistSource = {
	id: 'spotify',
	label: 'Spotify',
	parseUrl: spotifyPlaylistId,

	async fetchPlaylist(url, { limit }): Promise<PlaylistPage> {
		const id = spotifyPlaylistId(url);
		if (!id) throw new PlaylistError('Not a Spotify playlist URL', 400);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		let html: string;
		try {
			const response = await fetch(`${EMBED_URL}/${id}`, {
				signal: controller.signal,
				headers: { 'user-agent': USER_AGENT, accept: 'text/html' }
			});
			if (response.status === 404) {
				throw new PlaylistError('Spotify could not find that playlist', 422);
			}
			if (!response.ok) throw new PlaylistError(`Spotify answered ${response.status}`, 502);
			html = await response.text();
		} catch (err) {
			if (err instanceof PlaylistError) throw err;
			throw new PlaylistError(
				`Spotify request failed: ${err instanceof Error ? err.message : String(err)}`,
				502
			);
		} finally {
			clearTimeout(timer);
		}

		const entity = readNextData(html);
		if (!entity || !Array.isArray(entity.trackList)) {
			throw new PlaylistError('Spotify did not return a readable playlist', 502);
		}

		const declared = entity.trackList.length;
		const tracks: PlaylistTrack[] = entity.trackList.slice(0, limit).flatMap((entry) => {
			if (!entry.title) return [];
			return [
				{
					title: entry.title,
					artists: splitArtists(entry.subtitle),
					album: null,
					year: null,
					durationMs: typeof entry.duration === 'number' ? entry.duration : null,
					isrc: null
				}
			];
		});

		if (tracks.length === 0) {
			throw new PlaylistError('That playlist is empty or private', 422);
		}

		return {
			playlist: {
				provider: 'spotify',
				id,
				url: url.toString(),
				title: entity.title?.trim() || 'Spotify playlist',
				description: null,
				owner: entity.subtitle?.trim() || null,
				coverUrl: entity.coverArt?.sources?.[0]?.url ?? null,
				trackCount: declared
				// The embed publishes 100 tracks; a longer playlist is imported
				// as its first page and the UI says so.
			},
			tracks,
			truncated: declared > tracks.length
		};
	}
};

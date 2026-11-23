/**
 * Deezer playlists, through the public API.
 *
 * Keyless, already the source of the Discover music charts, and the only
 * provider that hands back the *album* for every track — which turns a whole
 * playlist into one MusicBrainz lookup per album instead of one per song.
 */
import { PlaylistError } from '../errors.js';
import type { PlaylistPage, PlaylistSource, PlaylistTrack } from '../types.js';

const API = 'https://api.deezer.com';
const PAGE_SIZE = 100;
const TIMEOUT_MS = 20_000;

interface DeezerArtist {
	name?: string;
}

interface DeezerAlbum {
	title?: string;
}

interface DeezerTrack {
	title?: string;
	duration?: number;
	isrc?: string;
	artist?: DeezerArtist;
	album?: DeezerAlbum;
}

interface DeezerPlaylist {
	id?: number;
	title?: string;
	description?: string;
	creator?: { name?: string };
	picture_xl?: string;
	nb_tracks?: number;
	error?: { type?: string; message?: string; code?: number };
}

interface DeezerTrackPage {
	data?: DeezerTrack[];
	total?: number;
	error?: DeezerPlaylist['error'];
}

async function getJson<T>(url: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { accept: 'application/json' }
		});
		if (!response.ok) {
			throw new PlaylistError(`Deezer answered ${response.status}`, 502);
		}
		return (await response.json()) as T;
	} catch (err) {
		if (err instanceof PlaylistError) throw err;
		throw new PlaylistError(
			`Deezer request failed: ${err instanceof Error ? err.message : String(err)}`,
			502
		);
	} finally {
		clearTimeout(timer);
	}
}

function deezerPlaylistId(url: URL): string | null {
	const host = url.hostname.replace(/^www\./, '');
	if (host !== 'deezer.com' && host !== 'api.deezer.com') {
		// Localised paths (deezer.com/en/playlist/123) keep the same host rule.
		if (!host.endsWith('.deezer.com')) return null;
	}
	const match = url.pathname.match(/\/playlist\/(\d+)/);
	return match ? match[1] : null;
}

function toTrack(track: DeezerTrack): PlaylistTrack | null {
	if (!track.title) return null;
	return {
		title: track.title,
		artists: track.artist?.name ? [track.artist.name] : [],
		album: track.album?.title ?? null,
		year: null,
		durationMs: typeof track.duration === 'number' ? track.duration * 1000 : null,
		isrc: track.isrc ?? null
	};
}

export const deezerSource: PlaylistSource = {
	id: 'deezer',
	label: 'Deezer',
	parseUrl: deezerPlaylistId,

	async fetchPlaylist(url, { limit }): Promise<PlaylistPage> {
		const id = deezerPlaylistId(url);
		if (!id) throw new PlaylistError('Not a Deezer playlist URL', 400);

		const playlist = await getJson<DeezerPlaylist>(`${API}/playlist/${id}`);
		if (playlist.error || !playlist.id) {
			throw new PlaylistError(
				playlist.error?.message ?? 'Deezer could not find that playlist',
				422
			);
		}

		const tracks: PlaylistTrack[] = [];
		let index = 0;
		let declared = playlist.nb_tracks ?? 0;

		// The playlist object carries one page of tracks; a full paste needs the
		// paged endpoint. Stop at `limit` or the declared count, whichever is
		// smaller, and never loop forever on a bad `total`.
		while (tracks.length < limit) {
			const page = await getJson<DeezerTrackPage>(
				`${API}/playlist/${id}/tracks?limit=${PAGE_SIZE}&index=${index}`
			);
			if (page.error) {
				throw new PlaylistError(page.error.message ?? 'Deezer track listing failed', 502);
			}
			const data = page.data ?? [];
			if (data.length === 0) break;
			if (typeof page.total === 'number') declared = page.total;
			for (const track of data) {
				const mapped = toTrack(track);
				if (mapped) tracks.push(mapped);
				if (tracks.length >= limit) break;
			}
			index += data.length;
			if (declared > 0 && index >= declared) break;
		}

		if (tracks.length === 0) {
			throw new PlaylistError('That playlist is empty or private', 422);
		}

		return {
			playlist: {
				provider: 'deezer',
				id,
				url: url.toString(),
				title: playlist.title?.trim() || 'Deezer playlist',
				description: playlist.description?.trim() || null,
				owner: playlist.creator?.name ?? null,
				coverUrl: playlist.picture_xl ?? null,
				trackCount: Math.max(declared, tracks.length)
			},
			tracks,
			truncated: declared > tracks.length
		};
	}
};

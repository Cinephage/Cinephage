/**
 * The music landing: charts as shelves, not one flat grid of 24 covers.
 *
 * Deezer's chart answers albums, artists and tracks in a single request, so a
 * landing costs one upstream call per selected genre however many shelves it
 * shows. Genres merge rather than replace: picking two genres is two cached
 * chart requests, deduplicated by provider id.
 */

import {
	deezer,
	pickImage,
	type DeezerAlbum,
	type DeezerApi,
	type DeezerArtist,
	type DeezerChart,
	type DeezerGenre,
	type DeezerTrack
} from './deezerApi.js';
import type { MusicRowItem } from '#lib/components/discover/music-row-item.js';
import { mergeById } from './rows.js';

/** Shelf identity, not a label: the page translates it. */
export type MusicShelfId = 'topAlbums' | 'topArtists' | 'topTracks';

export interface MusicShelf {
	id: MusicShelfId;
	rows: MusicRowItem[];
}

export interface MusicLanding {
	shelves: MusicShelf[];
	/** The chart genre list, offered as the Music tab's facet options. */
	genres: { id: number; name: string }[];
	/** Set only when exactly one genre is selected, so a heading can name it. */
	activeGenreName: string | null;
}

const ALBUM_SHELF_ROWS = 24;
const ARTIST_SHELF_ROWS = 12;
const TRACK_SHELF_ROWS = 12;

function albumRows(albums: DeezerAlbum[]): MusicRowItem[] {
	return albums.slice(0, ALBUM_SHELF_ROWS).map((album) => ({
		id: `deezer-album-${album.id}`,
		title: album.title,
		subtitle: album.artist?.name ?? null,
		image_url: pickImage(album.cover_big, album.cover_medium, album.cover_small),
		media_type: 'music' as const,
		mbid: null,
		musicKind: 'album' as const,
		album_title: album.title,
		deezerId: album.id,
		deezerAlbumId: album.id
	}));
}

function artistRows(artists: DeezerArtist[]): MusicRowItem[] {
	return artists.slice(0, ARTIST_SHELF_ROWS).map((artist) => ({
		id: `deezer-artist-${artist.id}`,
		title: artist.name,
		subtitle: null,
		image_url: pickImage(artist.picture_big, artist.picture_medium, artist.picture_small),
		media_type: 'music' as const,
		mbid: null,
		musicKind: 'artist' as const,
		album_title: null,
		deezerId: artist.id,
		deezerAlbumId: null
	}));
}

function trackRows(tracks: DeezerTrack[]): MusicRowItem[] {
	return tracks.slice(0, TRACK_SHELF_ROWS).map((track) => ({
		id: `deezer-track-${track.id}`,
		title: track.title,
		subtitle: track.artist?.name ?? null,
		image_url: pickImage(
			track.album?.cover_big,
			track.album?.cover_medium,
			track.album?.cover_small
		),
		media_type: 'music' as const,
		mbid: null,
		musicKind: 'song' as const,
		album_title: track.album?.title ?? null,
		deezerId: track.id,
		deezerAlbumId: track.album?.id ?? null
	}));
}

/**
 * The chart genre list on its own. The landing already carries it; this is for
 * the cold-failure path, where the shelves are gone but the panel still needs
 * something to offer.
 */
export async function musicGenreOptions(api: DeezerApi = deezer): Promise<
	{ id: number; name: string }[]
> {
	const genres: DeezerGenre[] = await api.genres().catch(() => []);
	return genres.map((genre) => ({ id: genre.id, name: genre.name }));
}

/**
 * `null` when Deezer is unreachable — the caller keeps the page it has rather
 * than rendering an empty landing over a working chart.
 */
export async function musicLanding(
	genreIds: number[] = [],
	api: DeezerApi = deezer
): Promise<MusicLanding | null> {
	const requests =
		genreIds.length > 0 ? genreIds.map((genreId) => api.chart({ genreId })) : [api.chart({})];
	const charts = (await Promise.all(requests)).filter(
		(chart): chart is DeezerChart => chart !== null
	);
	if (charts.length === 0) return null;

	// `deezer.genres()` carries its own 24 h cache; a second one here would only
	// be a copy that can go stale on its own clock.
	const genres: DeezerGenre[] = await api.genres();

	const shelves: MusicShelf[] = [
		{ id: 'topAlbums', rows: albumRows(mergeById(charts.map((c) => c.albums?.data ?? []))) },
		{ id: 'topArtists', rows: artistRows(mergeById(charts.map((c) => c.artists?.data ?? []))) },
		{ id: 'topTracks', rows: trackRows(mergeById(charts.map((c) => c.tracks?.data ?? []))) }
	];

	return {
		shelves: shelves.filter((shelf) => shelf.rows.length > 0),
		genres: genres.map((genre) => ({ id: genre.id, name: genre.name })),
		activeGenreName:
			genreIds.length === 1
				? (genres.find((genre) => genre.id === genreIds[0])?.name ?? null)
				: null
	};
}

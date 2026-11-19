/**
 * The music landing: charts as shelves, not one flat grid of 24 covers.
 *
 * Deezer's chart answers albums, artists and tracks in a single request, so
 * the landing costs one upstream call however many shelves it shows. A genre
 * is the same request with a genre id — the chips are a view over the chart,
 * not a second code path.
 */

import { deezer, pickImage, type DeezerChart, type DeezerGenre } from './deezerApi.js';
import type { MusicRowItem } from '#lib/components/discover/music-row-item.js';

/** Shelf identity, not a label: the page translates it. */
export type MusicShelfId = 'topAlbums' | 'topArtists' | 'topTracks';

export interface MusicShelf {
	id: MusicShelfId;
	rows: MusicRowItem[];
}

export interface MusicGenreChip {
	id: number;
	name: string;
	picture: string | null;
}

export interface MusicLanding {
	shelves: MusicShelf[];
	genres: MusicGenreChip[];
	activeGenreId: number | null;
	/** The active genre's name, so a shelf heading can say which chart it is. */
	activeGenreName: string | null;
}

const ALBUM_SHELF_ROWS = 24;
const ARTIST_SHELF_ROWS = 12;
const TRACK_SHELF_ROWS = 12;
const GENRE_CHIP_LIMIT = 12;

function albumRows(chart: DeezerChart): MusicRowItem[] {
	return (chart.albums?.data ?? []).slice(0, ALBUM_SHELF_ROWS).map((album) => ({
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

function artistRows(chart: DeezerChart): MusicRowItem[] {
	return (chart.artists?.data ?? []).slice(0, ARTIST_SHELF_ROWS).map((artist) => ({
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

function trackRows(chart: DeezerChart): MusicRowItem[] {
	return (chart.tracks?.data ?? []).slice(0, TRACK_SHELF_ROWS).map((track) => ({
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

function genreChips(genres: DeezerGenre[]): MusicGenreChip[] {
	return genres.slice(0, GENRE_CHIP_LIMIT).map((genre) => ({
		id: genre.id,
		name: genre.name,
		picture: pickImage(genre.picture_medium, genre.picture_small)
	}));
}

/**
 * `null` when Deezer is unreachable — the caller keeps the page it has rather
 * than rendering an empty landing over a working chart.
 */
export async function musicLanding(genreId?: number): Promise<MusicLanding | null> {
	const chart = await deezer.chart(genreId ? { genreId } : {});
	if (!chart) return null;

	// `deezer.genres()` carries its own 24 h cache; a second one here would only
	// be a copy that can go stale on its own clock.
	const genres = await deezer.genres();
	const activeGenre = genreId ? (genres.find((genre) => genre.id === genreId) ?? null) : null;

	const shelves: MusicShelf[] = [
		{ id: 'topAlbums', rows: albumRows(chart) },
		{ id: 'topArtists', rows: artistRows(chart) },
		{ id: 'topTracks', rows: trackRows(chart) }
	];

	return {
		shelves: shelves.filter((shelf) => shelf.rows.length > 0),
		genres: genreChips(genres),
		activeGenreId: activeGenre?.id ?? null,
		activeGenreName: activeGenre?.name ?? null
	};
}

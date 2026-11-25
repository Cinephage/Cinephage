import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicArtistService } from '#lib/server/music/MusicArtistService.js';
import { musicTrackService } from '#lib/server/music/MusicTrackService.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';
import { deriveFeaturedArtists } from '#lib/components/music/music-card.js';

/**
 * One artist's shelf: the artist row, its albums and the songs inside them.
 *
 * The artist is a library entity here, not a MusicBrainz lookup — this page is
 * reached from the library grid, and a slow upstream must never stand between
 * the owner and their own records. Albums carry their tracklists so the page
 * can expand one in place, the way a series page expands a season.
 */
export const load: PageServerLoad = async ({ params }) => {
	let artist = musicArtistService.getArtist(params.id);
	if (!artist) error(404, 'Artist not found');

	// Type, country and genres are MusicBrainz fields the row is created
	// without. Fill them once, but never let a slow upstream hold the page: the
	// lookup gets a bounded wait and the page renders from what is stored.
	if (artist.mbid && (!artist.artistType || (artist.genres?.length ?? 0) === 0)) {
		await Promise.race([
			musicArtistService.ensureMetadata(artist.id, artist.mbid).catch(() => undefined),
			new Promise((resolve) => setTimeout(resolve, 1500))
		]);
		artist = musicArtistService.getArtist(params.id) ?? artist;
	}

	const albums = musicAlbumService.listAlbums({ artistId: artist.id });
	const songs = musicTrackService.listTracks({ artistId: artist.id });
	const byAlbum = new Map<string, typeof songs>();
	for (const song of songs) {
		byAlbum.set(song.albumId, [...(byAlbum.get(song.albumId) ?? []), song]);
	}

	return {
		artist,
		qualityProfiles: musicProfileService.list().map((profile) => ({
			id: profile.id,
			name: profile.name
		})),
		defaultProfileName: musicProfileService.getDefault()?.name ?? null,
		albums: albums.map((album) => ({ ...album, tracks: byAlbum.get(album.id) ?? [] })),
		songs,
		featured: deriveFeaturedArtists(
			songs.map((song) => song.artistCredit),
			artist.name
		),
		counts: {
			albums: albums.length,
			inLibrary: albums.filter((album) => album.hasFile).length,
			songs: songs.length,
			songsWithFile: songs.filter((song) => song.hasFile).length
		}
	};
};

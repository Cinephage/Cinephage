import { describe, expect, it } from 'vitest';
import { albumPageHref, artistPageHref, deezerPrimaryType, mapDeezerAlbum } from './detail.js';
import type { DeezerAlbum } from '#lib/server/catalog/deezerApi.js';

const album: DeezerAlbum = {
	id: 6575789,
	title: 'Random Access Memories',
	upc: '886443927087',
	label: 'Columbia',
	release_date: '2013-05-17',
	record_type: 'album',
	nb_tracks: 2,
	duration: 540,
	cover_big: 'https://x/ram-500.jpg',
	artist: { id: 27, name: 'Daft Punk' },
	contributors: [
		{ id: 27, name: 'Daft Punk', role: 'Main' },
		{ id: 99, name: 'Pharrell Williams', role: 'Featured' }
	],
	tracks: {
		data: [
			{
				id: 1,
				title: 'Give Life Back to Music',
				artist: { name: 'Daft Punk' },
				duration: 276,
				track_position: 1,
				disk_number: 1
			},
			{
				id: 2,
				title: 'Get Lucky',
				artist: { name: 'Daft Punk' },
				duration: 264,
				track_position: 8
			}
		]
	}
};

describe('music detail pages', () => {
	it('maps a Deezer album onto the album page shape', () => {
		const page = mapDeezerAlbum(album, null);

		expect(page.provider).toBe('deezer');
		expect(page.group).toMatchObject({
			mbid: null,
			deezerId: 6575789,
			title: 'Random Access Memories',
			primaryType: 'Album',
			year: 2013,
			artist: { mbid: null, deezerId: 27, name: 'Daft Punk' }
		});
		expect(page.release?.labelName).toBe('Columbia');
		expect(page.release?.barcode).toBe('886443927087');
		expect(page.release?.trackCount).toBe(2);
		expect(page.release?.tracks.map((track) => track.title)).toEqual([
			'Give Life Back to Music',
			'Get Lucky'
		]);
		// The album artist is not a featured credit.
		expect(page.featured).toEqual(['Pharrell Williams']);
		expect(page.artworkUrl).toBe('https://x/ram-500.jpg');
		expect(page.libraryAlbumId).toBeNull();
	});

	it('falls back to the summed track runtime when the album omits one', () => {
		const page = mapDeezerAlbum({ ...album, duration: undefined }, 'album-1');
		expect(page.release?.duration).toBe(540);
		expect(page.libraryAlbumId).toBe('album-1');
	});

	it('reads Deezer record types into the MusicBrainz vocabulary the cards use', () => {
		expect(deezerPrimaryType({ id: 1, title: 'x', record_type: 'album' })).toBe('Album');
		expect(deezerPrimaryType({ id: 1, title: 'x', record_type: 'single' })).toBe('Single');
		expect(deezerPrimaryType({ id: 1, title: 'x', record_type: 'ep' })).toBe('EP');
		expect(deezerPrimaryType({ id: 1, title: 'x', record_type: 'compile' })).toBe('Compilation');
	});

	it('links a row to the page its provider can answer', () => {
		expect(albumPageHref({ mbid: 'mbid-1' })).toBe('/discover/music/mbid-1');
		expect(albumPageHref({ mbid: null, deezerId: 42 })).toBe('/discover/music/deezer-album-42');
		expect(albumPageHref({})).toBeNull();
		expect(artistPageHref({ mbid: 'mbid-1' })).toBe('/discover/music/artist/mbid-1');
		expect(artistPageHref({ mbid: null, deezerId: 42 })).toBe(
			'/discover/music/artist/deezer-artist-42'
		);
		expect(artistPageHref({})).toBeNull();
	});
});

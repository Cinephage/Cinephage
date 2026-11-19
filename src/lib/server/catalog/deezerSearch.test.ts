import { describe, expect, it, vi } from 'vitest';
import { createDeezerSearch, mergeMusicRows, titleRelevance } from './deezerSearch.js';

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});

describe('deezer music search', () => {
	it('asks for artists, albums and songs at once and maps all three to Discover rows', async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/search/artist')) {
				return json({
					data: [
						{
							id: 27,
							name: 'Daft Punk',
							picture_big: 'https://x/artist.jpg',
							nb_album: 38,
							nb_fan: 5_240_209
						}
					]
				});
			}
			if (url.includes('/search/track')) {
				return json({
					data: [
						{
							id: 3135556,
							title: 'One More Time',
							artist: { name: 'Daft Punk' },
							album: { id: 302127, title: 'Discovery', cover_big: 'https://x/album.jpg' }
						}
					]
				});
			}
			return json({
				data: [
					{
						id: 302127,
						title: 'Discovery',
						cover_big: 'https://x/album.jpg',
						release_date: '2001-03-07',
						artist: { name: 'Daft Punk' }
					}
				]
			});
		});
		const search = createDeezerSearch({ fetchImpl });
		const rows = await search('daft punk');

		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({
			id: 'deezer-artist-27',
			title: 'Daft Punk',
			musicKind: 'artist',
			imageUrl: 'https://x/artist.jpg',
			mbid: null,
			deezerId: 27
		});
		expect(rows[1]).toMatchObject({
			id: 'deezer-album-302127',
			title: 'Discovery',
			subtitle: 'Daft Punk',
			year: 2001,
			musicKind: 'album',
			imageUrl: 'https://x/album.jpg',
			deezerId: 302127,
			deezerAlbumId: 302127
		});
		expect(rows[2]).toMatchObject({
			id: 'deezer-track-3135556',
			title: 'One More Time',
			subtitle: 'Daft Punk',
			musicKind: 'song',
			albumTitle: 'Discovery',
			deezerAlbumId: 302127
		});
	});

	it('drops empty artist profiles and puts the artist whose name matches first', () => {
		const rows = mergeMusicRows(
			[
				{ id: 1477045, name: 'Daft Punk - Stardust', nb_album: 0, nb_fan: 8620 },
				{ id: 412557421, name: 'Daft Punk', nb_album: 0, nb_fan: 0 },
				{ id: 27, name: 'Daft Punk', nb_album: 38, nb_fan: 5_240_209 },
				{ id: 176017197, name: 'Daft Punk Experience', nb_album: 1, nb_fan: 64 }
			],
			[
				{
					id: 6575789,
					title: 'Random Access Memories',
					artist: { name: 'Daft Punk' },
					release_date: '2013-05-17'
				}
			],
			[
				{
					id: 3135553,
					title: 'One More Time',
					artist: { name: 'Daft Punk' },
					rank: 896_666,
					album: { id: 302127, title: 'Discovery' }
				}
			],
			'daft punk'
		);

		// The real profile leads, the tribute acts with no releases are gone, and
		// the album lands above the song.
		expect(rows.map((row) => row.title)).toEqual([
			'Daft Punk',
			'Random Access Memories',
			'Daft Punk Experience',
			'One More Time'
		]);
		expect(rows.filter((row) => row.musicKind === 'artist')).toHaveLength(2);
	});

	it('keeps album art when Deezer returns an empty string for the big size', () => {
		const rows = mergeMusicRows(
			[],
			[
				{
					id: 1,
					title: 'Blonde',
					cover_big: '',
					cover_medium: 'https://x/blonde-250.jpg',
					artist: { name: 'Frank Ocean' }
				},
				{
					id: 2,
					title: 'Endless',
					cover_big: '',
					cover_medium: '',
					artist: { name: 'Frank Ocean' }
				}
			],
			[],
			'blonde'
		);

		expect(rows[0].imageUrl).toBe('https://x/blonde-250.jpg');
		expect(rows[1].imageUrl).toBeNull();
	});

	it('scores an exact title above a prefix and a loose mention', () => {
		expect(titleRelevance('Blonde', 'blonde')).toBe(100);
		expect(titleRelevance('Blonde (Deluxe)', 'blonde')).toBe(80);
		expect(titleRelevance('Channel Orange', 'blonde')).toBe(0);
		expect(titleRelevance('Blonde', 'blonde frank ocean')).toBeGreaterThan(0);
		expect(titleRelevance('Beyoncé', 'BEYONCE')).toBe(100);
	});

	it('caps how many rows each kind contributes', () => {
		const artists = Array.from({ length: 8 }, (_, i) => ({
			id: i + 1,
			name: `Artist ${i + 1}`,
			nb_album: 3,
			nb_fan: 1000 - i
		}));
		const albums = Array.from({ length: 20 }, (_, i) => ({
			id: 100 + i,
			title: `Album ${i + 1}`,
			artist: { name: `Artist ${i + 1}` }
		}));
		const tracks = Array.from({ length: 20 }, (_, i) => ({
			id: 200 + i,
			title: `Song ${i + 1}`,
			artist: { name: `Artist ${i + 1}` }
		}));

		const rows = mergeMusicRows(artists, albums, tracks, 'artist');
		const count = (kind: string) => rows.filter((row) => row.musicKind === kind).length;
		expect(count('artist')).toBeLessThanOrEqual(2);
		expect(count('album')).toBeLessThanOrEqual(12);
		expect(count('song')).toBeLessThanOrEqual(8);
	});

	it('memoises a query for its TTL and expires it after', async () => {
		let clock = 1_000;
		const fetchImpl = vi.fn(async () => json({ data: [] }));
		const search = createDeezerSearch({ fetchImpl, now: () => clock });

		await search('ecco2k');
		await search('ECCO2K');
		expect(fetchImpl).toHaveBeenCalledTimes(3); // artist, album and song legs

		clock += 10 * 60 * 1000 + 1;
		await search('ecco2k');
		expect(fetchImpl).toHaveBeenCalledTimes(6);
	});

	it('returns nothing for an empty query without calling upstream', async () => {
		const fetchImpl = vi.fn(async () => json({ data: [] }));
		const search = createDeezerSearch({ fetchImpl });
		expect(await search('   ')).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('survives one leg failing', async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/artist')) throw new Error('deezer down');
			return json({
				data: [{ id: 1, title: 'Homework', artist: { name: 'Daft Punk' } }]
			});
		});
		const rows = await createDeezerSearch({ fetchImpl })('daft punk');
		expect(rows.filter((row) => row.musicKind === 'album')).toHaveLength(1);
		expect(rows.some((row) => row.musicKind === 'artist')).toBe(false);
	});
});

import { describe, expect, it, vi } from 'vitest';
import { createDeezerSearch } from './deezerSearch.js';

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
					data: [{ id: 27, name: 'Daft Punk', picture_big: 'https://x/artist.jpg' }]
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
			mbid: null
		});
		expect(rows[1]).toMatchObject({
			id: 'deezer-album-302127',
			title: 'Discovery',
			subtitle: 'Daft Punk',
			year: 2001,
			musicKind: 'album',
			imageUrl: 'https://x/album.jpg'
		});
		expect(rows[2]).toMatchObject({
			id: 'deezer-track-3135556',
			title: 'One More Time',
			subtitle: 'Daft Punk',
			musicKind: 'song',
			albumTitle: 'Discovery'
		});
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
			return json({ data: [{ id: 1, title: 'Homework', artist: { name: 'Daft Punk' } }] });
		});
		const rows = await createDeezerSearch({ fetchImpl })('daft punk');
		expect(rows.filter((row) => row.musicKind === 'album')).toHaveLength(1);
		expect(rows.some((row) => row.musicKind === 'artist')).toBe(false);
	});
});

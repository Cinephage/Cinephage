import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchForAlbum = vi.hoisted(() => vi.fn());
const grabAlbum = vi.hoisted(() => vi.fn());

vi.mock('./MusicSearchService.js', () => ({ musicSearchService: { searchForAlbum } }));
vi.mock('./MusicGrabService.js', () => ({ musicGrabService: { grabAlbum } }));

const { searchAddedAlbums } = await import('./MusicAutoSearch.js');

const ALBUM = { id: 'album-1', title: 'Discovery', artistName: 'Daft Punk' };

function candidate(title: string) {
	return { title, guid: `guid-${title}`, accepted: true, protocol: 'torrent' };
}

beforeEach(() => {
	searchForAlbum.mockReset();
	grabAlbum.mockReset();
	grabAlbum.mockResolvedValue({ title: 'grabbed', size: 1 });
});

describe('searchAddedAlbums', () => {
	it('searches each added album and grabs the release that carries its title', async () => {
		searchForAlbum
			.mockResolvedValueOnce({ candidates: [candidate('Daft Punk - Discovery FLAC')] })
			.mockResolvedValueOnce({ candidates: [candidate('Daft Punk - Homework FLAC')] });

		await searchAddedAlbums([
			{ ...ALBUM },
			{ id: 'album-2', title: 'Homework', artistName: 'Daft Punk' }
		]);

		expect(searchForAlbum).toHaveBeenCalledTimes(2);
		expect(grabAlbum).toHaveBeenCalledTimes(2);
	});

	it('keeps going when one album fails', async () => {
		searchForAlbum
			.mockRejectedValueOnce(new Error('indexer down'))
			.mockResolvedValueOnce({ candidates: [candidate('Daft Punk - Homework FLAC')] });

		await searchAddedAlbums([
			{ ...ALBUM },
			{ id: 'album-2', title: 'Homework', artistName: 'Daft Punk' }
		]);

		expect(searchForAlbum).toHaveBeenCalledTimes(2);
		expect(grabAlbum).toHaveBeenCalledTimes(1);
	});

	it('refuses a release whose title does not carry the album, the same guard automation uses', async () => {
		searchForAlbum.mockResolvedValueOnce({ candidates: [candidate('Daft Punk - Homework FLAC')] });

		await searchAddedAlbums([{ ...ALBUM }]);

		expect(grabAlbum).not.toHaveBeenCalled();
	});
});

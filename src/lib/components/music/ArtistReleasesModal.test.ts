// @vitest-environment jsdom
/**
 * A discography search files each release under the album it names, and a grab
 * targets that album — the album is the unit the queue row hangs off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/svelte';
import ArtistReleasesModal from './ArtistReleasesModal.svelte';

const fetchMock = vi.hoisted(() => vi.fn());

vi.stubGlobal('fetch', fetchMock);

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		title: 'Chris Webby - Asylum (2026) 320',
		guid: '/post/asylum',
		indexerName: 'TheRARBG',
		size: 146_905_498,
		seeders: 17,
		format: 'mp3',
		bitrateKbps: 320,
		accepted: true,
		reasons: [],
		albumId: 'album-asylum',
		albumTitle: 'Asylum',
		...overrides
	};
}

beforeEach(() => {
	fetchMock.mockReset();
	cleanup();
});

describe('ArtistReleasesModal', () => {
	it('groups releases under their album and grabs through that album', async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						candidates: [
							candidate(),
							candidate({
								title: 'Chris Webby - The White Noise LP (2026) FLAC',
								guid: '/post/white-noise',
								albumId: 'album-white-noise',
								albumTitle: 'The White Noise LP',
								format: 'flac'
							})
						]
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true, title: 'Asylum' }), { status: 201 })
			);

		render(ArtistReleasesModal, {
			props: { open: true, artistId: 'artist-1', artistName: 'Chris Webby', onClose: vi.fn() }
		});

		await waitFor(() => expect(screen.getByText('Asylum')).toBeTruthy());
		expect(screen.getByText('The White Noise LP')).toBeTruthy();

		await fireEvent.click(screen.getAllByText('Grab')[0]);

		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith('/api/music/albums/album-asylum/grab', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ releaseGuid: '/post/asylum' })
			})
		);
	});

	it('says there are no releases when the search returns none', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ candidates: [] }), { status: 200 })
		);

		render(ArtistReleasesModal, {
			props: { open: true, artistId: 'artist-1', artistName: 'Chris Webby', onClose: vi.fn() }
		});

		await waitFor(() => expect(screen.getByText('No releases found for this album.')).toBeTruthy());
	});
});

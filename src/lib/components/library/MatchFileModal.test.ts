// @vitest-environment jsdom
/**
 * The unmatched-file dialog now runs on the shared search pieces. This test
 * pins the wiring end to end: the parsed title drives the search, a result is
 * a real pick, and a TV pick carries the parsed season/episode into the match.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import MatchFileModal from './MatchFileModal.svelte';

const searchTmdbMock = vi.hoisted(() => vi.fn());
const matchUnmatchedMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/discover.js', () => ({ searchTmdb: searchTmdbMock }));
vi.mock('#lib/api/library.js', () => ({ matchUnmatched: matchUnmatchedMock }));

const FILE = {
	id: 'file-1',
	path: '/tv/Alien.S01E02.1080p.mkv',
	mediaType: 'tv',
	parsedTitle: 'Alien',
	parsedYear: null,
	parsedSeason: 1,
	parsedEpisode: 2,
	suggestedMatches: null
};

beforeEach(() => {
	searchTmdbMock.mockReset();
	matchUnmatchedMock.mockReset();
});

describe('MatchFileModal', () => {
	it('searches the parsed title and matches the picked episode', async () => {
		searchTmdbMock.mockResolvedValue({
			results: [{ id: 348, name: 'Alien', poster_path: null, first_air_date: '1979-05-25' }]
		});
		matchUnmatchedMock.mockResolvedValue({ success: true });
		const onSuccess = vi.fn();

		render(MatchFileModal, {
			props: { open: true, file: FILE, onClose: vi.fn(), onSuccess }
		});

		await waitFor(() => expect(searchTmdbMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
		expect(searchTmdbMock).toHaveBeenCalledWith({ query: 'Alien', type: 'tv' });

		await fireEvent.click(await screen.findByText('Alien'));

		const matchButton = await screen.findByRole('button', { name: /Match to Alien/ });
		await fireEvent.click(matchButton);

		await waitFor(() =>
			expect(matchUnmatchedMock).toHaveBeenCalledWith('file-1', {
				tmdbId: 348,
				mediaType: 'tv',
				season: 1,
				episode: 2
			})
		);
		expect(onSuccess).toHaveBeenCalledWith('file-1');
	});
});

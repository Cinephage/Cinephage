// @vitest-environment jsdom
/**
 * The folder dialog's search must pause once a match is picked (the panel owns
 * the screen) and resume when the user goes back — the guard that made its copy
 * of the search different from the other three.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import * as m from '#lib/paraglide/messages.js';
import MatchFolderModal from './MatchFolderModal.svelte';
import type { UnmatchedFolder } from '#lib/types/unmatched.js';

const searchTmdbMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/discover.js', () => ({ searchTmdb: searchTmdbMock }));

function folder(): UnmatchedFolder {
	return {
		folderPath: '/movies/Alien (1979)',
		folderName: 'Alien (1979)',
		mediaType: 'movie',
		fileCount: 1,
		commonParsedTitle: 'Alien',
		isShowFolder: false,
		reasons: ['no_match'],
		files: [
			{
				id: 'file-1',
				path: '/movies/Alien (1979)/Alien.1979.1080p.mkv',
				rootFolderId: null,
				rootFolderPath: null,
				mediaType: 'movie',
				size: 8_000_000_000,
				parsedTitle: 'Alien',
				parsedYear: 1979,
				parsedSeason: null,
				parsedEpisode: null,
				suggestedMatches: null,
				reason: 'no_match',
				discoveredAt: '2026-11-19T00:00:00.000Z',
				correlationId: null
			}
		]
	};
}

beforeEach(() => {
	searchTmdbMock.mockReset();
});

describe('MatchFolderModal', () => {
	it('searches the folder title, then pauses on a pick and resumes after Change', async () => {
		searchTmdbMock.mockResolvedValue({
			results: [{ id: 348, title: 'Alien', poster_path: null, release_date: '1979-05-25' }]
		});

		render(MatchFolderModal, {
			props: { open: true, folder: folder(), onClose: vi.fn(), onSuccess: vi.fn() }
		});

		await waitFor(() => expect(searchTmdbMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
		expect(searchTmdbMock).toHaveBeenCalledWith({ query: 'Alien', type: 'movie' });

		await fireEvent.click(await screen.findByText('Alien'));

		const changeButton = await screen.findByText(m.action_change());
		expect(screen.queryByPlaceholderText(m.library_matchFolder_searchPlaceholder())).toBeNull();

		await fireEvent.click(changeButton);

		await waitFor(() =>
			expect(screen.getByPlaceholderText(m.library_matchFolder_searchPlaceholder())).toBeTruthy()
		);
		await waitFor(() => expect(searchTmdbMock).toHaveBeenCalledTimes(2), { timeout: 3000 });
	});
});

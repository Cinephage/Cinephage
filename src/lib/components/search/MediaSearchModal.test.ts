// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import MediaSearchModal from './MediaSearchModal.svelte';

const getSeriesMock = vi.hoisted(() => vi.fn());
const getMovieMock = vi.hoisted(() => vi.fn());
const searchReleasesMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/library.js', () => ({
	getSeries: getSeriesMock,
	getMovie: getMovieMock
}));

vi.mock('#lib/api/indexers.js', () => ({
	searchReleases: searchReleasesMock
}));

vi.mock('#lib/api/downloads.js', () => ({
	grabRelease: vi.fn()
}));

const SERIES_ID = '1a3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49';

function seriesResponse() {
	return {
		success: true,
		series: {
			title: 'Test Show',
			tmdbId: 123,
			imdbId: null,
			tvdbId: null,
			year: 2020,
			scoringProfileId: null,
			episodeCount: 10
		}
	};
}

describe('MediaSearchModal', () => {
	beforeEach(() => {
		getSeriesMock.mockReset();
		getMovieMock.mockReset();
		searchReleasesMock.mockReset();
		getSeriesMock.mockResolvedValue(seriesResponse());
		searchReleasesMock.mockResolvedValue({
			releases: [],
			meta: { totalResults: 0, searchTimeMs: 1 }
		});

		// InteractiveSearchModal fetches these directly via global fetch once open.
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (typeof url === 'string' && url.includes('/api/download-clients')) {
					return new Response(JSON.stringify([]), { status: 200 });
				}
				if (typeof url === 'string' && url.includes('/api/settings/acquisition')) {
					return new Response(JSON.stringify({ defaultAcquisitionProtocol: 'torrent' }), {
						status: 200
					});
				}
				return new Response(JSON.stringify([]), { status: 200 });
			})
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('does not re-fetch metadata (and reset the open search) when re-rendered for the same series', async () => {
		const { rerender } = render(MediaSearchModal, {
			props: { open: true, seriesId: SERIES_ID, onClose: vi.fn() }
		});

		await waitFor(() => expect(getSeriesMock).toHaveBeenCalledTimes(1));

		// Once metadata loads, the loading spinner dialog should go away and the
		// real interactive search modal should take over.
		await waitFor(() => expect(screen.queryByText('Test Show')).toBeTruthy());

		// Simulate an unrelated parent re-render while the modal stays open for
		// the same series (e.g. background download counters updating elsewhere
		// on the page) by re-rendering with a fresh onClose callback identity.
		await rerender({ open: true, seriesId: SERIES_ID, onClose: vi.fn() });

		// Metadata must not be re-fetched, and the search UI must not flash back
		// to the loading spinner.
		expect(getSeriesMock).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Test Show')).toBeTruthy();
	});

	it('re-fetches metadata when the modal is reopened for a different series', async () => {
		const OTHER_SERIES_ID = '2b4e0bc7-0ce6-5d51-c9b6-0f146bcfc50';
		const { rerender } = render(MediaSearchModal, {
			props: { open: true, seriesId: SERIES_ID, onClose: vi.fn() }
		});

		await waitFor(() => expect(getSeriesMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByText('Test Show')).toBeTruthy());

		await rerender({ open: false, seriesId: SERIES_ID, onClose: vi.fn() });
		await rerender({ open: true, seriesId: OTHER_SERIES_ID, onClose: vi.fn() });

		await waitFor(() => expect(getSeriesMock).toHaveBeenCalledTimes(2));
		expect(getSeriesMock).toHaveBeenLastCalledWith(OTHER_SERIES_ID);
	});
});

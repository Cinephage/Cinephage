// @vitest-environment jsdom
/**
 * A track search must not report "no releases" when the indexer did return the
 * album and only the quality profile refused it. The rows stay visible, greyed
 * with the reason, and the grab is not offered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import TrackSearchModal from './TrackSearchModal.svelte';

const fetchMock = vi.hoisted(() => vi.fn());

vi.stubGlobal('fetch', fetchMock);

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		title: 'Chris Webby - Asylum (2026) 320',
		guid: '/post/1',
		indexerName: 'TheRARBG',
		size: 146_905_498,
		seeders: 17,
		format: 'mp3',
		accepted: true,
		reasons: [],
		...overrides
	};
}

beforeEach(() => {
	fetchMock.mockReset();
	cleanup();
});

describe('TrackSearchModal', () => {
	it('shows a profile-rejected album release instead of claiming nothing was found', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					candidates: [candidate({ accepted: false, reasons: ['Below profile'] })]
				}),
				{
					status: 200
				}
			)
		);

		render(TrackSearchModal, {
			props: {
				open: true,
				track: { id: 't-1', title: 'Madhouse' },
				albumId: 'a-1',
				albumTitle: 'Asylum',
				onClose: vi.fn()
			}
		});

		await waitFor(() => expect(screen.getByText(/Asylum \(2026\) 320/)).toBeTruthy());

		expect(screen.getByText('Below profile')).toBeTruthy();
		expect(screen.queryByText('No releases found for this album.')).toBeNull();
		const grab = screen.getByRole('button', { name: 'Grab' }) as HTMLButtonElement;
		// Interactive means the person can pick it anyway; the profile only
		// decides what "Grab best" would choose.
		expect(grab.disabled).toBe(false);
		expect(grab.title).toBe('Below profile');
	});

	it('keeps only releases that name the album or the track', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					candidates: [
						candidate({ title: 'Chris Webby - Asylum (2026) 320' }),
						candidate({ title: 'Chris Isaak - Silvertone [1985] FLAC', guid: '/post/2' })
					]
				}),
				{ status: 200 }
			)
		);

		render(TrackSearchModal, {
			props: {
				open: true,
				track: { id: 't-1', title: 'Madhouse' },
				albumId: 'a-1',
				albumTitle: 'Asylum',
				onClose: vi.fn()
			}
		});

		await waitFor(() => expect(screen.getByText(/Asylum \(2026\) 320/)).toBeTruthy());

		expect(screen.queryByText(/Silvertone/)).toBeNull();
	});

	it('says no results only when the search returned none', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ candidates: [] }), { status: 200 }));

		render(TrackSearchModal, {
			props: {
				open: true,
				track: { id: 't-1', title: 'Madhouse' },
				albumId: 'a-1',
				albumTitle: 'Asylum',
				onClose: vi.fn()
			}
		});

		await waitFor(() => expect(screen.getByText('No results found')).toBeTruthy());
	});
});

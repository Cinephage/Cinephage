// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import ActivityTable from './ActivityTable.svelte';
import type { UnifiedActivity } from '#lib/types/activity.js';

const activity: UnifiedActivity = {
	id: 'activity-1',
	activitySource: 'queue',
	mediaType: 'movie',
	mediaId: 'movie-1',
	mediaTitle: 'The Matrix',
	mediaYear: 1999,
	releaseTitle: 'The.Matrix.1999.1080p.BluRay',
	quality: null,
	releaseGroup: null,
	size: 1_000_000,
	indexerId: null,
	indexerName: null,
	protocol: 'torrent',
	status: 'downloading',
	isUpgrade: false,
	timeline: [],
	startedAt: new Date().toISOString(),
	completedAt: null,
	queueItemId: 'queue-1'
};

describe('ActivityTable mobile inline remove (issue #579)', () => {
	beforeAll(() => {
		// ActivityTable picks the mobile-card layout off this media query.
		window.matchMedia = vi.fn().mockReturnValue({
			matches: true,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		});
	});

	afterEach(() => {
		cleanup();
	});

	it('asks for confirmation before removing, with parity to the detail modal', async () => {
		const onRemove = vi.fn().mockResolvedValue(undefined);
		render(ActivityTable, {
			props: { activities: [activity], onRemove }
		});

		await fireEvent.click(await screen.findByRole('button', { name: /remove/i }));

		const confirmation = await screen.findByRole('dialog', { name: /remove download/i });
		expect(within(confirmation).getByText(/delete its downloaded files from disk/)).toBeTruthy();
		expect(onRemove).not.toHaveBeenCalled();

		await fireEvent.click(
			within(confirmation).getByRole('button', { name: /remove and delete files/i })
		);

		expect(onRemove).toHaveBeenCalledWith('queue-1', { deleteFiles: true, blocklist: false });
	});

	it('does not remove anything when the confirmation is cancelled', async () => {
		const onRemove = vi.fn().mockResolvedValue(undefined);
		render(ActivityTable, {
			props: { activities: [activity], onRemove }
		});

		await fireEvent.click(await screen.findByRole('button', { name: /remove/i }));
		const confirmation = await screen.findByRole('dialog', { name: /remove download/i });
		await fireEvent.click(within(confirmation).getByRole('button', { name: /cancel/i }));

		expect(onRemove).not.toHaveBeenCalled();
	});
});

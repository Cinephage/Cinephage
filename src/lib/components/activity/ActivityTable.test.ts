// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import ActivityTable from './ActivityTable.svelte';
import type { UnifiedActivity } from '#lib/types/activity.js';
import * as m from '#lib/paraglide/messages.js';

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

describe('ActivityTable inline remove (issue #579)', () => {
	afterEach(() => {
		cleanup();
	});

	// The unified table (desktop + mobile share one layout) keeps per-row quick
	// actions inside the row's expand panel, so reaching "Remove" means opening
	// the row first - the whole row toggles expand, there's no dedicated button.
	// The media title is a link with its own stopPropagation, so click the row
	// itself rather than any particular cell's text.
	async function expandRow(container: HTMLElement): Promise<void> {
		const row = container.querySelector('tbody tr');
		if (!row) throw new Error('Expected a table row to be rendered');
		await fireEvent.click(row);
	}

	it('asks for confirmation before removing, with parity to the detail modal', async () => {
		const onRemove = vi.fn().mockResolvedValue(undefined);
		const { container } = render(ActivityTable, {
			props: { activities: [activity], onRemove }
		});

		await expandRow(container);
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
		const { container } = render(ActivityTable, {
			props: { activities: [activity], onRemove }
		});

		await expandRow(container);
		await fireEvent.click(await screen.findByRole('button', { name: /remove/i }));
		const confirmation = await screen.findByRole('dialog', { name: /remove download/i });
		await fireEvent.click(within(confirmation).getByRole('button', { name: /cancel/i }));

		expect(onRemove).not.toHaveBeenCalled();
	});
});

describe('ActivityTable phone touch targets', () => {
	afterEach(() => {
		cleanup();
	});

	it('gives the row checkbox a 32 px tap area', () => {
		render(ActivityTable, { props: { activities: [activity] } });
		const checkbox = screen.getByRole('checkbox', { name: `Select ${activity.mediaTitle}` });
		expect(checkbox.classList.contains('checkbox-sm')).toBe(true);
		const label = checkbox.closest('label');
		expect(label).not.toBeNull();
		expect(label?.classList.contains('min-h-8')).toBe(true);
	});

	it('gives the select-all checkbox a 32 px tap area', () => {
		render(ActivityTable, { props: { activities: [activity], isSelectable: () => true } });
		const checkbox = screen.getByRole('checkbox', { name: m.activity_table_selectAllVisible() });
		expect(checkbox.classList.contains('checkbox-sm')).toBe(true);
		expect(checkbox.closest('label')?.classList.contains('min-h-8')).toBe(true);
	});

	it('puts Remove last in the detail toolbar, pushed away from the other actions', async () => {
		const failed: UnifiedActivity = { ...activity, status: 'failed' };
		const { container } = render(ActivityTable, {
			props: { activities: [failed], onRemove: vi.fn() }
		});
		const row = container.querySelector('tbody tr');
		if (!row) throw new Error('Expected a table row to be rendered');
		await fireEvent.click(row);

		const removeButton = await screen.findByRole('button', { name: /^remove$/i });
		const toolbar = removeButton.parentElement;
		const buttons = toolbar ? [...toolbar.querySelectorAll('button')] : [];
		expect(buttons.length).toBeGreaterThan(1);
		expect(buttons.at(-1)).toBe(removeButton);
		expect(toolbar?.lastElementChild).toBe(removeButton);
		expect(removeButton.classList.contains('ml-auto')).toBe(true);
	});
});

// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import ActivityDetailModal from './ActivityDetailModal.svelte';
import type { UnifiedActivity } from '#lib/types/activity.js';

vi.mock('#lib/paraglide/messages.js', () => {
	const message = (value: string) => () => value;
	return {
		action_cancel: message('Cancel'),
		action_close: message('Close'),
		action_confirm: message('Confirm'),
		action_remove: message('Remove'),
		action_resume: message('Resume'),
		activity_detail_addToBlocklist: message('Add to blocklist'),
		activity_detail_alreadyBlocklisted: message('Blocklisted'),
		activity_detail_alsoBlocklist: message(
			"Also blocklist this release so it won't be grabbed again"
		),
		activity_detail_blocklisted: message('Release added to the blocklist'),
		activity_detail_downloadRemoved: message('Download removed'),
		activity_detail_failedToBlocklist: message('Failed to add release to blocklist'),
		activity_detail_indexer: message('Indexer'),
		activity_detail_mediaType: message('Media type'),
		activity_detail_protocol: message('Protocol'),
		activity_detail_releaseGroup: message('Release group'),
		activity_detail_removeAndDeleteFiles: message('Remove and delete files'),
		activity_detail_removeConfirmTitle: message('Remove download?'),
		activity_detail_removeFromClientWarning: message(
			'This will permanently remove the download from your download client and delete its downloaded files from disk.'
		),
		activity_relativeTime_justNow: message('just now'),
		common_overview: message('Overview'),
		common_retry: message('Retry'),
		common_size: message('Size'),
		common_status: message('Status'),
		status_failed: message('Failed'),
		status_paused: message('Paused'),
		ui_modal_closeModal: message('Close modal')
	};
});

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
	status: 'paused',
	isUpgrade: false,
	timeline: [],
	startedAt: new Date().toISOString(),
	completedAt: null,
	queueItemId: 'queue-1'
};

describe('ActivityDetailModal queue removal', () => {
	beforeAll(() => {
		HTMLElement.prototype.scrollTo = vi.fn();
	});

	afterEach(() => {
		cleanup();
	});

	it('confirms disk deletion before removing a download', async () => {
		const onRemove = vi.fn().mockResolvedValue(undefined);
		const onClose = vi.fn();
		render(ActivityDetailModal, {
			props: { open: true, activity, onClose, onRemove }
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

		const confirmation = screen.getByRole('dialog', { name: 'Remove download?' });
		expect(within(confirmation).getByText(/delete its downloaded files from disk/)).toBeTruthy();

		await fireEvent.click(
			within(confirmation).getByRole('button', { name: 'Remove and delete files' })
		);

		await waitFor(() => {
			expect(onRemove).toHaveBeenCalledWith('queue-1', { deleteFiles: true, blocklist: false });
			expect(onClose).toHaveBeenCalledOnce();
		});
	});
});

describe('ActivityDetailModal blocklist action (issue #618)', () => {
	beforeAll(() => {
		HTMLElement.prototype.scrollTo = vi.fn();
	});

	afterEach(() => {
		cleanup();
	});

	const failedActivity: UnifiedActivity = {
		...activity,
		activitySource: 'download_history',
		status: 'failed',
		queueItemId: undefined,
		downloadHistoryId: 'history-1'
	};

	it('shows a standalone "Add to blocklist" button even with no live queue item', async () => {
		const onBlocklistHistory = vi.fn().mockResolvedValue(undefined);
		render(ActivityDetailModal, {
			props: { open: true, activity: failedActivity, onClose: vi.fn(), onBlocklistHistory }
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Add to blocklist' }));

		await waitFor(() => {
			expect(onBlocklistHistory).toHaveBeenCalledWith('history-1');
		});
	});

	it('shows a "Blocklisted" badge instead of the button once already blocklisted', () => {
		render(ActivityDetailModal, {
			props: {
				open: true,
				activity: { ...failedActivity, isBlocklisted: true },
				onClose: vi.fn(),
				onBlocklistHistory: vi.fn()
			}
		});

		expect(screen.getByText('Blocklisted')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Add to blocklist' })).toBeNull();
	});

	it('hides the "also blocklist" checkbox on the remove dialog once already blocklisted', async () => {
		const onRemove = vi.fn().mockResolvedValue(undefined);
		render(ActivityDetailModal, {
			props: {
				open: true,
				activity: { ...failedActivity, queueItemId: 'queue-1', isBlocklisted: true },
				onClose: vi.fn(),
				onRemove
			}
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

		const confirmation = screen.getByRole('dialog', { name: 'Remove download?' });
		expect(
			within(confirmation).queryByText("Also blocklist this release so it won't be grabbed again")
		).toBeNull();
	});
});

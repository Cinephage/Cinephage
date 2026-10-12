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
		action_remove: message('Delete'),
		action_resume: message('Resume'),
		activity_detail_downloadRemoved: message('Download removed'),
		activity_detail_indexer: message('Indexer'),
		activity_detail_mediaType: message('Media type'),
		activity_detail_protocol: message('Protocol'),
		activity_detail_releaseGroup: message('Release group'),
		activity_detail_removeConfirmTitle: message('Delete download?'),
		activity_relativeTime_justNow: message('just now'),
		common_overview: message('Overview'),
		common_size: message('Size'),
		common_status: message('Status'),
		status_paused: message('Paused'),
		toast_library_movieDetail_movieRemoved: message('Movie removed from library'),
		ui_deleteModal_confirmDeleteFiles_prefix: message('This will delete'),
		ui_deleteModal_confirmDeleteFiles_suffix: message('file(s) from your disk permanently.'),
		ui_deleteModal_confirmRemoveAndDelete_prefix: message('This will remove'),
		ui_deleteModal_confirmRemoveAndDelete_suffix: message('from your library and delete files.'),
		ui_deleteModal_confirmUnmatch_prefix: message('This will unmatch'),
		ui_deleteModal_confirmUnmatch_suffix: message('from its current match.'),
		ui_deleteModal_deleteFiles: message('Delete Files'),
		ui_deleteModal_deleteFilesFromDisk: message('Delete files from disk & download client'),
		ui_deleteModal_removeAndDeleteFiles: message('Delete Library and Files'),
		ui_deleteModal_removeFromLibraryEntirely: message('Delete from library'),
		ui_deleteModal_unmatchFiles: message('Unmatch Files'),
		ui_deleteModal_warningDeleteFiles: message('Files will be permanently deleted.'),
		ui_deleteModal_warningRemoveAndDelete: message('Will remove the item and delete all files.'),
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

		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

		const confirmation = screen.getByRole('dialog', { name: 'Delete download?' });
		// Queue removal defaults to deleting files (also dropping the client entry).
		expect(
			within(confirmation).getByRole('checkbox', {
				name: 'Delete files from disk & download client'
			})
		).toBeTruthy();

		await fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete Files' }));

		await waitFor(() => {
			expect(onRemove).toHaveBeenCalledWith('queue-1', {
				deleteFiles: true,
				removeFromLibrary: false
			});
			expect(onClose).toHaveBeenCalledOnce();
		});
	});

	it('offers library removal for movie downloads', async () => {
		const onRemove = vi.fn().mockResolvedValue(undefined);
		const onClose = vi.fn();
		render(ActivityDetailModal, {
			props: { open: true, activity, onClose, onRemove }
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		const confirmation = screen.getByRole('dialog', { name: 'Delete download?' });

		await fireEvent.click(
			within(confirmation).getByRole('checkbox', { name: 'Delete from library' })
		);
		await fireEvent.click(
			within(confirmation).getByRole('button', { name: 'Delete Library and Files' })
		);

		await waitFor(() => {
			expect(onRemove).toHaveBeenCalledWith('queue-1', {
				deleteFiles: true,
				removeFromLibrary: true
			});
			expect(onClose).toHaveBeenCalledOnce();
		});
	});

	it('hides library removal for episode downloads', async () => {
		const onRemove = vi.fn().mockResolvedValue(undefined);
		render(ActivityDetailModal, {
			props: {
				open: true,
				activity: { ...activity, mediaType: 'episode', mediaId: 'episode-1' },
				onClose: vi.fn(),
				onRemove
			}
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		const confirmation = screen.getByRole('dialog', { name: 'Delete download?' });
		expect(
			within(confirmation).queryByRole('checkbox', { name: 'Delete from library' })
		).toBeNull();
	});
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import ActivityTable from './ActivityTable.svelte';
import type { UnifiedActivity } from '#lib/types/activity.js';

vi.mock('#lib/paraglide/messages.js', () => {
	const message =
		(value: string) =>
		(..._args: unknown[]) =>
			value;
	return {
		action_cancel: message('Cancel'),
		action_close: message('Close'),
		action_confirm: message('Confirm'),
		action_pause: message('Pause'),
		action_remove: message('Remove'),
		action_resume: message('Resume'),
		action_search: message('Search'),
		activity_detail_downloadPaused: message('Download paused'),
		activity_detail_downloadRemoved: message('Download removed'),
		activity_detail_downloadResumed: message('Download resumed'),
		activity_detail_downloadRetryInitiated: message('Retry initiated'),
		activity_detail_importRetryInitiated: message('Import retry initiated'),
		activity_detail_removeAndDeleteFiles: message('Remove and delete files'),
		activity_detail_removeConfirmTitle: message('Remove download?'),
		activity_detail_removeFromClientWarning: message(
			'This will permanently remove the download from your download client and delete its downloaded files from disk.'
		),
		activity_detail_retryImport: message('Retry import'),
		activity_importFailed: message('Import failed'),
		activity_popover_media: message('Media'),
		activity_popover_reason: message('Reason'),
		activity_popover_release: message('Release'),
		activity_popover_viewInActivity: message('View in activity'),
		activity_popover_when: message('When'),
		activity_relativeTime_daysAgo: message('days ago'),
		activity_relativeTime_hoursAgo: message('hours ago'),
		activity_relativeTime_justNow: message('just now'),
		activity_relativeTime_minutesAgo: message('minutes ago'),
		activity_resolutionAuto: message('Auto'),
		activity_table_failedToAction: message('Action failed'),
		activity_table_hideReason: message('Hide reason'),
		activity_table_hideTimeline: message('Hide timeline'),
		activity_table_group: message('Group'),
		activity_table_importedTo: message('Imported to'),
		activity_table_media: message('Media'),
		activity_table_quality: message('Quality'),
		activity_table_release: message('Release'),
		activity_table_selectAllVisible: message('Select all'),
		activity_table_source: message('Source'),
		activity_table_timeline: message('Timeline'),
		activity_table_upgrade: message('Upgrade'),
		activity_table_noActivity: message('No activity'),
		activity_table_noActivityHint: message('No activity hint'),
		activity_table_reason: message('Reason'),
		activity_table_showReason: message('Show reason'),
		activity_table_showTimeline: message('Show timeline'),
		activity_tag_download: message('download'),
		activity_tag_list: message('list'),
		activity_tag_media: message('media'),
		activity_tag_move: message('move'),
		activity_tag_sub: message('sub'),
		activity_taskError: message('Task error'),
		common_retry: message('Retry'),
		common_size: message('Size'),
		common_status: message('Status'),
		status_downloading: message('Downloading'),
		status_error: message('Error'),
		status_failed: message('Failed'),
		status_imported: message('Imported'),
		status_importing: message('Importing'),
		status_materializing: message('Materializing'),
		status_noResults: message('No results'),
		status_paused: message('Paused'),
		status_rejected: message('Rejected'),
		status_removed: message('Removed'),
		status_searchError: message('Search error'),
		status_searching: message('Searching'),
		status_seeding: message('Seeding'),
		status_streaming: message('Streaming'),
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
	status: 'downloading',
	isUpgrade: false,
	timeline: [],
	startedAt: new Date().toISOString(),
	completedAt: null,
	queueItemId: 'queue-1',
	downloadProgress: 42
} as unknown as UnifiedActivity;

function mockMobileViewport() {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches: query.includes('max-width'),
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn()
		}))
	});
}

describe('ActivityTable inline removal', () => {
	beforeEach(() => {
		mockMobileViewport();
		HTMLElement.prototype.scrollTo = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('routes mobile inline remove through delete-files confirmation (#579)', async () => {
		const onRemove = vi.fn().mockResolvedValue(undefined);
		render(ActivityTable, {
			props: { activities: [activity], onRemove }
		});

		// Inline trash can on the mobile card — no direct delete yet.
		await fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(onRemove).not.toHaveBeenCalled();

		// Same confirmation copy as the detail modal.
		const confirmation = screen.getByRole('dialog', { name: 'Remove download?' });
		expect(
			within(confirmation).getByText(/delete its downloaded files from disk/)
		).toBeTruthy();

		await fireEvent.click(
			within(confirmation).getByRole('button', { name: 'Remove and delete files' })
		);

		await waitFor(() => {
			expect(onRemove).toHaveBeenCalledWith('queue-1', { deleteFiles: true });
		});
	});
});

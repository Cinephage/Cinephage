// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

const { getActivitySettings } = vi.hoisted(() => ({
	getActivitySettings: vi.fn()
}));

vi.mock('#lib/api/activity.js', () => ({
	getActivity: vi.fn().mockResolvedValue({ success: true, activities: [], total: 0 }),
	getActivitySettings,
	setRetentionDays: vi.fn(),
	deleteActivity: vi.fn(),
	purgeHistory: vi.fn(),
	getSearchActivity: vi.fn().mockResolvedValue({ success: true, items: [], total: 0 }),
	resetSearchFailures: vi.fn(),
	getSearchItemDetail: vi.fn(),
	setSearchItemPaused: vi.fn(),
	setGlobalSearchPaused: vi.fn()
}));

vi.mock('#lib/api/downloads.js', () => ({
	pauseQueueItem: vi.fn(),
	resumeQueueItem: vi.fn(),
	removeQueueItem: vi.fn(),
	retryQueueItem: vi.fn(),
	refreshQueue: vi.fn(),
	relinkOrphans: vi.fn(),
	getUnmatched: vi.fn().mockResolvedValue({ success: true, items: [], total: 0 }),
	blocklistHistoryItem: vi.fn(),
	resolveUnmatched: vi.fn(),
	trackUnmatched: vi.fn(),
	enrollUnmatched: vi.fn(),
	clearFailedQueue: vi.fn()
}));

vi.mock('#lib/sse/index.js', () => ({
	createSSE: () => ({
		status: 'idle',
		isConnected: false,
		isPaused: false,
		error: null,
		reconnectCount: 0,
		maxRetriesExceeded: false,
		connect: vi.fn(),
		close: vi.fn(),
		reconnect: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn()
	})
}));

vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
	invalidate: vi.fn(),
	invalidateAll: vi.fn(),
	replaceState: vi.fn(),
	pushState: vi.fn()
}));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/state', () => ({
	page: { data: {}, url: new URL('http://localhost/activity?tab=history'), state: {} }
}));
vi.mock('#lib/stores/toast.svelte.js', () => ({
	toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

import ActivityPage from '../../../routes/activity/+page.svelte';

const historyData = {
	tab: 'history',
	activities: [],
	total: 0,
	summary: null,
	importBatches: [],
	filterOptions: { indexers: [], downloadClients: [], releaseGroups: [], resolutions: [] }
} as never;

function pendingSettings() {
	let resolveSettings: (value: unknown) => void = () => {};
	getActivitySettings.mockImplementation(
		() => new Promise((resolve) => (resolveSettings = resolve))
	);
	return (value: unknown) => resolveSettings(value);
}

async function settle() {
	for (let i = 0; i < 3; i++) {
		await Promise.resolve();
		await tick();
	}
}

describe('activity page history settings', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
	});

	afterEach(() => {
		cleanup();
		getActivitySettings.mockReset();
		vi.unstubAllGlobals();
	});

	it('loads the settings once when opened on the History tab', async () => {
		const resolveSettings = pendingSettings();

		render(ActivityPage, { props: { data: historyData } });
		await settle();
		resolveSettings({ success: true, retentionDays: 30 });
		await settle();

		expect(getActivitySettings).toHaveBeenCalledTimes(1);
	});

	it('reuses the pending request when leaving and returning to History', async () => {
		const resolveSettings = pendingSettings();

		render(ActivityPage, { props: { data: historyData } });
		await settle();
		await fireEvent.click(screen.getByRole('button', { name: /^Searches$/ }));
		await settle();
		await fireEvent.click(screen.getByRole('button', { name: /^History$/ }));
		await settle();
		resolveSettings({ success: true, retentionDays: 30 });
		await settle();

		expect(getActivitySettings).toHaveBeenCalledTimes(1);
	});
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import InsightDetailModal from './InsightDetailModal.svelte';
import type { Insight } from './utils.js';

const getInsightItemsMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/storage.js', () => ({
	getInsightItems: getInsightItemsMock
}));

function pageResponse(page: number) {
	return {
		success: true,
		data: {
			items: [{ id: `item-page-${page}`, kind: 'movie' as const, title: `Item on page ${page}` }],
			pagination: { page, limit: 50, total: 60, totalPages: 2 }
		},
		meta: { insightId: 'insight-1', insightType: 'unplayed', filters: { page, limit: 50 } }
	};
}

const INSIGHT: Insight = {
	id: 'insight-1',
	insightType: 'unplayed',
	severity: 'info',
	title: 'Unplayed items',
	summary: '60 items',
	reclaimableBytes: null,
	detailsJson: null,
	itemCount: 60
};

describe('InsightDetailModal pagination', () => {
	beforeEach(() => {
		getInsightItemsMock.mockReset();
		getInsightItemsMock.mockImplementation(async (_id: string, params: { page: number }) =>
			pageResponse(params.page)
		);
	});

	afterEach(() => {
		cleanup();
	});

	it('stays on the page Next navigated to instead of snapping back to page 1', async () => {
		render(InsightDetailModal, {
			props: { open: true, insight: INSIGHT, onClose: vi.fn() }
		});

		await waitFor(() => expect(screen.queryByText('Item on page 1')).toBeTruthy());
		expect(getInsightItemsMock).toHaveBeenCalledTimes(1);
		expect(getInsightItemsMock).toHaveBeenLastCalledWith('insight-1', { page: 1, limit: 50 });

		await fireEvent.click(screen.getByText('Next'));
		await waitFor(() => expect(screen.queryByText('Item on page 2')).toBeTruthy());
		expect(getInsightItemsMock).toHaveBeenCalledTimes(2);
		expect(getInsightItemsMock).toHaveBeenLastCalledWith('insight-1', { page: 2, limit: 50 });

		// Regression: the "reset to page 1 when the modal opens" effect used to
		// read `page` synchronously inside fetchItems(), which Svelte then
		// treated as one of the effect's own dependencies - so the effect
		// re-ran on every page change and immediately reset back to page 1.
		// Flush every pending microtask/effect tick and confirm no further
		// (page-1-resetting) fetch happens and page 2's item is still shown.
		for (let i = 0; i < 5; i++) {
			await tick();
		}
		expect(screen.queryByText('Item on page 2')).toBeTruthy();
		expect(screen.queryByText('Item on page 1')).toBeFalsy();
		expect(getInsightItemsMock).toHaveBeenCalledTimes(2);
	});
});

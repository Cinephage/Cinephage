// @vitest-environment jsdom
/**
 * LibraryDrawer filter rendering test.
 *
 * Bug #494: the "Cancelled" status filter option must actually render in the
 * library drawer dropdown. The drawer is generic (prop-driven), so this pins
 * that a status filter with the cancelled option renders its select entry.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import LibraryDrawer from './LibraryDrawer.svelte';
import { seriesStatusFilterOptions } from '#lib/utils/format-status.js';

function renderDrawer() {
	return render(LibraryDrawer, {
		props: {
			isOpen: true,
			sortOptions: [{ value: 'title', label: 'Title' }],
			filterOptions: [
				{
					key: 'status',
					label: 'Show Status',
					options: seriesStatusFilterOptions()
				}
			],
			currentSort: 'title',
			currentFilters: {},
			onClose: vi.fn(),
			onSortChange: vi.fn(),
			onFilterChange: vi.fn(),
			onClearFilters: vi.fn()
		}
	});
}

describe('LibraryDrawer status filter', () => {
	afterEach(() => {
		cleanup();
	});

	it('renders the cancelled status option in the dropdown (bug #494)', () => {
		renderDrawer();
		const statusSelect = screen.getByLabelText('Show Status') as HTMLSelectElement;

		const options = Array.from(statusSelect.options).map((o) => o.value);
		expect(options).toContain('cancelled');
	});
});

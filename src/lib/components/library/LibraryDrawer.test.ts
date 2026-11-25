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
import * as m from '#lib/paraglide/messages.js';

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

describe('LibraryDrawer panel width', () => {
	afterEach(() => {
		cleanup();
	});

	// A 384px cap left a sliver of backdrop on the left of a 393px phone.
	it('is full width on phones and capped only from the sm breakpoint', () => {
		renderDrawer();
		const panel = screen
			.getByRole('heading', { name: m.library_drawer_title() })
			.closest('div.fixed') as HTMLElement;

		expect(panel).toBeTruthy();
		expect(panel.classList.contains('w-full')).toBe(true);
		expect(panel.classList.contains('sm:max-w-sm')).toBe(true);
		expect(panel.classList.contains('max-w-sm')).toBe(false);
	});
});

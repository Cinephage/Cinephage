// @vitest-environment jsdom
/**
 * The bar is the one place the three lists say what a selection can do. It must
 * render only the actions the caller can serve — music has no quality profile —
 * and it must own the count sentence so each list does not write its own.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import LibraryBulkActionBar from './LibraryBulkActionBar.svelte';
import * as m from '#lib/paraglide/messages.js';

afterEach(cleanup);

const base = {
	selectedCount: 3,
	itemLabel: 'albums',
	loading: false,
	currentAction: null,
	onMonitor: vi.fn(),
	onUnmonitor: vi.fn(),
	onDelete: vi.fn(),
	onClear: vi.fn()
} as const;

describe('LibraryBulkActionBar', () => {
	it('says what is selected using the caller label', () => {
		const { container } = render(LibraryBulkActionBar, { props: { ...base } });

		expect(container.textContent).toMatch(/3\s*albums\s*selected/i);
	});

	it('hides the quality action when the kind cannot serve it', () => {
		render(LibraryBulkActionBar, { props: { ...base } });

		expect(screen.queryByText('Quality')).toBeNull();
	});

	it('shows the quality action when a handler is supplied', () => {
		render(LibraryBulkActionBar, {
			props: { ...base, onChangeQuality: vi.fn() }
		});

		expect(screen.getByText('Quality')).toBeTruthy();
	});

	it('reports monitor and delete clicks', async () => {
		const onMonitor = vi.fn();
		const onDelete = vi.fn();
		render(LibraryBulkActionBar, { props: { ...base, onMonitor, onDelete } });

		await fireEvent.click(screen.getByTitle(m.library_bulkActionBar_titleMonitor()));
		await fireEvent.click(screen.getByTitle(m.library_bulkActionBar_titleDelete()));

		expect(onMonitor).toHaveBeenCalledTimes(1);
		expect(onDelete).toHaveBeenCalledTimes(1);
	});

	it('renders nothing without a selection', () => {
		const { container } = render(LibraryBulkActionBar, {
			props: { ...base, selectedCount: 0 }
		});

		expect(container.textContent?.trim()).toBe('');
	});
});

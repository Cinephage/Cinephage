// @vitest-environment jsdom
/**
 * On phones the library search sits behind an icon in the toolbar, so the
 * sticky header is one row instead of two. The row must still open with focus
 * in the field, close again without trapping focus, and never hide an active
 * query (a filtered list has to show what filters it).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import LibraryListHeader from './LibraryListHeader.svelte';
import * as m from '#lib/paraglide/messages.js';

afterEach(cleanup);

function setup(searchQuery = '') {
	render(LibraryListHeader, {
		props: {
			title: 'Movies',
			total: 3,
			totalUnfiltered: 3,
			ofTotalLabel: 'of 3',
			searchPlaceholder: 'Search Movies…',
			clearSearchLabel: 'Clear search',
			searchQuery,
			viewMode: 'grid',
			switchToGridLabel: 'Grid',
			switchToListLabel: 'List',
			onToggleView: () => {},
			activeFilterCount: 0,
			filterLabel: 'Filters',
			onOpenFilters: () => {}
		}
	});
	const toggle = screen.getByRole('button', { name: m.action_search() });
	// jsdom applies no media queries: the desktop field is in the DOM too, so
	// look inside the phone row only.
	const row = document.getElementById(toggle.getAttribute('aria-controls')!)!;
	const field = row.querySelector('input')!;
	return { toggle, row, field };
}

describe('LibraryListHeader phone search', () => {
	it('starts collapsed behind the search icon', () => {
		const { toggle, row } = setup();

		expect(row.hidden).toBe(true);
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
	});

	it('opens with focus in the field', async () => {
		const { toggle, row, field } = setup();

		await fireEvent.click(toggle);

		expect(row.hidden).toBe(false);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(document.activeElement).toBe(field);
	});

	it('closes on Escape and gives focus back to the icon', async () => {
		const { toggle, row, field } = setup();
		await fireEvent.click(toggle);

		await fireEvent.keyDown(field, { key: 'Escape' });

		expect(row.hidden).toBe(true);
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(toggle);
	});

	it('closes from its close button and gives focus back to the icon', async () => {
		const { toggle, row } = setup();
		await fireEvent.click(toggle);

		await fireEvent.click(screen.getByRole('button', { name: m.action_closeSearch() }));

		expect(row.hidden).toBe(true);
		expect(document.activeElement).toBe(toggle);
	});

	it('closes on a tap outside, and a second tap on the icon closes it too', async () => {
		const { toggle, row } = setup();
		await fireEvent.click(toggle);
		await fireEvent.pointerDown(document.body);
		expect(row.hidden).toBe(true);

		await fireEvent.click(toggle);
		expect(row.hidden).toBe(false);
		await fireEvent.click(toggle);
		expect(row.hidden).toBe(true);
	});

	it('keeps a typed query on screen after a tap outside', async () => {
		const { toggle, row, field } = setup();
		await fireEvent.click(toggle);
		await fireEvent.input(field, { target: { value: 'alien' } });

		await fireEvent.pointerDown(document.body);

		expect(row.hidden).toBe(false);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
	});

	it('shows an active query from the start and does not close over it', async () => {
		const { toggle, row, field } = setup('alien');

		expect(row.hidden).toBe(false);
		expect(field.value).toBe('alien');
		expect(screen.queryByRole('button', { name: m.action_closeSearch() })).toBeNull();

		await fireEvent.keyDown(field, { key: 'Escape' });
		await fireEvent.pointerDown(document.body);
		expect(row.hidden).toBe(false);

		// The icon then leads into the field instead of closing it.
		await fireEvent.click(toggle);
		expect(row.hidden).toBe(false);
		expect(document.activeElement).toBe(field);
	});

	it('offers close again once the query is cleared', async () => {
		const { row } = setup('alien');

		const clear = row.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
		clear.focus();
		await fireEvent.click(clear);

		expect(row.hidden).toBe(false);
		expect(screen.getByRole('button', { name: m.action_closeSearch() })).toBeTruthy();
	});
});

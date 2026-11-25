// @vitest-environment jsdom
/**
 * In select mode a tap on a list row (title and poster included) toggles the
 * selection instead of navigating, the same as the grid card.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import LibraryMediaMobileCard from './LibraryMediaMobileCard.svelte';
import LibraryMediaTableRow from './LibraryMediaTableRow.svelte';
import type { MediaRowView } from './media-view.js';

const row = {
	id: 'movie-1',
	kind: 'movie',
	title: 'Sample Title',
	href: '/library/movie/movie-1',
	year: 2020,
	subtitle: null,
	art: null,
	monitored: true,
	partiallyMonitored: false,
	state: null,
	qualityBadges: [],
	profileLabel: null,
	sizeLabel: null,
	progressLabel: null,
	progress: null,
	added: null
} as unknown as MediaRowView;

function baseProps(selectable: boolean) {
	return {
		row,
		selected: false,
		selectable,
		isLoading: false,
		downloadingIds: new Set<string>(),
		onSelectChange: vi.fn(),
		onNavigate: vi.fn()
	};
}

describe('library list rows in select mode', () => {
	afterEach(cleanup);

	it('mobile card: a title tap toggles the selection and does not navigate', async () => {
		const props = baseProps(true);
		render(LibraryMediaMobileCard, { props });
		const title = screen.getByText('Sample Title');
		expect(title.closest('a')?.hasAttribute('href')).toBe(false);
		await fireEvent.click(title);
		expect(props.onSelectChange).toHaveBeenCalledWith('movie-1', true);
		expect(props.onNavigate).not.toHaveBeenCalled();
	});

	it('mobile card: outside select mode the title stays a link', () => {
		render(LibraryMediaMobileCard, { props: baseProps(false) });
		expect(screen.getByText('Sample Title').closest('a')?.getAttribute('href')).toBe(
			'/library/movie/movie-1'
		);
	});

	it('table row: a title click toggles the selection and does not navigate', async () => {
		const props = { ...baseProps(true), idx: 0, showProgress: false };
		const table = document.createElement('table');
		const tbody = document.createElement('tbody');
		table.appendChild(tbody);
		document.body.appendChild(table);
		render(LibraryMediaTableRow, { props, target: tbody });
		const title = screen.getByText('Sample Title');
		expect(title.closest('a')?.hasAttribute('href')).toBe(false);
		await fireEvent.click(title);
		expect(props.onSelectChange).toHaveBeenCalledWith('movie-1', true);
		expect(props.onNavigate).not.toHaveBeenCalled();
		table.remove();
	});
});

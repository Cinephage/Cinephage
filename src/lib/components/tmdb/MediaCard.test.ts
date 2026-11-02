// @vitest-environment jsdom
/**
 * MediaCard badge/quick-add layout + multi-select tests.
 *
 * Pins the discover regression where the hover "+" button sat underneath the
 * top-right type badge (same corner, badge on a higher layer) so the badge
 * covered it and swallowed the clicks: badge and button must be siblings in
 * the same top-right row. Also covers the multi-select mode added for the
 * bulk add flow.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import MediaCard from './MediaCard.svelte';
import type { TmdbMediaItem } from '#lib/types/tmdb.js';

type CardItem = TmdbMediaItem & { inLibrary?: boolean; hasFile?: boolean };

const movieStub = {
	id: 603,
	media_type: 'movie',
	title: 'The Matrix',
	release_date: '1999-03-31',
	poster_path: '/matrix.jpg',
	vote_average: 8.2
} as unknown as CardItem;

afterEach(cleanup);

describe('MediaCard top-right corner', () => {
	it('renders the type badge and quick-add button as siblings (no overlap)', () => {
		render(MediaCard, { props: { item: movieStub, onAddToLibrary: vi.fn() } });

		const badge = screen.getByText('Movie');
		const addButton = screen.getByTitle('Add to Library');

		expect(addButton.parentElement).toBe(badge.parentElement);
	});

	it('fires onAddToLibrary without following the card link', async () => {
		const onAddToLibrary = vi.fn();
		render(MediaCard, { props: { item: movieStub, onAddToLibrary } });

		await fireEvent.click(screen.getByTitle('Add to Library'));

		expect(onAddToLibrary).toHaveBeenCalledTimes(1);
		expect(onAddToLibrary.mock.calls[0][0]).toMatchObject({ id: 603 });
	});

	it('hides the quick-add button for items already in the library', () => {
		const inLibraryItem = { ...movieStub, inLibrary: true, hasFile: true } as CardItem;
		render(MediaCard, { props: { item: inLibraryItem, onAddToLibrary: vi.fn() } });

		expect(screen.queryByTitle('Add to Library')).toBeNull();
	});
});

describe('MediaCard multi-select mode', () => {
	it('toggles selection from the checkbox', async () => {
		const onToggleSelect = vi.fn();
		render(MediaCard, {
			props: {
				item: movieStub,
				selectable: true,
				selected: false,
				onToggleSelect
			}
		});

		await fireEvent.click(screen.getByLabelText('Select'));

		expect(onToggleSelect).toHaveBeenCalledTimes(1);
	});

	it('toggles selection when the card body is clicked and drops the link', async () => {
		const onToggleSelect = vi.fn();
		const { container } = render(MediaCard, {
			props: {
				item: movieStub,
				selectable: true,
				selected: false,
				onToggleSelect
			}
		});

		const card = container.querySelector('a');
		expect(card?.getAttribute('href')).toBeNull();

		await fireEvent.click(card!);

		expect(onToggleSelect).toHaveBeenCalledTimes(1);
	});

	it('marks the checkbox pressed when selected and hides quick-add', () => {
		render(MediaCard, {
			props: {
				item: movieStub,
				selectable: true,
				selected: true,
				onToggleSelect: vi.fn(),
				onAddToLibrary: vi.fn()
			}
		});

		expect(screen.getByLabelText('Select').getAttribute('aria-pressed')).toBe('true');
		expect(screen.queryByTitle('Add to Library')).toBeNull();
	});

	it('keeps library items navigable and unselectable', () => {
		const inLibraryItem = { ...movieStub, inLibrary: true, hasFile: true } as CardItem;
		const { container } = render(MediaCard, {
			props: {
				item: inLibraryItem,
				selectable: true,
				selected: false,
				onToggleSelect: vi.fn()
			}
		});

		expect(screen.queryByLabelText('Select')).toBeNull();
		expect(container.querySelector('a')?.getAttribute('href')).toBe('/discover/movie/603');
	});
});

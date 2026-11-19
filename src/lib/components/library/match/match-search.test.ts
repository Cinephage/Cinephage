// @vitest-environment jsdom
/**
 * The four match dialogs all search TMDB the same way and render the same
 * result row. These tests pin the shared pieces before the dialogs adopt them:
 * one request per typing burst, newest response wins, and a row that reports
 * the pick it represents.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { createTmdbMatchSearch, type TmdbMatchResult } from './match-search.svelte.js';
import MatchSearchField from './MatchSearchField.svelte';
import MatchResultList from './MatchResultList.svelte';

const searchTmdbMock = vi.hoisted(() => vi.fn());
const errorMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/discover.js', () => ({ searchTmdb: searchTmdbMock }));
vi.mock('#lib/stores/toast.svelte.js', () => ({ toasts: { error: errorMock, success: vi.fn() } }));

function tmdbResult(id: number, overrides: Partial<TmdbMatchResult> = {}): TmdbMatchResult {
	return {
		id,
		title: `Movie ${id}`,
		poster_path: '/poster.jpg',
		release_date: '2024-05-01',
		overview: 'A film.',
		...overrides
	};
}

beforeEach(() => {
	searchTmdbMock.mockReset();
	errorMock.mockReset();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe('createTmdbMatchSearch', () => {
	it('collapses a typing burst into one request with the final text', async () => {
		let query = 'ali';
		const search = createTmdbMatchSearch({
			query: () => query,
			type: () => 'movie',
			failureMessage: () => 'search failed'
		});

		vi.useFakeTimers();
		search.schedule();
		query = 'alien';
		search.schedule();

		await vi.advanceTimersByTimeAsync(399);
		expect(searchTmdbMock).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(searchTmdbMock).toHaveBeenCalledTimes(1);
		expect(searchTmdbMock).toHaveBeenCalledWith({ query: 'alien', type: 'movie' });
	});

	it('does not search while paused, and resumes when enabled', async () => {
		let enabled = false;
		const search = createTmdbMatchSearch({
			query: () => 'alien',
			type: () => 'tv',
			enabled: () => enabled,
			failureMessage: () => 'search failed'
		});

		vi.useFakeTimers();
		search.schedule();
		await vi.advanceTimersByTimeAsync(1000);
		expect(searchTmdbMock).not.toHaveBeenCalled();

		enabled = true;
		search.schedule();
		await vi.advanceTimersByTimeAsync(400);
		expect(searchTmdbMock).toHaveBeenCalledWith({ query: 'alien', type: 'tv' });
	});

	it('run() searches immediately and exposes the results', async () => {
		searchTmdbMock.mockResolvedValue({ results: [tmdbResult(1)] });
		const search = createTmdbMatchSearch({
			query: () => 'alien',
			type: () => 'movie',
			failureMessage: () => 'search failed'
		});

		await search.run();

		expect(search.results).toHaveLength(1);
		expect(search.searching).toBe(false);
	});

	it('ignores a response that lands after a newer search started', async () => {
		let resolveFirst: (value: { results: TmdbMatchResult[] }) => void = () => {};
		searchTmdbMock.mockImplementationOnce(
			() => new Promise<{ results: TmdbMatchResult[] }>((resolve) => (resolveFirst = resolve))
		);
		searchTmdbMock.mockImplementationOnce(async () => ({ results: [tmdbResult(2)] }));
		const search = createTmdbMatchSearch({
			query: () => 'alien',
			type: () => 'movie',
			failureMessage: () => 'search failed'
		});

		const first = search.run();
		await search.run();
		resolveFirst({ results: [tmdbResult(1)] });
		await first;

		expect(search.results.map((result) => result.id)).toEqual([2]);
	});

	it('reset() drops results and discards an in-flight response', async () => {
		let resolveRun: (value: { results: TmdbMatchResult[] }) => void = () => {};
		searchTmdbMock.mockImplementationOnce(
			() => new Promise<{ results: TmdbMatchResult[] }>((resolve) => (resolveRun = resolve))
		);
		const search = createTmdbMatchSearch({
			query: () => 'alien',
			type: () => 'movie',
			failureMessage: () => 'search failed'
		});

		const pending = search.run();
		search.reset();
		resolveRun({ results: [tmdbResult(3)] });
		await pending;

		expect(search.results).toEqual([]);
		expect(search.searching).toBe(false);
	});

	it('toasts once and leaves no results when the request fails', async () => {
		searchTmdbMock.mockRejectedValue(new Error('offline'));
		const search = createTmdbMatchSearch({
			query: () => 'alien',
			type: () => 'movie',
			failureMessage: () => 'search failed'
		});

		await search.run();

		expect(errorMock).toHaveBeenCalledWith('search failed');
		expect(search.results).toEqual([]);
		expect(search.searching).toBe(false);
	});
});

describe('MatchSearchField', () => {
	it('renders the caller placeholder and reports Enter', async () => {
		const onEnter = vi.fn();
		render(MatchSearchField, {
			props: { value: 'alien', placeholder: 'Search movies…', onEnter }
		});

		const input = screen.getByPlaceholderText('Search movies…') as HTMLInputElement;
		expect(input.value).toBe('alien');

		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(onEnter).toHaveBeenCalledTimes(1);

		await fireEvent.keyDown(input, { key: 'a' });
		expect(onEnter).toHaveBeenCalledTimes(1);
	});

	it('shows a spinner in place of the search icon while searching', () => {
		const { container } = render(MatchSearchField, {
			props: { value: 'alien', placeholder: 'Search', searching: true, onEnter: vi.fn() }
		});

		expect(container.querySelector('.animate-spin')).not.toBeNull();
	});

	it('does not spin when idle', () => {
		const { container } = render(MatchSearchField, {
			props: { value: 'alien', placeholder: 'Search', onEnter: vi.fn() }
		});

		expect(container.querySelector('.animate-spin')).toBeNull();
	});
});

describe('MatchResultList', () => {
	it('reports the clicked result', async () => {
		const onpick = vi.fn();
		render(MatchResultList, {
			props: { results: [tmdbResult(7), tmdbResult(8)], mediaType: 'movie', onpick }
		});

		await fireEvent.click(screen.getByText('Movie 8'));

		expect(onpick).toHaveBeenCalledTimes(1);
		expect(onpick.mock.calls[0][0].id).toBe(8);
	});

	it('marks rows disabled while a pick is being applied', () => {
		render(MatchResultList, {
			props: {
				results: [tmdbResult(7)],
				mediaType: 'movie',
				disabled: true,
				onpick: vi.fn()
			}
		});

		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
	});

	it('swaps the chevron for a spinner on the busy row only', () => {
		const { container } = render(MatchResultList, {
			props: {
				results: [tmdbResult(7), tmdbResult(8)],
				mediaType: 'movie',
				busyId: 7,
				onpick: vi.fn()
			}
		});

		expect(container.querySelectorAll('.animate-spin')).toHaveLength(1);
	});

	it('hides the trailing affordance for a plain pick', () => {
		const { container } = render(MatchResultList, {
			props: { results: [tmdbResult(7)], mediaType: 'movie', trailing: null, onpick: vi.fn() }
		});

		expect(container.querySelectorAll('svg.lucide-chevron-right')).toHaveLength(0);
	});

	it('falls back to the unknown-year label and the kind icon without a poster', () => {
		render(MatchResultList, {
			props: {
				results: [tmdbResult(9, { poster_path: null, release_date: null })],
				mediaType: 'tv',
				onpick: vi.fn()
			}
		});

		expect(screen.getByText('Unknown year')).toBeTruthy();
	});
});

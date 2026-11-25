import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	discoverMovies: vi.fn(),
	discoverTv: vi.fn(),
	apply: vi.fn()
}));

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: { discoverMovies: mocks.discoverMovies, discoverTv: mocks.discoverTv }
}));
vi.mock('#lib/server/filters/ContentFilterPipeline.js', () => ({
	contentFilterPipeline: { apply: mocks.apply }
}));

import { POST } from './+server.js';

const movies = (ids: number[]) => ids.map((id) => ({ id, title: `Movie ${id}` }));
const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

async function preview(body: Record<string, unknown>) {
	const request = new Request('http://localhost/api/smartlists/preview', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mediaType: 'movie', filters: {}, ...body })
	});
	const response = await POST({ request } as Parameters<typeof POST>[0]);
	return (await response.json()) as { items: { id: number }[] };
}

describe('POST /api/smartlists/preview', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.apply.mockImplementation(async (items: unknown[]) => ({ results: items }));
	});

	it('keeps each TMDB id once when the next page repeats a title from the first', async () => {
		// Page 2 starts with id 20, already on page 1: the sort order shifted between the requests.
		mocks.discoverMovies.mockImplementation(async ({ page }: { page: number }) => ({
			page,
			total_pages: 5,
			total_results: 100,
			results:
				page === 1 ? movies(range(1, 20)) : movies(range(20 * (page - 1), 20 * (page - 1) + 19))
		}));

		const { items } = await preview({ page: 1 });
		const ids = items.map((i) => i.id);

		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toHaveLength(27);
		expect(ids.slice(19, 21)).toEqual([20, 21]);
	});
});

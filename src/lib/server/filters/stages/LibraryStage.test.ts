import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryStage } from './LibraryStage.js';
import type { FilterContext } from '../types.js';

const mockEnrich = vi.hoisted(() => vi.fn());
const mockFilter = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/library/status.js', () => ({
	enrichWithLibraryStatus: mockEnrich,
	filterInLibrary: mockFilter
}));

const stage = new LibraryStage();

const makeItems = (ids: number[]) => ids.map((id) => ({ id, media_type: 'movie' as const }));

const ctx: FilterContext = { mediaType: 'movie' };

describe('LibraryStage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('is always enabled', () => {
		expect(stage.isEnabled(ctx)).toBe(true);
		expect(stage.isEnabled({ mediaType: 'tv' })).toBe(true);
		expect(stage.isEnabled({ mediaType: 'all', excludeInLibrary: true })).toBe(true);
	});

	it('returns empty array for empty input', async () => {
		const result = await stage.apply([], ctx);
		expect(result).toEqual([]);
		expect(mockEnrich).not.toHaveBeenCalled();
	});

	it('enriches items with library status', async () => {
		const items = makeItems([1, 2]);
		const enriched = items.map((i) => ({ ...i, inLibrary: false, hasFile: false }));
		mockEnrich.mockResolvedValue(enriched);

		const result = await stage.apply(items, ctx);

		expect(mockEnrich).toHaveBeenCalledWith(items, 'movie');
		expect(result).toEqual(enriched);
	});

	it('enriches with tv media type', async () => {
		const items = makeItems([10]);
		mockEnrich.mockResolvedValue([{ ...items[0], inLibrary: true, hasFile: true }]);

		await stage.apply(items, { mediaType: 'tv' });

		expect(mockEnrich).toHaveBeenCalledWith(items, 'tv');
	});

	it('calls filterInLibrary when excludeInLibrary is true', async () => {
		const items = makeItems([1, 2, 3]);
		const enriched = items.map((i) => ({ ...i, inLibrary: i.id === 2, hasFile: i.id === 2 }));
		mockEnrich.mockResolvedValue(enriched);
		mockFilter.mockReturnValue([enriched[0], enriched[2]]);

		const result = await stage.apply(items, { mediaType: 'all', excludeInLibrary: true });

		expect(mockFilter).toHaveBeenCalledWith(enriched, true);
		expect(result).toEqual([enriched[0], enriched[2]]);
	});

	it('does not call filterInLibrary when excludeInLibrary is false', async () => {
		const items = makeItems([1]);
		mockEnrich.mockResolvedValue([{ ...items[0], inLibrary: true, hasFile: true }]);

		await stage.apply(items, { mediaType: 'movie', excludeInLibrary: false });

		expect(mockFilter).not.toHaveBeenCalled();
	});

	it('handles null input gracefully', async () => {
		// @ts-expect-error testing null input
		// eslint-disable-next-line prefer-spread
		const result = await stage.apply(null, ctx);
		expect(result).toEqual([]);
	});
});

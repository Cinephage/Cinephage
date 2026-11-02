import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockedMediaStage } from './BlockedMediaStage.js';

const mockFilter = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/library/status.js', () => ({
	filterBlockedMedia: mockFilter
}));

const stage = new BlockedMediaStage();

const makeItems = (ids: number[]) => ids.map((id) => ({ id, media_type: 'movie' as const }));

describe('BlockedMediaStage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('is enabled by default', () => {
		expect(stage.isEnabled({ mediaType: 'movie' })).toBe(true);
	});

	it('is disabled when skipBlockedMedia is true', () => {
		expect(stage.isEnabled({ mediaType: 'movie', skipBlockedMedia: true })).toBe(false);
	});

	it('delegates to filterBlockedMedia', async () => {
		const items = makeItems([1, 2, 3]);
		const filtered = [items[0], items[2]];
		mockFilter.mockResolvedValue(filtered);

		const result = await stage.apply(items, { mediaType: 'movie' });

		expect(mockFilter).toHaveBeenCalledWith(items, 'movie');
		expect(result).toBe(filtered);
	});

	it('passes tv media type', async () => {
		const items = makeItems([5]);
		mockFilter.mockResolvedValue(items);

		await stage.apply(items, { mediaType: 'tv' });

		expect(mockFilter).toHaveBeenCalledWith(items, 'tv');
	});

	it('passes all media type', async () => {
		const items = makeItems([1]);
		mockFilter.mockResolvedValue([]);

		const result = await stage.apply(items, { mediaType: 'all' });

		expect(mockFilter).toHaveBeenCalledWith(items, 'all');
		expect(result).toEqual([]);
	});
});

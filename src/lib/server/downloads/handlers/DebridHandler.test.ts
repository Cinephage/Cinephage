import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	episodeRows: [{ id: 'wire-s01e01' }, { id: 'wire-s05e10' }],
	updatedValues: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({ all: vi.fn(() => mocks.episodeRows) }))
			}))
		})),
		update: vi.fn(() => ({
			set: vi.fn((values: unknown) => {
				mocks.updatedValues(values);
				return { where: vi.fn(() => ({ run: vi.fn() })) };
			})
		}))
	}
}));

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: vi.fn(() => ({ warn: vi.fn() }))
}));

import { DebridHandler } from './DebridHandler';

describe('DebridHandler retry target recovery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('persists missing monitored episode IDs on a legacy empty-target series row', async () => {
		const handler = new DebridHandler() as unknown as {
			restoreMissingSeriesTarget(row: Record<string, unknown>): Promise<Record<string, unknown>>;
		};
		const restored = await handler.restoreMissingSeriesTarget({
			id: 'queue-wire',
			seriesId: 'series-wire',
			episodeIds: []
		});

		expect(restored.episodeIds).toEqual(['wire-s01e01', 'wire-s05e10']);
		expect(mocks.updatedValues).toHaveBeenCalledWith({
			episodeIds: ['wire-s01e01', 'wire-s05e10']
		});
	});
});
